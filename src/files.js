'use strict';

// src/files.js — almacen plano de blobs sobre el nucleo HTTP de js-base.
// Cero dependencias runtime: solo node:fs y node:path.
// Subida atomica (temp en mismo dir + fsync + rename) en streaming del body CRUDO
// (cualquier content-type NO json; el nucleo NO consume bodies no-json, asi que
// ctx.req llega intacto como stream legible). Lectura publica en streaming.

const fs = require('node:fs');
const path = require('node:path');

// Solo nombres seguros: alfanumerico al inicio, luego [A-Za-z0-9._-] (max 128).
// ADEMAS: sin ".." en ninguna posicion, ni sufijos reservados (.meta.json / .tmp)
// que colisionarian con sidecars y temps internos.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_SUFFIXES = ['.meta.json', '.tmp'];

let tempCounter = 0;

function validationError(message) {
  const e = new Error(message || 'invalid name');
  e.code = 'VALIDATION';
  return e;
}

function forbiddenError(message) {
  const e = new Error(message || 'forbidden');
  e.code = 'FORBIDDEN';
  return e;
}

function notFoundError(message) {
  const e = new Error(message || 'not found');
  e.code = 'NOT_FOUND';
  return e;
}

// Valida el :name. Devuelve un Error tipado (VALIDATION) si rechaza, o null si ok.
// NUNCA toca el filesystem: un name invalido se rechaza antes de cualquier I/O.
function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return validationError('invalid name');
  if (name.includes('..')) return validationError('invalid name');
  for (const suf of RESERVED_SUFFIXES) {
    if (name.endsWith(suf)) return validationError('invalid name');
  }
  return null;
}

// Defensa en profundidad: la ruta resuelta debe quedar DENTRO de dir.
function isInside(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function metaPathOf(finalPath) {
  return finalPath + '.meta.json';
}

// Envia una respuesta JSON directa al response nativo. Idempotente si ya termino.
function sendJSON(res, status, obj) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

// Lee el body CRUDO (stream) escribiendolo en tempPath de forma ATOMICA:
//  - abre temp con 'wx' (falla si existe -> unico por proceso via contador)
//  - por chunk: acumula size; si excede maxBytes aborta (no destruye el socket,
//    solo pausa -> el 413 viaja por la MISMA conexion, igual que el nucleo)
//  - aplica backpressure: pausa req mientras espera cada write del FileHandle
//  - al 'end': fsync + close -> el caller hace rename al destino final
// Devuelve size. Rechaza con err.code='PAYLOAD_TOO_LARGE' si excede.
// No destruye ctx.req: deja que la respuesta de error viaje por la conexion.
function streamToFile(req, tempPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    let ended = false;
    let fh = null;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      req.pause();
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
      // Limpieza del temp: nunca deja residual.
      (async () => {
        try { if (fh) await fh.close(); } catch {}
        try { await fs.promises.unlink(tempPath); } catch {}
        reject(err);
      })();
    };

    fs.promises.open(tempPath, 'wx').then((h) => {
      fh = h;
      if (aborted) {
        fail(new Error('aborted'));
        return;
      }
      req.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBytes) {
          const e = new Error('file too large');
          e.code = 'PAYLOAD_TOO_LARGE';
          fail(e);
          return;
        }
        // Backpressure: pausa hasta que el write del fd se complete.
        req.pause();
        fh.write(chunk).then(() => {
          if (!aborted && !ended) req.resume();
        }).catch((e) => fail(e));
      });
      req.on('end', async () => {
        ended = true;
        if (aborted) return;
        try {
          await fh.sync();   // fsync antes de cerrar (durabilidad)
          await fh.close();
          fh = null;
          resolve(size);
        } catch (e) {
          fail(e);
        }
      });
      req.on('error', (e) => fail(e));
    }).catch((e) => {
      // No se pudo abrir el temp (p.ej. colision de nombre): error comun.
      reject(e);
    });
  });
}

function buildRequestCtx(ctx) {
  return { method: ctx.req.method, path: ctx.req.url, query: ctx.query };
}

function registerFileRoutes(app, opts = {}) {
  const dir = opts.dir;
  const authResolver = opts.authResolver || (async () => null);
  const maxBytes = opts.maxBytes || (10 * 1024 * 1024);

  if (!dir || typeof dir !== 'string') {
    throw new Error('files: dir requerido');
  }

  // Crea dir recursivo si falta (storage plano).
  fs.mkdirSync(dir, { recursive: true });

  const safePath = (name) => {
    const finalPath = path.resolve(dir, name);
    if (!isInside(dir, finalPath)) return null;
    return finalPath;
  };

  // POST /api/files/:name — subida atomica en streaming.
  app.route('POST', '/api/files/:name', async (ctx) => {
    const name = ctx.params.name;
    const verr = validateName(name);
    if (verr) throw verr;

    const user = await authResolver(ctx.token);
    const ruleCtx = {
      op: 'create',
      collection: '_files',
      auth: user,
      record: { name },
      request: buildRequestCtx(ctx),
    };
    if (!(await app.rules.check(ruleCtx)).allow) throw forbiddenError();

    const finalPath = safePath(name);
    if (!finalPath) throw validationError('invalid name');

    const tempPath = path.resolve(dir, `.${name}.${process.pid}.${tempCounter++}.tmp`);
    let size;
    try {
      size = await streamToFile(ctx.req, tempPath, maxBytes);
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        // El nucleo no mapea 413 en CODE_STATUS: se escribe el status directo.
        // res.writableEnded queda true -> el nucleo NO vuelve a responder.
        sendJSON(ctx.res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'file too large' } });
        return;
      }
      throw e;
    }

    // Rename atomico (mismo dir => misma particion => cambio de inodo, no copia).
    await fs.promises.rename(tempPath, finalPath);

    const contentType = ctx.req.headers['content-type'] || 'application/octet-stream';
    const meta = {
      contentType,
      size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: user && user.id != null ? user.id : null,
    };
    fs.writeFileSync(metaPathOf(finalPath), JSON.stringify(meta));

    return { name, size, contentType };
  });

  // GET /api/files/:name — streamea el archivo (lectura publica en MVP, sin rules).
  app.route('GET', '/api/files/:name', async (ctx) => {
    const name = ctx.params.name;
    const verr = validateName(name);
    if (verr) throw verr;

    const finalPath = safePath(name);
    if (!finalPath) throw validationError('invalid name');

    let stat;
    try {
      stat = await fs.promises.stat(finalPath);
    } catch {
      throw notFoundError();
    }

    let contentType = 'application/octet-stream';
    try {
      const raw = fs.readFileSync(metaPathOf(finalPath), 'utf8');
      const meta = JSON.parse(raw);
      if (meta && typeof meta.contentType === 'string') contentType = meta.contentType;
    } catch {
      // Sin sidecar o corrupto -> octet-stream (defensa, no falla la lectura).
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', contentType);
    ctx.res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(finalPath);
    // Devuelve una promesa que resuelve (undefined) SOLO cuando el pipe termina.
    // Asi el nucleo ve res.writableEnded=true y NO aplica el 204 por defecto
    // (mecanismo real del nucleo: handler que devuelve undefined tras escribir res).
    return new Promise((resolve, reject) => {
      stream.on('error', () => {
        if (!ctx.res.headersSent) {
          reject(Object.assign(new Error('read failed'), { code: 'INTERNAL' }));
        } else {
          ctx.res.destroy();
          resolve();
        }
      });
      ctx.res.on('error', () => {
        stream.destroy();
        resolve();
      });
      // 'finish' = todos los bytes enviados al SO. NO usar 'close': con keep-alive
      // el socket persiste y 'close' se retrasa hasta que el cliente lo cierra,
      // lo que dejaria el handler (y el test) colgado.
      ctx.res.on('finish', () => resolve());
      stream.pipe(ctx.res);
    });
  });

  // DELETE /api/files/:name — borra archivo + sidecar.
  app.route('DELETE', '/api/files/:name', async (ctx) => {
    const name = ctx.params.name;
    const verr = validateName(name);
    if (verr) throw verr;

    const user = await authResolver(ctx.token);
    const ruleCtx = {
      op: 'delete',
      collection: '_files',
      auth: user,
      record: { name },
      request: buildRequestCtx(ctx),
    };
    if (!(await app.rules.check(ruleCtx)).allow) throw forbiddenError();

    const finalPath = safePath(name);
    if (!finalPath) throw validationError('invalid name');

    try {
      await fs.promises.stat(finalPath);
    } catch {
      throw notFoundError();
    }
    await fs.promises.unlink(finalPath);
    try {
      await fs.promises.unlink(metaPathOf(finalPath));
    } catch {
      // sidecar ausente: no es error.
    }
    return { ok: true };
  });

  return app;
}

module.exports = { registerFileRoutes, validateName, isInside };
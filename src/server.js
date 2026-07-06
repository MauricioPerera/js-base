'use strict';

// src/server.js — nucleo HTTP generico de js-base (estilo PocketBase).
// Solo node:http y node:url. Sin HTTPS, sin websockets, sin static files.
// Pipeline por request: CORS -> parseo JSON body -> match router -> ctx -> handler.

const http = require('node:http');

const { Router } = require('./router.js');
const { defaultRules, defaultEvents } = require('./hooks.js');

// Limite del body JSON: 1 MiB. Excederlo -> 413.
const BODY_LIMIT = 1024 * 1024;

// Mapeo de err.code (enum de auth-service + VALIDATION) -> status HTTP.
const CODE_STATUS = {
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  INVALID_TOKEN: 401,
  WEAK_PASSWORD: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
};

// createApp({ rules?, events? } = {}) -> app
function createApp(opts = {}) {
  const rules = opts.rules || defaultRules;
  const events = opts.events || defaultEvents;
  const router = new Router();

  const app = {
    router,
    rules,
    events,
    route(method, pattern, handler) {
      router.add(method, pattern, handler);
      return app;
    },
    listen(port) {
      return listen(app, port);
    },
    close() {
      return close(app);
    },
    _server: null,
  };

  return app;
}

// listen(port) -> Promise<server>. port=0 => puerto efimero (server.address().port).
function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // El handler es async; nunca deja la peticion colgada.
      handleRequest(app, req, res).catch((err) => {
        if (!res.writableEnded) {
          console.error(err);
          res.statusCode = 500;
          res.end();
        }
      });
    });
    app._server = server;
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// close() -> Promise. No lanza si no hay server.
function close(app) {
  return new Promise((resolve) => {
    const server = app._server;
    if (!server) return resolve();
    app._server = null;
    server.close(() => resolve());
  });
}

// --- Pipeline por request ---------------------------------------------------

async function handleRequest(app, req, res) {
  // (a) CORS: Allow-Origin en TODAS las respuestas (se setea aca y sendJSON lo reafirma).
  res.setHeader('Access-Control-Allow-Origin', '*');

  // OPTIONS preflight -> 204 + headers CORS.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.statusCode = 204;
    res.end();
    return;
  }

  const u = new URL(req.url, 'http://localhost');

  // (b) parseo JSON del body si Content-Type: application/json.
  let body;
  const ct = req.headers['content-type'] || '';
  if (ct.toLowerCase().includes('application/json')) {
    let buf;
    try {
      buf = await readBody(req, BODY_LIMIT);
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        sendJSON(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'request body too large' } });
      } else {
        sendJSON(res, 400, { error: { code: 'INVALID_JSON', message: 'could not read request body' } });
      }
      return;
    }
    if (buf.length > 0) {
      try {
        body = JSON.parse(buf.toString('utf8'));
      } catch {
        sendJSON(res, 400, { error: { code: 'INVALID_JSON', message: 'invalid json body' } });
        return;
      }
    }
  }

  // (c) match del router -> 404 JSON si no hay ruta.
  const matched = app.router.match(req.method, u.pathname);
  if (!matched) {
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    return;
  }

  // (d) construye ctx. token = Bearer del header Authorization o null (solo extraccion).
  const ctx = {
    req,
    res,
    params: matched.params,
    query: queryToObject(u.searchParams),
    body,
    token: extractToken(req),
  };

  // (e) invoca handler.
  let result;
  try {
    result = await matched.handler(ctx);
  } catch (err) {
    handleError(err, res);
    return;
  }

  // Si devuelve un objeto -> 200 JSON (o ctx.status para otro 2xx).
  if (result !== undefined && result !== null && typeof result === 'object') {
    sendJSON(res, ctx.status || 200, result);
  } else if (!res.writableEnded) {
    // Handler que no devuelve cuerpo (o ya respondio). Si no termino, 204.
    res.statusCode = ctx.status || 204;
    res.end();
  }
}

// Lee el body entero hasta BODY_LIMIT; rechaza con PAYLOAD_TOO_LARGE si excede.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        // No destruye el socket: deja de acumular y rechaza para que el nucleo
        // responda 413 sobre la MISMA conexion (destruir aqui tira el socket y el
        // cliente no recibe el 413). El resto del body se ignora (aborted=true).
        aborted = true;
        const err = new Error('request body too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

// URLSearchParams -> objeto plano (ultima gana en claves repetidas).
function queryToObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams.entries()) out[k] = v;
  return out;
}

// Extrae el token Bearer del header Authorization (solo extraccion, sin verificar).
function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Mapea un Error lanzado por el handler a una respuesta JSON.
function handleError(err, res) {
  const code = err && err.code;
  const status = CODE_STATUS[code];
  if (status) {
    sendJSON(res, status, { error: { code, message: err.message } });
  } else {
    // Error comun (sin .code): 500, mensaje interno NO se filtra al cliente.
    console.error(err);
    sendJSON(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
  }
}

// Envia una respuesta JSON con status y CORS header. No falla si ya termino.
function sendJSON(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(body);
}

module.exports = { createApp, CODE_STATUS, BODY_LIMIT };
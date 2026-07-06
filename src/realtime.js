'use strict';

// src/realtime.js — fanout SSE (Server-Sent Events) sobre el nucleo HTTP de js-base.
// Cero dependencias runtime: solo node:http (via el nucleo) y estructuras en memoria.
// Implementa el contrato de events (ver src/hooks.js): events.emit(evt) hace fanout
// del evt a todos los clientes SSE suscritos a evt.collection (y a los suscritos al
// comodin "*"). register(app) monta GET /api/realtime/:collection que abre un stream
// SSE y lo mantiene abierto (el handler devuelve una Promise que resuelve en res
// 'close', igual que files.js mantiene viva su respuesta de streaming).
//
// Sin storage: todo en memoria del proceso. Nada persiste tras cerrar el server.

// makeRealtime(opts?) -> { events, register(app), subscriberCount(collection?) }
//   opts.heartbeatMs : intervalo del ping SSE en ms; 0/omitido => sin heartbeat.
//                      Si se habilita, el timer usa unref() para no colgar el proceso.
//
// events.emit(evt)  : implementa el contrato de hooks (ver src/hooks.js). NUNCA
//                     lanza: captura errores de escritura por cliente y limpia ese
//                     suscriptor. evt = { collection, op, record }.
// register(app)     : registra GET /api/realtime/:collection. Devuelve app.
// subscriberCount(collection?) : nro de suscriptores (para tests). Sin argumento =
//                     total; con collection = suscritos a esa coleccion (incluye
//                     solo los de esa clave exacta; "*" cuenta aparte).
function makeRealtime(opts = {}) {
  const heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : 0;

  // Map<collection, Set<ServerResponse>>. "*" es una clave mas (comodin).
  const subs = new Map();

  const getSet = (collection) => {
    let s = subs.get(collection);
    if (!s) { s = new Set(); subs.set(collection, s); }
    return s;
  };

  // subscribe(collection, res) -> unsubscribe(). Idempotente.
  const subscribe = (collection, res) => {
    const set = getSet(collection);
    set.add(res);
    return () => {
      set.delete(res);
      if (set.size === 0) subs.delete(collection);
    };
  };

  // Limpia un res muerto de TODAS las colecciones (defensa: un cliente podria estar
  // suscrito a varias, aunque la ruta actual suscribe a una sola).
  const purgeDead = (res) => {
    for (const s of subs.values()) s.delete(res);
    for (const [col, s] of subs) if (s.size === 0) subs.delete(col);
  };

  // Escribe un frame SSE estandar: "event: <op>\ndata: <json>\n\n".
  // Devuelve true si llego al socket, false si el res estaba muerto/erroreo.
  const writeFrame = (res, op, evt) => {
    if (res.destroyed || res.writableEnded) return false;
    let payload;
    try { payload = JSON.stringify(evt); } catch { return false; }
    try {
      res.write(`event: ${op}\n`);
      res.write(`data: ${payload}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  // events: implementa el contrato de hooks (emit(evt)). Fanout a suscriptores de
  // evt.collection + comodin "*". NUNCA lanza.
  const events = {
    emit(evt) {
      if (!evt || typeof evt !== 'object') return;
      const collection = evt.collection;
      if (typeof collection !== 'string') return;
      const op = evt.op;

      // Recolectar destinatarios unicos (un res podria estar en collection y en "*").
      const targets = new Set();
      const colSet = subs.get(collection);
      if (colSet) for (const r of colSet) targets.add(r);
      const starSet = subs.get('*');
      if (starSet) for (const r of starSet) targets.add(r);
      if (targets.size === 0) return;

      const dead = [];
      for (const res of targets) {
        if (!writeFrame(res, op, evt)) dead.push(res);
      }
      if (dead.length) for (const r of dead) purgeDead(r);
    },
  };

  // register(app): monta la ruta SSE. El handler NO cierra la respuesta: devuelve una
  // Promise que resuelve en res 'close' para que el nucleo mantenga viva la conexion
  // (mecanismo de "handler que ya respondio" de src/server.js / src/files.js).
  const register = (app) => {
    app.route('GET', '/api/realtime/:collection', (ctx) => {
      const collection = ctx.params.collection || '*';
      const res = ctx.res;

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // CORS ya lo setea el nucleo; lo reafirmamos por simetria con el resto.
      res.setHeader('Access-Control-Allow-Origin', '*');

      let timer = null;
      let cleaned = false;

      const off = subscribe(collection, res);

      // Comentario inicial SSE (keep-alive + señal de "conectado" para el cliente).
      try { res.write(': connected\n\n'); } catch { /* socket roto -> close limpia */ }

      // Heartbeat opcional: SIEMPRE unref() para no colgar el proceso ni los tests.
      if (heartbeatMs > 0) {
        timer = setInterval(() => {
          if (res.destroyed || res.writableEnded) return;
          try { res.write(': ping\n\n'); } catch { /* close se encarga */ }
        }, heartbeatMs);
        timer.unref();
      }

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        off();
        if (timer) { clearInterval(timer); timer = null; }
      };

      // Desuscribe al cerrar la conexion (cliente se va o se cae el socket).
      ctx.req.on('close', cleanup);
      res.on('close', cleanup);

      // Mantiene la respuesta abierta: resuelve recien en res 'close'. Ahi el nucleo
      // ve res.writableEnded=false y aplica su 204/end sobre un res ya cerrado (no-op),
      // sin doble respuesta ni crash (igual que files.js con 'finish').
      return new Promise((resolve) => {
        res.on('close', () => resolve());
      });
    });
    return app;
  };

  const subscriberCount = (collection) => {
    if (collection === undefined) {
      let n = 0;
      for (const s of subs.values()) n += s.size;
      return n;
    }
    const s = subs.get(collection);
    return s ? s.size : 0;
  };

  return { events, register, subscriberCount };
}

module.exports = { makeRealtime };
'use strict';

// tests/realtime.test.js — src/realtime.js (congelado).
// Flujo real: createApp({ events }) -> register(app) -> cliente SSE real (node:http)
// -> POST que dispara app.events.emit -> el cliente recibe el frame SSE.
// Todo con timeout y cerrado en finally; sin timers colgados (no se usa heartbeat).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createApp } = require('../src/server.js');
const { makeRealtime } = require('../src/realtime.js');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// Parsea un frame SSE (sin el bloque separador '\n\n') en { event, data }.
function parseFrame(frame) {
  let event;
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

// Abre un cliente SSE real contra /api/realtime/:collection.
// Devuelve { connected, frames, close }. `connected` resuelve cuando llega el
// comentario inicial ': connected' (senal de que el server ya registro la suscripcion).
function openSSE(port, collection) {
  const frames = [];
  let raw = '';
  let req;
  let resolveConnected;
  let connectedResolved = false;
  const connected = new Promise((res) => { resolveConnected = res; });

  req = http.get(
    `http://127.0.0.1:${port}/api/realtime/${collection}`,
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        let idx;
        while ((idx = raw.indexOf('\n\n')) !== -1) {
          const frame = raw.slice(0, idx);
          raw = raw.slice(idx + 2);
          if (frame.startsWith(':')) {
            if (!connectedResolved) { connectedResolved = true; resolveConnected(); }
            continue;
          }
          const parsed = parseFrame(frame);
          if (parsed) frames.push(parsed);
        }
      });
    },
  );
  req.on('error', () => {}); // ignoramos errores tras destroy/close.

  return {
    connected,
    frames,
    close: () => { try { req.destroy(); } catch {} },
  };
}

// POST JSON a una ruta del app (dispara el emit del flujo real).
function postJSON(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => { res.resume(); res.on('end', () => resolve()); },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

// Espera a que aparezca un frame que cumpla predicate (o timeout).
async function waitForFrame(sse, predicate, timeout = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = sse.frames.find(predicate);
    if (found) return found;
    await tick(20);
  }
  throw new Error(`timeout esperando frame (frames=${JSON.stringify(sse.frames)})`);
}

// Arma el app completo: nucleo real + realtime cableado via createApp({ events }).
function buildApp() {
  const rt = makeRealtime();
  const app = createApp({ events: rt.events });
  rt.register(app);
  // Ruta "create" que dispara el emit (flujo real create->emit->cliente).
  app.route('POST', '/api/:collection', async (ctx) => {
    const record = ctx.body || {};
    app.events.emit({ collection: ctx.params.collection, op: 'create', record });
    return record;
  });
  return { app, rt };
}

async function start(app) {
  const server = await app.listen(0);
  return { server, port: server.address().port };
}

test('suscriptor a "posts" recibe el evt emitido para "posts"', async () => {
  const { app, rt } = buildApp();
  const { port } = await start(app);
  const sse = openSSE(port, 'posts');
  try {
    await sse.connected;
    assert.equal(rt.subscriberCount('posts'), 1);

    await postJSON(port, '/api/posts', { id: 1, text: 'hola' });

    const frame = await waitForFrame(sse, (f) => f.data && f.data.collection === 'posts');
    assert.equal(frame.event, 'create');
    assert.equal(frame.data.collection, 'posts');
    assert.equal(frame.data.op, 'create');
    assert.deepEqual(frame.data.record, { id: 1, text: 'hola' });
  } finally {
    sse.close();
    await app.close();
  }
});

test('suscriptor a "posts" NO recibe un evt de "comments"', async () => {
  const { app } = buildApp();
  const { port } = await start(app);
  const sse = openSSE(port, 'posts');
  try {
    await sse.connected;

    // Emitimos primero un evt de comments (no debe llegar al suscriptor de posts).
    await postJSON(port, '/api/comments', { id: 9, text: 'coment' });
    // Luego un evt de posts (debe llegar y ser el unico frame de datos).
    await postJSON(port, '/api/posts', { id: 2, text: 'post2' });

    const frame = await waitForFrame(sse, (f) => f.data && f.data.collection === 'posts');
    assert.equal(frame.data.collection, 'posts');

    // Damos un margen por si un evt de comments fuera a llegar (no deberia).
    await tick(80);
    const commentsFrames = sse.frames.filter((f) => f.data && f.data.collection === 'comments');
    assert.equal(commentsFrames.length, 0, 'no debe recibir frames de comments');
    assert.equal(sse.frames.length, 1, 'recibe un solo frame (el de posts)');
  } finally {
    sse.close();
    await app.close();
  }
});

test('subscriberCount refleja alta y baja tras cerrar el cliente', async () => {
  const { app, rt } = buildApp();
  const { port } = await start(app);
  const sse = openSSE(port, 'posts');
  try {
    await sse.connected;
    assert.equal(rt.subscriberCount('posts'), 1);
    assert.equal(rt.subscriberCount(), 1);

    sse.close();
    // Damos tiempo a que el 'close' del server desuscriba.
    for (let i = 0; i < 50 && rt.subscriberCount('posts') !== 0; i++) await tick(20);
    assert.equal(rt.subscriberCount('posts'), 0);
    assert.equal(rt.subscriberCount(), 0);
  } finally {
    await app.close();
  }
});

test('emit sin suscriptores no lanza', async () => {
  const { app, rt } = buildApp();
  await start(app);
  try {
    assert.doesNotThrow(() => {
      rt.events.emit({ collection: 'orphan', op: 'create', record: { id: 1 } });
    });
    assert.doesNotThrow(() => {
      rt.events.emit({ collection: 'orphan', op: 'create', record: null });
    });
  } finally {
    await app.close();
  }
});

test('emit hacia un cliente ya desconectado no lanza y limpia el suscriptor', async () => {
  const { app, rt } = buildApp();
  const { port } = await start(app);
  const sse = openSSE(port, 'posts');
  try {
    await sse.connected;
    assert.equal(rt.subscriberCount('posts'), 1);

    sse.close();
    for (let i = 0; i < 50 && rt.subscriberCount('posts') !== 0; i++) await tick(20);
    assert.equal(rt.subscriberCount('posts'), 0, 'el close desuscribio');

    // Emitir tras la desconexion no debe lanzar (write a res muerto se descarta).
    assert.doesNotThrow(() => {
      rt.events.emit({ collection: 'posts', op: 'create', record: { id: 5 } });
    });
    assert.equal(rt.subscriberCount('posts'), 0);
  } finally {
    await app.close();
  }
});

test('comodin "*" recibe eventos de cualquier coleccion', async () => {
  const { app, rt } = buildApp();
  const { port } = await start(app);
  const star = openSSE(port, '*');
  try {
    await star.connected;
    assert.equal(rt.subscriberCount('*'), 1);

    await postJSON(port, '/api/posts', { id: 1 });
    const frame = await waitForFrame(star, (f) => f.data && f.data.collection === 'posts');
    assert.equal(frame.data.collection, 'posts');
    assert.equal(frame.data.op, 'create');
  } finally {
    star.close();
    await app.close();
  }
});
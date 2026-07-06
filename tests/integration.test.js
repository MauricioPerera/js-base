'use strict';

// tests/integration.test.js — e2e del server ensamblado por src/app.js (B6).
// createServer real sobre un tempdir (filesystem atómico) + listen(0) + fetch real.
// Cubre el flujo completo del Definition of Done: (a) colección, (b) auth,
// (c) records, (d) files, (e) semantic, (f) realtime SSE, (g) rules deny/auth.
// CIERRA TODO en finally (server.close + semanticStores.closeAll) y borra el
// tempdir. Sin handles/timers huérfanos.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../src/app.js');

// --- Helpers ----------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsbase-int-'));
}

function rimraf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// Levanta un server real sobre un tempdir fresco. Devuelve { origin, ctx, close }.
async function start() {
  const dataDir = tempDir();
  const ctx = await createServer({ dataDir, secret: 'integration-test-secret-16' });
  const server = await ctx.listen(0);
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    ctx,
    close: async () => {
      try { await ctx.close(); } catch {}
      rimraf(dataDir);
    },
  };
}

// fetch JSON con Authorization opcional.
async function req(origin, method, url, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${origin}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function json(res) {
  return res.json();
}

// Cliente SSE real contra /api/realtime/:collection. Devuelve { connected, frames, close }.
// `connected` resuelve al llegar al comentario inicial ': connected'.
function openSSE(origin, collection) {
  const frames = [];
  let raw = '';
  let req_;
  let resolveConnected;
  let connectedResolved = false;
  const connected = new Promise((res) => { resolveConnected = res; });

  req_ = http.get(`${origin}/api/realtime/${collection}`, (res) => {
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
        let event;
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) {
          try { frames.push({ event, data: JSON.parse(data) }); } catch {}
        }
      }
    });
  });
  req_.on('error', () => {});

  return { connected, frames, close: () => { try { req_.destroy(); } catch {} } };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Tests ------------------------------------------------------------------

test('(a) colección creada via registry con rules públicas', async () => {
  const env = await start();
  try {
    env.ctx.registry.create({
      name: 'posts',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'views', type: 'number' },
      ],
      rules: { create: null, list: null, view: null, update: null, delete: null },
      vector: null,
    });
    const cfg = env.ctx.registry.get('posts');
    assert.equal(cfg.name, 'posts');
    assert.equal(cfg.rules.create, null);
    assert.equal(cfg.rules.list, null);
  } finally { await env.close(); }
});

test('(b)(c) auth register+login -> token; records POST con Bearer -> 201; GET list trae el doc', async () => {
  const env = await start();
  try {
    env.ctx.registry.create({
      name: 'posts',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'views', type: 'number' },
      ],
      rules: { create: null, list: null, view: null, update: null, delete: null },
      vector: null,
    });

    // (b) auth: register + login -> token
    const email = `user-${Date.now()}@test.com`;
    const reg = await req(env.origin, 'POST', '/api/auth/register', {
      body: { email, password: 'password123', profile: { name: 'Test' } },
    });
    assert.equal(reg.status, 201);
    const regJson = await json(reg);
    assert.equal(regJson.user.email, email);
    assert.equal(regJson.user.passwordHash, undefined);

    const login = await req(env.origin, 'POST', '/api/auth/login', {
      body: { email, password: 'password123' },
    });
    assert.equal(login.status, 200);
    const { token } = await json(login);
    assert.ok(typeof token === 'string' && token.length > 0);

    // (c) records: POST con Bearer -> 201; GET list -> lo trae
    const created = await req(env.origin, 'POST', '/api/collections/posts/records', {
      body: { title: 'hola', views: 0 },
      token,
    });
    assert.equal(created.status, 201);
    const cdoc = await json(created);
    assert.equal(cdoc.title, 'hola');
    assert.ok(typeof cdoc._id === 'string' && cdoc._id.length > 0);

    const list = await req(env.origin, 'GET', '/api/collections/posts/records');
    assert.equal(list.status, 200);
    const ljson = await json(list);
    assert.equal(ljson.totalItems, 1);
    assert.equal(ljson.items[0]._id, cdoc._id);
    assert.equal(ljson.items[0].title, 'hola');
  } finally { await env.close(); }
});

test('(d) files: POST binario CON Bearer -> GET byte-identico (lectura pública)', async () => {
  const env = await start();
  try {
    // La escritura/borrado de '_files' exige auth: registrar+login -> token.
    const email = `files-${Date.now()}@test.com`;
    await req(env.origin, 'POST', '/api/auth/register', {
      body: { email, password: 'password123' },
    });
    const login = await req(env.origin, 'POST', '/api/auth/login', {
      body: { email, password: 'password123' },
    });
    const { token } = await json(login);

    const payload = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0xaa, 0x55, 0xc3, 0x28]);
    const up = await fetch(`${env.origin}/api/files/blob.bin`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', Authorization: `Bearer ${token}` },
      body: payload,
    });
    assert.equal(up.status, 200);
    const upJson = await json(up);
    assert.equal(upJson.name, 'blob.bin');
    assert.equal(upJson.size, payload.length);
    assert.equal(upJson.contentType, 'image/png');

    // La LECTURA sigue siendo pública: GET SIN token -> 200 byte-identico.
    const down = await fetch(`${env.origin}/api/files/blob.bin`);
    assert.equal(down.status, 200);
    const buf = Buffer.from(await down.arrayBuffer());
    assert.equal(buf.length, payload.length);
    assert.deepEqual(buf, payload);
  } finally { await env.close(); }
});

test('(e) semantic: coleccion vector{dim:3}, POST /vectors, POST /search -> el mas cercano', async () => {
  const env = await start();
  try {
    env.ctx.registry.create({
      name: 'docs',
      fields: [{ name: 'text', type: 'string' }],
      rules: { create: null, list: null, view: null, update: null, delete: null },
      vector: { dim: 3 },
    });

    const a = await req(env.origin, 'POST', '/api/collections/docs/vectors', {
      body: { id: 'a', doc: { text: 'foo' }, vector: [1, 0, 0] },
    });
    assert.equal(a.status, 201);
    assert.equal((await json(a)).id, 'a');

    const b = await req(env.origin, 'POST', '/api/collections/docs/vectors', {
      body: { id: 'b', doc: { text: 'bar' }, vector: [0, 1, 0] },
    });
    assert.equal(b.status, 201);

    const s = await req(env.origin, 'POST', '/api/collections/docs/search', {
      body: { vector: [0.99, 0.01, 0], limit: 2 },
    });
    assert.equal(s.status, 200);
    const sj = await json(s);
    assert.ok(Array.isArray(sj.items));
    assert.ok(sj.items.length > 0);
    assert.equal(sj.items[0].id, 'a', 'el mas cercano a [0.99,0.01,0] debe ser "a"');
    assert.ok(typeof sj.items[0].score === 'number');
  } finally { await env.close(); }
});

test('(f) realtime: SSE suscrito a la coleccion recibe el evento de create', async () => {
  const env = await start();
  try {
    env.ctx.registry.create({
      name: 'posts',
      fields: [{ name: 'title', type: 'string', required: true }],
      rules: { create: null, list: null, view: null, update: null, delete: null },
      vector: null,
    });

    const sse = openSSE(env.origin, 'posts');
    await sse.connected;

    // create dispara app.events.emit -> fanout al suscriptor SSE.
    const created = await req(env.origin, 'POST', '/api/collections/posts/records', {
      body: { title: 'evento-realtime' },
    });
    assert.equal(created.status, 201);
    const cdoc = await json(created);

    // Espera (acotada) a que llegue el frame 'create'.
    let evt = null;
    for (let i = 0; i < 40 && !evt; i++) {
      evt = sse.frames.find((f) => f.event === 'create') || null;
      if (!evt) await tick(25);
    }
    sse.close();
    assert.ok(evt, 'debe llegar un frame SSE con event "create"');
    assert.equal(evt.data.collection, 'posts');
    assert.equal(evt.data.op, 'create');
    assert.equal(evt.data.record._id, cdoc._id);
  } finally { await env.close(); }
});

test('(g) rules: create exige auth.id -> sin token 403, con token 201', async () => {
  const env = await start();
  try {
    env.ctx.registry.create({
      name: 'priv',
      fields: [{ name: 'content', type: 'string' }],
      rules: {
        create: { 'auth.id': { $exists: true } },
        list: null,
        view: null,
        update: null,
        delete: null,
      },
      vector: null,
    });

    // sin token -> 403 (authResolver devuelve null -> auth.id no existe -> deny)
    const noTok = await req(env.origin, 'POST', '/api/collections/priv/records', {
      body: { content: 'x' },
    });
    assert.equal(noTok.status, 403);
    assert.equal((await json(noTok)).error.code, 'FORBIDDEN');

    // con token -> 201
    const email = `priv-${Date.now()}@test.com`;
    await req(env.origin, 'POST', '/api/auth/register', {
      body: { email, password: 'password123' },
    });
    const login = await req(env.origin, 'POST', '/api/auth/login', {
      body: { email, password: 'password123' },
    });
    const { token } = await json(login);

    const withTok = await req(env.origin, 'POST', '/api/collections/priv/records', {
      body: { content: 'x' },
      token,
    });
    assert.equal(withTok.status, 201);
    const wj = await json(withTok);
    assert.equal(wj.content, 'x');
  } finally { await env.close(); }
});

test('health: una ruta no registrada devuelve 404 JSON del nucleo (server vivo)', async () => {
  const env = await start();
  try {
    const res = await fetch(`${env.origin}/api/collections/no-existe/records`);
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally { await env.close(); }
});

test('createServer valida secret y dataDir', async () => {
  await assert.rejects(() => createServer({ secret: 'x'.repeat(16) }), /dataDir/);
  await assert.rejects(() => createServer({ dataDir: './data' }), /secret/);
  await assert.rejects(
    () => createServer({ dataDir: './data', secret: 'short' }),
    /secret/,
  );
});
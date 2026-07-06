'use strict';

// tests/semantic.test.js — tests congelados de src/semantic-routes.js + semantic-provider.js.
// createApp real + CollectionRegistry real con una coleccion { vector:{dim:3} } y otra
// { vector:null }; fetch real; modo memoria salvo un test de modo disco en tempdir.
// CIERRA el server y semanticStores.closeAll SIEMPRE (finally).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server.js');
const { registerSemanticRoutes } = require('../src/semantic-routes.js');
const { makeSemanticStores } = require('../src/semantic-provider.js');
const { CollectionRegistry } = require('../src/collections.js');
const { DocStore, MemoryStorageAdapter } = require('../src/vendor/js-store/vendor/js-doc-store.js');

// --- Fakes ------------------------------------------------------------------

function makeAuthResolver() {
  const calls = [];
  const fn = async (token) => {
    calls.push(token);
    if (token === 'u1') return { id: 'u1' };
    return null;
  };
  fn.calls = calls;
  return fn;
}

function makeRules({ allow = true, denyOp = null } = {}) {
  const calls = [];
  const rules = {
    calls,
    async check(ctx) {
      calls.push(ctx);
      if (ctx.op === denyOp) return { allow: false };
      return { allow };
    },
  };
  return rules;
}

// --- Helpers ----------------------------------------------------------------

function makeDb() {
  return new DocStore(new MemoryStorageAdapter());
}

// Registry con "docs" (vector.dim:3) y "plain" (vector:null).
function makeRegistry(db) {
  const registry = new CollectionRegistry(db);
  registry.create({
    name: 'docs',
    fields: [
      { name: 'text', type: 'string' },
      { name: 'tag', type: 'string' },
    ],
    rules: { list: null, create: null, delete: null, update: null },
    vector: { dim: 3 },
  });
  registry.create({
    name: 'plain',
    fields: [{ name: 'title', type: 'string' }],
    rules: { list: null, create: null, delete: null, update: null },
    vector: null,
  });
  return registry;
}

// Levanta app con fakes. baseDir opcional -> modo disco.
async function start({ rules, auth, baseDir } = {}) {
  const db = makeDb();
  const registry = makeRegistry(db);
  const semanticStores = makeSemanticStores({ registry, baseDir });
  const r = rules || makeRules();
  const ar = auth || makeAuthResolver();
  const app = createApp({ rules: r, events: { emit() {} } });
  registerSemanticRoutes(app, { registry, semanticStores, authResolver: ar });
  const server = await app.listen(0);
  const port = server.address().port;
  return {
    app, server, registry, semanticStores,
    rules: r, auth: ar,
    origin: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

async function json(res) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function req(origin, method, pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Vectores dim 3 ortogonales.
const V = {
  a: [1, 0, 0],
  b: [0, 1, 0],
  c: [0, 0, 1],
};

// --- Tests ------------------------------------------------------------------

describe('semantic routes — happy path', () => {
  test('upsert 3 vectores -> search por el mas cercano devuelve el id correcto con score', async () => {
    const env = await start();
    try {
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'a', doc: { text: 'hello world', tag: 'a' }, vector: V.a });
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'b', doc: { text: 'foo bar', tag: 'b' }, vector: V.b });
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'c', doc: { text: 'baz qux', tag: 'a' }, vector: V.c });

      const res = await req(env.origin, 'POST', '/api/collections/docs/search', { vector: [0.99, 0, 0.01] });
      const j = await json(res);
      assert.equal(j.status, 200);
      assert.ok(Array.isArray(j.body.items));
      assert.ok(j.body.items.length > 0, 'debe devolver items');
      assert.equal(j.body.items[0].id, 'a', 'el mas cercano debe ser "a"');
      assert.ok(typeof j.body.items[0].score === 'number', 'score numerico');
      assert.ok(j.body.items[0].score > 0, 'score positivo para vector cercano');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('search con filter Mongo restringe resultados', async () => {
    const env = await start();
    try {
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'a', doc: { text: 'hello world', tag: 'a' }, vector: V.a });
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'b', doc: { text: 'foo bar', tag: 'b' }, vector: V.b });
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'c', doc: { text: 'baz qux', tag: 'a' }, vector: V.c });

      const res = await req(env.origin, 'POST', '/api/collections/docs/search', { vector: [1, 1, 1], filter: { tag: 'a' } });
      const j = await json(res);
      assert.equal(j.status, 200);
      assert.ok(j.body.items.length > 0);
      for (const it of j.body.items) {
        assert.equal(it.doc.tag, 'a', 'solo docs con tag "a" pasan el filtro');
      }
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('search/hybrid con query textual devuelve items', async () => {
    const env = await start();
    try {
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'a', doc: { text: 'hello world foo', tag: 'a' }, vector: V.a });
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'b', doc: { text: 'foo bar baz', tag: 'b' }, vector: V.b });

      const res = await req(env.origin, 'POST', '/api/collections/docs/search/hybrid', { vector: [1, 0, 0], query: 'hello' });
      const j = await json(res);
      assert.equal(j.status, 200);
      assert.ok(Array.isArray(j.body.items));
      assert.ok(j.body.items.length > 0, 'hybrid debe devolver items');
      assert.ok(typeof j.body.items[0].score === 'number');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });
});

describe('semantic routes — validacion y errores', () => {
  test('vector de longitud incorrecta -> 400 VALIDATION', async () => {
    const env = await start();
    try {
      const res = await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'x', doc: { text: 't' }, vector: [1, 0] });
      const j = await json(res);
      assert.equal(j.status, 400);
      assert.equal(j.body.error.code, 'VALIDATION');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('search con vector de longitud incorrecta -> 400 VALIDATION', async () => {
    const env = await start();
    try {
      const res = await req(env.origin, 'POST', '/api/collections/docs/search', { vector: [1, 0] });
      const j = await json(res);
      assert.equal(j.status, 400);
      assert.equal(j.body.error.code, 'VALIDATION');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('coleccion sin vector.dim -> endpoints semanticos dan 404', async () => {
    const env = await start();
    try {
      const r1 = await req(env.origin, 'POST', '/api/collections/plain/vectors', { id: 'x', doc: { title: 't' }, vector: [1, 0, 0] });
      const j1 = await json(r1);
      assert.equal(j1.status, 404);
      assert.equal(j1.body.error.code, 'NOT_FOUND');

      const r2 = await req(env.origin, 'POST', '/api/collections/plain/search', { vector: [1, 0, 0] });
      const j2 = await json(r2);
      assert.equal(j2.status, 404);
      assert.equal(j2.body.error.code, 'NOT_FOUND');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('rules deny -> 403 sin mutar', async () => {
    const env = await start({ rules: makeRules({ denyOp: 'create' }) });
    try {
      const res = await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'a', doc: { text: 't', tag: 'a' }, vector: V.a });
      const j = await json(res);
      assert.equal(j.status, 403);
      assert.equal(j.body.error.code, 'FORBIDDEN');

      // No muta: search posterior no trae "a".
      const sres = await req(env.origin, 'POST', '/api/collections/docs/search', { vector: V.a, limit: 10 });
      const sj = await json(sres);
      assert.equal(sj.status, 200);
      const ids = sj.body.items.map((i) => i.id);
      assert.ok(!ids.includes('a'), 'el vector denegado no debe persistirse');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('delete quita el vector (search posterior no lo trae)', async () => {
    const env = await start();
    try {
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'a', doc: { text: 'hello', tag: 'a' }, vector: V.a });
      await req(env.origin, 'POST', '/api/collections/docs/vectors', { id: 'b', doc: { text: 'foo', tag: 'b' }, vector: V.b });

      const dres = await req(env.origin, 'DELETE', '/api/collections/docs/vectors/a');
      const dj = await json(dres);
      assert.equal(dj.status, 200);
      assert.equal(dj.body.ok, true);

      const sres = await req(env.origin, 'POST', '/api/collections/docs/search', { vector: V.a, limit: 10 });
      const sj = await json(sres);
      const ids = sj.body.items.map((i) => i.id);
      assert.ok(!ids.includes('a'), '"a" no debe aparecer tras delete');
      assert.ok(ids.includes('b'), '"b" sigue presente');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });

  test('delete de id inexistente -> 404', async () => {
    const env = await start();
    try {
      const res = await req(env.origin, 'DELETE', '/api/collections/docs/vectors/ghost');
      const j = await json(res);
      assert.equal(j.status, 404);
      assert.equal(j.body.error.code, 'NOT_FOUND');
    } finally {
      await env.close();
      env.semanticStores.closeAll();
    }
  });
});

describe('semantic-provider — modo disco', () => {
  test('persistencia: upsert + closeAll + nuevo provider sobre mismo baseDir ve los datos', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-disk-'));
    try {
      const db = makeDb();
      const registry = makeRegistry(db);

      // Provider 1: escribe en disco.
      const stores1 = makeSemanticStores({ registry, baseDir: tmp });
      const sc1 = stores1.get('docs');
      assert.ok(sc1, 'get("docs") debe devolver una SemanticCollection en modo disco');
      sc1.upsert('x', { text: 'persistente', tag: 'a' }, V.a);
      stores1.closeAll();

      // Provider 2: reabre sobre el mismo baseDir y ve los datos.
      const stores2 = makeSemanticStores({ registry, baseDir: tmp });
      const sc2 = stores2.get('docs');
      const hits = sc2.search(V.a, { limit: 1 });
      assert.ok(hits.length > 0, 'el dato debe persistir en disco');
      assert.equal(hits[0].id, 'x', 'el id persistido debe ser "x"');
      assert.equal(hits[0].doc.text, 'persistente');
      stores2.closeAll();
    } finally {
      // Limpia el tempdir.
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
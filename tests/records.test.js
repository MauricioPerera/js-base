'use strict';

// tests/records.test.js — tests congelados de src/records.js (CRUD de records).
// createApp real + CollectionRegistry real con MemoryStorageAdapter + fakes de
// rules/events/authResolver. CIERRA el server SIEMPRE (finally).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server.js');
const { registerRecordRoutes } = require('../src/records.js');
const { makeStores } = require('../src/store-provider.js');
const { CollectionRegistry } = require('../src/collections.js');
const { DocStore, MemoryStorageAdapter } = require('../src/vendor/js-store/vendor/js-doc-store.js');

// --- Fakes ------------------------------------------------------------------

// authResolver: mapea el token Bearer (ya extraido por el server) a un user.
// "u1" -> { id: "u1" }; cualquier otro (incluido null) -> null.
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

// rules: registra cada check; deniega la op `denyOp` si se setea.
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

// events: registra cada emit.
function makeEvents() {
  const emits = [];
  return { emits, emit(evt) { emits.push(evt); } };
}

// --- Helpers ----------------------------------------------------------------

function makeDb() {
  return new DocStore(new MemoryStorageAdapter());
}

function makeRegistry(db) {
  const registry = new CollectionRegistry(db);
  registry.create({
    name: 'posts',
    fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'views', type: 'number' },
    ],
    rules: {},
    vector: null,
  });
  return registry;
}

// Levanta un app con fakes y devuelve { app, origin, rules, events, auth, close }.
async function start({ rules, events, auth } = {}) {
  const db = makeDb();
  const registry = makeRegistry(db);
  const stores = makeStores(db);
  const r = rules || makeRules();
  const ev = events || makeEvents();
  const ar = auth || makeAuthResolver();
  const app = createApp({ rules: r, events: ev });
  registerRecordRoutes(app, { registry, stores, authResolver: ar });
  const server = await app.listen(0);
  const port = server.address().port;
  return {
    app, server, registry, stores,
    rules: r, events: ev, auth: ar,
    origin: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

async function json(res) {
  return res.json();
}

async function req(origin, method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

// --- Tests ------------------------------------------------------------------

describe('records — CRUD happy path', () => {
  test('crear + ver + patch + delete + 404 despues', async () => {
    const ctx = await start();
    try {
      // POST -> 201 con _id y title
      const created = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { title: 'hola', views: 0 },
      });
      assert.equal(created.status, 201);
      const cdoc = await json(created);
      assert.equal(cdoc.title, 'hola');
      assert.equal(cdoc.views, 0);
      assert.ok(typeof cdoc._id === 'string' && cdoc._id.length > 0);
      const id = cdoc._id;

      // GET -> 200 doc
      const got = await req(ctx.origin, 'GET', `/api/collections/posts/records/${id}`);
      assert.equal(got.status, 200);
      assert.deepEqual(await json(got), cdoc);

      // PATCH -> merge
      const patched = await req(ctx.origin, 'PATCH', `/api/collections/posts/records/${id}`, {
        body: { views: 5 },
      });
      assert.equal(patched.status, 200);
      const pdoc = await json(patched);
      assert.equal(pdoc._id, id);
      assert.equal(pdoc.title, 'hola');    // preservado
      assert.equal(pdoc.views, 5);          // mergeado

      // DELETE -> { ok: true }
      const del = await req(ctx.origin, 'DELETE', `/api/collections/posts/records/${id}`);
      assert.equal(del.status, 200);
      assert.deepEqual(await json(del), { ok: true });

      // GET -> 404
      const after = await req(ctx.origin, 'GET', `/api/collections/posts/records/${id}`);
      assert.equal(after.status, 404);
      assert.equal((await json(after)).error.code, 'NOT_FOUND');
    } finally { await ctx.close(); }
  });
});

describe('records — list con filter + paginacion', () => {
  test('totalItems correcto, perPage respetado, pagina correcta', async () => {
    const ctx = await start();
    try {
      // Insertar 10 docs con views 1..10
      for (let i = 1; i <= 10; i++) {
        const r = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
          body: { title: `t${i}`, views: i },
        });
        assert.equal(r.status, 201);
      }
      // filter views >= 6 -> 5 docs (6,7,8,9,10); perPage=2 page=1 -> 2 items
      const enc = encodeURIComponent('{"views":{"$gte":6}}');
      const r1 = await req(ctx.origin, 'GET', `/api/collections/posts/records?filter=${enc}&page=1&perPage=2`);
      assert.equal(r1.status, 200);
      const b1 = await json(r1);
      assert.equal(b1.page, 1);
      assert.equal(b1.perPage, 2);
      assert.equal(b1.totalItems, 5);
      assert.equal(b1.items.length, 2);

      // page=2 -> siguientes 2
      const r2 = await req(ctx.origin, 'GET', `/api/collections/posts/records?filter=${enc}&page=2&perPage=2`);
      const b2 = await json(r2);
      assert.equal(b2.items.length, 2);

      // ultima pagina (page=3) -> 1 item
      const r3 = await req(ctx.origin, 'GET', `/api/collections/posts/records?filter=${enc}&page=3&perPage=2`);
      const b3 = await json(r3);
      assert.equal(b3.items.length, 1);

      // sin filter -> totalItems 10, defaults page=1 perPage=30
      const rAll = await req(ctx.origin, 'GET', '/api/collections/posts/records');
      const bAll = await json(rAll);
      assert.equal(bAll.totalItems, 10);
      assert.equal(bAll.page, 1);
      assert.equal(bAll.perPage, 30);
      assert.equal(bAll.items.length, 10);
    } finally { await ctx.close(); }
  });

  test('perPage > 200 se clampea a 200', async () => {
    const ctx = await start();
    try {
      const r = await req(ctx.origin, 'GET', '/api/collections/posts/records?perPage=500');
      assert.equal(r.status, 200);
      const b = await json(r);
      assert.equal(b.perPage, 200);
    } finally { await ctx.close(); }
  });

  test('filter invalido -> 400 VALIDATION', async () => {
    const ctx = await start();
    try {
      const r = await req(ctx.origin, 'GET', '/api/collections/posts/records?filter={bad json');
      assert.equal(r.status, 400);
      assert.equal((await json(r)).error.code, 'VALIDATION');
    } finally { await ctx.close(); }
  });
});

describe('records — validacion de schema', () => {
  test('POST invalido (required faltante) -> 400 con errors', async () => {
    const ctx = await start();
    try {
      const r = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { views: 1 }, // falta title (required)
      });
      assert.equal(r.status, 400);
      const b = await json(r);
      assert.equal(b.error.code, 'VALIDATION');
      assert.ok(/title/i.test(b.error.message));
    } finally { await ctx.close(); }
  });

  test('POST con tipo incorrecto -> 400 VALIDATION', async () => {
    const ctx = await start();
    try {
      const r = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { title: 'ok', views: 'no-es-number' },
      });
      assert.equal(r.status, 400);
      assert.equal((await json(r)).error.code, 'VALIDATION');
    } finally { await ctx.close(); }
  });
});

describe('records — PATCH no pisa _id', () => {
  test('body._id se ignora; el _id existente se preserva', async () => {
    const ctx = await start();
    try {
      const created = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { _id: 'fixed', title: 't', views: 0 },
      });
      assert.equal(created.status, 201);
      assert.equal((await json(created))._id, 'fixed');

      const patched = await req(ctx.origin, 'PATCH', '/api/collections/posts/records/fixed', {
        body: { _id: 'hacked', title: 't2' },
      });
      assert.equal(patched.status, 200);
      const pdoc = await json(patched);
      assert.equal(pdoc._id, 'fixed');
      assert.equal(pdoc.title, 't2');
    } finally { await ctx.close(); }
  });
});

describe('records — coleccion inexistente', () => {
  test('GET sobre coleccion no registrada -> 404', async () => {
    const ctx = await start();
    try {
      const r = await req(ctx.origin, 'GET', '/api/collections/nope/records');
      assert.equal(r.status, 404);
      assert.equal((await json(r)).error.code, 'NOT_FOUND');
    } finally { await ctx.close(); }
  });

  test('POST sobre coleccion no registrada -> 404', async () => {
    const ctx = await start();
    try {
      const r = await req(ctx.origin, 'POST', '/api/collections/nope/records', {
        body: { title: 'x' },
      });
      assert.equal(r.status, 404);
    } finally { await ctx.close(); }
  });
});

describe('records — rules deniegan una op -> 403 y NO persiste', () => {
  test('denegar create -> 403 y la coleccion queda vacia', async () => {
    const ctx = await start({ rules: makeRules({ denyOp: 'create' }) });
    try {
      const r = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { title: 'no-deberia-persistir' },
      });
      assert.equal(r.status, 403);
      assert.equal((await json(r)).error.code, 'FORBIDDEN');

      const list = await req(ctx.origin, 'GET', '/api/collections/posts/records');
      const lb = await json(list);
      assert.equal(lb.totalItems, 0);
      assert.equal(lb.items.length, 0);
    } finally { await ctx.close(); }
  });

  test('denegar delete -> 403 y el doc sigue existiendo', async () => {
    const ctx = await start({ rules: makeRules({ denyOp: 'delete' }) });
    try {
      const created = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { title: 'keep' },
      });
      const id = (await json(created))._id;

      const del = await req(ctx.origin, 'DELETE', `/api/collections/posts/records/${id}`);
      assert.equal(del.status, 403);

      const got = await req(ctx.origin, 'GET', `/api/collections/posts/records/${id}`);
      assert.equal(got.status, 200); // sigue existiendo
    } finally { await ctx.close(); }
  });
});

describe('records — events.emit', () => {
  test('create/update/delete emiten; list/view NO', async () => {
    const events = makeEvents();
    const ctx = await start({ events });
    try {
      const created = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { title: 'e', views: 1 },
      });
      const cdoc = await json(created);
      const id = cdoc._id;
      assert.equal(events.emits.length, 1);
      assert.deepEqual(events.emits[0], { collection: 'posts', op: 'create', record: cdoc });

      // view -> no emite
      await req(ctx.origin, 'GET', `/api/collections/posts/records/${id}`);
      assert.equal(events.emits.length, 1);

      const patched = await req(ctx.origin, 'PATCH', `/api/collections/posts/records/${id}`, {
        body: { views: 2 },
      });
      const pdoc = await json(patched);
      assert.equal(events.emits.length, 2);
      assert.deepEqual(events.emits[1], { collection: 'posts', op: 'update', record: pdoc });

      // list -> no emite
      await req(ctx.origin, 'GET', '/api/collections/posts/records');
      assert.equal(events.emits.length, 2);

      const del = await req(ctx.origin, 'DELETE', `/api/collections/posts/records/${id}`);
      const ddoc = await json(del);
      assert.equal(events.emits.length, 3);
      assert.equal(events.emits[2].collection, 'posts');
      assert.equal(events.emits[2].op, 'delete');
      assert.equal(events.emits[2].record._id, id);
    } finally { await ctx.close(); }
  });
});

describe('records — authResolver inyectado a rules.check', () => {
  test('rules.check recibe auth del resolver (Bearer u1 -> {id:"u1"})', async () => {
    const rules = makeRules();
    const ctx = await start({ rules });
    try {
      const r = await req(ctx.origin, 'POST', '/api/collections/posts/records', {
        body: { title: 'auth' },
        token: 'u1',
      });
      assert.equal(r.status, 201);
      assert.ok(rules.calls.length >= 1);
      const createCall = rules.calls.find((c) => c.op === 'create');
      assert.ok(createCall, 'debe haber una llamada op=create');
      assert.deepEqual(createCall.auth, { id: 'u1' });
      assert.equal(createCall.collection, 'posts');
      assert.equal(createCall.request.method, 'POST');
    } finally { await ctx.close(); }
  });

  test('sin token -> auth null llega a rules.check', async () => {
    const rules = makeRules();
    const ctx = await start({ rules });
    try {
      const r = await req(ctx.origin, 'GET', '/api/collections/posts/records');
      assert.equal(r.status, 200);
      const listCall = rules.calls.find((c) => c.op === 'list');
      assert.ok(listCall);
      assert.equal(listCall.auth, null);
    } finally { await ctx.close(); }
  });
});
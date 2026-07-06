'use strict';

// tests/auth-routes.test.js — tests congelados de las rutas de auth.
// Stack real: createApp (src/server.js) + createAuthService (src/auth-service.js)
// sobre DocStore + MemoryStorageAdapter del vendor. Sin mocks de crypto/JWT.
// Cliente: fetch global contra app.listen(0). Cada test levanta y CIERRA su
// propio server (finally) — los servidores SIEMPRE quedan cerrados.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DocStore, MemoryStorageAdapter } = require('../src/vendor/js-store/vendor/js-doc-store.js');
const { createApp } = require('../src/server.js');
const { createAuthService } = require('../src/auth-service.js');
const { registerAuthRoutes } = require('../src/auth-routes.js');

const SECRET = 'supersecret-key-0123456789-abcdef'; // >= 16 chars

// Levanta un server efimero con las rutas de auth registradas.
// Devuelve { base, auth, close }. base lista para fetch.
async function startServer() {
  const db = new DocStore(new MemoryStorageAdapter());
  const auth = await createAuthService({ db, secret: SECRET });
  const app = createApp();
  registerAuthRoutes(app, { auth });
  const server = await app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => app.close();
  return { base, auth, close };
}

// fetch + parse JSON. opts.body objeto -> se serializa como JSON.
async function jfetch(base, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + path, { ...opts, headers, body });
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: res.status, json };
}

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

// Email unico por test (el DocStore es fresh en cada startServer, pero el
// contador aporta robustez si un test reusa el server).
let emailSeq = 0;
function emailFor(prefix) {
  emailSeq += 1;
  return `${prefix}.${emailSeq}.${Date.now()}@test.com`;
}

describe('auth-routes — registro y login', () => {
  test('register -> 201 y user sin password/hash en el JSON', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('alice');
      const r = await jfetch(base, '/api/auth/register', {
        method: 'POST',
        body: { email, password: 'password123', profile: { name: 'Alice' } },
      });
      assert.equal(r.status, 201, `esperaba 201, vino ${r.status} ${JSON.stringify(r.json)}`);
      assert.ok(r.json && r.json.user, 'debe devolver { user }');
      assert.equal(r.json.user.email, email);
      assert.ok(!('passwordHash' in r.json.user), 'passwordHash no debe viajar');
      assert.ok(!('password' in r.json.user), 'password no debe viajar');
      assert.equal(r.json.user.name, 'Alice');
    } finally { await close(); }
  });

  test('register duplicado -> 409', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('bob');
      const first = await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      assert.equal(first.status, 201);
      const dup = await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      assert.equal(dup.status, 409, `esperaba 409, vino ${dup.status}`);
      assert.equal(dup.json.error.code, 'EMAIL_TAKEN');
    } finally { await close(); }
  });

  test('login ok -> token utilizable (me con ese token devuelve user)', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('carol');
      await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const r = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'password123' },
      });
      assert.equal(r.status, 200, `esperaba 200, vino ${r.status}`);
      assert.ok(r.json.token, 'debe devolver token');
      assert.ok(r.json.user && !('passwordHash' in r.json.user), 'user sin hash');
      // el token es utilizable: /me lo acepta
      const me = await jfetch(base, '/api/auth/me', { headers: authHeader(r.json.token) });
      assert.equal(me.status, 200);
      assert.equal(me.json.user.email, email);
    } finally { await close(); }
  });

  test('login password malo -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('dave');
      await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const r = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'wrongpass99' },
      });
      assert.equal(r.status, 401, `esperaba 401, vino ${r.status}`);
      assert.equal(r.json.error.code, 'INVALID_CREDENTIALS');
    } finally { await close(); }
  });
});

describe('auth-routes — me y token', () => {
  test('me con token valido -> user', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('erin');
      await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const login = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const me = await jfetch(base, '/api/auth/me', { headers: authHeader(login.json.token) });
      assert.equal(me.status, 200);
      assert.equal(me.json.user.email, email);
      assert.ok(!('passwordHash' in me.json.user));
    } finally { await close(); }
  });

  test('me sin token -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const me = await jfetch(base, '/api/auth/me');
      assert.equal(me.status, 401, `esperaba 401, vino ${me.status}`);
      assert.equal(me.json.error.code, 'INVALID_TOKEN');
    } finally { await close(); }
  });

  test('me con token basura -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const me = await jfetch(base, '/api/auth/me', { headers: authHeader('garbage.token.value') });
      assert.equal(me.status, 401, `esperaba 401, vino ${me.status}`);
      assert.equal(me.json.error.code, 'INVALID_TOKEN');
    } finally { await close(); }
  });
});

describe('auth-routes — logout', () => {
  test('logout -> ok y el MISMO token en me posterior -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('frank');
      await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const login = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const token = login.json.token;

      const out = await jfetch(base, '/api/auth/logout', { method: 'POST', headers: authHeader(token) });
      assert.equal(out.status, 200, `esperaba 200, vino ${out.status}`);
      assert.deepEqual(out.json, { ok: true });

      const me = await jfetch(base, '/api/auth/me', { headers: authHeader(token) });
      assert.equal(me.status, 401, 'el mismo token debe estar invalidado tras logout');
      assert.equal(me.json.error.code, 'INVALID_TOKEN');
    } finally { await close(); }
  });

  test('logout sin token -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const out = await jfetch(base, '/api/auth/logout', { method: 'POST' });
      assert.equal(out.status, 401);
      assert.equal(out.json.error.code, 'INVALID_TOKEN');
    } finally { await close(); }
  });
});

describe('auth-routes — change-password', () => {
  test('change-password ok; login con nuevo funciona y con el viejo -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('grace');
      await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const login = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const token = login.json.token;

      const ch = await jfetch(base, '/api/auth/change-password', {
        method: 'POST',
        headers: authHeader(token),
        body: { oldPassword: 'password123', newPassword: 'newpassword456' },
      });
      assert.equal(ch.status, 200, `esperaba 200, vino ${ch.status} ${JSON.stringify(ch.json)}`);
      assert.deepEqual(ch.json, { ok: true });

      // login con el nuevo password funciona
      const newLogin = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'newpassword456' },
      });
      assert.equal(newLogin.status, 200, 'login con nuevo password debe funcionar');
      assert.ok(newLogin.json.token);

      // login con el viejo password -> 401
      const oldLogin = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'password123' },
      });
      assert.equal(oldLogin.status, 401, 'login con viejo password debe fallar');
      assert.equal(oldLogin.json.error.code, 'INVALID_CREDENTIALS');
    } finally { await close(); }
  });

  test('change-password sin token -> 401', async () => {
    const { base, close } = await startServer();
    try {
      const ch = await jfetch(base, '/api/auth/change-password', {
        method: 'POST',
        body: { oldPassword: 'password123', newPassword: 'newpassword456' },
      });
      assert.equal(ch.status, 401);
      assert.equal(ch.json.error.code, 'INVALID_TOKEN');
    } finally { await close(); }
  });

  test('change-password con token pero body sin campos -> 400', async () => {
    const { base, close } = await startServer();
    try {
      const email = emailFor('heidi');
      await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const login = await jfetch(base, '/api/auth/login', {
        method: 'POST', body: { email, password: 'password123' },
      });
      const ch = await jfetch(base, '/api/auth/change-password', {
        method: 'POST',
        headers: authHeader(login.json.token),
        body: {},
      });
      assert.equal(ch.status, 400);
      assert.equal(ch.json.error.code, 'VALIDATION');
    } finally { await close(); }
  });
});

describe('auth-routes — validacion de shape del body', () => {
  test('register sin campos requeridos -> 400', async () => {
    const { base, close } = await startServer();
    try {
      const r = await jfetch(base, '/api/auth/register', { method: 'POST', body: {} });
      assert.equal(r.status, 400, `esperaba 400, vino ${r.status}`);
      assert.equal(r.json.error.code, 'VALIDATION');
    } finally { await close(); }
  });

  test('register con email/password no-string -> 400', async () => {
    const { base, close } = await startServer();
    try {
      const r = await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email: 123, password: 'password123' },
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'VALIDATION');
    } finally { await close(); }
  });

  test('login sin campos requeridos -> 400', async () => {
    const { base, close } = await startServer();
    try {
      const r = await jfetch(base, '/api/auth/login', { method: 'POST', body: {} });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'VALIDATION');
    } finally { await close(); }
  });

  test('register password debil -> 400 (WEAK_PASSWORD del service)', async () => {
    const { base, close } = await startServer();
    try {
      const r = await jfetch(base, '/api/auth/register', {
        method: 'POST', body: { email: emailFor('ivan'), password: '123' },
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'WEAK_PASSWORD');
    } finally { await close(); }
  });
});

describe('auth-routes — servers siempre cerrados', () => {
  test('close() detiene el listen (conexion rechazada tras close)', async () => {
    const { base, close } = await startServer();
    await close();
    // Tras close, una nueva peticion debe fallar (conexion rechazida).
    let threw = false;
    try {
      await jfetch(base, '/api/auth/me');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'fetch tras close() debe fallar (server cerrado)');
  });
});
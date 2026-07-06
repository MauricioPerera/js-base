'use strict';

// tests/files-auth.test.js — fija el fix del hallazgo de auditoría: la
// escritura/borrado de '_files' EXIGE usuario autenticado; la lectura sigue
// pública. Usa createServer real (src/app.js) sobre un tempdir, fetch real y
// cierra el server en finally. Sin handles/timers huérfanos.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../src/app.js');

// --- Helpers ----------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsbase-filesauth-'));
}

function rimraf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

async function start() {
  const dataDir = tempDir();
  const ctx = await createServer({ dataDir, secret: 'files-auth-test-secret-16' });
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

async function req(origin, method, url, { body, token, headers: extra } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (extra) Object.assign(headers, extra);
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

// POST binario (crudo, no JSON). Authorization opcional vía `token`.
async function postBinary(origin, name, payload, { token, contentType } = {}) {
  const headers = { 'content-type': contentType || 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${origin}/api/files/${name}`, { method: 'POST', headers, body: payload });
}

// Registra+loguea un usuario y devuelve su token.
async function getToken(origin) {
  const email = `filesauth-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  await req(origin, 'POST', '/api/auth/register', {
    body: { email, password: 'password123' },
  });
  const login = await req(origin, 'POST', '/api/auth/login', {
    body: { email, password: 'password123' },
  });
  const { token } = await json(login);
  return token;
}

const BLOB = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0xaa, 0x55, 0xc3, 0x28]);

// --- Tests ------------------------------------------------------------------

test('(a) POST /api/files/x.bin SIN Authorization -> 403 y no se escribe', async () => {
  const env = await start();
  try {
    const up = await postBinary(env.origin, 'x.bin', BLOB, { contentType: 'image/png' });
    assert.equal(up.status, 403);
    const body = await json(up);
    assert.equal(body.error.code, 'FORBIDDEN');

    // El archivo NO se escribió: el GET posterior da 404.
    const down = await fetch(`${env.origin}/api/files/x.bin`);
    assert.equal(down.status, 404);
  } finally { await env.close(); }
});

test('(b) DELETE /api/files/x.bin SIN Authorization -> 403', async () => {
  const env = await start();
  try {
    const del = await fetch(`${env.origin}/api/files/x.bin`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    const body = await json(del);
    assert.equal(body.error.code, 'FORBIDDEN');
  } finally { await env.close(); }
});

test('(c) POST con Bearer de usuario logueado -> 200 y { name, size, contentType }', async () => {
  const env = await start();
  try {
    const token = await getToken(env.origin);
    const up = await postBinary(env.origin, 'x.bin', BLOB, {
      token,
      contentType: 'image/png',
    });
    assert.equal(up.status, 200);
    const upJson = await json(up);
    assert.equal(upJson.name, 'x.bin');
    assert.equal(upJson.size, BLOB.length);
    assert.equal(upJson.contentType, 'image/png');
  } finally { await env.close(); }
});

test('(d) GET /api/files/x.bin SIN token tras subida autenticada -> 200 byte-identico', async () => {
  const env = await start();
  try {
    const token = await getToken(env.origin);
    await postBinary(env.origin, 'x.bin', BLOB, { token, contentType: 'image/png' });

    // Lectura pública: GET SIN token -> 200 byte-identico.
    const down = await fetch(`${env.origin}/api/files/x.bin`);
    assert.equal(down.status, 200);
    const buf = Buffer.from(await down.arrayBuffer());
    assert.equal(buf.length, BLOB.length);
    assert.deepEqual(buf, BLOB);
  } finally { await env.close(); }
});

test('(e) DELETE con Bearer -> ok y GET posterior 404', async () => {
  const env = await start();
  try {
    const token = await getToken(env.origin);
    await postBinary(env.origin, 'x.bin', BLOB, { token, contentType: 'image/png' });

    const del = await fetch(`${env.origin}/api/files/x.bin`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(del.status, 200);
    const delJson = await json(del);
    assert.equal(delJson.ok, true);

    const down = await fetch(`${env.origin}/api/files/x.bin`);
    assert.equal(down.status, 404);
  } finally { await env.close(); }
});
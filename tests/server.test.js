'use strict';

// tests/server.test.js — tests congelados del nucleo HTTP (createApp).
// Usa listen(0) + fetch global de Node. CIERRA el server SIEMPRE (finally/after).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server.js');

const ONE_MIB = 1024 * 1024;

// Inicia un app en puerto efimero y devuelve { app, origin, close }.
async function start(opts, register) {
  const app = createApp(opts);
  if (register) register(app);
  const server = await app.listen(0);
  const port = server.address().port;
  return { app, server, origin: `http://127.0.0.1:${port}`, close: () => app.close() };
}

// Igual que start pero recibe una app ya construida (para casos custom).
async function startApp(app) {
  const server = await app.listen(0);
  const port = server.address().port;
  return { app, server, origin: `http://127.0.0.1:${port}`, close: () => app.close() };
}

describe('server — happy path y ruteo', () => {
  test('GET ruta ok -> 200 y JSON correcto', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/ping', (c) => ({ pong: true, id: c.params }));
    });
    try {
      const res = await fetch(`${ctx.origin}/ping`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const body = await res.json();
      assert.deepEqual(body, { pong: true, id: {} });
    } finally { await ctx.close(); }
  });

  test('404 en ruta desconocida -> JSON con error', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/ping', () => ({ ok: true }));
    });
    try {
      const res = await fetch(`${ctx.origin}/no-existe`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, 'NOT_FOUND');
    } finally { await ctx.close(); }
  });

  test('params llegan al handler via ctx.params', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/u/:id', (c) => ({ id: c.params.id }));
    });
    try {
      const res = await fetch(`${ctx.origin}/u/77`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { id: '77' });
    } finally { await ctx.close(); }
  });

  test('query llega al handler como objeto plano', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/q', (c) => ({ q: c.query }));
    });
    try {
      const res = await fetch(`${ctx.origin}/q?a=1&b=two`);
      assert.deepEqual(await res.json(), { q: { a: '1', b: 'two' } });
    } finally { await ctx.close(); }
  });

  test('handler que setea ctx.status devuelve ese 2xx', async () => {
    const ctx = await start({}, (app) => {
      app.route('POST', '/c', (c) => { c.status = 201; return { created: true }; });
    });
    try {
      const res = await fetch(`${ctx.origin}/c`, { method: 'POST' });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { created: true });
    } finally { await ctx.close(); }
  });
});

describe('server — body JSON', () => {
  test('POST JSON -> handler recibe body', async () => {
    const ctx = await start({}, (app) => {
      app.route('POST', '/echo', (c) => ({ got: c.body }));
    });
    try {
      const res = await fetch(`${ctx.origin}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world', n: 3 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { got: { hello: 'world', n: 3 } });
    } finally { await ctx.close(); }
  });

  test('JSON invalido -> 400', async () => {
    const ctx = await start({}, (app) => {
      app.route('POST', '/echo', (c) => ({ got: c.body }));
    });
    try {
      const res = await fetch(`${ctx.origin}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'esto no es json {',
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'INVALID_JSON');
    } finally { await ctx.close(); }
  });

  test('body > 1 MiB -> 413', async () => {
    const ctx = await start({}, (app) => {
      app.route('POST', '/big', (c) => ({ ok: true }));
    });
    try {
      const big = '{"x":"' + 'a'.repeat(ONE_MIB + 1024) + '"}';
      const res = await fetch(`${ctx.origin}/big`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      });
      assert.equal(res.status, 413);
      const body = await res.json();
      assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
    } finally { await ctx.close(); }
  });

  test('POST sin body -> handler recibe body undefined', async () => {
    const ctx = await start({}, (app) => {
      app.route('POST', '/nb', (c) => ({ hasBody: c.body !== undefined }));
    });
    try {
      const res = await fetch(`${ctx.origin}/nb`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { hasBody: false });
    } finally { await ctx.close(); }
  });
});

describe('server — errores tipados', () => {
  test('handler lanza {code:"FORBIDDEN"} -> 403 con { error: { code } }', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/f', () => { const e = new Error('no puedes'); e.code = 'FORBIDDEN'; throw e; });
    });
    try {
      const res = await fetch(`${ctx.origin}/f`);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error.code, 'FORBIDDEN');
      assert.equal(body.error.message, 'no puedes');
    } finally { await ctx.close(); }
  });

  test('handler lanza Error comun -> 500 con code INTERNAL y SIN el mensaje interno', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/boom', () => { throw new Error('secreto interno: token=XYZ'); });
    });
    try {
      const res = await fetch(`${ctx.origin}/boom`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error.code, 'INTERNAL');
      assert.equal(body.error.message, 'internal error');
      assert.ok(!JSON.stringify(body).includes('secreto interno'), 'no filtra el mensaje interno');
    } finally { await ctx.close(); }
  });

  test('mapeo de codes a status: EMAIL_TAKEN=409, INVALID_CREDENTIALS=401, NOT_FOUND=404, WEAK_PASSWORD=400, VALIDATION=400', async () => {
    const cases = [
      ['EMAIL_TAKEN', 409],
      ['INVALID_CREDENTIALS', 401],
      ['INVALID_TOKEN', 401],
      ['WEAK_PASSWORD', 400],
      ['NOT_FOUND', 404],
      ['VALIDATION', 400],
    ];
    for (const [code, status] of cases) {
      const ctx = await start({}, (app) => {
        app.route('GET', '/x', () => { const e = new Error(code); e.code = code; throw e; });
      });
      try {
        const res = await fetch(`${ctx.origin}/x`);
        assert.equal(res.status, status, `${code} -> ${status}`);
        assert.equal((await res.json()).error.code, code);
      } finally { await ctx.close(); }
    }
  });
});

describe('server — CORS y token', () => {
  test('OPTIONS preflight -> 204 con headers CORS', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/x', () => ({ ok: true }));
    });
    try {
      const res = await fetch(`${ctx.origin}/x`, { method: 'OPTIONS' });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.ok(res.headers.get('access-control-allow-methods').includes('GET'));
      assert.ok(res.headers.get('access-control-allow-headers').includes('Authorization'));
    } finally { await ctx.close(); }
  });

  test('toda respuesta incluye Access-Control-Allow-Origin: *', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/x', () => ({ ok: true }));
    });
    try {
      const res = await fetch(`${ctx.origin}/x`);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      // tambien en el 404:
      const r404 = await fetch(`${ctx.origin}/missing`);
      assert.equal(r404.headers.get('access-control-allow-origin'), '*');
    } finally { await ctx.close(); }
  });

  test('Authorization "Bearer abc" -> ctx.token === "abc"', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/t', (c) => ({ token: c.token }));
    });
    try {
      const res = await fetch(`${ctx.origin}/t`, { headers: { authorization: 'Bearer abc' } });
      assert.deepEqual(await res.json(), { token: 'abc' });
    } finally { await ctx.close(); }
  });

  test('sin Authorization -> ctx.token === null', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/t', (c) => ({ token: c.token }));
    });
    try {
      const res = await fetch(`${ctx.origin}/t`);
      assert.deepEqual(await res.json(), { token: null });
    } finally { await ctx.close(); }
  });
});

describe('server — rules inyectadas (el nucleo NO las llama automaticamente)', () => {
  test('app.rules es el objeto inyectado (no el default)', async () => {
    const injected = { check: () => ({ allow: false }) };
    const app = createApp({ rules: injected });
    assert.equal(app.rules, injected);
  });

  test('rules.check NO corta nada por si solo; un handler puede usarlo para devolver 403', async () => {
    const injected = { async check() { return { allow: false }; } };
    const ctx = await startApp(createApp({ rules: injected }));
    ctx.app.route('GET', '/secret', async (c) => {
      const r = await ctx.app.rules.check(c);
      if (!r.allow) { const e = new Error('forbidden'); e.code = 'FORBIDDEN'; throw e; }
      return { ok: true };
    });
    try {
      const res = await fetch(`${ctx.origin}/secret`);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, 'FORBIDDEN');
    } finally { await ctx.close(); }
  });

  test('rules default permite y un handler puede continuar', async () => {
    const ctx = await start({}, (app) => {
      app.route('GET', '/ok', async (c) => {
        const r = await app.rules.check(c);
        if (!r.allow) { const e = new Error('forbidden'); e.code = 'FORBIDDEN'; throw e; }
        return { ok: true };
      });
    });
    try {
      const res = await fetch(`${ctx.origin}/ok`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    } finally { await ctx.close(); }
  });
});

describe('server — ciclo de vida', () => {
  test('app.close() resuelve y deja de escuchar', async () => {
    const app = createApp({});
    app.route('GET', '/x', () => ({ ok: true }));
    const server = await app.listen(0);
    const port = server.address().port;
    assert.ok(port > 0);
    await app.close();
    // Tras close, una peticion nueva falla (conexion rechazada).
    let connected = true;
    try {
      await fetch(`http://127.0.0.1:${port}/x`);
    } catch { connected = false; }
    assert.equal(connected, false, 'el server ya no escucha tras close()');
  });

  test('app.close() sin server previo resuelve igual', async () => {
    const app = createApp({});
    await app.close();
  });
});
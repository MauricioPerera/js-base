'use strict';

// tests/files.test.js — cubre src/files.js contra el nucleo real (createApp)
// + fetch real + tempdir (mkdtempSync) limpiado al final. Cero dependencias.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../src/server.js');
const { registerFileRoutes } = require('../src/files.js');

// --- Helpers ----------------------------------------------------------------

function makeApp({ dir, authResolver, maxBytes, rules } = {}) {
  const app = createApp({ rules });
  registerFileRoutes(app, { dir, authResolver, maxBytes });
  return app;
}

async function start(app) {
  return app.listen(0); // listen(port) -> Promise<http.Server>
}

function baseUrl(server) {
  return 'http://127.0.0.1:' + server.address().port;
}

async function readBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function listDir(dir) {
  return fs.readdirSync(dir).sort();
}

// --- Setup/teardown por test ------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsbase-files-'));
}

async function withApp(opts, fn) {
  const dir = tempDir();
  const app = makeApp({ dir, ...opts });
  const server = await start(app);
  const base = baseUrl(server);
  try {
    await fn({ base, dir, app });
  } finally {
    await app.close();
    // Limpieza total del tempdir.
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    try { fs.rmdirSync(dir); } catch {}
  }
}

// --- Tests ------------------------------------------------------------------

test('upload binario + download byte-identico con Content-Type preservado', async () => {
  await withApp({}, async ({ base, dir }) => {
    // Bytes no-UTF8 (0x00..0xFF) para forzar binario real.
    const payload = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0xaa, 0x55, 0x80, 0xc3]);
    const res = await fetch(base + '/api/files/blob.bin', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: payload,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.name, 'blob.bin');
    assert.equal(json.size, payload.length);
    assert.equal(json.contentType, 'image/png');

    // GET -> byte identico y content-type preservado.
    const get = await fetch(base + '/api/files/blob.bin');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/png');
    assert.equal(get.headers.get('content-length'), String(payload.length));
    const back = await readBody(get);
    assert.deepEqual(back, payload);

    // Sidecar presente en disco.
    const files = listDir(dir);
    assert.ok(files.includes('blob.bin'));
    assert.ok(files.includes('blob.bin.meta.json'));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'blob.bin.meta.json'), 'utf8'));
    assert.equal(meta.contentType, 'image/png');
    assert.equal(meta.size, payload.length);
    assert.equal(meta.uploadedBy, null);
  });
});

test('upload que excede maxBytes -> 413 y NO queda archivo ni temp residual', async () => {
  await withApp({ maxBytes: 1024 }, async ({ base, dir }) => {
    const before = listDir(dir);
    const payload = Buffer.alloc(2048, 0xab); // 2KB > 1KB
    const res = await fetch(base + '/api/files/big.dat', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.code, 'PAYLOAD_TOO_LARGE');
    // El dir queda exactamente como estaba: sin archivo ni temp.
    assert.deepEqual(listDir(dir), before);
  });
});

test('PATH TRAVERSAL: nombres que alcanzan el handler -> 400 y dir sin archivos nuevos', async () => {
  await withApp({}, async ({ base, dir }) => {
    // Nombres que el router entrega como un solo segmento al handler (no son
    // dot-segments colapsables por la capa URL) y que el validador debe rechazar.
    //   a..b        -> regex ok pero contiene ".."  (ejercita el branch includes('..'))
    //   .sec        -> primer char '.' -> regex fail
    //   x.meta.json -> sufijo reservado .meta.json
    //   x.tmp       -> sufijo reservado .tmp
    //   a%2F..%2Fb  -> barras codificadas: llega como UN segmento con ".." real
    //                  (ejercita includes('..') + isInside sobre un name traversal entregado)
    const bad = ['a..b', '.sec', 'x.meta.json', 'x.tmp', 'a%2F..%2Fb'];
    for (const name of bad) {
      const before = listDir(dir);
      // POST
      const res = await fetch(base + '/api/files/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([1, 2, 3]),
      });
      assert.equal(res.status, 400, 'POST ' + name);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION', 'POST ' + name);
      assert.deepEqual(listDir(dir), before, 'POST ' + name + ' no debe crear archivos');
      // GET
      const g = await fetch(base + '/api/files/' + name);
      assert.equal(g.status, 400, 'GET ' + name);
      assert.deepEqual(listDir(dir), before, 'GET ' + name + ' no debe crear archivos');
      // DELETE
      const d = await fetch(base + '/api/files/' + name, { method: 'DELETE' });
      assert.equal(d.status, 400, 'DELETE ' + name);
      assert.deepEqual(listDir(dir), before, 'DELETE ' + name + ' no debe crear archivos');
    }
  });
});

test('PATH TRAVERSAL: ".." y "../x" literales se colapsan en la capa URL -> 404 y dir limpio', async () => {
  // La capa URL (fetch + new URL del nucleo) normaliza los dot-segments ".." ANTES
  // del router: "/api/files/.." -> "/api/" y "/api/files/../x" -> "/api/x". Esas
  // rutas no matchean "/api/files/:name" -> 404 (rechazo seguro, sin tocar FS).
  await withApp({}, async ({ base, dir }) => {
    const bad = ['..', '../x'];
    for (const name of bad) {
      const before = listDir(dir);
      const res = await fetch(base + '/api/files/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([1, 2, 3]),
      });
      // 404 (capa URL) o 400 (si llegara al validador): ambos son 4xx seguros.
      assert.ok(res.status === 404 || res.status === 400, 'POST ' + name + ' -> ' + res.status);
      assert.deepEqual(listDir(dir), before, name + ' no debe crear archivos');
    }
  });
});

test('PATH TRAVERSAL: "a/../b" se colapsa a "b" (dentro de dir, sin escape)', async () => {
  // La capa URL colapsa "a/../b" -> "b" antes del handler; "b" es un nombre valido
  // y vive DENTRO de dir. No hay escape: isInside(path.resolve(dir,"b")) es true y
  // path.resolve(dir, "b") nunca sale de dir. La forma codificada a%2F..%2Fb (la
  // que SI entrega un name traversal al handler) se rechaza con 400 en el test
  // anterior. Aqui verificamos contencion: un GET no crea artefactos.
  await withApp({}, async ({ base, dir }) => {
    const before = listDir(dir);
    const res = await fetch(base + '/api/files/a/../b');
    assert.equal(res.status, 404); // "b" no existe -> 404, sin tocar FS
    assert.deepEqual(listDir(dir), before);
  });
});

test('delete -> ok; GET posterior 404 y sidecar borrado', async () => {
  await withApp({}, async ({ base, dir }) => {
    const payload = Buffer.from([10, 20, 30, 40]);
    await fetch(base + '/api/files/del.bin', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    assert.ok(listDir(dir).includes('del.bin'));
    assert.ok(listDir(dir).includes('del.bin.meta.json'));

    const del = await fetch(base + '/api/files/del.bin', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });

    const after = listDir(dir);
    assert.ok(!after.includes('del.bin'));
    assert.ok(!after.includes('del.bin.meta.json'));

    const get = await fetch(base + '/api/files/del.bin');
    assert.equal(get.status, 404);
  });
});

test('DELETE de archivo inexistente -> 404', async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(base + '/api/files/missing.dat', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

test('GET de archivo inexistente -> 404', async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(base + '/api/files/missing.dat');
    assert.equal(res.status, 404);
  });
});

test('rules deniegan create -> 403 y no se escribe nada', async () => {
  const rules = {
    async check(ctx) {
      if (ctx.op === 'create') return { allow: false };
      return { allow: true };
    },
  };
  await withApp({ rules }, async ({ base, dir }) => {
    const before = listDir(dir);
    const res = await fetch(base + '/api/files/forbidden.bin', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3, 4]),
    });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error.code, 'FORBIDDEN');
    assert.deepEqual(listDir(dir), before);
  });
});

test('sobreescritura de name existente reemplaza contenido atomico', async () => {
  await withApp({}, async ({ base, dir }) => {
    const first = Buffer.alloc(8, 0x11);
    const second = Buffer.alloc(8, 0x22);
    await fetch(base + '/api/files/over.bin', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: first,
    });
    const res2 = await fetch(base + '/api/files/over.bin', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: second,
    });
    assert.equal(res2.status, 200);
    const get = await fetch(base + '/api/files/over.bin');
    const back = await readBody(get);
    assert.deepEqual(back, second);
    // Un solo archivo de datos + su sidecar (no acumula temps).
    const files = listDir(dir);
    const temps = files.filter((f) => f.endsWith('.tmp'));
    assert.equal(temps.length, 0);
    assert.ok(files.includes('over.bin'));
    assert.ok(files.includes('over.bin.meta.json'));
  });
});

test('authResolver inyectado: uploadedBy queda en el sidecar', async () => {
  const authResolver = async (token) => (token === 'tok123' ? { id: 'user-42' } : null);
  await withApp({ authResolver }, async ({ base, dir }) => {
    const payload = Buffer.from([5, 6, 7]);
    const res = await fetch(base + '/api/files/auth.bin', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer tok123' },
      body: payload,
    });
    assert.equal(res.status, 200);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'auth.bin.meta.json'), 'utf8'));
    assert.equal(meta.uploadedBy, 'user-42');
  });
});

test('dir se crea recursivo si falta', async () => {
  const root = tempDir();
  const nested = path.join(root, 'a', 'b', 'c');
  try {
    await withApp({ dir: nested }, async ({ base }) => {
      assert.ok(fs.existsSync(nested));
      const res = await fetch(base + '/api/files/x.bin', {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1]),
      });
      assert.equal(res.status, 200);
    });
  } finally {
    // limpieza recursiva
    for (const f of fs.readdirSync(root)) {
      try { fs.rmSync(path.join(root, f), { recursive: true, force: true }); } catch {}
    }
    try { fs.rmdirSync(root); } catch {}
  }
});

test('GET sin sidecar (plantado a mano) cae a octet-stream', async () => {
  await withApp({}, async ({ base, dir }) => {
    fs.writeFileSync(path.join(dir, 'naked.bin'), Buffer.from([9, 9, 9]));
    const res = await fetch(base + '/api/files/naked.bin');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(await readBody(res), Buffer.from([9, 9, 9]));
  });
});
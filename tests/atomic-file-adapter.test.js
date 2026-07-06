// Tests congelados de AtomicFileStorageAdapter (B1-T3).
// Cubren: roundtrip write+read, sobreescritura, delete, listKeys sin temporales
// residuales tras N escrituras, DROP-IN real con un DocStore del vendor, y
// atomicidad ante fallo (monkey-patch de fs.renameSync). Usan tempdir con
// fs.mkdtempSync y limpian al final.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AtomicFileStorageAdapter } = require("../src/atomic-file-adapter.js");
// DocStore del vendor para la prueba de DROP-IN real.
const { DocStore } = require("../src/vendor/js-store/vendor/js-doc-store.js");

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "afa-"));
}

// Limpieza determinista: borra el tempdir recursivamente al final de cada
// bloque, sin importar si quedaron temps residuales.
function withDir(fn) {
  return async () => {
    const dir = mkdtemp();
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("write+read roundtrip", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  a.writeJson("users.docs.json", [{ _id: "u1", name: "Alice" }]);
  const read = a.readJson("users.docs.json");
  assert.deepEqual(read, [{ _id: "u1", name: "Alice" }]);
}));

test("readJson devuelve null si el archivo no existe", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  assert.equal(a.readJson("no-existe.json"), null);
}));

test("sobreescritura reemplaza el contenido completo", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  a.writeJson("f.json", { v: 1, extra: "keep" });
  a.writeJson("f.json", { v: 2 });
  const read = a.readJson("f.json");
  assert.deepEqual(read, { v: 2 });
  // El destino no debe quedar con mezcla de campos viejos y nuevos.
  assert.equal(read.extra, undefined);
}));

test("delete borra el archivo y readJson vuelve a null", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  a.writeJson("f.json", { x: 1 });
  a.delete("f.json");
  assert.equal(a.readJson("f.json"), null);
  // delete de un archivo inexistente no lanza.
  assert.doesNotThrow(() => a.delete("f.json"));
}));

test("listKeys no lista temporales residuales tras N escrituras", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  for (let i = 0; i < 5; i++) {
    a.writeJson(`c${i}.docs.json`, [{ _id: String(i), n: i }]);
    a.writeJson(`c${i}.meta.json`, { indexes: [] });
  }
  const keys = a.listKeys();
  // Sin temporales residuales tras escrituras exitosas.
  assert.equal(keys.filter((k) => k.endsWith(".tmp")).length, 0);
  // Estan los 10 archivos esperados.
  assert.equal(keys.length, 10);
  keys.sort();
  assert.deepEqual(keys, [
    "c0.docs.json", "c0.meta.json",
    "c1.docs.json", "c1.meta.json",
    "c2.docs.json", "c2.meta.json",
    "c3.docs.json", "c3.meta.json",
    "c4.docs.json", "c4.meta.json",
  ].sort());
}));

test("listKeys exclige un temp residual dejado a mano", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  a.writeJson("real.json", { ok: true });
  // Simula un temp residual de un crash previo.
  fs.writeFileSync(path.join(dir, "real.json.123.1.tmp"), "basura parcial");
  const keys = a.listKeys();
  assert.deepEqual(keys, ["real.json"]);
}));

test("constructor crea el dir recursivo si falta", () => {
  const base = mkdtemp();
  try {
    const nested = path.join(base, "a", "b", "c");
    assert.equal(fs.existsSync(nested), false);
    const a = new AtomicFileStorageAdapter(nested); // debe crearlo
    assert.equal(fs.existsSync(nested), true);
    a.writeJson("f.json", { ok: true });
    assert.deepEqual(a.readJson("f.json"), { ok: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("DROP-IN real: DocStore del vendor funciona con AtomicFileStorageAdapter", withDir((dir) => {
  const adapter = new AtomicFileStorageAdapter(dir);
  const db = new DocStore(adapter);
  const col = db.collection("things");
  const inserted = col.insert({ name: "foo", n: 42 });
  db.flush();

  // Un SEGUNDO DocStore sobre el mismo dir lee lo insertado tras flush.
  const db2 = new DocStore(new AtomicFileStorageAdapter(dir));
  const col2 = db2.collection("things");
  const found = col2.findById(inserted._id);
  assert.equal(found.name, "foo");
  assert.equal(found.n, 42);

  // listKeys del adapter subyacente no expone temps.
  const keys = db._adapter.listKeys();
  assert.equal(keys.filter((k) => k.endsWith(".tmp")).length, 0);
  assert.ok(keys.includes("things.docs.json"));
}));

test("ATOMICIDAD ante fallo: rename que lanza deja el destino intacto y parseable", withDir((dir) => {
  const a = new AtomicFileStorageAdapter(dir);
  // 1. Escritura base exitosa: destino = A.
  const A = { version: 1, payload: "estado-bueno" };
  a.writeJson("critico.json", A);
  assert.deepEqual(a.readJson("critico.json"), A);

  // 2. Monkey-patch de fs.renameSync para que lanze en UNA escritura.
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = function patched(...args) {
    calls += 1;
    if (calls === 1) throw new Error("simulated rename failure");
    return realRename.apply(this, args);
  };

  // 3. Escritura que falla en el rename: debe lanzar y NO tocar el destino.
  const B = { version: 2, payload: "estado-nuevo-mas-grande-xxxx" };
  assert.throws(() => a.writeJson("critico.json", B), /simulated rename failure/);

  // Restaurar el patch inmediatamente tras la escritura fallida.
  fs.renameSync = realRename;

  // 4. El destino conserva INTACTO el contenido anterior y sigue parseable.
  const afterFail = a.readJson("critico.json");
  assert.deepEqual(afterFail, A, "el destino no debe cambiar si el rename falla");
  assert.equal(afterFail.version, 1);

  // 5. La escritura siguiente (con el patch ya restaurado) funciona.
  const C = { version: 3, payload: "recuperado" };
  a.writeJson("critico.json", C);
  assert.deepEqual(a.readJson("critico.json"), C);

  // 6. listKeys no muestra el temp residual de la escritura fallida.
  const keys = a.listKeys();
  assert.equal(keys.filter((k) => k.endsWith(".tmp")).length, 0);
  assert.deepEqual(keys, ["critico.json"]);
}));
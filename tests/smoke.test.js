// Smoke tests congelados de js-base.
//
// Cubren la fachada de js-base (src/index.js) contra el vendor js-store, en sus dos
// modos: colección en memoria y colección en disco (persistencia real). Son la
// prueba de que el vendor funciona standalone a través de la fachada de js-base.
//
// Ejecutar: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { store } = require("../src/index.js");
const { SemanticCollection } = store;

test("memoria: upsert 3 docs, search devuelve el más cercano, find filtra por campo", () => {
  const c = new SemanticCollection({ dim: 3 });
  c.upsert("a", { kind: "x", label: "alpha" }, [1, 0, 0]);
  c.upsert("b", { kind: "x", label: "beta" }, [0, 1, 0]);
  c.upsert("c", { kind: "y", label: "gamma" }, [0, 0, 1]);

  // search: el vector de consulta cercano a [1,0,0] debe devolver "a" primero.
  const results = c.search([1, 0.01, 0], { limit: 1 });
  assert.ok(Array.isArray(results), "search debe devolver un array");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "a");

  // find: filtro exacto por campo devuelve un array correcto.
  const xs = c.find({ kind: "x" });
  assert.ok(Array.isArray(xs), "find debe devolver un array");
  assert.equal(xs.length, 2);
  const ids = xs.map((d) => d._id).sort();
  assert.deepEqual(ids, ["a", "b"]);

  c.close();
});

test("disco: persistencia real — upsert+close, reabrir con la misma path y verificar get/count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-base-smoke-"));
  try {
    const dbPath = path.join(dir, "db");

    const c = new SemanticCollection({ path: dbPath, dim: 3 });
    c.upsert("a", { n: 1 }, [1, 0, 0]);
    c.upsert("b", { n: 2 }, [0, 1, 0]);
    c.close();

    // Reabrir con la misma path: la persistencia debe ser real (no solo RAM).
    const c2 = new SemanticCollection({ path: dbPath, dim: 3 });
    assert.equal(c2.count(), 2, "count tras reabrir debe ser 2");
    const a = c2.get("a");
    assert.ok(a, "get('a') debe resolver tras reabrir");
    assert.equal(a.n, 1);
    const b = c2.get("b");
    assert.equal(b.n, 2);
    c2.close();
  } finally {
    // Limpia el tempdir siempre, incluso si el test falla.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
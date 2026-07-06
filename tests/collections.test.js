// Tests congelados del módulo src/collections.js.
//
// Usan MemoryStorageAdapter inyectado en un DocStore. Cubren: create/get/list,
// validación de config (nombre inválido/duplicado/tipo desconocido), update parcial
// preservando lo no tocado, remove, validateDoc (válido, required faltante, tipo
// incorrecto, campo extra permitido) y persistencia compartida (dos registros
// sobre el MISMO DocStore ven la misma config).
//
// Ejecutar: node --test tests/collections.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DocStore,
  MemoryStorageAdapter,
} = require("../src/vendor/js-store/vendor/js-doc-store.js");
const { CollectionRegistry } = require("../src/collections.js");

function makeRegistry() {
  const db = new DocStore(new MemoryStorageAdapter());
  return { db, reg: new CollectionRegistry(db) };
}

function validConfig(name = "users", extra = {}) {
  return {
    name,
    fields: [
      { name: "email", type: "string", required: true },
      { name: "age", type: "number" },
      { name: "active", type: "boolean" },
      { name: "tags", type: "array" },
      { name: "meta", type: "object" },
    ],
    rules: {
      list: null,
      view: null,
      create: { owner: "$$user.id" },
      update: null,
      delete: null,
    },
    vector: { dim: 3 },
    ...extra,
  };
}

// ── create + get/list ─────────────────────────────────────────────────────────

test("create válido: persiste y get devuelve la config", () => {
  const { reg } = makeRegistry();
  const cfg = validConfig("posts");
  const created = reg.create(cfg);
  assert.equal(created.name, "posts");
  assert.deepEqual(created.fields, cfg.fields);
  assert.deepEqual(created.rules, cfg.rules);
  assert.deepEqual(created.vector, cfg.vector);

  const got = reg.get("posts");
  assert.equal(got.name, "posts");
  assert.deepEqual(got.fields, cfg.fields);
});

test("get de colección inexistente devuelve null", () => {
  const { reg } = makeRegistry();
  assert.equal(reg.get("nope"), null);
});

test("list devuelve todas las colecciones registradas", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("a"));
  reg.create(validConfig("b"));
  reg.create(validConfig("c"));
  const names = reg.list().map((c) => c.name).sort();
  assert.deepEqual(names, ["a", "b", "c"]);
});

test("list en registro vacío devuelve []", () => {
  const { reg } = makeRegistry();
  assert.deepEqual(reg.list(), []);
});

// ── validación de config en create ───────────────────────────────────────────

test("create con nombre inválido lanza", () => {
  const { reg } = makeRegistry();
  assert.throws(() => reg.create(validConfig("Users")), /Config inválida/);
  assert.throws(() => reg.create(validConfig("_priv")), /Config inválida/);
  assert.throws(() => reg.create(validConfig("1bad")), /Config inválida/);
  assert.throws(() => reg.create(validConfig("con-guion")), /Config inválida/);
  assert.throws(
    () => reg.create(validConfig("a".repeat(51))),
    /Config inválida/
  );
});

test("create con nombre duplicado lanza", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("dup"));
  assert.throws(() => reg.create(validConfig("dup")), /Ya existe/);
});

test("create con tipo de campo desconocido lanza", () => {
  const { reg } = makeRegistry();
  const cfg = validConfig("weird");
  cfg.fields = [{ name: "x", type: "magic" }];
  assert.throws(() => reg.create(cfg), /Config inválida/);
});

test("create con rules no objeto lanza", () => {
  const { reg } = makeRegistry();
  const cfg = validConfig("badrules");
  cfg.rules = "nope";
  assert.throws(() => reg.create(cfg), /Config inválida/);
});

test("create con vector inválido lanza", () => {
  const { reg } = makeRegistry();
  assert.throws(
    () => reg.create(validConfig("v1", { vector: { dim: 0 } })),
    /Config inválida/
  );
  assert.throws(
    () => reg.create(validConfig("v2", { vector: { dim: 1.5 } })),
    /Config inválida/
  );
});

test("create con vector null es válido", () => {
  const { reg } = makeRegistry();
  const cfg = validConfig("novector", { vector: null });
  const created = reg.create(cfg);
  assert.equal(created.vector, null);
});

// ── update parcial ────────────────────────────────────────────────────────────

test("update parcial preserva lo no tocado", () => {
  const { reg } = makeRegistry();
  const cfg = validConfig("items");
  reg.create(cfg);

  const updated = reg.update("items", {
    fields: [{ name: "title", type: "string", required: true }],
  });

  assert.deepEqual(updated.fields, [
    { name: "title", type: "string", required: true },
  ]);
  // No tocado: rules y vector se preservan.
  assert.deepEqual(updated.rules, cfg.rules);
  assert.deepEqual(updated.vector, cfg.vector);
  assert.equal(updated.name, "items");
});

test("update revalida la config resultante y lanza si queda inválida", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("things"));
  assert.throws(
    () => reg.update("things", { fields: [{ name: "x", type: "magic" }] }),
    /Config inválida/
  );
  // El original queda intacto tras un update fallido.
  const current = reg.get("things");
  assert.deepEqual(current.fields, validConfig("things").fields);
});

test("update de colección inexistente lanza", () => {
  const { reg } = makeRegistry();
  assert.throws(() => reg.update("ghost", { vector: null }), /No existe/);
});

test("update de vector lo reemplaza wholesale", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("vec", { vector: { dim: 3 } }));
  const updated = reg.update("vec", { vector: { dim: 8 } });
  assert.deepEqual(updated.vector, { dim: 8 });
});

// ── remove ───────────────────────────────────────────────────────────────────

test("remove devuelve true y borra; false si no existe", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("gone"));
  assert.equal(reg.remove("gone"), true);
  assert.equal(reg.get("gone"), null);
  assert.equal(reg.remove("gone"), false);
  assert.equal(reg.remove("never"), false);
});

// ── validateDoc ──────────────────────────────────────────────────────────────

test("validateDoc: doc válido => ok", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("docs"));
  const r = reg.validateDoc("docs", {
    email: "a@b.com",
    age: 30,
    active: true,
    tags: ["x"],
    meta: { k: 1 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateDoc: required faltante => error", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("docs"));
  const r = reg.validateDoc("docs", { age: 30 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("email") && e.includes("requerido")));
});

test("validateDoc: tipo incorrecto => error", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("docs"));
  const r = reg.validateDoc("docs", { email: "a@b.com", age: "treinta" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("age")));
});

test("validateDoc: campo extra permitido", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("docs"));
  const r = reg.validateDoc("docs", {
    email: "a@b.com",
    extra: "cualquier cosa",
    otro: 999,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateDoc: campo opcional ausente no da error", () => {
  const { reg } = makeRegistry();
  reg.create(validConfig("docs"));
  const r = reg.validateDoc("docs", { email: "a@b.com" });
  assert.equal(r.ok, true);
});

test("validateDoc: colección inexistente lanza", () => {
  const { reg } = makeRegistry();
  assert.throws(() => reg.validateDoc("ghost", { x: 1 }), /No existe/);
});

test("validateDoc: cada tipo se valida correctamente", () => {
  const { reg } = makeRegistry();
  reg.create({
    name: "types",
    fields: [
      { name: "s", type: "string" },
      { name: "n", type: "number" },
      { name: "b", type: "boolean" },
      { name: "o", type: "object" },
      { name: "a", type: "array" },
    ],
    rules: { list: null, view: null, create: null, update: null, delete: null },
    vector: null,
  });

  // array no es object, null no es object, object no es array.
  const bad = reg.validateDoc("types", {
    s: 1, // número en string
    n: NaN, // NaN no es number válido
    b: "true", // string en boolean
    o: [1, 2], // array en object
    a: { x: 1 }, // object en array
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 5, "los 5 tipos deben fallar");
});

// ── persistencia compartida ──────────────────────────────────────────────────

test("persistencia: dos CollectionRegistry sobre el MISMO DocStore ven la misma config", () => {
  const db = new DocStore(new MemoryStorageAdapter());
  const regA = new CollectionRegistry(db);
  const regB = new CollectionRegistry(db);

  regA.create(validConfig("shared"));
  assert.equal(regB.get("shared").name, "shared");
  assert.deepEqual(regB.get("shared").fields, validConfig("shared").fields);

  regB.update("shared", { vector: { dim: 5 } });
  assert.deepEqual(regA.get("shared").vector, { dim: 5 });

  assert.equal(regA.remove("shared"), true);
  assert.equal(regB.get("shared"), null);
});

test("constructor sin DocStore lanza", () => {
  assert.throws(() => new CollectionRegistry(null), /DocStore inyectado/);
  assert.throws(() => new CollectionRegistry({}), /DocStore inyectado/);
});
// Tests congelados del módulo src/rules-engine.js.
//
// Cubren la semántica fijada en knowledge/contracts/rules-engine.md:
//   - colección inexistente -> deny
//   - rule null (pública) -> allow sin importar auth
//   - rule undefined (op ausente en config.rules) -> deny
//   - convención de login: { "auth.id": { $exists: true } } -> deny con auth null, allow con auth {id}
//   - rule de visibilidad { "record.public": true } -> permite públicos, niega privados
//   - rule por rol { "auth.role": "admin" } -> allow/deny según auth
//   - combinación AND implícita (varias claves en el filtro)
//   - limitación conocida: "owner == current user" NO es expresable con matchFilter puro
//     (no compara dos campos del ctx entre sí); se documenta, no se simula.
//
// Usa un registry real de src/collections.js sobre DocStore + MemoryStorageAdapter.
// Ejecutar: node --test tests/rules-engine.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DocStore,
  MemoryStorageAdapter,
} = require("../src/vendor/js-store/vendor/js-doc-store.js");
const { CollectionRegistry } = require("../src/collections.js");
const { makeRules } = require("../src/rules-engine.js");

function makeRegistry() {
  const db = new DocStore(new MemoryStorageAdapter());
  return new CollectionRegistry(db);
}

function baseFields() {
  return [{ name: "title", type: "string" }];
}

const req = { method: "GET", path: "/api/x", query: {} };

test("colección inexistente -> deny sin importar op ni auth", async () => {
  const rules = makeRules(makeRegistry());
  const r1 = await rules.check({ op: "list", collection: "nope", auth: null, record: null, request: req });
  const r2 = await rules.check({ op: "view", collection: "nope", auth: { id: "u1", role: "admin" }, record: {}, request: req });
  assert.equal(r1.allow, false);
  assert.equal(r2.allow, false);
});

test("rule null (operación pública) -> allow con y sin auth", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { list: null, view: null }, // públicas
  });
  const rules = makeRules(reg);
  const a = await rules.check({ op: "list", collection: "posts", auth: null, record: null, request: req });
  const b = await rules.check({ op: "view", collection: "posts", auth: { id: "u1" }, record: { public: true }, request: req });
  assert.equal(a.allow, true);
  assert.equal(b.allow, true);
});

test("rule undefined (op ausente en config.rules) -> deny (seguro por defecto)", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { list: null }, // solo list declarada; view/create/update/delete ausentes
  });
  const rules = makeRules(reg);
  const r = await rules.check({ op: "update", collection: "posts", auth: { id: "u1", role: "admin" }, record: {}, request: req });
  assert.equal(r.allow, false);
});

test("convención login { 'auth.id': { $exists: true } }: deny con auth null, allow con auth {id}", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { create: { "auth.id": { $exists: true } } },
  });
  const rules = makeRules(reg);
  const sinAuth = await rules.check({ op: "create", collection: "posts", auth: null, record: null, request: req });
  const conAuth = await rules.check({ op: "create", collection: "posts", auth: { id: "u1" }, record: null, request: req });
  assert.equal(sinAuth.allow, false);
  assert.equal(conAuth.allow, true);
});

test("$ne:null NO sirve para exigir login: permite auth=null (limitación documentada)", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { create: { "auth.id": { $ne: null } } },
  });
  const rules = makeRules(reg);
  // auth=null => auth.id resuelve a undefined; undefined !== null => $ne:null NO niega.
  const sinAuth = await rules.check({ op: "create", collection: "posts", auth: null, record: null, request: req });
  assert.equal(sinAuth.allow, true); // NO exige login — por eso la convención es $exists:true
});

test("visibilidad { 'record.public': true }: permite públicos, niega privados (sin auth)", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { view: { "record.public": true } },
  });
  const rules = makeRules(reg);
  const pub = await rules.check({ op: "view", collection: "posts", auth: null, record: { public: true }, request: req });
  const priv = await rules.check({ op: "view", collection: "posts", auth: null, record: { public: false }, request: req });
  const sinCampo = await rules.check({ op: "view", collection: "posts", auth: null, record: {}, request: req });
  assert.equal(pub.allow, true);
  assert.equal(priv.allow, false);
  assert.equal(sinCampo.allow, false);
});

test("rol { 'auth.role': 'admin' }: allow para admin, deny para user y para null", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { delete: { "auth.role": "admin" } },
  });
  const rules = makeRules(reg);
  const admin = await rules.check({ op: "delete", collection: "posts", auth: { id: "u1", role: "admin" }, record: {}, request: req });
  const user = await rules.check({ op: "delete", collection: "posts", auth: { id: "u2", role: "user" }, record: {}, request: req });
  const sinAuth = await rules.check({ op: "delete", collection: "posts", auth: null, record: {}, request: req });
  assert.equal(admin.allow, true);
  assert.equal(user.allow, false);
  assert.equal(sinAuth.allow, false);
});

test("AND implícito: login + rol a la vez (varias claves en el filtro)", async () => {
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { update: { "auth.id": { $exists: true }, "auth.role": "editor" } },
  });
  const rules = makeRules(reg);
  const editor = await rules.check({ op: "update", collection: "posts", auth: { id: "u1", role: "editor" }, record: {}, request: req });
  const admin = await rules.check({ op: "update", collection: "posts", auth: { id: "u2", role: "admin" }, record: {}, request: req });
  const anon = await rules.check({ op: "update", collection: "posts", auth: null, record: {}, request: req });
  assert.equal(editor.allow, true);
  assert.equal(admin.allow, false); // rol no es editor
  assert.equal(anon.allow, false);  // sin auth
});

test("limitación: 'owner == current user' NO expresable con matchFilter puro", async () => {
  // matchFilter compara campos del ctx contra VALORES LITERALES del filtro, no entre
  // campos del ctx entre sí. No hay forma de decir "record.owner == auth.id".
  // Lo más cercano es exigir un valor literal concreto, que NO expresa ownership dinámica.
  const reg = makeRegistry();
  reg.create({
    name: "posts",
    fields: baseFields(),
    rules: { update: { "record.owner": "u1", "auth.id": "u1" } },
  });
  const rules = makeRules(reg);
  // Con valores literales coincidentes, pasa — pero es estático, no "el dueño actual".
  const dueno = await rules.check({ op: "update", collection: "posts", auth: { id: "u1" }, record: { owner: "u1" }, request: req });
  const otro = await rules.check({ op: "update", collection: "posts", auth: { id: "u2" }, record: { owner: "u2" }, request: req });
  assert.equal(dueno.allow, true);  // coincide con el literal "u1"
  assert.equal(otro.allow, false);  // no coincide con el literal — aunque sea "dueño" real
  // Esto demuestra la limitación: la regla está hardcodeada a "u1", no a "auth.id".
});

test("registry fake mínimo (solo get()) también funciona", async () => {
  const fake = {
    get(name) {
      if (name === "pub") {
        return { name: "pub", fields: [], rules: { list: null } };
      }
      if (name === "priv") {
        return { name: "priv", fields: [], rules: { list: { "auth.id": { $exists: true } } } };
      }
      return null;
    },
  };
  const rules = makeRules(fake);
  const pub = await rules.check({ op: "list", collection: "pub", auth: null, record: null, request: req });
  const privAnon = await rules.check({ op: "list", collection: "priv", auth: null, record: null, request: req });
  const privAuth = await rules.check({ op: "list", collection: "priv", auth: { id: "u1" }, record: null, request: req });
  const unknown = await rules.check({ op: "list", collection: "ghost", auth: { id: "u1" }, record: null, request: req });
  assert.equal(pub.allow, true);
  assert.equal(privAnon.allow, false);
  assert.equal(privAuth.allow, true);
  assert.equal(unknown.allow, false);
});

test("makeRules lanza si el registry no tiene get()", () => {
  assert.throws(() => makeRules({}), /registry con get/);
  assert.throws(() => makeRules(null), /registry con get/);
});
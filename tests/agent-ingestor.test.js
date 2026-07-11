// Tests congelados del módulo agent/ingestor.js.
//
// Cubren la semántica fijada en knowledge/contracts/agent-ingestor.md:
//   - par user/assistant persistido en `turns` con ids deterministas `${sessionId}:${seq}:role`
//     y shape { session_id, role, text, seq, created_at } sin campo `compacted`
//   - assembly persistido en `assemblies` con _id compuesto `${sessionId}:${seq}`
//   - UNA sola llamada al embedder por turno, isQuery false (o ausente/falsy), ambos
//     textos en el mismo lote
//   - idempotencia: repetir la misma llamada no duplica (counts estables)
//   - VALIDATION (err.code) ante argumento faltante o de tipo incorrecto, sin escrituras
//   - error del embedder burbujea sin escribir nada
//   - error a mitad de par (falla el upsert del assistant) -> code 'INGEST', y el retry
//     con el mismo turno (ya sano) deja el estado completo sin duplicados
//
// js-base real en memoria: DocStore + MemoryStorageAdapter, CollectionRegistry,
// makeStores, makeSemanticStores (modo memoria). Colección `turns` con vector dim 3,
// `assemblies` sin vector. Embedder FAKE que cuenta llamadas y devuelve vectores dim 3
// deterministas, registrando el isQuery recibido.
//
// Ejecutar: node --test tests/agent-ingestor.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DocStore,
  MemoryStorageAdapter,
} = require('../src/vendor/js-store/vendor/js-doc-store.js');
const { CollectionRegistry } = require('../src/collections.js');
const { makeStores } = require('../src/store-provider.js');
const { makeSemanticStores } = require('../src/semantic-provider.js');
const { makeIngestor } = require('../agent/ingestor.js');

// --- Fixtures: js-base real en memoria ---------------------------------------

function makeDb() {
  return new DocStore(new MemoryStorageAdapter());
}

// Registro con `turns` (vector dim 3) y `assemblies` (documental, sin vector),
// tal como las declararía CONTRACT-10.
function makeRegistry(db) {
  const registry = new CollectionRegistry(db);
  registry.create({
    name: 'turns',
    fields: [
      { name: 'session_id', type: 'string' },
      { name: 'role', type: 'string' },
      { name: 'text', type: 'string' },
      { name: 'seq', type: 'number' },
      { name: 'created_at', type: 'string' },
    ],
    rules: { list: null, view: null, create: null, update: null, delete: null },
    vector: { dim: 3 },
  });
  registry.create({
    name: 'assemblies',
    fields: [
      { name: 'sha256', type: 'string' },
      { name: 'slots', type: 'array' },
      { name: 'mode', type: 'string' },
    ],
    rules: { list: null, view: null, create: null, update: null, delete: null },
    vector: null,
  });
  return registry;
}

function makeEnv() {
  const db = makeDb();
  const registry = makeRegistry(db);
  const stores = makeStores(db);
  const semanticStores = makeSemanticStores({ registry });
  return { db, registry, stores, semanticStores };
}

// --- Fixture: embedder fake ---------------------------------------------------
// Cuenta llamadas, registra isQuery recibido y devuelve vectores dim 3 deterministas
// (hash simple por texto, sin dependencias externas).

function vectorFor(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return [
    (h % 1000) / 1000,
    ((h >>> 8) % 1000) / 1000,
    ((h >>> 16) % 1000) / 1000,
  ];
}

function makeEmbedderFake() {
  const calls = [];
  return {
    calls,
    async embed(texts, opts) {
      calls.push({ texts: Array.isArray(texts) ? texts.slice() : texts, isQuery: opts && opts.isQuery });
      return texts.map(vectorFor);
    },
  };
}

function makeEmbedderQueRechaza(message) {
  return {
    calls: [],
    async embed() {
      throw new Error(message || 'embedder caído (simulado)');
    },
  };
}

// --- Fixture: assembly de ejemplo ---------------------------------------------

function makeAssembly(overrides) {
  return Object.assign(
    {
      sha256: 'a'.repeat(64),
      slots: [{ id: 'S0', tokens: 10, included: true, truncated: false }],
      mode: 'interactivo',
    },
    overrides
  );
}

// --- Helpers de lectura ---------------------------------------------------------

function contarTurns(semanticStores) {
  return semanticStores.get('turns').count({});
}

function contarAssemblies(stores) {
  return stores.get('assemblies').count({});
}

function leerTurn(semanticStores, id) {
  return semanticStores.get('turns').get(id);
}

function leerAssembly(stores, id) {
  return stores.get('assemblies').get(id);
}

// --- Wrapper frágil: falla el upsert de `turns` en la N-ésima llamada ----------
// Envuelve un semanticStores real; get('turns') devuelve un proxy cuyo upsert
// lanza en la llamada número `failOnCall` (compartido entre llamadas a get()) y
// delega el resto de los métodos + el resto de las colecciones sin cambios.

function makeSemanticStoresFragil(real, { failOnCall, message }) {
  let callCount = 0;
  return {
    get(colName) {
      const target = real.get(colName);
      if (target == null || colName !== 'turns') return target;
      return {
        upsert(id, doc, vector) {
          callCount++;
          if (callCount === failOnCall) {
            throw new Error(message || `upsert simulado: falla en la llamada ${callCount}`);
          }
          return target.upsert(id, doc, vector);
        },
        get: (...args) => target.get(...args),
        count: (...args) => target.count(...args),
        find: (...args) => target.find(...args),
        keys: (...args) => target.keys(...args),
        delete: (...args) => target.delete(...args),
        search: (...args) => target.search(...args),
      };
    },
    closeAll: () => real.closeAll(),
  };
}

// --- Tests: par persistido ------------------------------------------------------

test('ingestTurn persiste el par user/assistant con ids deterministas y shape correcto', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const ingestor = makeIngestor({ stores, semanticStores, embedder });
  const assembly = makeAssembly();

  const result = await ingestor.ingestTurn({
    sessionId: 's1',
    seq: 0,
    userText: 'hola',
    assistantText: 'buenas',
    assembly,
  });

  assert.equal(result.userId, 's1:0:user');
  assert.equal(result.assistantId, 's1:0:assistant');

  const userDoc = leerTurn(semanticStores, 's1:0:user');
  const assistantDoc = leerTurn(semanticStores, 's1:0:assistant');

  assert.ok(userDoc, 'debe existir el doc del turno de usuario');
  assert.equal(userDoc.session_id, 's1');
  assert.equal(userDoc.role, 'user');
  assert.equal(userDoc.text, 'hola');
  assert.equal(userDoc.seq, 0);
  assert.equal(typeof userDoc.created_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(userDoc.created_at)), 'created_at debe ser un ISO parseable');
  assert.equal(Object.prototype.hasOwnProperty.call(userDoc, 'compacted'), false);

  assert.ok(assistantDoc, 'debe existir el doc del turno de assistant');
  assert.equal(assistantDoc.session_id, 's1');
  assert.equal(assistantDoc.role, 'assistant');
  assert.equal(assistantDoc.text, 'buenas');
  assert.equal(assistantDoc.seq, 0);
  assert.equal(typeof assistantDoc.created_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(assistantDoc.created_at)));
  assert.equal(Object.prototype.hasOwnProperty.call(assistantDoc, 'compacted'), false);

  assert.equal(contarTurns(semanticStores), 2);
});

test('ingestTurn deja el assembly en `assemblies` con _id compuesto ${sessionId}:${seq}', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const ingestor = makeIngestor({ stores, semanticStores, embedder });
  const assembly = makeAssembly({ sha256: 'b'.repeat(64), mode: 'esporadico' });

  await ingestor.ingestTurn({
    sessionId: 's2',
    seq: 7,
    userText: 'pregunta',
    assistantText: 'respuesta',
    assembly,
  });

  const doc = leerAssembly(stores, 's2:7');
  assert.ok(doc, 'debe existir el registro de auditoría del assembly');
  assert.equal(doc.sha256, assembly.sha256);
  assert.deepEqual(doc.slots, assembly.slots);
  assert.equal(doc.mode, assembly.mode);
  assert.equal(contarAssemblies(stores), 1);
});

// --- Tests: embedder -------------------------------------------------------------

test('ingestTurn llama al embedder UNA sola vez por turno, isQuery false/ausente, ambos textos en el mismo lote', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const ingestor = makeIngestor({ stores, semanticStores, embedder });

  await ingestor.ingestTurn({
    sessionId: 's3',
    seq: 0,
    userText: 'texto usuario',
    assistantText: 'texto assistant',
    assembly: makeAssembly(),
  });

  assert.equal(embedder.calls.length, 1, 'debe haber exactamente 1 llamada al embedder');
  const call = embedder.calls[0];
  assert.deepEqual(call.texts, ['texto usuario', 'texto assistant']);
  assert.ok(!call.isQuery, 'isQuery debe ser false o ausente/falsy (prefijo documento)');
});

// --- Tests: idempotencia ----------------------------------------------------------

test('idempotencia: repetir la misma llamada no duplica turns ni assemblies', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const ingestor = makeIngestor({ stores, semanticStores, embedder });
  const args = {
    sessionId: 's4',
    seq: 1,
    userText: 'repetido',
    assistantText: 'respuesta repetida',
    assembly: makeAssembly({ sha256: 'c'.repeat(64) }),
  };

  const primero = await ingestor.ingestTurn(args);
  const segundo = await ingestor.ingestTurn(args);

  assert.deepEqual(segundo, primero);
  assert.equal(contarTurns(semanticStores), 2, 'turns no debe duplicarse tras el retry');
  assert.equal(contarAssemblies(stores), 1, 'assemblies no debe duplicarse tras el retry');

  const userDoc = leerTurn(semanticStores, 's4:1:user');
  assert.equal(userDoc.text, 'repetido');
});

// --- Tests: VALIDATION -------------------------------------------------------------

const casosInvalidos = [
  ['sessionId ausente', { seq: 0, userText: 'a', assistantText: 'b', assembly: makeAssembly() }],
  ['sessionId de tipo incorrecto', { sessionId: 42, seq: 0, userText: 'a', assistantText: 'b', assembly: makeAssembly() }],
  ['seq ausente', { sessionId: 's5', userText: 'a', assistantText: 'b', assembly: makeAssembly() }],
  ['seq de tipo incorrecto', { sessionId: 's5', seq: '0', userText: 'a', assistantText: 'b', assembly: makeAssembly() }],
  ['userText vacío', { sessionId: 's5', seq: 0, userText: '', assistantText: 'b', assembly: makeAssembly() }],
  ['assistantText ausente', { sessionId: 's5', seq: 0, userText: 'a', assembly: makeAssembly() }],
  ['assembly ausente', { sessionId: 's5', seq: 0, userText: 'a', assistantText: 'b' }],
];

for (const [nombre, args] of casosInvalidos) {
  test(`VALIDATION (${nombre}): lanza err.code 'VALIDATION' sin ninguna escritura`, async () => {
    const { stores, semanticStores } = makeEnv();
    const embedder = makeEmbedderFake();
    const ingestor = makeIngestor({ stores, semanticStores, embedder });

    await assert.rejects(
      () => ingestor.ingestTurn(args),
      (err) => {
        assert.equal(err.code, 'VALIDATION');
        return true;
      }
    );

    assert.equal(embedder.calls.length, 0, 'no debe haberse llamado al embedder');
    assert.equal(contarTurns(semanticStores), 0, 'turns debe quedar intacto');
    assert.equal(contarAssemblies(stores), 0, 'assemblies debe quedar intacto');
  });
}

// --- Tests: error del embedder ------------------------------------------------------

test('error del embedder burbujea sin escribir nada en turns ni assemblies', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderQueRechaza('fallo simulado de red');
  const ingestor = makeIngestor({ stores, semanticStores, embedder });

  await assert.rejects(() =>
    ingestor.ingestTurn({
      sessionId: 's6',
      seq: 0,
      userText: 'hola',
      assistantText: 'buenas',
      assembly: makeAssembly(),
    })
  );

  assert.equal(contarTurns(semanticStores), 0);
  assert.equal(contarAssemblies(stores), 0);
});

// --- Tests: error a mitad de par + retry reparador -----------------------------------

test("error a mitad de par: falla el upsert del assistant -> code 'INGEST'; el retry sano completa sin duplicados", async () => {
  const { stores, semanticStores } = makeEnv();
  const fragil = makeSemanticStoresFragil(semanticStores, { failOnCall: 2, message: 'upsert del assistant caído' });
  const embedder = makeEmbedderFake();
  const ingestorFragil = makeIngestor({ stores, semanticStores: fragil, embedder });

  const args = {
    sessionId: 's7',
    seq: 3,
    userText: 'hola de nuevo',
    assistantText: 'buenas de nuevo',
    assembly: makeAssembly({ sha256: 'd'.repeat(64) }),
  };

  await assert.rejects(
    () => ingestorFragil.ingestTurn(args),
    (err) => {
      assert.equal(err.code, 'INGEST');
      assert.ok(err.cause, 'debe preservar la causa original');
      return true;
    }
  );

  // Estado intermedio: el upsert del user sí llegó a escribirse, el del assistant no,
  // y el insert de assemblies (posterior al par) tampoco se alcanzó.
  assert.equal(contarTurns(semanticStores), 1, 'solo el turno de user quedó escrito');
  assert.equal(leerTurn(semanticStores, 's7:3:user').text, 'hola de nuevo');
  assert.equal(leerTurn(semanticStores, 's7:3:assistant'), null);
  assert.equal(contarAssemblies(stores), 0, 'el assembly no debe haberse insertado a mitad de par');

  // Retry con el mismo turno sobre un ingestor sano (semanticStores real, sin envoltorio
  // frágil): repara el estado sin duplicar el turno de user ya escrito.
  const ingestorSano = makeIngestor({ stores, semanticStores, embedder });
  const resultado = await ingestorSano.ingestTurn(args);

  assert.equal(resultado.userId, 's7:3:user');
  assert.equal(resultado.assistantId, 's7:3:assistant');
  assert.equal(contarTurns(semanticStores), 2, 'tras el retry deben quedar exactamente los 2 turnos, sin duplicados');
  assert.equal(contarAssemblies(stores), 1, 'tras el retry el assembly debe quedar insertado exactamente 1 vez');
  assert.equal(leerTurn(semanticStores, 's7:3:assistant').text, 'buenas de nuevo');
});

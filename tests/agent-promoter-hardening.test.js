// Tests congelados NUEVOS de CONTRACT-11 (T1) sobre agent/promoter.js.
//
// Endurecen 3 defectos REALES de la impl actual (ver specs/CONTRACT-11-promoter-hardening.md):
//   1. supersede(oldId, correction) no es idempotente: newId = crypto.randomUUID() ->
//      un retry tras un fallo simulado en el marcado del nodo viejo crea un SEGUNDO
//      nodo corrección en vez de reutilizar el mismo.
//   2. maybeCompact reusa el mismo `seq` de compactación entre compactaciones
//      sucesivas de la misma sesión (no lo deriva del batch) -> la segunda
//      compactación pisa los ids de nodos promovidos por la primera.
//   3. markCompacted y supersedeImpl leen `turns.vectorStore`/`nodes.vectorStore` y
//      `.col` (internos del vendor) en vez de la API pública (serialize() u otra) ->
//      rompen ante una SemanticCollection que no expone esos internos.
//   4. (verificación, no defecto conocido) ninguno de los dos fixes anteriores debe
//      agregar llamadas extra al embedder (contadores congelados de C10).
//
// tests/agent-promoter.test.js (7 tests congelados de C10) es READ-ONLY: NO se toca
// ni se importa nada de él; este archivo es autocontenido con sus propias fixtures,
// construidas con el mismo criterio (documentado ahí como referencia).
//
// Baseline esperado: los casos 1, 2 y 3 deben FALLAR contra agent/promoter.js tal
// como está hoy (comportamiento defectuoso), y quedar en verde una vez corregido.
// El caso 4 puede ya estar en verde (no es un defecto conocido, es una verificación).
//
// Ejecutar: node --test tests/agent-promoter-hardening.test.js

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
const { makePromoter } = require('../agent/promoter.js');

const NOW = 1700000000000;

// --- Fixtures: js-base real en memoria (mismo criterio que tests/agent-promoter.test.js) ---

function makeDb() {
  return new DocStore(new MemoryStorageAdapter());
}

function makeRegistry(db) {
  const registry = new CollectionRegistry(db);
  registry.create({
    name: 'nodes',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'tags', type: 'array' },
      { name: 'source_turns', type: 'array' },
      { name: 'created_at', type: 'string' },
    ],
    rules: { list: null, view: null, create: null, update: null, delete: null },
    vector: { dim: 3 },
  });
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
    name: 'sessions',
    fields: [
      { name: 'summary', type: 'string' },
      { name: 'summary_tokens', type: 'number' },
      { name: 'last_compaction_seq', type: 'number' },
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

// --- Fixture: embedder fake (mismo criterio que tests/agent-promoter.test.js) ---
// Cuenta llamadas, registra isQuery recibido y devuelve vectores dim 3 deterministas.

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

// --- Fixture: llm fake determinista con contador de llamadas -------------------

function makeLlmFake(response) {
  const calls = [];
  const fn = async ({ system, prompt }) => {
    calls.push({ system, prompt });
    return typeof response === 'function' ? response({ system, prompt }) : response;
  };
  fn.calls = calls;
  return fn;
}

// Respuesta JSON válida y determinista: 1 resumen + 2 hechos (tanda 1).
const RESUMEN_LLM = 'resumen de la sesion: se acordo el retry y el timeout.';
const RESPUESTA_LLM_FACTS = JSON.stringify({
  summary: RESUMEN_LLM,
  facts: [
    { title: 'retry acordado', body: 'el retry acordado es 5 intentos', kind: 'decision', tags: ['retry'] },
    { title: 'timeout acordado', body: 'el timeout acordado es 30s', kind: 'fact', tags: ['timeout'] },
  ],
});

// Segunda respuesta, con hechos DISTINTOS: usada en la segunda de dos compactaciones
// sucesivas para poder distinguir la tanda 1 de la tanda 2 por contenido.
const RESUMEN_LLM_2 = 'resumen de la sesion 2: se acordo el limite de reintentos y el modo offline.';
const RESPUESTA_LLM_FACTS_2 = JSON.stringify({
  summary: RESUMEN_LLM_2,
  facts: [
    { title: 'limite acordado', body: 'el limite acordado es 10 reintentos', kind: 'decision', tags: ['limite'] },
    { title: 'modo offline acordado', body: 'el modo offline queda habilitado', kind: 'fact', tags: ['offline'] },
  ],
});

// --- Fixture: turnos ------------------------------------------------------------

async function insertarTurno(semanticStores, embedder, { sessionId, seq, role, text, createdAt }) {
  const turns = semanticStores.get('turns');
  const id = `${sessionId}:${seq}:${role}`;
  const [vector] = await embedder.embed([text], { isQuery: false });
  turns.upsert(id, { session_id: sessionId, role, text, seq, created_at: createdAt }, vector);
  return id;
}

function textoLargo(n) {
  return `contenido de prueba numero ${n} con longitud de sobra para sumar tokens bajo `
    + 'la heuristica ceil de chars sobre cuatro que usa el contrato agent-promoter';
}

// Crea `n` pares user/assistant vivos con seq empezando en `startSeq` (en vez de
// siempre 0..n-1) para poder generar una segunda tanda de turnos con seqs mayores
// que la primera, sin colisión de ids, tal como exige el caso de compactaciones
// sucesivas.
async function insertarTurnosVivosDesde(semanticStores, embedder, sessionId, startSeq, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const seq = startSeq + i;
    ids.push(await insertarTurno(semanticStores, embedder, {
      sessionId, seq, role: 'user', text: `${textoLargo(seq)} (user)`,
      createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    }));
    ids.push(await insertarTurno(semanticStores, embedder, {
      sessionId, seq, role: 'assistant', text: `${textoLargo(seq)} (assistant)`,
      createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.500Z`,
    }));
  }
  return ids;
}

async function insertarTurnosVivos(semanticStores, embedder, sessionId, n) {
  return insertarTurnosVivosDesde(semanticStores, embedder, sessionId, 0, n);
}

// --- Helper de lectura -----------------------------------------------------------

function contarNodos(semanticStores) {
  return semanticStores.get('nodes').count({});
}

// --- Wrapper frágil: falla el upsert de `nodes` en la llamada N-esima -----------
// Mismo patrón que el wrapper frágil de turns en tests/agent-promoter.test.js: un
// Proxy transparente sobre la SemanticCollection real de `nodes` (delega TODO,
// incluidos internos, bindeando al target) salvo que intercepta upsert/upsertMany
// para lanzar en la llamada número `failOnCall` (compartida entre ambos métodos).
// Usado para simular el fallo del EFECTO 2 de supersede (el marcado del nodo
// viejo, que es el segundo upsert de `nodes` dentro de un mismo supersede).

function makeSemanticStoresFragilNodes(real, { failOnCall, message }) {
  let callCount = 0;
  function debeFallarAhora() {
    callCount += 1;
    return callCount === failOnCall;
  }
  return {
    get(colName) {
      const target = real.get(colName);
      if (target == null || colName !== 'nodes') return target;
      return new Proxy(target, {
        get(obj, prop, receiver) {
          if (prop === 'upsert') {
            return (id, doc, vector) => {
              if (debeFallarAhora()) {
                throw new Error(message || `upsert simulado: falla en la llamada ${callCount}`);
              }
              return obj.upsert(id, doc, vector);
            };
          }
          if (prop === 'upsertMany') {
            return (items) => items.map((it) => receiver.upsert(it.id, it.doc, it.vector));
          }
          const value = Reflect.get(obj, prop, obj);
          return typeof value === 'function' ? value.bind(obj) : value;
        },
      });
    },
    closeAll: () => real.closeAll(),
  };
}

// --- Proxy que bloquea el acceso a internos del vendor (vectorStore/col) --------
// Para el resto de propiedades delega en el target real, bindeando los métodos al
// target (no al proxy): así una llamada pública como serialize(), que internamente
// hace `this.vectorStore...`, NO vuelve a pasar por la trampa (this = target real
// dentro del método) y solo lanza cuando agent/promoter.js accede a `.vectorStore`
// o `.col` DIRECTAMENTE desde afuera.

function makeProxyBloqueaInternos(target) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'vectorStore' || prop === 'col') {
        throw new Error('acceso a interno del vendor');
      }
      const value = Reflect.get(obj, prop, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

function makeSemanticStoresBloqueaInternos(real) {
  return {
    get(colName) {
      const target = real.get(colName);
      return target == null ? target : makeProxyBloqueaInternos(target);
    },
    closeAll: () => real.closeAll(),
  };
}

// =================================================================================
// Caso 1 — retry de supersede idempotente
// =================================================================================

test('supersede: retry con la misma correction tras fallo simulado al marcar el nodo viejo -> mismo newId, sin duplicar', async () => {
  const { stores, semanticStores: real } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);

  const nodes = real.get('nodes');
  const [vOld] = await embedder.embed(['el retry acordado es 5 intentos'], { isQuery: false });
  nodes.upsert('n1', {
    title: 'retry acordado', body: 'el retry acordado es 5 intentos', kind: 'decision',
    tags: ['retry'], source_turns: ['s0:0:user'], created_at: '2026-01-01T00:00:00.000Z',
  }, vOld);

  const correction = { title: 'retry es 3', body: 'el retry acordado es 3, no 5' };

  // Falla el 2do upsert de `nodes` dentro de un mismo supersede: el 1ro escribe el
  // nodo nuevo, el 2do marca el viejo con superseded_by (y es el que falla).
  const fragil = makeSemanticStoresFragilNodes(real, {
    failOnCall: 2,
    message: 'fallo simulado al marcar el nodo viejo',
  });
  const promoterFragil = makePromoter({ stores, semanticStores: fragil, embedder, llm, threshold_tokens: 50 });

  await assert.rejects(() => promoterFragil.supersede('n1', correction));

  // Estado tras el "crash": el nodo nuevo quedó escrito (1er upsert, antes del
  // fallo), el viejo sigue sin superseded_by (el marcado, 2do upsert, falló).
  assert.equal(contarNodos(real), 2, 'el nodo nuevo debe quedar escrito aunque el marcado del viejo falle despues');
  const idsTrasFallo = real.get('nodes').keys().slice().sort();
  const idNuevoTrasFallo = idsTrasFallo.find((id) => id !== 'n1');
  assert.ok(idNuevoTrasFallo, 'debe existir un nodo nuevo (la correccion) tras el fallo parcial');
  assert.equal(nodes.get('n1').superseded_by, undefined, 'el viejo NO debe quedar marcado tras el fallo');

  // Retry: misma correction exacta, sobre un wrapper sano (sin fallo simulado).
  const promoterSano = makePromoter({ stores, semanticStores: real, embedder, llm, threshold_tokens: 50 });
  const { newId } = await promoterSano.supersede('n1', correction);

  assert.equal(
    newId,
    idNuevoTrasFallo,
    'el retry con la misma (oldId, correction) debe devolver el mismo newId que el intento fallido',
  );
  assert.equal(contarNodos(real), 2, 'el retry no debe duplicar nodos: total = n1 + una sola correccion');
  const idsTrasRetry = real.get('nodes').keys().slice().sort();
  assert.deepEqual(idsTrasRetry, idsTrasFallo, 'los ids de nodo tras el retry deben ser los mismos que tras el fallo (sin duplicar)');
  assert.equal(nodes.get('n1').superseded_by, newId, 'el viejo debe quedar apuntando al newId tras el retry');
});

// =================================================================================
// Caso 2 — compactaciones sucesivas sin colisión
// =================================================================================

test('maybeCompact: dos compactaciones sucesivas de la misma sesion producen ids de nodo disjuntos y no pisan la primera tanda', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const sessionId = 's-hardening-2';

  // Primera tanda: turnos seq 0..5, llm devuelve RESPUESTA_LLM_FACTS.
  await insertarTurnosVivos(semanticStores, embedder, sessionId, 6);
  const llm1 = makeLlmFake(RESPUESTA_LLM_FACTS);
  const promoter1 = makePromoter({ stores, semanticStores, embedder, llm: llm1, threshold_tokens: 50 });
  const res1 = await promoter1.maybeCompact({ sessionId, now: NOW });

  assert.equal(res1.compacted, true);
  assert.equal(res1.promoted, 2);

  const idsTanda1 = semanticStores.get('nodes').keys().slice().sort();
  assert.equal(idsTanda1.length, 2, 'la primera compactacion debe promover exactamente 2 nodos');
  const bodiesTanda1 = Object.fromEntries(idsTanda1.map((id) => [id, semanticStores.get('nodes').get(id).body]));

  // Segunda tanda: turnos NUEVOS con seq mayores (6..11) que vuelven a superar el
  // umbral; llm devuelve OTROS facts (RESPUESTA_LLM_FACTS_2) para distinguir tandas.
  await insertarTurnosVivosDesde(semanticStores, embedder, sessionId, 6, 6);
  const llm2 = makeLlmFake(RESPUESTA_LLM_FACTS_2);
  const promoter2 = makePromoter({ stores, semanticStores, embedder, llm: llm2, threshold_tokens: 50 });
  const res2 = await promoter2.maybeCompact({ sessionId, now: NOW });

  assert.equal(res2.compacted, true);
  assert.equal(res2.promoted, 2);

  const idsTotales = semanticStores.get('nodes').keys().slice().sort();
  assert.equal(idsTotales.length, 4, 'la segunda compactacion debe AGREGAR 2 nodos nuevos, no pisar los 2 de la primera');

  const idsTanda2 = idsTotales.filter((id) => !idsTanda1.includes(id));
  assert.equal(idsTanda2.length, 2, 'la segunda tanda debe aportar exactamente 2 ids nuevos, disjuntos de la primera');

  // Los nodos de la primera tanda deben seguir intactos (mismo body de antes).
  for (const id of idsTanda1) {
    const nodo = semanticStores.get('nodes').get(id);
    assert.ok(nodo, `el nodo ${id} de la primera tanda debe seguir existiendo`);
    assert.equal(nodo.body, bodiesTanda1[id], `el body del nodo ${id} de la primera tanda no debe haber cambiado`);
  }

  // Los nodos de la segunda tanda deben tener el contenido de la segunda respuesta.
  const bodiesTanda2 = idsTanda2.map((id) => semanticStores.get('nodes').get(id).body).sort();
  assert.deepEqual(bodiesTanda2, [
    'el limite acordado es 10 reintentos',
    'el modo offline queda habilitado',
  ].sort());
});

// =================================================================================
// Caso 3 — solo API pública del vendor (Proxy bloquea vectorStore/col)
// =================================================================================

test('maybeCompact y supersede funcionan sobre SemanticCollections que bloquean vectorStore/col (solo API publica del vendor)', async () => {
  const { stores, semanticStores: real } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const sessionId = 's-hardening-3';

  await insertarTurnosVivos(real, embedder, sessionId, 6);

  const nodes = real.get('nodes');
  const [vOld] = await embedder.embed(['contenido viejo'], { isQuery: false });
  nodes.upsert('viejo1', { title: 'viejo', body: 'contenido viejo', kind: 'fact', tags: [] }, vOld);

  const bloqueado = makeSemanticStoresBloqueaInternos(real);

  // Control: comprobar que el bloqueo es real (si no lanzara, el test no probaria nada).
  assert.throws(() => bloqueado.get('nodes').vectorStore, /acceso a interno del vendor/);
  assert.throws(() => bloqueado.get('turns').col, /acceso a interno del vendor/);

  const promoter = makePromoter({ stores, semanticStores: bloqueado, embedder, llm, threshold_tokens: 50 });

  const resCompact = await promoter.maybeCompact({ sessionId, now: NOW });
  assert.equal(resCompact.compacted, true, 'la compactacion debe completarse sin lanzar por acceso a internos');
  assert.equal(resCompact.promoted, 2);
  assert.equal(
    real.get('turns').find({ session_id: sessionId }).filter((t) => t.compacted === true).length,
    12,
    'los turnos deben quedar marcados compacted aun leyendo su vector solo por API publica',
  );

  const { newId } = await promoter.supersede('viejo1', { title: 'nuevo', body: 'contenido nuevo' });
  assert.ok(typeof newId === 'string' && newId.length > 0, 'supersede debe completarse sin lanzar por acceso a internos');
  assert.equal(real.get('nodes').get('viejo1').superseded_by, newId);
  assert.equal(real.get('nodes').get(newId).body, 'contenido nuevo');
});

// =================================================================================
// Caso 4 — sin costo extra de embeddings
// =================================================================================

test('maybeCompact: el marcado de turnos compactados no agrega llamadas al embedder (solo 1 lote por los facts)', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const sessionId = 's-hardening-4a';

  await insertarTurnosVivos(semanticStores, embedder, sessionId, 6);
  const callsAntes = embedder.calls.length;

  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });
  await promoter.maybeCompact({ sessionId, now: NOW });

  assert.equal(
    embedder.calls.length,
    callsAntes + 1,
    'el marcado de turnos compactados no debe agregar llamadas al embedder (solo el lote de facts)',
  );
});

test('supersede: no agrega llamadas al embedder al leer el vector del nodo viejo (solo 1 llamada por el body de la correccion)', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);

  const nodes = semanticStores.get('nodes');
  const [vOld] = await embedder.embed(['contenido original'], { isQuery: false });
  nodes.upsert('n-orig', { title: 'orig', body: 'contenido original', kind: 'fact', tags: [] }, vOld);

  const callsAntes = embedder.calls.length;
  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });
  await promoter.supersede('n-orig', { title: 'corregido', body: 'contenido corregido' });

  assert.equal(
    embedder.calls.length,
    callsAntes + 1,
    'supersede no debe agregar llamadas extra al embedder por leer el vector del nodo viejo',
  );
});

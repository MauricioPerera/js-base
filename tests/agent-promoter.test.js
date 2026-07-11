// Tests congelados del módulo agent/promoter.js.
//
// Cubren la semántica fijada en knowledge/contracts/agent-promoter.md:
//   - no-op bajo el umbral: turnos vivos que suman <= threshold_tokens -> sin llamar
//     al llm, { compacted: false, summaryTokens: 0, promoted: 0 }
//   - compactación completa: turnos que superan el umbral -> 1 sola llamada al llm,
//     resumen persistido en `sessions`, nodos promovidos en `nodes` con
//     source_turns/kind correctos, turnos marcados `compacted: true`
//   - idempotencia del retry: un fallo simulado al marcar turnos compactado la
//     primera vez deja nodos+sesión escritos y turnos sin marcar; el retry recompacta
//     sin duplicar nodos (mismos ids reutilizados)
//   - PROMOTER (err.code) ante una respuesta del llm que no es JSON válido, con cero
//     escrituras (nodes/sessions/turns intactos)
//   - supersede feliz: nodo nuevo con supersedes:[oldId], viejo con
//     superseded_by:newId, un search con filtro { superseded_by: { $exists: false } }
//     devuelve el nuevo y nunca el viejo
//   - supersede de id inexistente -> err.code 'NOT_FOUND'
//   - cadena de dos supersedes A<-B<-C: solo el último queda recuperable con ese filtro
//
// js-base real en memoria: DocStore + MemoryStorageAdapter, CollectionRegistry,
// makeStores, makeSemanticStores (modo memoria). Colecciones `nodes` y `turns` con
// vector dim 3, `sessions` sin vector (documental pura). Embedder FAKE dim 3 con
// contador de llamadas; llm FAKE determinista con contador de llamadas.
//
// Ejecutar: node --test tests/agent-promoter.test.js

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

// --- Fixtures: js-base real en memoria ---------------------------------------

function makeDb() {
  return new DocStore(new MemoryStorageAdapter());
}

// Registro con `nodes` y `turns` (vector dim 3) y `sessions` (documental, sin
// vector), tal como las declararía CONTRACT-10.
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

// --- Fixture: embedder fake (mismo criterio que tests/agent-ingestor.test.js) ---
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

// Respuesta JSON válida y determinista: 1 resumen + 2 hechos con kind distinto,
// tal como la describe el contrato (facts: [{ title, body, kind, tags }]).
const RESUMEN_LLM = 'resumen de la sesion: se acordo el retry y el timeout.';
const RESPUESTA_LLM_FACTS = JSON.stringify({
  summary: RESUMEN_LLM,
  facts: [
    { title: 'retry acordado', body: 'el retry acordado es 5 intentos', kind: 'decision', tags: ['retry'] },
    { title: 'timeout acordado', body: 'el timeout acordado es 30s', kind: 'fact', tags: ['timeout'] },
  ],
});

// --- Fixture: turnos ------------------------------------------------------------

// Inserta un turno directamente en la colección semántica `turns`, mismo camino que
// usaría agent/ingestor.js (doc + vector documento, sin `compacted` al nacer).
async function insertarTurno(semanticStores, embedder, { sessionId, seq, role, text, createdAt }) {
  const turns = semanticStores.get('turns');
  const id = `${sessionId}:${seq}:${role}`;
  const [vector] = await embedder.embed([text], { isQuery: false });
  turns.upsert(id, { session_id: sessionId, role, text, seq, created_at: createdAt }, vector);
  return id;
}

// Texto largo (independiente por índice) para cruzar umbrales bajos de tokens con
// pocos turnos, vía la heurística ceil(chars/4) del contrato.
function textoLargo(n) {
  return `contenido de prueba numero ${n} con longitud de sobra para sumar tokens bajo `
    + 'la heuristica ceil de chars sobre cuatro que usa el contrato agent-promoter';
}

// Crea `n` pares user/assistant vivos (seq 0..n-1) con texto largo. Devuelve los ids
// en orden de inserción (user y assistant intercalados por seq).
async function insertarTurnosVivos(semanticStores, embedder, sessionId, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(await insertarTurno(semanticStores, embedder, {
      sessionId, seq: i, role: 'user', text: `${textoLargo(i)} (user)`,
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));
    ids.push(await insertarTurno(semanticStores, embedder, {
      sessionId, seq: i, role: 'assistant', text: `${textoLargo(i)} (assistant)`,
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.500Z`,
    }));
  }
  return ids;
}

// --- Helpers de lectura -----------------------------------------------------------

function contarNodos(semanticStores) {
  return semanticStores.get('nodes').count({});
}

function leerSesion(stores, sessionId) {
  return stores.get('sessions').get(sessionId);
}

function turnosVivos(semanticStores, sessionId) {
  return semanticStores.get('turns').find({ session_id: sessionId }).filter((d) => d.compacted !== true);
}

function turnosCompactados(semanticStores, sessionId) {
  return semanticStores.get('turns').find({ session_id: sessionId }).filter((d) => d.compacted === true);
}

// --- Wrapper frágil: falla el upsert/upsertMany de `turns` la primera vez --------
// Envuelve un semanticStores real; get('turns') devuelve un Proxy transparente sobre
// la SemanticCollection real (delega TODO — incluidas propiedades internas como
// vectorStore/col que el promoter pueda necesitar para preservar el vector al marcar
// compacted) salvo que intercepta upsert/upsertMany para lanzar en la llamada número
// `failOnCall` (compartida entre ambos métodos) y delegar el resto sin cambios.

function makeSemanticStoresFragilTurnos(real, { failOnCall, message }) {
  let callCount = 0;
  function debeFallarAhora() {
    callCount += 1;
    return callCount === failOnCall;
  }
  return {
    get(colName) {
      const target = real.get(colName);
      if (target == null || colName !== 'turns') return target;
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

// =================================================================================
// no-op bajo el umbral
// =================================================================================

test('maybeCompact: turnos vivos que suman menos que threshold_tokens -> no-op sin llamar al llm', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const sessionId = 's1';

  await insertarTurno(semanticStores, embedder, { sessionId, seq: 0, role: 'user', text: 'hola', createdAt: '2026-01-01T00:00:00.000Z' });
  await insertarTurno(semanticStores, embedder, { sessionId, seq: 0, role: 'assistant', text: 'buenas', createdAt: '2026-01-01T00:00:01.000Z' });

  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 100000 });
  const res = await promoter.maybeCompact({ sessionId, now: NOW });

  assert.equal(res.compacted, false);
  assert.equal(res.summaryTokens, 0);
  assert.equal(res.promoted, 0);
  assert.equal(llm.calls.length, 0, 'bajo el umbral no debe llamarse al llm');
  assert.equal(contarNodos(semanticStores), 0);
  assert.equal(leerSesion(stores, sessionId), null, 'no debe crearse doc de sesion en el no-op');
  assert.equal(turnosCompactados(semanticStores, sessionId).length, 0);
});

// =================================================================================
// compactación completa
// =================================================================================

test('maybeCompact: turnos que superan el umbral -> 1 llamada al llm, resumen en sessions, nodos promovidos y turnos marcados compacted', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const sessionId = 's2';

  const turnIds = await insertarTurnosVivos(semanticStores, embedder, sessionId, 6); // 12 turnos, texto largo
  const embedCallsAntes = embedder.calls.length;

  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });
  const res = await promoter.maybeCompact({ sessionId, now: NOW });

  assert.equal(res.compacted, true);
  assert.equal(res.promoted, 2);
  assert.equal(res.summaryTokens, Math.ceil(RESUMEN_LLM.length / 4));
  assert.equal(llm.calls.length, 1, 'debe haber exactamente 1 llamada al llm');

  // Resumen persistido en sessions.
  const session = leerSesion(stores, sessionId);
  assert.ok(session, 'debe existir un doc de sesion');
  assert.equal(session.summary, RESUMEN_LLM);
  assert.equal(typeof session.summary_tokens, 'number');
  assert.ok(Number.isInteger(session.last_compaction_seq), 'last_compaction_seq debe quedar registrado');

  // Nodos promovidos en `nodes`, con source_turns y kind correctos.
  const nodeDocs = semanticStores.get('nodes').find({});
  assert.equal(nodeDocs.length, 2);
  const porTitulo = Object.fromEntries(nodeDocs.map((n) => [n.title, n]));
  assert.equal(porTitulo['retry acordado'].body, 'el retry acordado es 5 intentos');
  assert.equal(porTitulo['retry acordado'].kind, 'decision');
  assert.equal(porTitulo['timeout acordado'].body, 'el timeout acordado es 30s');
  assert.equal(porTitulo['timeout acordado'].kind, 'fact');
  for (const n of nodeDocs) {
    assert.ok(Array.isArray(n.source_turns), 'source_turns debe ser un array');
    assert.deepEqual([...n.source_turns].sort(), [...turnIds].sort(), 'source_turns debe listar los turnos origen');
    assert.equal(n.created_at, new Date(NOW).toISOString());
  }

  // El embedder recibió los 2 bodies en UN solo lote, isQuery false/ausente.
  assert.equal(embedder.calls.length, embedCallsAntes + 1, 'los facts se embeben en un unico lote adicional');
  const loteFacts = embedder.calls[embedCallsAntes];
  assert.deepEqual(loteFacts.texts, ['el retry acordado es 5 intentos', 'el timeout acordado es 30s']);
  assert.ok(!loteFacts.isQuery, 'isQuery debe ser false o ausente/falsy (prefijo documento)');

  // Turnos marcados compacted true.
  assert.equal(turnosVivos(semanticStores, sessionId).length, 0, 'no deben quedar turnos vivos');
  assert.equal(turnosCompactados(semanticStores, sessionId).length, turnIds.length);
});

// =================================================================================
// idempotencia del retry
// =================================================================================

test('maybeCompact: fallo simulado al marcar turnos compactado -> el retry recompacta sin duplicar nodos', async () => {
  const { stores, semanticStores: real } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const sessionId = 's3';

  const turnIds = await insertarTurnosVivos(real, embedder, sessionId, 6);

  const fragil = makeSemanticStoresFragilTurnos(real, { failOnCall: 1, message: 'fallo simulado al marcar turno compactado' });
  const promoter = makePromoter({ stores, semanticStores: fragil, embedder, llm, threshold_tokens: 50 });

  await assert.rejects(() => promoter.maybeCompact({ sessionId, now: NOW }));

  // Estado tras el "crash": nodos y sesion ya escritos (orden de efectos del
  // contrato), turnos sin marcar (el marcado es lo último y falló).
  assert.equal(contarNodos(real), 2, 'los nodos deben quedar escritos aunque el marcado falle despues');
  assert.ok(leerSesion(stores, sessionId), 'la sesion debe quedar escrita aunque el marcado falle despues');
  assert.equal(turnosVivos(real, sessionId).length, turnIds.length, 'ningun turno debe quedar marcado tras el fallo');
  const idsNodosTrasFallo = real.get('nodes').keys().slice().sort();

  // Retry: mismo promoter (mismo wrapper, el fallo ya se consumió una vez).
  const res2 = await promoter.maybeCompact({ sessionId, now: NOW });

  assert.equal(res2.compacted, true);
  assert.equal(res2.promoted, 2);
  assert.equal(contarNodos(real), 2, 'el retry no debe duplicar nodos');
  const idsNodosTrasRetry = real.get('nodes').keys().slice().sort();
  assert.deepEqual(idsNodosTrasRetry, idsNodosTrasFallo, 'los ids de nodo deben ser deterministas: el retry reutiliza los mismos ids (upsert pisa)');

  assert.equal(turnosVivos(real, sessionId).length, 0, 'tras el retry todos los turnos quedan marcados compacted');
  assert.equal(turnosCompactados(real, sessionId).length, turnIds.length);
  assert.equal(llm.calls.length, 2, 'cada intento de maybeCompact hace su propia llamada al llm');
});

// =================================================================================
// PROMOTER: respuesta del llm que no es JSON válido
// =================================================================================

test("maybeCompact: llm que responde 'no soy json' -> Error con code 'PROMOTER' y cero escrituras", async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake('no soy json');
  const sessionId = 's4';

  const turnIds = await insertarTurnosVivos(semanticStores, embedder, sessionId, 6);
  const embedCallsAntes = embedder.calls.length;
  const nodosAntes = contarNodos(semanticStores);
  const sesionAntes = leerSesion(stores, sessionId);
  const vivosAntes = turnosVivos(semanticStores, sessionId).length;

  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });

  await assert.rejects(
    () => promoter.maybeCompact({ sessionId, now: NOW }),
    (err) => {
      assert.equal(err.code, 'PROMOTER');
      return true;
    }
  );

  assert.equal(llm.calls.length, 1, 'el llm se llama exactamente 1 vez aunque la respuesta sea invalida');
  assert.equal(embedder.calls.length, embedCallsAntes, 'no debe embeberse nada tras una respuesta invalida');
  assert.equal(contarNodos(semanticStores), nodosAntes, 'nodes debe quedar intacto');
  assert.equal(leerSesion(stores, sessionId), sesionAntes, 'sessions debe quedar intacto (sigue sin doc)');
  assert.equal(turnosVivos(semanticStores, sessionId).length, vivosAntes, 'ningun turno debe quedar marcado');
  assert.equal(turnosVivos(semanticStores, sessionId).length, turnIds.length);
});

// =================================================================================
// supersede
// =================================================================================

test('supersede: nodo nuevo con supersedes[oldId], viejo con superseded_by, retrieval solo devuelve el nuevo', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });

  const nodes = semanticStores.get('nodes');
  const [vOld] = await embedder.embed(['el retry acordado es 5 intentos'], { isQuery: false });
  nodes.upsert('n1', {
    title: 'retry acordado', body: 'el retry acordado es 5 intentos', kind: 'decision',
    tags: ['retry'], source_turns: ['s0:0:user'], created_at: '2026-01-01T00:00:00.000Z',
  }, vOld);

  const { newId } = await promoter.supersede('n1', { title: 'retry es 3', body: 'el retry acordado es 3, no 5' });

  assert.ok(typeof newId === 'string' && newId.length > 0 && newId !== 'n1');

  const nodoNuevo = nodes.get(newId);
  assert.ok(nodoNuevo, 'el nodo nuevo debe existir');
  assert.deepEqual(nodoNuevo.supersedes, ['n1']);
  assert.equal(nodoNuevo.superseded_by, undefined, 'el nodo nuevo nace sin superseded_by');
  assert.equal(nodoNuevo.kind, 'correction', 'kind por defecto es correction');
  assert.equal(nodoNuevo.body, 'el retry acordado es 3, no 5');

  const nodoViejo = nodes.get('n1');
  assert.equal(nodoViejo.superseded_by, newId);

  const encontrados = nodes.search([1, 1, 1], { limit: 10, filter: { superseded_by: { $exists: false } } });
  const idsEncontrados = encontrados.map((r) => r.id);
  assert.ok(idsEncontrados.includes(newId), 'el filtro debe devolver el nodo nuevo');
  assert.ok(!idsEncontrados.includes('n1'), 'el filtro NUNCA debe devolver el nodo viejo');
});

test("supersede: id inexistente -> Error con code 'NOT_FOUND'", async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });

  await assert.rejects(
    () => promoter.supersede('fantasma', { title: 'x', body: 'y' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    }
  );
  assert.equal(contarNodos(semanticStores), 0, 'no debe crearse ningun nodo si el viejo no existe');
});

test('supersede: cadena A<-B<-C — solo el ultimo queda recuperable con el filtro superseded_by $exists:false', async () => {
  const { stores, semanticStores } = makeEnv();
  const embedder = makeEmbedderFake();
  const llm = makeLlmFake(RESPUESTA_LLM_FACTS);
  const promoter = makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens: 50 });

  const nodes = semanticStores.get('nodes');
  const [vA] = await embedder.embed(['contenido A'], { isQuery: false });
  nodes.upsert('a1', { title: 'A', body: 'contenido A', kind: 'fact', tags: [] }, vA);

  const { newId: bId } = await promoter.supersede('a1', { title: 'B', body: 'contenido B' });
  const { newId: cId } = await promoter.supersede(bId, { title: 'C', body: 'contenido C' });

  assert.notEqual(bId, cId);
  assert.equal(nodes.get('a1').superseded_by, bId);
  assert.equal(nodes.get(bId).superseded_by, cId);
  assert.equal(nodes.get(cId).superseded_by, undefined);

  const encontrados = nodes.search([1, 1, 1], { limit: 10, filter: { superseded_by: { $exists: false } } });
  const idsEncontrados = encontrados.map((r) => r.id).sort();
  assert.deepEqual(idsEncontrados, [cId]);
  assert.ok(!idsEncontrados.includes('a1'));
  assert.ok(!idsEncontrados.includes(bId));
});

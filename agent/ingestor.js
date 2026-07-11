'use strict';

// agent/ingestor.js — persistencia del log crudo de turnos (contrato agent-ingestor).
// makeIngestor({ stores, semanticStores, embedder }) -> { ingestTurn, nextSeq }.
// Sin reloj interno: created_at deriva del argumento opcional `now` (ms epoch).
// Lógica en helpers de nivel de módulo; el factory solo cablea deps.

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

// VALIDATION: todos los argumentos antes de cualquier escritura.
function validateArgs({ sessionId, seq, userText, assistantText, assembly }) {
  if (!isNonEmptyString(sessionId)) fail('VALIDATION', 'sessionId debe ser string no vacío');
  if (typeof seq !== 'number') fail('VALIDATION', 'seq debe ser number');
  if (!isNonEmptyString(userText)) fail('VALIDATION', 'userText debe ser string no vacío');
  if (!isNonEmptyString(assistantText)) fail('VALIDATION', 'assistantText debe ser string no vacío');
  if (!isObject(assembly)) fail('VALIDATION', 'assembly debe ser object');
}

// created_at desde `now` inyectado (ms epoch); fallback determinista sin Date.now().
function isoFrom(now) {
  return Number.isFinite(now) ? new Date(now).toISOString() : '1970-01-01T00:00:00.000Z';
}

// Shape del doc de turno (sin `compacted`: ese campo lo agrega el promoter).
function buildTurnDoc(sessionId, role, text, seq, createdAt) {
  return { session_id: sessionId, role, text, seq, created_at: createdAt };
}

// Espejo documental idempotente del turno en stores.get('turns') (lo lee el assembler).
function mirrorTurn(store, id, doc) {
  if (store.get(id)) {
    store.update(id, doc);
  } else {
    store.insert(id, doc);
  }
}

// Persiste el par user/assistant: upsert semántico + espejo documental por rol.
// Fallo en el upsert del assistant -> code 'INGEST' con cause (par reparable por retry).
async function persistPair({ stores, semanticStores }, ids, docs, vectors) {
  const semanticTurns = semanticStores.get('turns');
  const docTurns = stores.get('turns');
  await semanticTurns.upsert(ids.userId, docs.userDoc, vectors[0]);
  mirrorTurn(docTurns, ids.userId, docs.userDoc);
  try {
    await semanticTurns.upsert(ids.assistantId, docs.assistantDoc, vectors[1]);
  } catch (cause) {
    const err = new Error(`fallo el upsert del turno assistant: ${cause.message}`);
    err.code = 'INGEST';
    err.cause = cause;
    throw err;
  }
  mirrorTurn(docTurns, ids.assistantId, docs.assistantDoc);
}

// Insert idempotente en la colección documental assemblies (_id existente = ya ingestado).
function persistAssembly(stores, assemblyId, assembly) {
  const store = stores.get('assemblies');
  if (!store.get(assemblyId)) {
    store.insert(assemblyId, assembly);
  }
}

async function ingestTurnImpl(deps, args) {
  validateArgs(args);
  const { sessionId, seq, userText, assistantText, assembly, now } = args;

  // EMBED: ambos textos en UN lote con isQuery falsy (prefijo documento).
  const vectors = await deps.embedder.embed([userText, assistantText], { isQuery: false });

  const createdAt = isoFrom(now);
  const userId = `${sessionId}:${seq}:user`;
  const assistantId = `${sessionId}:${seq}:assistant`;
  const userDoc = buildTurnDoc(sessionId, 'user', userText, seq, createdAt);
  const assistantDoc = buildTurnDoc(sessionId, 'assistant', assistantText, seq, createdAt);

  await persistPair(deps, { userId, assistantId }, { userDoc, assistantDoc }, vectors);
  persistAssembly(deps.stores, `${sessionId}:${seq}`, assembly);

  return { userId, assistantId };
}

// Lectura pura: max(seq) persistido de la sesión + 1, o 0 si no hay turnos.
async function nextSeqImpl(semanticStores, sessionId) {
  const docs = await semanticStores.get('turns').find({ session_id: sessionId });
  if (!docs || docs.length === 0) return 0;
  return Math.max(...docs.map((doc) => doc.seq)) + 1;
}

function makeIngestor({ stores, semanticStores, embedder }) {
  const deps = { stores, semanticStores, embedder };
  return {
    ingestTurn: (args) => ingestTurnImpl(deps, args),
    nextSeq: (sessionId) => nextSeqImpl(semanticStores, sessionId),
  };
}

module.exports = { makeIngestor };

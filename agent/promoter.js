'use strict';

const crypto = require('node:crypto');

/**
 * Extrae vectores de una colección semántica por API pública.
 * Llama serialize() UNA vez y devuelve Map id->vector para los ids solicitados.
 */
function vectorsOf(sc, ids) {
  const { records } = sc.serialize();
  const vectorMap = new Map();
  const idSet = new Set(ids);
  for (const rec of records) {
    if (idSet.has(rec.id)) {
      vectorMap.set(rec.id, rec.vector);
    }
  }
  return vectorMap;
}

/**
 * Turnos vivos (compacted !== true) de la sesión y su medida en tokens
 * con la heurística ceil(chars/4) del contrato.
 */
function liveTurnsAndTokens(turns, sessionId) {
  const turnos = turns.find({ session_id: sessionId }).filter((t) => t.compacted !== true);
  const totalChars = turnos.reduce((sum, t) => sum + ((t.text || '').length), 0);
  return { turnos, tokens: Math.ceil(totalChars / 4) };
}

/** Prompt de compactación: turnos + shape JSON esperado. */
function buildCompactionPrompt(turnos) {
  const turnosText = turnos.map((t) => `[${t.role}] ${t.text}`).join('\n\n');
  return `Resumen de conversación y extracción de hechos.\n\nTurnos:\n${turnosText}\n\n`
    + 'Devuelve JSON:\n{ "summary": "...", "facts": [{ "title": "...", "body": "...", "kind": "...", "tags": [...] }] }';
}

/**
 * Parsea la respuesta del LLM y valida el shape { summary: string, facts: array }.
 * Cualquier violación -> Error con code 'PROMOTER' (antes de toda escritura).
 */
function parseLlmJson(respuesta) {
  let datos;
  try {
    datos = JSON.parse(respuesta);
  } catch {
    const err = new Error('Respuesta del LLM no es JSON válido');
    err.code = 'PROMOTER';
    throw err;
  }
  if (typeof datos.summary !== 'string' || !Array.isArray(datos.facts)) {
    const err = new Error('Respuesta del LLM no tiene shape válido');
    err.code = 'PROMOTER';
    throw err;
  }
  return datos;
}

/**
 * EFECTO 1: embebe los bodies de los facts en UN lote (isQuery falsy) y upserta
 * los nodos promovidos con ids deterministas `${sessionId}:c${seq}:${i}`.
 * Devuelve la cantidad promovida.
 */
async function promoteNodes({ nodes, embedder, facts, sessionId, seq, turnos, now }) {
  const bodies = facts.map((f) => f.body);
  const vectors = await embedder.embed(bodies, { isQuery: false });
  const items = facts.map((fact, i) => ({
    id: `${sessionId}:c${seq}:${i}`,
    doc: {
      title: fact.title,
      body: fact.body,
      kind: fact.kind,
      tags: fact.tags,
      source_turns: turnos.map((t) => t._id),
      created_at: new Date(now).toISOString(),
    },
    vector: vectors[i],
  }));
  nodes.upsertMany(items);
  return items.length;
}

/**
 * EFECTO 2: persiste el resumen en `sessions` (insert si no existe, update si sí).
 * Devuelve summary_tokens.
 */
function upsertSession(sessions, sessionId, summary, seq) {
  const summaryTokens = Math.ceil(summary.length / 4);
  const doc = { summary, summary_tokens: summaryTokens, last_compaction_seq: seq };
  const sesion = sessions.get(sessionId);
  if (sesion) {
    sessions.update(sessionId, { ...sesion, ...doc });
  } else {
    sessions.insert(sessionId, doc);
  }
  return summaryTokens;
}

/**
 * EFECTO 3: marca turnos como compacted: true en la colección semántica
 * (re-upsert doc+vector para preservar el vector) y en el espejo documental
 * que lee el assembler (si el doc existe en el espejo; si no, sigue sin error).
 */
function markCompacted(turns, docStore, turnos) {
  if (turnos.length === 0) return;
  const ids = turnos.map(t => t._id);
  const vectors = vectorsOf(turns, ids);
  for (const turno of turnos) {
    const vector = vectors.get(turno._id);
    turns.upsert(turno._id, { ...turno, compacted: true }, vector);
    const existing = docStore.get(turno._id);
    if (existing) docStore.update(turno._id, { ...existing, compacted: true });
  }
}

/**
 * Lógica de maybeCompact a nivel de módulo (patrón deps).
 * deps = { stores, semanticStores, embedder, llm, threshold_tokens }.
 *
 * Compactación de historial: cuando los turnos vivos de una sesión superan
 * el umbral, resume con el LLM inyectado, persiste en sessions, promueve
 * hechos a nodos, y marca turnos como compactados.
 */
async function maybeCompactImpl(deps, { sessionId, now }) {
  const { stores, semanticStores, embedder, llm, threshold_tokens } = deps;
  const turns = semanticStores.get('turns');
  const sessions = stores.get('sessions');

  const { turnos, tokens } = liveTurnsAndTokens(turns, sessionId);
  if (tokens <= threshold_tokens) {
    return { compacted: false, summaryTokens: 0, promoted: 0 };
  }

  // UNA sola llamada al LLM; parse/validación antes de toda escritura.
  const respuesta = await llm({
    system: 'Eres un asistente que resume conversaciones y extrae hechos clave.',
    prompt: buildCompactionPrompt(turnos),
  });
  const datos = parseLlmJson(respuesta);

  // Seq derivado del batch: max seq de los turnos vivos a compactar (determinista).
  const seq = turnos.length > 0 ? Math.max(...turnos.map(t => t.seq)) : 1;

  const promoted = await promoteNodes({
    nodes: semanticStores.get('nodes'), embedder,
    facts: datos.facts, sessionId, seq, turnos, now,
  });
  const summaryTokens = upsertSession(sessions, sessionId, datos.summary, seq);
  markCompacted(turns, stores.get('turns'), turnos);

  return { compacted: true, summaryTokens, promoted };
}

/**
 * Lógica de supersede a nivel de módulo (patrón deps).
 * deps = { stores, semanticStores, embedder, llm, threshold_tokens }.
 */
async function supersedeImpl(deps, oldId, correction) {
  const { semanticStores, embedder } = deps;
  const nodes = semanticStores.get('nodes');
  const nodoViejo = nodes.get(oldId);
  if (!nodoViejo) {
    const err = new Error(`Nodo "${oldId}" no existe`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  // newId determinista: derivado de (oldId, correction.body) por sha256 truncado.
  const newId = 'sup:' + crypto.createHash('sha256')
    .update(oldId + '\n' + correction.body)
    .digest('hex')
    .slice(0, 16);
  const [vector] = await embedder.embed([correction.body], { isQuery: false });

  // Nuevo primero (nace sin superseded_by), marcado del viejo después.
  nodes.upsert(newId, {
    title: correction.title,
    body: correction.body,
    kind: correction.kind || 'correction',
    tags: correction.tags || [],
    supersedes: [oldId],
  }, vector);

  const vectors = vectorsOf(nodes, [oldId]);
  const oldVector = vectors.get(oldId);
  nodes.upsert(oldId, { ...nodoViejo, superseded_by: newId }, oldVector);

  return { newId };
}

/**
 * makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens })
 * -> { maybeCompact({ sessionId, now }), supersede(oldId, correction) }
 */
function makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens }) {
  const deps = { stores, semanticStores, embedder, llm, threshold_tokens };
  return {
    maybeCompact: (args) => maybeCompactImpl(deps, args),
    supersede: (oldId, correction) => supersedeImpl(deps, oldId, correction),
  };
}

module.exports = { makePromoter };

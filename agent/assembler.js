'use strict';

// agent/assembler.js — ensamblador determinista de contexto por slots (S0-S4).
// Contract: knowledge/contracts/agent-assembler.md

const crypto = require('node:crypto');

// Separador de slots fijo (parte del byte-a-byte del context)
const SLOT_SEP = '\n---\n';

// Orden fijo de slots (volatilidad creciente) y prioridad de presupuesto
const SLOT_ORDER = ['S0', 'S1', 'S2', 'S3', 'S4'];
const BUDGET_PRIORITY = ['S0', 'S1', 'S2', 'S4', 'S3'];

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function calcTokens(text) {
  return Math.ceil(text.length / 4);
}

function validateRegexPatterns(patterns) {
  for (const p of patterns) {
    try {
      new RegExp(p);
    } catch (e) {
      const err = new Error(`Invalid regex pattern: ${p}`);
      err.code = 'VALIDATION';
      throw err;
    }
  }
}

function getLastTurnMs(turns) {
  if (!turns || turns.length === 0) return null;
  let maxMs = null;
  for (const turn of turns) {
    const ms = new Date(turn.created_at).getTime();
    if (maxMs === null || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function getModeFromLastTurn(lastTurnMs, now, ttlMs) {
  if (lastTurnMs === null) return 'interactivo';
  return now - lastTurnMs > ttlMs ? 'esporadico' : 'interactivo';
}

function sortByScoreThenId(results) {
  return results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.id.localeCompare(b.id);
  });
}

// Extrae todos los turnos de una sesion en orden seq ascendente
function getTurnsForSession(stores, sessionId) {
  const all = stores.get('turns').find({});
  const sessionTurns = all.filter((turn) => turn.session_id === sessionId);
  sessionTurns.sort((a, b) => a.seq - b.seq);
  return sessionTurns;
}

// ---------------------------------------------------------------------------
// Construccion de slots
// ---------------------------------------------------------------------------

// S0 (system + indice pinned) y S1 (resumen vigente de la sesion)
function buildS0S1({ stores, sessionId, config }) {
  const s0Text = config.system || '';
  const sessionDoc = stores.get('sessions').get(sessionId);
  const s1Text = sessionDoc && sessionDoc.summary ? sessionDoc.summary : '';
  return {
    S0: { tokens: calcTokens(s0Text), text: s0Text },
    S1: { tokens: calcTokens(s1Text), text: s1Text },
  };
}

// S2: historial vivo (turns con compacted != true, seq asc); vacio en esporadico
function buildS2({ turns, mode }) {
  if (mode !== 'interactivo') return { tokens: 0, text: '' };
  const liveTurns = turns.filter((t) => !t.compacted);
  const s2Text = liveTurns.map((turn) => turn.text).join('');
  return { tokens: calcTokens(s2Text), text: s2Text };
}

// Guardrails: cada patron de regex_deny se testea REAL sobre el body recuperado
function checkGuardrails(body, patterns) {
  for (const pattern of patterns) {
    if (new RegExp(pattern).test(body)) {
      const err = new Error(
        `Guardrail violation: pattern "${pattern}" matched in retrieved content`
      );
      err.code = 'GUARDRAIL';
      throw err;
    }
  }
}

// S3: retrieval hibrido sobre nodes (excluye superseded, desempata por id) + guardrails
async function buildS3({ semanticStores, queryVector, turnText, config }) {
  const collection = semanticStores.get('nodes');
  const results = await collection.searchHybrid(queryVector, turnText, {
    limit: config.retrieval_k || 8,
    textField: 'body',
    filter: { superseded_by: { $exists: false } },
  });
  sortByScoreThenId(results);

  const patterns = config.regex_deny || [];
  const items = results.map((result) => {
    const body = (result.doc && result.doc.body) || '';
    checkGuardrails(body, patterns);
    return { id: result.id, score: result.score, text: body, tokens: calcTokens(body) };
  });

  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);
  return { tokens: totalTokens, items, selectedItems: items };
}

// ---------------------------------------------------------------------------
// Presupuesto
// ---------------------------------------------------------------------------

// S2 nunca se trunca parcialmente: entra completo o queda fuera (truncated:true)
function allocateS2(slot, remaining, mode) {
  if (mode === 'esporadico') {
    return { allocated: 0, included: false, truncated: false };
  }
  if (slot.tokens <= remaining) {
    return { allocated: slot.tokens, included: true, truncated: false };
  }
  return { allocated: 0, included: false, truncated: true };
}

// Recorta S3 item a item desde el peor score (items ya ordenados mejor->peor)
function trimS3Items(slot, allocated) {
  let tokensUsed = 0;
  const selected = [];
  for (const item of slot.items) {
    if (tokensUsed + item.tokens <= allocated) {
      selected.push(item);
      tokensUsed += item.tokens;
    }
  }
  slot.selectedItems = selected;
}

// Prioridad de asignacion: S0, S1, S2, S4, S3 (S3 es lo primero que se recorta)
function allocateBudget(slots, availableTokens, mode) {
  const result = {};
  let remaining = availableTokens;

  for (const slotId of BUDGET_PRIORITY) {
    const slot = slots[slotId];
    if (slotId === 'S2') {
      result[slotId] = allocateS2(slot, remaining, mode);
      remaining -= result[slotId].allocated;
      continue;
    }
    const toAllocate = Math.min(slot.tokens, remaining);
    result[slotId] = {
      allocated: toAllocate,
      included: toAllocate > 0,
      truncated: slot.tokens > toAllocate && toAllocate > 0,
    };
    remaining -= toAllocate;
  }

  if (result.S3.included && result.S3.truncated) {
    trimS3Items(slots.S3, result.S3.allocated);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Context y reporte
// ---------------------------------------------------------------------------

function slotParts(slotId, slot) {
  if (slotId === 'S3') {
    return (slot.selectedItems || []).map((item) => item.text).filter((t) => t.length > 0);
  }
  return slot.text && slot.text.length > 0 ? [slot.text] : [];
}

// Concatena los slots incluidos, en orden fijo S0..S4, con SLOT_SEP
function buildContext(slots, budget) {
  const parts = [];
  for (const slotId of SLOT_ORDER) {
    if (!budget[slotId].included) continue;
    parts.push(...slotParts(slotId, slots[slotId]));
  }
  return parts.join(SLOT_SEP);
}

// Reporte por slot: tokens reales incluidos (0 si quedo fuera), included, truncated
function buildSlotsReport(budget, slots) {
  return SLOT_ORDER.map((id) => {
    const alloc = budget[id];
    const tokens = alloc.included ? Math.min(slots[id].tokens, alloc.allocated) : 0;
    return { id, tokens, included: alloc.included, truncated: alloc.truncated };
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeAssembler({ stores, semanticStores, embedder, config }) {
  validateRegexPatterns(config.regex_deny || []);

  const availableTokens = config.max_tokens - config.output_reserve;
  if (availableTokens <= 0) {
    const err = new Error('Presupuesto disponible debe ser > 0');
    err.code = 'VALIDATION';
    throw err;
  }

  async function assemble({ sessionId, turnText, now }) {
    const turns = getTurnsForSession(stores, sessionId);
    const mode = getModeFromLastTurn(getLastTurnMs(turns), now, config.ttl_ms);

    const queryVectors = await embedder.embed([turnText], { isQuery: true });
    const queryVector = queryVectors[0];

    const { S0, S1 } = buildS0S1({ stores, sessionId, config });
    const S2 = buildS2({ turns, mode });
    const S3 = await buildS3({ semanticStores, queryVector, turnText, config });
    const S4 = { tokens: calcTokens(turnText), text: turnText };

    const slots = { S0, S1, S2, S3, S4 };
    const budget = allocateBudget(slots, availableTokens, mode);
    const context = buildContext(slots, budget);
    const sha256 = crypto.createHash('sha256').update(context, 'utf8').digest('hex');

    return { context, sha256, slots: buildSlotsReport(budget, slots), mode };
  }

  return { assemble };
}

module.exports = { makeAssembler };

// Tests congelados del módulo agent/loop.js.
//
// Cubren la semántica fijada en knowledge/contracts/agent-loop.md:
//   - orden FIJO del turno: assembler.assemble -> llm -> ingestor.ingestTurn ->
//     promoter.maybeCompact (verificado con un array compartido `eventos` donde
//     cada fake pushea su nombre al ser llamado)
//   - turno feliz devuelve { reply, seq: 0, assembly, compaction } y un segundo
//     turno en la misma sesión da seq: 1
//   - seq monotónico DERIVADO DEL ESTADO PERSISTIDO (no de memoria): un makeLoop
//     nuevo sobre el MISMO ingestor con 2 turnos ya persistidos asigna seq 2
//     (simula reinicio del proceso)
//   - fallo del llm -> err.code 'LLM' con err.cause, ingestor y promoter NO
//     llamados, estado intacto
//   - fallo del assembler (p.ej. GUARDRAIL) -> burbujea TAL CUAL (misma
//     identidad de error), el llm NO fue llamado
//   - fallo del ingestor DESPUÉS del llm -> el error burbujea con err.reply
//     igual a la respuesta del llm
//   - compaction reportada: un promoter que compacta aparece en el resultado
//   - `now` se propaga IDÉNTICO a assembler, ingestor y promoter (no al llm)
//   - caso de integración: assembler + ingestor + promoter REALES
//     (agent/assembler.js, agent/ingestor.js, agent/promoter.js) cableados
//     sobre js-base real en memoria, con embedder fake dim 3 y llm fake — un
//     turno feliz end-to-end (reply correcto, turno persistido en `turns`,
//     assembly persistido en `assemblies`)
//
// NOTA DE DISEÑO (seq derivado del estado persistido):
// El contrato fija la firma `makeLoop({ assembler, ingestor, promoter, llm,
// config })` — SIN acceso directo a `stores` — pero exige que `seq` se derive
// del estado persistido "vía el ingestor/stores" (no de un contador en
// memoria). La única vía compatible con esa firma es que el INGESTOR exponga,
// además de `ingestTurn`, una forma de consultar el próximo seq de una sesión
// a partir de lo ya persistido. Estos tests fijan esa capacidad como
// `ingestor.nextSeq(sessionId) -> number` (0 si la sesión no tiene turnos
// persistidos, o `max(seq) + 1` si los tiene). Es una extensión MÍNIMA sobre
// lo documentado en agent-ingestor.md (que solo detalla `ingestTurn`), no una
// contradicción: agent-ingestor.md no prohíbe métodos adicionales, y
// agent-loop.md habilita explícitamente "documentar y proponer índice del
// vendor" si la derivación de seq lo exige. Quien implemente agent/ingestor.js
// deberá exponer `nextSeq` para que agent/loop.js supere este archivo.
//
// Ejecutar: node --test tests/agent-loop.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeLoop } = require('../agent/loop.js');

const { DocStore, MemoryStorageAdapter } = require('../src/vendor/js-store/vendor/js-doc-store.js');
const { CollectionRegistry } = require('../src/collections.js');
const { makeStores } = require('../src/store-provider.js');
const { makeSemanticStores } = require('../src/semantic-provider.js');
const { makeAssembler } = require('../agent/assembler.js');
const { makeIngestor } = require('../agent/ingestor.js');
const { makePromoter } = require('../agent/promoter.js');

// ---------------------------------------------------------------------------
// Fakes de las 4 dependencias, con un array `eventos` COMPARTIDO donde cada
// fake pushea `{ who, now }` al ser invocado (verifica orden Y propagación de
// `now` a la vez). `onCall` permite forzar fallos o respuestas custom por test
// sin duplicar la fábrica.
// ---------------------------------------------------------------------------

function crearEventos() {
  return [];
}

function assemblerFalso(eventos, { onCall } = {}) {
  return {
    async assemble({ sessionId, turnText, now }) {
      eventos.push({ who: 'assembler', now });
      if (onCall) return onCall({ sessionId, turnText, now });
      return {
        context: `S0..S4:${turnText}`,
        sha256: `sha-${turnText}`,
        slots: [{ id: 'S0', tokens: 10, included: true, truncated: false }],
        mode: 'interactivo',
      };
    },
  };
}

function llmFalso(eventos, { onCall, reply = 'buenas' } = {}) {
  const calls = [];
  const fn = async ({ context }) => {
    calls.push({ context });
    eventos.push({ who: 'llm' });
    if (onCall) return onCall({ context });
    return reply;
  };
  fn.calls = calls;
  return fn;
}

// El ingestor falso simula el "estado persistido" con un Map en memoria
// (sessionId -> turnos ingestados). `nextSeq` lee ESE estado, no un contador
// aparte, así que reusar la MISMA instancia entre dos `makeLoop` distintos
// simula fielmente un reinicio del proceso sobre los mismos stores.
function ingestorFalso(eventos, { onCall } = {}) {
  const persisted = new Map();
  const calls = [];
  return {
    calls,
    persisted,
    nextSeq(sessionId) {
      const turnos = persisted.get(sessionId) || [];
      if (turnos.length === 0) return 0;
      return Math.max(...turnos.map((t) => t.seq)) + 1;
    },
    async ingestTurn({ sessionId, seq, userText, assistantText, assembly, now }) {
      calls.push({ sessionId, seq, userText, assistantText, assembly, now });
      eventos.push({ who: 'ingestor', now });
      if (onCall) return onCall({ sessionId, seq, userText, assistantText, assembly, now });
      const turnos = persisted.get(sessionId) || [];
      turnos.push({ seq, userText, assistantText, now });
      persisted.set(sessionId, turnos);
      return { userId: `${sessionId}:${seq}:user`, assistantId: `${sessionId}:${seq}:assistant` };
    },
  };
}

function promoterFalso(eventos, { onCall, resultado } = {}) {
  const calls = [];
  return {
    calls,
    async maybeCompact({ sessionId, now }) {
      calls.push({ sessionId, now });
      eventos.push({ who: 'promoter', now });
      if (onCall) return onCall({ sessionId, now });
      return resultado || { compacted: false, summaryTokens: 0, promoted: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Casos con las 4 dependencias FAKE.
// ---------------------------------------------------------------------------

test('orden FIJO del turno: assembler -> llm -> ingestor -> promoter', async () => {
  const eventos = crearEventos();
  const loop = makeLoop({
    assembler: assemblerFalso(eventos),
    ingestor: ingestorFalso(eventos),
    promoter: promoterFalso(eventos),
    llm: llmFalso(eventos),
    config: {},
  });

  await loop.turn({ sessionId: 's-orden', userText: 'hola', now: 1000 });

  assert.deepEqual(eventos.map((e) => e.who), ['assembler', 'llm', 'ingestor', 'promoter']);
});

test('turno feliz: { reply, seq: 0, assembly, compaction }; segundo turno da seq 1', async () => {
  const eventos = crearEventos();
  const loop = makeLoop({
    assembler: assemblerFalso(eventos),
    ingestor: ingestorFalso(eventos),
    promoter: promoterFalso(eventos),
    llm: llmFalso(eventos, { reply: 'buenas' }),
    config: {},
  });

  const now = 1700000000000;
  const res = await loop.turn({ sessionId: 's1', userText: 'hola', now });

  assert.equal(res.reply, 'buenas');
  assert.equal(res.seq, 0);
  assert.equal(res.assembly.mode, 'interactivo');
  assert.equal(typeof res.assembly.sha256, 'string');
  assert.deepEqual(res.compaction, { compacted: false, summaryTokens: 0, promoted: 0 });

  const res2 = await loop.turn({ sessionId: 's1', userText: 'y ahora?', now: now + 1000 });
  assert.equal(res2.seq, 1);
});

test('seq monotónico derivado del estado persistido: makeLoop nuevo sobre el mismo ingestor asigna seq 2 tras "reinicio"', async () => {
  const eventos1 = crearEventos();
  const ingestor = ingestorFalso(eventos1); // se reutiliza entre los dos loops
  const loop1 = makeLoop({
    assembler: assemblerFalso(eventos1),
    ingestor,
    promoter: promoterFalso(eventos1),
    llm: llmFalso(eventos1),
    config: {},
  });

  const r0 = await loop1.turn({ sessionId: 's-restart', userText: 'uno', now: 1 });
  const r1 = await loop1.turn({ sessionId: 's-restart', userText: 'dos', now: 2 });
  assert.equal(r0.seq, 0);
  assert.equal(r1.seq, 1);

  // "Reinicio del proceso": instancia NUEVA de loop, sin memoria propia, sobre
  // el MISMO ingestor (mismos "stores" persistidos).
  const eventos2 = crearEventos();
  const loop2 = makeLoop({
    assembler: assemblerFalso(eventos2),
    ingestor,
    promoter: promoterFalso(eventos2),
    llm: llmFalso(eventos2),
    config: {},
  });
  const r2 = await loop2.turn({ sessionId: 's-restart', userText: 'tres', now: 3 });
  assert.equal(r2.seq, 2);
});

test('fallo del llm -> err.code "LLM" con err.cause; ingestor y promoter NO llamados, estado intacto', async () => {
  const eventos = crearEventos();
  const llmErr = new Error('rate limited');
  const ingestor = ingestorFalso(eventos);
  const promoter = promoterFalso(eventos);
  const loop = makeLoop({
    assembler: assemblerFalso(eventos),
    ingestor,
    promoter,
    llm: llmFalso(eventos, { onCall: () => { throw llmErr; } }),
    config: {},
  });

  await assert.rejects(
    () => loop.turn({ sessionId: 's-llmfail', userText: 'hola', now: 1 }),
    (err) => err.code === 'LLM' && err.cause === llmErr
  );

  assert.equal(ingestor.calls.length, 0);
  assert.equal(promoter.calls.length, 0);
  assert.equal(ingestor.persisted.size, 0);
  assert.deepEqual(eventos.map((e) => e.who), ['assembler', 'llm']);
});

test('fallo del assembler (GUARDRAIL) -> burbujea TAL CUAL, el llm NO fue llamado', async () => {
  const eventos = crearEventos();
  const guardErr = new Error('GUARDRAIL: password:');
  guardErr.code = 'GUARDRAIL';
  const llm = llmFalso(eventos);
  const loop = makeLoop({
    assembler: assemblerFalso(eventos, { onCall: () => { throw guardErr; } }),
    ingestor: ingestorFalso(eventos),
    promoter: promoterFalso(eventos),
    llm,
    config: {},
  });

  await assert.rejects(
    () => loop.turn({ sessionId: 's-guard', userText: 'password: hunter2', now: 1 }),
    (err) => err === guardErr && err.code === 'GUARDRAIL'
  );

  assert.equal(llm.calls.length, 0);
  assert.deepEqual(eventos.map((e) => e.who), ['assembler']);
});

test('fallo del ingestor DESPUÉS del llm -> el error burbujea con err.reply === respuesta del llm', async () => {
  const eventos = crearEventos();
  const ingestErr = new Error('fallo simulado de escritura');
  ingestErr.code = 'INGEST';
  const loop = makeLoop({
    assembler: assemblerFalso(eventos),
    ingestor: ingestorFalso(eventos, { onCall: () => { throw ingestErr; } }),
    promoter: promoterFalso(eventos),
    llm: llmFalso(eventos, { reply: 'buenas' }),
    config: {},
  });

  await assert.rejects(
    () => loop.turn({ sessionId: 's-ingfail', userText: 'hola', now: 1 }),
    (err) => err.code === 'INGEST' && err.reply === 'buenas'
  );
});

test('compaction reportada: un promoter que compacta aparece en el resultado', async () => {
  const eventos = crearEventos();
  const promoter = promoterFalso(eventos, {
    resultado: { compacted: true, summaryTokens: 500, promoted: 2 },
  });
  const loop = makeLoop({
    assembler: assemblerFalso(eventos),
    ingestor: ingestorFalso(eventos),
    promoter,
    llm: llmFalso(eventos),
    config: {},
  });

  const res = await loop.turn({ sessionId: 's-compact', userText: 'hola', now: 1 });

  assert.deepEqual(res.compaction, { compacted: true, summaryTokens: 500, promoted: 2 });
  assert.deepEqual(eventos.map((e) => e.who), ['assembler', 'llm', 'ingestor', 'promoter']);
});

test('now se propaga idéntico a assembler, ingestor y promoter (el llm no recibe now)', async () => {
  const eventos = crearEventos();
  const loop = makeLoop({
    assembler: assemblerFalso(eventos),
    ingestor: ingestorFalso(eventos),
    promoter: promoterFalso(eventos),
    llm: llmFalso(eventos),
    config: {},
  });

  const now = 1735689600123;
  await loop.turn({ sessionId: 's-now', userText: 'hola', now });

  const nowPorQuien = Object.fromEntries(
    eventos.filter((e) => e.who !== 'llm').map((e) => [e.who, e.now])
  );
  assert.equal(nowPorQuien.assembler, now);
  assert.equal(nowPorQuien.ingestor, now);
  assert.equal(nowPorQuien.promoter, now);
});

// ---------------------------------------------------------------------------
// Caso de integración: piezas REALES (assembler/ingestor/promoter) cableadas
// sobre js-base real en memoria, con embedder fake dim 3 y llm fake. Se espera
// que este test también quede ROJO hoy (agent/loop.js, agent/assembler.js,
// agent/ingestor.js y agent/promoter.js no existen todavía).
// ---------------------------------------------------------------------------

const EMBED_DIM = 3;

function embedderFalsoDim3() {
  return {
    async embed(texts, { isQuery = false } = {}) {
      return texts.map((t) => {
        const base = t.length + (isQuery ? 1000 : 0);
        const v = new Array(EMBED_DIM);
        for (let i = 0; i < EMBED_DIM; i += 1) {
          v[i] = ((base + i) % 97) / 97;
        }
        return v;
      });
    },
  };
}

function crearRegistryAgente() {
  const db = new DocStore(new MemoryStorageAdapter());
  const registry = new CollectionRegistry(db);

  registry.create({
    name: 'sessions',
    fields: [
      { name: 'summary', type: 'string' },
      { name: 'summary_tokens', type: 'number' },
      { name: 'last_compaction_seq', type: 'number' },
    ],
    rules: {},
    vector: null,
  });

  registry.create({
    name: 'turns',
    fields: [
      { name: 'session_id', type: 'string', required: true },
      { name: 'role', type: 'string', required: true },
      { name: 'text', type: 'string', required: true },
      { name: 'seq', type: 'number', required: true },
      { name: 'created_at', type: 'string', required: true },
      { name: 'compacted', type: 'boolean' },
    ],
    rules: {},
    vector: { dim: EMBED_DIM },
  });

  registry.create({
    name: 'assemblies',
    fields: [
      { name: 'sha256', type: 'string', required: true },
      { name: 'slots', type: 'array', required: true },
      { name: 'mode', type: 'string', required: true },
    ],
    rules: {},
    vector: null,
  });

  registry.create({
    name: 'nodes',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string', required: true },
      { name: 'kind', type: 'string' },
      { name: 'tags', type: 'array' },
      { name: 'source_turns', type: 'array' },
      { name: 'supersedes', type: 'array' },
      { name: 'superseded_by', type: 'string' },
      { name: 'created_at', type: 'string' },
    ],
    rules: {},
    vector: { dim: EMBED_DIM },
  });

  return { db, registry };
}

test('[integración] turno feliz end-to-end con assembler/ingestor/promoter reales sobre js-base en memoria', async () => {
  const { registry } = crearRegistryAgente();
  const stores = makeStores(registry.db);
  const semanticStores = makeSemanticStores({ registry });
  const embedder = embedderFalsoDim3();

  const assembler = makeAssembler({
    stores,
    semanticStores,
    embedder,
    config: {
      system: 'Sos un agente de prueba.',
      max_tokens: 2000,
      output_reserve: 200,
      retrieval_k: 4,
      ttl_ms: 300000,
      regex_deny: [],
    },
  });
  const ingestor = makeIngestor({ stores, semanticStores, embedder });
  const promoterLlm = async () => {
    throw new Error('el llm del promoter no debería llamarse en este test (umbral no cruzado)');
  };
  const promoter = makePromoter({
    stores,
    semanticStores,
    embedder,
    llm: promoterLlm,
    threshold_tokens: 20000,
  });
  const llm = async () => 'buenas';

  const loop = makeLoop({ assembler, ingestor, promoter, llm, config: {} });

  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const res = await loop.turn({ sessionId: 's-integ', userText: 'hola', now });

  assert.equal(res.reply, 'buenas');
  assert.equal(res.seq, 0);
  assert.equal(res.assembly.mode, 'interactivo');
  assert.equal(typeof res.assembly.sha256, 'string');
  assert.equal(res.compaction.compacted, false);

  const turnosPersistidos = semanticStores.get('turns').find({ session_id: 's-integ' });
  assert.equal(turnosPersistidos.length, 2);

  const assembliesPersistidas = stores.get('assemblies').find({});
  assert.equal(assembliesPersistidas.length, 1);
});

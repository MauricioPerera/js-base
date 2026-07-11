'use strict';
// Demo end-to-end del agente de contexto dinámico (CONTRACT-10/11) — TODO REAL:
// js-base embebido en modo DISCO + embeddinggemma (Ollama) + gemma4 (Ollama) como LLM.
//
// Requisitos: Ollama corriendo en localhost:11434 con los modelos `embeddinggemma`
// (dim 768) y `gemma4`. Sin npm install: cero dependencias, como todo el repo.
//
//   node examples/agent-demo.js
//
// Qué demuestra: retrieval alimentando la inferencia (turno 0), corrección por
// supersede que PREVALECE sobre la historia sin editarla (turno 1), compactación
// real con promoción de hechos, régimen esporádico por TTL (turno 2, S2 omitido),
// y continuidad tras reinicio del proceso (nextSeq desde estado persistido).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createServer } = require('../src/app.js');
const { makeEmbedder } = require('../agent/embedder.js');
const { makeAssembler } = require('../agent/assembler.js');
const { makeIngestor } = require('../agent/ingestor.js');
const { makePromoter } = require('../agent/promoter.js');
const { makeLoop } = require('../agent/loop.js');

const OLLAMA = 'http://localhost:11434';

// LLM del turno: recibe el contexto ensamblado (S0..S4) y devuelve la respuesta.
async function llmChat({ context }) {
  const res = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemma4', stream: false,
      messages: [{ role: 'user', content: context }],
      options: { temperature: 0 },
    }),
  });
  return (await res.json()).message.content;
}

// LLM del promoter: debe devolver JSON { summary, facts } — format:'json' lo fuerza.
async function llmJson({ system, prompt }) {
  const res = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemma4', stream: false, format: 'json',
      messages: [
        { role: 'system', content: system + ' Responde UNICAMENTE el objeto JSON pedido, sin texto extra.' },
        { role: 'user', content: prompt },
      ],
      options: { temperature: 0 },
    }),
  });
  return (await res.json()).message.content;
}

function slotLine(a) {
  return a.slots.map((s) => `${s.id}${s.included ? '' : '(omitido)'}:${s.tokens}t`).join(' ');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-demo-'));
  console.log('dataDir:', dataDir, '\n');

  // ── 1. js-base embebido (disco) + colecciones del agente ──────────────────
  let srv = await createServer({ dataDir, secret: 'demo-secret-de-16-chars!' });
  const defs = [
    { name: 'nodes', dim: 768 }, { name: 'turns', dim: 768 },
    { name: 'sessions', dim: null }, { name: 'assemblies', dim: null },
  ];
  for (const d of defs) {
    srv.registry.create({
      name: d.name, fields: [],
      rules: { list: null, view: null, create: null, update: null, delete: null },
      vector: d.dim ? { dim: d.dim } : null,
    });
  }

  // ── 2. Piezas del agente, cableadas ────────────────────────────────────────
  const embedder = makeEmbedder({}); // Ollama real, embeddinggemma, dim 768
  const wire = (s) => ({ stores: s.stores, semanticStores: s.semanticStores, embedder });
  const assembler = makeAssembler({ ...wire(srv), config: {
    system: 'Sos el asistente del proyecto. Debajo va conocimiento curado recuperado y la conversacion. ' +
            'REGLA: los nodos de conocimiento (especialmente correcciones) PREVALECEN sobre lo dicho antes en la conversacion. ' +
            'Responde en una sola frase, en espanol.',
    max_tokens: 16000, output_reserve: 3000, retrieval_k: 4,
    ttl_ms: 300000, regex_deny: ['api_key='],
  }});
  const ingestor = makeIngestor(wire(srv));
  const promoter = makePromoter({ ...wire(srv), llm: llmJson, threshold_tokens: 60 });
  const loop = makeLoop({ assembler, ingestor, promoter, llm: llmChat, config: {} });

  // ── 3. Sembrar conocimiento curado ────────────────────────────────────────
  const seedBody = 'El retry acordado para las llamadas al API externo es de 5 intentos con backoff exponencial.';
  const [seedVec] = await embedder.embed([seedBody]);
  srv.semanticStores.get('nodes').upsert('decision-retry',
    { title: 'Politica de retry', body: seedBody, kind: 'decision', created_at: new Date().toISOString() }, seedVec);
  console.log('[seed] nodo "decision-retry": retry = 5 intentos\n');

  const S = 'demo';

  // ── 4. Turno 1: el retrieval alimenta al LLM ──────────────────────────────
  let r = await loop.turn({ sessionId: S, userText: 'cuantos intentos de retry usamos contra el API externo?', now: Date.now() });
  console.log(`[turno ${r.seq}] modo=${r.assembly.mode} sha=${r.assembly.sha256.slice(0, 12)}`);
  console.log('  slots:', slotLine(r.assembly));
  console.log('  LLM :', r.reply.trim(), '\n');

  // ── 5. Corrección por supersede (sin editar nada) ─────────────────────────
  const { newId } = await promoter.supersede('decision-retry', {
    title: 'Politica de retry (corregida)',
    body: 'CORRECCION vigente: el retry para el API externo es de 3 intentos, no 5. La politica anterior queda obsoleta.',
  });
  console.log(`[supersede] decision-retry -> ${newId} (retry = 3)\n`);

  // ── 6. Turno 2: misma pregunta; el nodo corregido debe prevalecer ─────────
  r = await loop.turn({ sessionId: S, userText: 'repetime: cuantos intentos de retry usamos contra el API externo?', now: Date.now() });
  console.log(`[turno ${r.seq}] modo=${r.assembly.mode} sha=${r.assembly.sha256.slice(0, 12)}`);
  console.log('  slots:', slotLine(r.assembly));
  console.log('  LLM :', r.reply.trim());
  console.log('  compactacion:', JSON.stringify(r.compaction), '\n');

  // ── 7. Turno 3 "10 minutos despues": regimen esporadico (S2 omitido) ──────
  r = await loop.turn({ sessionId: S, userText: 'y el retry del API externo, cuantos intentos era?', now: Date.now() + 10 * 60 * 1000 });
  console.log(`[turno ${r.seq}] modo=${r.assembly.mode} sha=${r.assembly.sha256.slice(0, 12)}`);
  console.log('  slots:', slotLine(r.assembly));
  console.log('  LLM :', r.reply.trim(), '\n');

  // ── 8. Estado persistido + reinicio del proceso ───────────────────────────
  const sess = srv.stores.get('sessions').get(S);
  console.log('[estado] resumen de sesion:', sess && sess.summary ? JSON.stringify(sess.summary).slice(0, 140) : '(sin compactar aun)');
  console.log('[estado] turnos persistidos:', srv.stores.get('turns').count({}), '| assemblies:', srv.stores.get('assemblies').count({}));

  // js-base NO flushea el lado documental en close() (trade-off documentado en
  // app.js / app-integration.md): para sobrevivir reinicios hay que flushear.
  srv.db.flush();
  await srv.close();
  srv = await createServer({ dataDir, secret: 'demo-secret-de-16-chars!' });
  const ingestor2 = makeIngestor({ stores: srv.stores, semanticStores: srv.semanticStores, embedder });
  console.log('[reinicio] nextSeq tras reabrir el dataDir:', await ingestor2.nextSeq(S), '(continua, no arranca de 0)');
  await srv.close();
  console.log('\nDEMO OK');
}

main().catch((e) => { console.error('DEMO FALLO:', e); process.exit(1); });

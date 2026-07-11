---
type: 'Task Contract'
title: 'Ensamblador determinista de contexto por slots (S0-S4)'
description: 'makeAssembler arma el prompt del turno con slots ordenados por volatilidad creciente, presupuesto de tokens, retrieval híbrido filtrando superseded, guardrails regex_deny con abort y firma sha256. Determinista: mismos stores + misma tarea = mismo contexto byte a byte.'
tags: ['js-base', 'agent', 'contexto', 'rag', 'cache-kv', 'kdd']

task: agent-assembler
intent: "Construir el ensamblador de contexto de la capa agent/: dado el estado en js-base (nodes, turns, sessions) y el turno actual, produce el contexto S0-S4 presupuestado, con retrieval determinista que excluye nodos superseded, guardrails de denegación por regex y firma sha256, ordenando los slots por volatilidad creciente para maximizar el prefijo estable de la caché KV."
target: agent/assembler.js
signature: "makeAssembler({ stores, semanticStores, embedder, config }) -> { async assemble({ sessionId, turnText, now }) -> { context, sha256, slots, mode } }"
language: javascript
test_command: "node --test tests/agent-assembler.test.js"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/agent-assembler.test.js"
deps_allowed: ['node:crypto', 'agent/embedder.js']
forbids: ['red', 'subprocess', 'reloj-interno', 'aleatoriedad', 'editar-src', 'editar-src-vendor']
---

# Contract: agent-assembler

## Intent
Es el corazón del contexto dinámico: el equivalente runtime de
`scripts/assemble_context.py` (slots, prioridad, presupuesto, compaction, firma,
guardrails) con el retriever lexical reemplazado por la búsqueda híbrida de js-base.
La disciplina de orden de slots es la que preserva la caché KV del proveedor LLM:
lo inmutable primero, lo volátil al final, correcciones por apéndice. Metodología:
[metodologia-ejecución](../metodologia-ejecucion.md). Piezas que consume:
[agent-embedder](./agent-embedder.md), [semantic-routes](./semantic-routes.md) (semántica
de search/filter). Contrato de ejecución padre: CONTRACT-10 (T2) en `specs/`.

## Interface
```javascript
const { makeAssembler } = require("../agent/assembler.js");

const assembler = makeAssembler({
  stores,          // makeStores(db) — acceso doc a sessions/turns
  semanticStores,  // makeSemanticStores — acceso vectorial a nodes (y turns)
  embedder,        // agent/embedder.js — embed([turnText], { isQuery: true })
  config: {
    system: "…",                 // texto fijo de S0
    max_tokens: 16000,
    output_reserve: 3000,
    retrieval_k: 8,
    ttl_ms: 300000,              // ventana de caché del proveedor (5 min)
    regex_deny: ["clave_api=", "secreto:"],  // patrones de ejemplo (los reales, en la config del deploy; no se escriben aquí para no disparar el guardrail del ensamblador KDD sobre este nodo)
  },
});

// assemble({ sessionId, turnText, now }) -> {
//   context: string,            // S0+S1+S2+S3+S4 concatenados con separadores fijos
//   sha256: string,             // firma del context
//   slots: [{ id, tokens, included, truncated }],
//   mode: "interactivo" | "esporadico",
// }
// `now` (ms epoch) SIEMPRE entra como parámetro. Tokens = ceil(chars / 4).
```

## Invariants
- Orden FIJO de slots: S0 system+índice de nodos pinned, S1 resumen vigente de la sesión,
  S2 historial vivo (turns de la sesión con compacted != true, orden por seq ascendente,
  append-only), S3 retrieval del turno, S4 turno actual. Nunca se reordena.
- Modo: `esporadico` si `now - lastTurnAt > config.ttl_ms` (o si la sesión no tiene
  turnos previos... NO: sesión nueva sin turnos = interactivo con S2 vacío). En modo
  esporádico S2 se OMITE (slot presente en el reporte con `included: false`).
- Retrieval (S3): `searchHybrid(vectorQuery, turnText, { limit: retrieval_k,
  textField: "body", filter: { superseded_by: { $exists: false } } })` sobre `nodes`;
  empates de score se desempatan por `id` ascendente (orden total estable). El vector
  de query se obtiene del embedder con `isQuery: true`.
- Presupuesto: disponible = `max_tokens - output_reserve` (validar > 0 al construir).
  Prioridad de asignación: S0, S1, S2, S4, S3 (el retrieval es lo primero que se
  recorta, ítem a ítem desde el score más bajo). S2 NUNCA se trunca parcialmente: si
  no entra completo, se reporta `truncated: true` y es señal para el promoter — el
  assembler no compacta.
- Guardrails: cada patrón de `config.regex_deny` se evalúa con `new RegExp(p).test()`
  REAL sobre el contenido de S3 antes de incluirlo; un match -> lanza `Error` con
  `code: 'GUARDRAIL'` nombrando el patrón (comportamiento abort, igual que
  `assemble_context.py`). Patrón inválido -> `Error` con `code: 'VALIDATION'` al
  construir el assembler, no al ensamblar.
- Determinismo total: sin `Date.now()`, sin `Math.random()`, sin orden dependiente de
  iteración de Map/Set no determinista. Mismos stores + mismos argumentos -> mismo
  `context` y mismo `sha256` byte a byte.
- `sha256` se calcula sobre `context` exacto (utf8, `node:crypto`).

## Examples
- Sesión con 2 turnos vivos, 1 nodo relevante, modo interactivo:
  `assemble({ sessionId, turnText: "que decidimos del retry", now })` -> `context`
  contiene S0, S1 (resumen), los 2 turnos en orden seq, el body del nodo, y el turno
  actual al final; `mode: "interactivo"`; segunda llamada idéntica -> mismo `sha256`.
- Mismo estado pero `now` adelantado 10 minutos -> `mode: "esporadico"`, S2 con
  `included: false`, el resto idéntico; el `sha256` difiere del caso interactivo.
- Nodo A superseded por nodo B (A.superseded_by = B.id): el retrieval devuelve B y
  NUNCA A, aunque A tenga mejor score vectorial.
- `config.regex_deny: ["secreto:"]` y un nodo recuperado contiene `secreto: hunter2`
  -> `assemble` lanza `code: 'GUARDRAIL'` mencionando el patrón y no devuelve contexto.

## Do / Don't
- DO: recibir TODO el estado por inyección (stores, semanticStores, embedder, now);
  la pureza es lo que hace verificable el determinismo por sha256 repetido.
- DO: reusar la heurística de tokens de `scripts/assemble_context.py`
  (`ceil(chars/4)`) para que los presupuestos sean comparables entre capas.
- DO: separadores de slots fijos y documentados en el módulo (parte del byte-a-byte).
- DON'T: llamar al LLM, escribir en ningún store, compactar historial (eso es del
  promoter), usar reloj o aleatoriedad internos, ni capturar excepciones del embedder
  (burbujean al loop).
- DON'T: tocar `src/**` ni `src/vendor/**`; el assembler es consumidor puro.

## Tests
(Los tests están en `tests/agent-assembler.test.js`, congelados, sobre js-base real en
memoria (DocStore + MemoryStorageAdapter + SemanticCollection dim 3 para fixtures) y
embedder fake determinista. Cubren: orden de slots; determinismo sha256 en 2 corridas;
modo esporádico por ttl_ms omite S2; retrieval excluye superseded; desempate estable
por id; presupuesto recorta S3 primero y reporta truncated; guardrail abort con nombre
de patrón; patrón regex inválido falla al construir; tokens = ceil(chars/4).)

## Constraints
- PARAR y reportar si `searchHybrid` de la SemanticCollection no respeta el `filter`
  Mongo con `$exists` sobre campos del doc (verificar con un `node -e` mínimo ANTES de
  implementar; si no lo respeta, el fallback documentado es search vectorial +
  post-filtro con `matchFilter` del vendor, y se anota el trade-off en este contrato).
- PARAR y reportar si el determinismo byte a byte resulta imposible sin fijar el orden
  de alguna estructura del vendor (documentar cuál y proponer el orden explícito).
- PARAR y reportar si cumplir los tests exigiera editar archivos fuera de
  `agent/assembler.js`, `tests/agent-assembler.test.js` y
  `knowledge/contracts/agent-assembler.md`.

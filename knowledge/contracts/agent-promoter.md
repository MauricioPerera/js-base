---
type: 'Task Contract'
title: 'Promoter: compactación de historial y promoción log a conocimiento'
description: 'makePromoter compacta el historial vivo cuando supera el umbral (resumen a sessions, hechos durables a nodes, turnos marcados compacted) y expone supersede() para correcciones por apéndice. El LLM entra como función async inyectada.'
tags: ['js-base', 'agent', 'compactacion', 'promocion', 'memoria', 'kdd']

task: agent-promoter
intent: "Implementar el puente log-a-conocimiento de la capa agent/: cuando los turnos vivos de una sesión superan el umbral de tokens, pedir al LLM inyectado resumen y hechos durables, persistir el resumen en sessions y los hechos como nodos en nodes con procedencia source_turns, marcar los turnos como compacted, y ofrecer supersede() para correcciones que reemplazan nodos sin editarlos."
target: agent/promoter.js
signature: "makePromoter({ stores, semanticStores, embedder, llm, threshold_tokens }) -> { async maybeCompact({ sessionId, now }) -> { compacted, summaryTokens, promoted }, async supersede(oldId, correction) -> { newId } }"
language: javascript
test_command: "node --test tests/agent-promoter.test.js"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/agent-promoter.test.js"
deps_allowed: ['agent/embedder.js']
forbids: ['red', 'subprocess', 'reloj-interno', 'editar-src', 'editar-src-vendor']
---

# Contract: agent-promoter

## Intent
La compactación no es solo ahorro de tokens: es el mecanismo de curación. El historial
crudo se destila en (a) un resumen de sesión que ocupa el slot S1 del assembler y (b)
nodos de conocimiento durables con procedencia, que el retrieval servirá en sesiones
futuras. La corrección de conocimiento es un dato nuevo que supersede al viejo — nunca
una edición — para que el retrieval jamás vuelva a servir la versión obsoleta y la
historia quede auditable. Metodología:
[metodologia-ejecución](../metodologia-ejecucion.md). Piezas que consume:
[agent-embedder](./agent-embedder.md). Contrato de ejecución padre: CONTRACT-10 (T4)
en `specs/`.

## Interface
```javascript
const { makePromoter } = require("../agent/promoter.js");

const promoter = makePromoter({
  stores, semanticStores, embedder,
  llm,                    // async ({ system, prompt }) -> string (JSON esperado; fake en tests)
  threshold_tokens: 20000 // umbral de historial vivo (heurística ceil(chars/4))
});

// maybeCompact({ sessionId, now }) -> Promise<{ compacted: boolean, summaryTokens, promoted }>
//   - Si los turnos vivos (compacted != true) de la sesión suman <= threshold_tokens:
//     no-op -> { compacted: false, summaryTokens: 0, promoted: 0 }.
//   - Si superan: llama a `llm` UNA vez pidiendo JSON { summary, facts: [{ title, body,
//     kind, tags }] }; persiste y devuelve { compacted: true, ... }.
// supersede(oldId, { title, body, kind, tags }) -> Promise<{ newId }>
//   - Inserta el nodo corrección con supersedes: [oldId] y marca el viejo con
//     superseded_by: newId. kind default "correction".
```

## Invariants
- Orden de efectos de `maybeCompact` (fijado por recuperabilidad ante crash):
  (1) upsert de nodos promovidos en `nodes` (embebidos como documento, en lote),
  (2) update del resumen en `sessions` (summary, summary_tokens, last_compaction_seq),
  (3) marcar turnos `compacted: true` AL FINAL. Un crash entre pasos deja historial
  sin marcar -> la próxima corrida re-compacta (ids de nodo deterministas
  `${sessionId}:c${last_compaction_seq}:${i}` la hacen idempotente, upsert pisa).
- Respuesta del `llm` que no parsea como JSON con `summary` string y `facts` array ->
  `Error` con `code: 'PROMOTER'` y CERO escrituras (todo-o-nada en la frontera del LLM).
- Los nodos promovidos llevan `source_turns` con los ids de los turnos que los
  originaron y `created_at` derivado del `now` recibido (nunca reloj interno).
- `supersede`: el nodo viejo debe existir (`NOT_FOUND` si no); el nuevo se embebe y
  upserta ANTES de marcar el viejo (si el marcado falla, el retry es idempotente);
  el nuevo nace sin `superseded_by`. Cadenas A<-B<-C válidas: solo el último queda
  recuperable.
- `maybeCompact` con umbral no superado NO llama al `llm` (los tests cuentan llamadas).
- El promoter NO arma prompts de usuario final ni decide CUÁNDO correr (eso es del
  loop); solo evalúa el umbral cuando lo llaman.

## Examples
- Sesión con 30 turnos vivos que suman 25k tokens, `threshold_tokens: 20000`:
  `maybeCompact` -> 1 llamada al llm fake que devuelve `{ summary: "…", facts: [f1, f2] }`
  -> `sessions.summary` actualizado, 2 nodos nuevos con `source_turns`, 30 turnos con
  `compacted: true`, resultado `{ compacted: true, promoted: 2 }`.
- Misma sesión inmediatamente después: los turnos vivos ahora son 0 -> no-op sin llamar
  al llm -> `{ compacted: false, ... }`.
- `supersede("n1", { title: "retry es 3", body: "el retry acordado es 3, no 5" })` ->
  nodo nuevo con `supersedes: ["n1"]`, `n1.superseded_by` = newId; un searchHybrid con
  filtro `{ superseded_by: { $exists: false } }` devuelve el nuevo y nunca n1.
- llm fake que devuelve `"no soy json"` -> `PROMOTER`, y counts de nodes/sessions/turns
  idénticos a antes de la llamada.

## Do / Don't
- DO: inyectar `llm` como función async pura de la firma declarada; en tests es un fake
  determinista (respuestas fijas por prompt), jamás un modelo real.
- DO: embeber los bodies de nodos promovidos con `isQuery: false` en UN lote.
- DO: reutilizar la heurística `ceil(chars/4)` para medir el historial (coherencia con
  assembler y con `scripts/assemble_context.py`).
- DON'T: editar el body de un nodo existente (correcciones SOLO por supersede);
  borrar turnos (se marcan, no se destruyen: siguen siendo memoria episódica buscable);
  llamar al llm más de una vez por compactación.
- DON'T: tocar `src/**` ni `src/vendor/**`.

## Tests
(Los tests están en `tests/agent-promoter.test.js`, congelados, sobre js-base real en
memoria, embedder fake y llm fake con contador de llamadas. Cubren: no-op bajo umbral
sin llamada al llm; compactación completa con orden de efectos verificable; idempotencia
del retry tras fallo simulado entre pasos; PROMOTER ante respuesta no-JSON sin
escrituras; supersede feliz + NOT_FOUND + cadena de dos supersedes; el retrieval con
filtro $exists excluye el superseded (test de integración con assembler o con
searchHybrid directo); nodos promovidos llevan source_turns correctos.)

## Constraints
- PARAR y reportar si el update de docs en `turns` vía el store (`update` = reemplazo
  removeById+insert, ver `src/store-provider.js`) interfiere con el vector asociado en
  la colección semántica — verificar ANTES con `node -e` si marcar `compacted` sobre el
  doc de una SemanticCollection preserva el vector; si no, el marcado va en el doc del
  upsert semántico completo (doc+vector re-upsertado) y se documenta el costo.
- PARAR y reportar si cumplir los tests exigiera editar archivos fuera de
  `agent/promoter.js`, `tests/agent-promoter.test.js` y
  `knowledge/contracts/agent-promoter.md`.
- PARAR y reportar si el todo-o-nada ante respuesta inválida del llm no es alcanzable
  sin transacciones multi-colección (que js-base no tiene): el orden de efectos y la
  validación previa a toda escritura son el mecanismo permitido; si no alcanzan,
  renegociar.

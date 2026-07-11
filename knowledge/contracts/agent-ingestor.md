---
type: 'Task Contract'
title: 'Ingestor de turnos: persistencia del log crudo en js-base'
description: 'makeIngestor persiste cada par de turnos user/assistant en la colección turns (doc + vector con prefijo documento) y el registro de auditoría del ensamblado en assemblies. Idempotente por (session_id, seq, role).'
tags: ['js-base', 'agent', 'ingesta', 'memoria', 'kdd']

task: agent-ingestor
intent: "Persistir tras cada turno el par user/assistant en la colección turns de js-base (texto embebido como documento, session_id y seq monotónico) y el registro de auditoría sha256 del contexto ensamblado en assemblies, de forma idempotente por (session_id, seq, role)."
target: agent/ingestor.js
signature: "makeIngestor({ stores, semanticStores, embedder }) -> { async ingestTurn({ sessionId, seq, userText, assistantText, assembly }) -> { userId, assistantId }, async nextSeq(sessionId) -> number }"
language: javascript
test_command: "node --test tests/agent-ingestor.test.js"
budget:
  max_cyclomatic_complexity: 6
  max_nesting_depth: 3
tests: "tests/agent-ingestor.test.js"
deps_allowed: ['agent/embedder.js']
forbids: ['red', 'subprocess', 'llamadas-llm', 'editar-src', 'editar-src-vendor']
---

# Contract: agent-ingestor

## Intent
El camino de escritura del log crudo: cada interacción queda buscable por vector sin
ceremonia OKF (la curación es del promoter, no de acá). Corre DESPUÉS de responder al
usuario, así que no agrega latencia percibida al turno. También deja la traza de
auditoría: qué contexto exacto (sha256 + slots) vio el modelo en ese turno, persistida
en js-base mismo. Metodología: [metodologia-ejecución](../metodologia-ejecucion.md).
Piezas que consume: [agent-embedder](./agent-embedder.md). Contrato de ejecución padre:
CONTRACT-10 (T3) en `specs/`.

## Interface
```javascript
const { makeIngestor } = require("../agent/ingestor.js");

const ingestor = makeIngestor({ stores, semanticStores, embedder });

// ingestTurn({ sessionId, seq, userText, assistantText, assembly }) -> Promise<{ userId, assistantId }>
//   - sessionId: string no vacío; seq: entero >= 0 monotónico por sesión (lo asigna el loop).
//   - userText / assistantText: strings no vacíos.
//   - assembly: { sha256, slots, mode } tal como lo devolvió el assembler (opaco acá).
//   - Ids deterministas: `${sessionId}:${seq}:user` y `${sessionId}:${seq}:assistant`.
// Efectos:
//   - 2 upserts en la colección semántica `turns` (doc + vector documento, isQuery: false).
//   - 1 insert en la colección documental `assemblies` con _id `${sessionId}:${seq}`.
//
// nextSeq(sessionId) -> Promise<number>
//   - max(seq) de los turnos persistidos de la sesión + 1; 0 si la sesión no tiene turnos.
//   - Es la vía por la que el loop deriva seq del estado persistido (el loop no recibe
//     stores; ver agent-loop.md). Lectura pura: no escribe nada.
```

## Invariants
- Ids DETERMINISTAS construidos de (sessionId, seq, role): re-ejecutar `ingestTurn` con
  los mismos argumentos es idempotente (upsert pisa con el mismo contenido; el insert
  de assemblies con _id existente se trata como ya-ingestado, no como error).
- El doc persistido en `turns` tiene shape { session_id, role, text, seq, created_at }
  y NUNCA lleva `compacted` al nacer (el campo lo agrega el promoter). `created_at` es
  un string ISO RECIBIDO en el argumento o derivado de un `now` inyectado — el módulo
  no llama a `Date.now()` (mismo criterio de determinismo que el assembler).
- Los embeddings de ambos textos se piden en UN solo lote al embedder con
  `isQuery: false` (prefijo documento): 1 llamada, 2 vectores.
- ESPEJO DOCUMENTAL (invariante compartido con agent-assembler y agent-promoter,
  formalizado por CONTRACT-11): cada doc de turno se escribe ADEMÁS en
  `stores.get('turns')` (lado documental) con el MISMO id, inmediatamente después de su
  upsert semántico, de forma idempotente (get -> update | insert). El assembler lee el
  historial S2 y `lastTurnAt` de ese espejo; el promoter marca `compacted` en ambos
  lados. Los lectores toleran fixtures que no pueblan el espejo.
- Validación antes de cualquier escritura: argumento faltante o de tipo incorrecto ->
  `Error` con `code: 'VALIDATION'` y CERO escrituras (no hay ingesta parcial evitable).
- Si el upsert del assistant falla tras el del user, el error burbujea con
  `code: 'INGEST'` y `cause`; el par queda incompleto — límite heredado documentado
  (js-base no tiene ACID multi-colección) y el retry idempotente del mismo turno lo
  repara.
- El ingestor NO llama al LLM, NO decide compactación, NO lee `nodes`.

## Examples
- `ingestTurn({ sessionId: "s1", seq: 0, userText: "hola", assistantText: "buenas",
  assembly })` -> upserts `s1:0:user` y `s1:0:assistant` en `turns`, insert `s1:0` en
  `assemblies`; devuelve `{ userId: "s1:0:user", assistantId: "s1:0:assistant" }`.
- La MISMA llamada repetida (retry tras crash) -> mismo resultado, sin duplicados:
  `turns` sigue con 2 docs de seq 0 y `assemblies` con 1 registro.
- `ingestTurn({ ..., userText: "" })` -> lanza `VALIDATION` y ni `turns` ni
  `assemblies` cambian (count intacto).

## Do / Don't
- DO: pedir los 2 embeddings en un solo `embed([userText, assistantText])`.
- DO: usar los stores/semanticStores inyectados tal como los expone `createServer`
  (mismas interfaces que usan `src/records.js` y `src/semantic-routes.js`).
- DO: mantener el shape del doc alineado con el schema de la colección `turns`
  declarado en CONTRACT-10 (validado por `registry.validateDoc` aguas arriba).
- DON'T: generar ids aleatorios (la idempotencia depende de ids deterministas);
  llamar al LLM; tocar `nodes` o `sessions`; capturar errores del embedder.
- DON'T: tocar `src/**` ni `src/vendor/**`.

## Tests
(Los tests están en `tests/agent-ingestor.test.js`, congelados, sobre js-base real en
memoria y embedder fake que cuenta llamadas. Cubren: par persistido con ids
deterministas y shape correcto; assembly en assemblies con _id compuesto; 1 sola
llamada al embedder por turno con isQuery false; idempotencia del retry (counts
estables); VALIDATION sin escrituras parciales; error del embedder burbujea sin
escribir; error a mitad de par deja estado reparable por retry.)

## Constraints
- PARAR y reportar si la SemanticCollection no permite upsert con id existente
  (semántica upsert-pisa) — verificar con `node -e` antes de implementar; el vendor
  la documenta como upsert, pero si fuera insert-only el diseño de idempotencia cambia
  y hay que renegociar el contrato.
- PARAR y reportar si cumplir los tests exigiera editar archivos fuera de
  `agent/ingestor.js`, `tests/agent-ingestor.test.js` y
  `knowledge/contracts/agent-ingestor.md`.
- PARAR y reportar si el shape de `assemblies` exigiera vector (no lo lleva: es
  colección documental pura, `vector: null`).

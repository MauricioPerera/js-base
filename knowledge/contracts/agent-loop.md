---
type: 'Task Contract'
title: 'Loop del agente: orquestación del turno completo'
description: 'makeLoop cablea assembler, llm, ingestor y promoter en el ciclo de un turno: ensamblar, inferir, persistir, compactar si corresponde. Detecta el régimen interactivo/esporádico y garantiza que un turno fallido no persiste estado.'
tags: ['js-base', 'agent', 'orquestacion', 'loop', 'kdd']

task: agent-loop
intent: "Orquestar el turno completo del agente: dado el texto del usuario, ensamblar el contexto, llamar al LLM inyectado, persistir el par de turnos y el registro de auditoría vía el ingestor, y disparar la compactación del promoter cuando corresponde, garantizando que un fallo del LLM no deja estado persistido a medias."
target: agent/loop.js
signature: "makeLoop({ assembler, ingestor, promoter, llm, config }) -> { async turn({ sessionId, userText, now }) -> { reply, seq, assembly, compaction } }"
language: javascript
test_command: "node --test tests/agent-loop.test.js"
budget:
  max_cyclomatic_complexity: 7
  max_nesting_depth: 3
tests: "tests/agent-loop.test.js"
deps_allowed: ['agent/assembler.js', 'agent/ingestor.js', 'agent/promoter.js']
forbids: ['red', 'subprocess', 'reloj-interno', 'editar-src', 'editar-src-vendor']
---

# Contract: agent-loop

## Intent
La pieza de integración de la capa `agent/` — como `src/app.js` lo es del backend: no
reimplementa nada, solo cablea las piezas en el orden correcto del turno y fija las
garantías de conjunto (turno fallido no persiste; compactación después de responder,
nunca antes; `seq` monotónico por sesión). Metodología:
[metodologia-ejecución](../metodologia-ejecucion.md). Piezas que cablea:
[agent-assembler](./agent-assembler.md), [agent-ingestor](./agent-ingestor.md),
[agent-promoter](./agent-promoter.md). Contrato de ejecución padre: CONTRACT-10 (T5)
en `specs/`.

## Interface
```javascript
const { makeLoop } = require("../agent/loop.js");

const loop = makeLoop({
  assembler,   // agent/assembler.js
  ingestor,    // agent/ingestor.js
  promoter,    // agent/promoter.js
  llm,         // async ({ context }) -> string (la respuesta del modelo; fake en tests)
  config: {},  // reservado (hoy sin opciones propias)
});

// turn({ sessionId, userText, now }) -> Promise<{
//   reply: string,          // respuesta del llm
//   seq: number,            // seq asignado a este turno
//   assembly: { sha256, slots, mode },   // lo que devolvió el assembler
//   compaction: { compacted, promoted } | null,  // resultado del promoter post-turno
// }>
```

## Invariants
- Orden del turno, FIJO: (1) `assembler.assemble` -> (2) `llm({ context })` ->
  (3) `ingestor.ingestTurn` -> (4) `promoter.maybeCompact`. La compactación va DESPUÉS
  de persistir el turno (el turno recién respondido cuenta para el umbral) y su
  resultado viaja en `compaction`; si el promoter no compactó, `compaction` refleja
  `{ compacted: false, ... }`.
- `seq` monotónico por sesión: el loop lo deriva del estado persistido (max seq en
  `turns` de la sesión + 1, vía el ingestor/stores), NO de un contador en memoria —
  sobrevive reinicios del proceso.
- Fallo del `llm` (rechazo) -> el error burbujea con `code: 'LLM'` y `cause`, y NO se
  llama al ingestor ni al promoter: cero estado persistido del turno fallido. El retry
  del caller re-ensambla desde cero.
- Fallo del assembler (p.ej. `GUARDRAIL`) -> burbujea tal cual, sin llamar al llm.
- Fallo del ingestor DESPUÉS de responder el llm -> burbujea con la respuesta del llm
  adjunta en `err.reply` (el caller decide si re-ingestar con el mismo seq — la
  idempotencia del ingestor lo permite — o descartar).
- `now` SIEMPRE entra como parámetro y se propaga a assembler/ingestor/promoter;
  el loop no llama a `Date.now()`.
- El loop NO conoce Ollama, ni colecciones, ni prompts internos del promoter: solo las
  cuatro interfaces inyectadas.

## Examples
- Turno feliz: `turn({ sessionId: "s1", userText: "hola", now })` -> assemble ->
  llm devuelve "buenas" -> ingesta del par seq 0 -> maybeCompact no-op ->
  `{ reply: "buenas", seq: 0, assembly: { mode: "interactivo", ... },
  compaction: { compacted: false, ... } }`. Un segundo turno -> `seq: 1`.
- llm fake que rechaza: `turn(...)` rechaza con `code: 'LLM'`, y los counts de `turns`
  y `assemblies` quedan idénticos a antes del turno (nada persistido).
- Historial que cruza el umbral con este turno: `turn(...)` responde normal y
  `compaction.compacted === true` (la compactación ocurrió tras persistir, verificable
  porque el turno recién ingestado figura entre los `compacted`).
- Reinicio del proceso entre turnos: un `makeLoop` nuevo sobre los mismos stores asigna
  `seq` correcto (max persistido + 1), no 0.

## Do / Don't
- DO: mantener el módulo como glue puro (estilo `src/app.js`): validación de argumentos,
  orden de llamadas, propagación de errores tipados — nada de lógica de negocio propia.
- DO: propagar `assembly.mode` al resultado para observabilidad del régimen de caché.
- DO: en tests, cablear fakes de las cuatro dependencias con contadores de llamadas y
  verificar el ORDEN (arrays de eventos), no solo los resultados.
- DON'T: reintentar internamente, hacer streaming, ni capturar errores para
  transformarlos más allá de lo especificado; no llamar a `Date.now()`; no importar
  `agent/embedder.js` (llega dentro de las piezas ya construidas).
- DON'T: tocar `src/**` ni `src/vendor/**`.

## Tests
(Los tests están en `tests/agent-loop.test.js`, congelados, con las cuatro dependencias
fake (registro de orden de eventos) más un caso de integración con las piezas reales
sobre js-base en memoria. Cubren: orden assemble-llm-ingest-compact; seq monotónico y
derivado del estado persistido tras reinicio simulado; fallo del llm sin persistencia;
fallo del assembler sin llamar al llm; fallo del ingestor adjunta err.reply; compaction
reportada cuando el umbral se cruza; now propagado a las tres piezas.)

## Constraints
- PARAR y reportar si derivar `seq` del estado persistido exige una query que los
  stores inyectados no soportan (find por session_id + max de un campo: `find` +
  reduce en memoria es aceptable en v1; si el costo fuera prohibitivo, documentar y
  proponer índice del vendor).
- PARAR y reportar si cumplir los tests exigiera editar archivos fuera de
  `agent/loop.js`, `tests/agent-loop.test.js` y `knowledge/contracts/agent-loop.md`.
- PARAR y reportar si la garantía "turno fallido no persiste" resultara inalcanzable
  con el orden de llamadas especificado (indicaría un efecto colateral no declarado en
  alguna pieza: eso es un hallazgo sobre el contrato de esa pieza, no algo a parchear
  en el loop).

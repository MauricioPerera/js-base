# CONTRACT-10 — Agente con contexto dinámico cacheado sobre js-base — REPORT

Fecha: 2026-07-11
Spec: `specs/CONTRACT-10-contexto-dinamico.md`

## Resumen ejecutivo

| Criterio | Veredicto | Evidencia |
|---|---|---|
| `node --test` (suite completa, sin regresiones) | ✅ verde 2× (232 tests: 180 previos + 52 nuevos) | `ℹ tests 232 / pass 232 / fail 0` en dos corridas idénticas |
| Tests congelados por tarea | ✅ 52/52 (12+11+13+7+9) | baseline rojo verificado antes de delegar; sha256 de los 5 archivos intactos de punta a punta |
| Determinismo del assembler (sha256 2×) | ✅ | caso dedicado en `tests/agent-assembler.test.js`, verde |
| Corrección efectiva (supersede excluido del retrieval) | ✅ | casos en `tests/agent-promoter.test.js` + probe del PM contra el vendor real (`search` y `searchHybrid` con `$exists:false`) |
| `python scripts/validate_contracts.py knowledge/contracts` | ✅ | `0 error(es), 0 warning(s) en 23 archivo(s)` |
| `python scripts/validate_okf.py knowledge` | ✅ | `0 error(es), 0 warning(s) en 27 archivo(s)` |
| `python scripts/validate_specs.py specs` | ✅ | `0 error(es) en 10 archivo(s)` |
| Suite Python de la plantilla | ✅ | `OK (skipped=14)` (skips preexistentes por repo instanciado) |
| Ensamblador de contexto (smoke) | ✅ | `python scripts/assemble_context.py ccdd/context.json "smoke"` exit 0 |

Mecánica: metodología pm-native-ccdd — 5 oráculos (Sonnet) autoraron los tests congelados
ANTES de delegar; 5 devs (Haiku) implementaron contra ellos; gate del PM = re-corrida de
tests + hash de tests + complejidad (ninguna función >41 líneas / cyclomatic sobre umbral).
Reintentos: T1 ×1, T2 ×1, T3 ×2, T4 ×2 + escalación a Sonnet (refactor residual del
factory). RECON verificado contra Ollama real (embeddinggemma dim 768, norma 1.0).

## AGENT-EMBEDDER (T1) (commit `b76fe48`)

`agent/embedder.js`: prefijos asimétricos de EmbeddingGemma aplicados antes de la clave de
caché (query y documento jamás comparten entrada); lote deduplica misses; errores tipados
VALIDATION/EMBEDDER sin cacheo parcial. Retry por gate: helpers movidos a nivel de módulo.

## AGENT-ASSEMBLER (T2) (commit `5b75b69`)

`agent/assembler.js`: slots S0-S4 por volatilidad creciente, presupuesto con prioridad
S0,S1,S2,S4,S3 (S2 todo-o-nada), retrieval híbrido con filtro `superseded_by $exists:false`
y desempate estable por id, guardrails con abort, firma sha256, modo esporádico por TTL.
Sin reloj ni aleatoriedad internos. Retry por gate: `assemble` de 136 → 19 líneas.

## AGENT-INGESTOR (T3) (commit `faced17`)

`agent/ingestor.js`: ids deterministas `sessionId:seq:role` (idempotencia = mecanismo de
recuperación), embed en un lote, par semántico + espejo documental (fix de integración del
PM: el assembler lee el historial del lado documental), `created_at` del `now` inyectado,
`nextSeq` (enmienda de contrato pedida por el oráculo del loop). 2 retries.

## AGENT-PROMOTER (T4) (commit `bd2b171`)

`agent/promoter.js`: umbral por `ceil(chars/4)`; orden de efectos recuperable ante crash
(nodos promovidos → sesión → marcado al final); marcado dual semántico+documental (fix de
integración del PM); `supersede()` para corrección por apéndice; PROMOTER todo-o-nada ante
respuesta inválida del LLM. 2 retries + escalación Sonnet por longitud del factory.

## AGENT-LOOP (T5) (commit `2115771`)

`agent/loop.js`: orden fijo assemble→llm→ingest→compact; `seq` derivado del estado
persistido (sobrevive reinicios); turno fallido no persiste (LLM con code+cause);
`err.reply` ante fallo post-LLM; e2e con las cuatro piezas reales en verde a la primera.

## Verificación final del PM (independiente de los devs)

- `node --test`: 232/232, dos corridas consecutivas idénticas, exit 0.
- sha256 de los 5 tests congelados: idénticos a los sellados pre-delegación.
- Longitud/complejidad re-medidas por el PM sobre el código final (no la palabra del dev):
  ninguna función >41 líneas; `measure_complexity` (tree-sitter) en verde donde se corrió.
- Los 3 validadores KDD + suite Python + smoke del ensamblador: exit 0 (salidas arriba).
- Hallazgo de dogfooding: el nodo `agent-assembler.md` contenía patrones vivos del
  `regex_deny` en sus ejemplos y el ensamblador KDD real se abortó (exit 2) al recuperarlo
  — el guardrail operó como debía; se reescribieron los ejemplos con patrones inertes.
- Lección registrada en memoria compartida cq (KU): el gate tree-sitter agrega la
  complejidad de los closures al factory padre; el patrón deps va en el primer prompt.

## Pendientes / ítems de seguimiento

Candidatos a CONTRACT-11 (documentados, no bloquean; los tests congelados no los cubren):
- `supersede` genera `newId` con `randomUUID` → su retry no es idempotente (el invariante
  del contrato lo pedía).
- `last_compaction_seq` no incrementa entre compactaciones distintas de una misma sesión →
  colisión de ids de nodos promovidos en la segunda compactación (el test de retry fuerza
  la semántica de reuso; el caso multi-compactación quedó sin cubrir).
- `markCompacted`/`supersede` acceden a internos del vendor (`vectorStore.get(col, id)`) —
  frágil ante re-vendorizado de js-store.
- El espejo documental de `turns` es policy de glue implementada en ingestor/promoter;
  falta formalizarla como invariante en los contratos de las tres piezas que la comparten.

# CONTRACT-11 — Hardening del promoter y espejo documental — REPORT

Fecha: 2026-07-11
Spec: `specs/CONTRACT-11-promoter-hardening.md`

## Resumen ejecutivo

| Criterio | Veredicto | Evidencia |
|---|---|---|
| Baseline rojo pre-implementación | ✅ | 3/5 tests de hardening rojos contra la impl de C10 (retry duplica; 2ª compactación pisa 2 nodos; Proxy anti-internos lanza en `promoter.js:90`) |
| T1 verde con congelados de C10 intactos | ✅ | `node --test tests/agent-promoter.test.js tests/agent-promoter-hardening.test.js` 12/12; sha256 de ambos archivos idénticos a los sellados |
| Cero internos del vendor en `agent/` | ✅ | `grep -rn "vectorStore\|randomUUID" agent/` sin resultados |
| Suite completa sin regresiones | ✅ verde 2× (237 tests: 232 + 5) | `ℹ tests 237 / pass 237 / fail 0` dos corridas idénticas |
| Validadores KDD | ✅ | contracts `0 err en 23`, OKF `0 err en 27`, specs `0 err en 11` |
| Suite Python de la plantilla | ✅ | `OK (skipped=14)` |

Mecánica: pm-native-ccdd, secuencial (1 oráculo Sonnet + 1 dev Haiku). La KU de C10
(patrón deps en el primer prompt) se aplicó y el dev pasó el gate de complejidad a la
primera — la lección amortizó en el primer uso.

## PROMOTER-HARDENING (T1)

Los 3 defectos documentados como pendientes en el reporte de C10, corregidos:
- `supersede`: `newId = 'sup:' + sha256(oldId + '\n' + correction.body)[..16]` — mismo
  par, mismo id; el retry tras fallo del marcado re-upserta sin duplicar (verificado con
  wrapper que falla el marcado: count estable, mismo newId).
- Ids de compactación derivados del batch: `seq = max(turno.seq)` de los turnos vivos —
  retry del mismo batch reusa ids (invariante de C10 intacto); compactaciones sucesivas
  producen conjuntos disjuntos y la primera tanda queda intacta.
- Vendor: helper único `vectorsOf(sc, ids)` sobre `serialize()` (API pública, una llamada
  por batch); eliminados `turns.vectorStore.get` y `nodes.vectorStore.get`. Verificado
  conductualmente: compactación y supersede corren sobre Proxies que bloquean
  `vectorStore`/`col` sin lanzar. Sin llamadas extra al embedder (contadores congelados).

## CONTRATOS-ESPEJO (T2, tarea del PM)

El invariante del espejo documental de `turns` (ingestor escribe ambos lados con los
mismos ids; assembler lee historial y `lastTurnAt` del lado documental; promoter marca
`compacted` en ambos; fixtures sin espejo se toleran) quedó declarado en
`agent-ingestor.md`, `agent-assembler.md` y `agent-promoter.md`. Este último además
refleja los ids deterministas nuevos y la regla "solo API pública del vendor".

## Verificación final del PM (independiente del dev)

- Ambas suites del promoter re-corridas por el PM: 12/12, exit 0.
- sha256 de `tests/agent-promoter.test.js` (`9230dfbb…`) y
  `tests/agent-promoter-hardening.test.js` (`273e3047…`): idénticos a los sellados.
- `grep -rn "vectorStore\|randomUUID" agent/`: exit 1 (limpio).
- Longitud/complejidad re-medidas: ninguna función >41 líneas.
- Suite completa 2× consecutivas: 237/237 ambas, exit 0. Validadores y suite Python: exit 0.

## Pendientes / ítems de seguimiento

Ninguno de los 4 ítems heredados de C10 queda abierto. Observación menor (no bloquea):
`vectorsOf` vía `serialize()` es O(n) por batch — a la escala objetivo (10^3-10^4 docs)
es irrelevante; si el vendor expone lectura puntual de vectores en una versión futura,
el helper único hace el reemplazo trivial.

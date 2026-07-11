# Contrato 11 — Hardening del promoter y formalización del espejo documental

Prerrequisitos: CONTRACT-10 cerrado (reporte en `docs/reports/CONTRACT-10-REPORT.md`).
Este contrato ejecuta los 4 pendientes documentados en ese reporte: idempotencia real de
`supersede`, ids de compactación sin colisión entre compactaciones sucesivas, eliminación
del acceso a internos del vendor, y el invariante del espejo documental formalizado en los
contratos de las tres piezas que lo comparten.

> Capa: este es un **contrato de ejecución** (nivel proyecto). Las tareas que impliquen código
> delegado a un agente efímero llevan además su **task contract** CCDD en
> `knowledge/contracts/<task>.md` (validado por `scripts/validate_contracts.py`).

RECON verificado antes de redactar (2026-07-11):
- Los tests congelados de C10 NO fijan formato de ids: `newId` solo debe ser string no
  vacío distinto de `oldId`; `last_compaction_seq` solo debe ser entero. Hay libertad
  total para ids deterministas.
- Los tests congelados SÍ fijan contadores: la compactación embebe los facts en
  exactamente UN lote adicional — los fixes no pueden agregar llamadas al embedder.
- `SemanticCollection.serialize()` es API PÚBLICA y devuelve
  `{ records: [{ id, doc, vector }] }` en modo memoria — vía pública para leer vectores
  sin tocar `vectorStore`/`col` (internos).

## PROMOTER-HARDENING (T1) — ids deterministas y solo API pública del vendor

Hoy en `agent/promoter.js`: (a) `supersede` genera `newId` con `crypto.randomUUID()` — un
retry tras fallo del marcado crea un SEGUNDO nodo corrección (no idempotente, contra el
invariante de su contrato); (b) el seq de compactación reusa `last_compaction_seq` sin
incrementar entre compactaciones distintas — la segunda compactación de una sesión pisa
los nodos promovidos de la primera (colisión de ids); (c) `markCompacted` y `supersede`
leen vectores vía `turns.vectorStore.get(turns.col, id)` — internos del vendor, frágil
ante re-vendorizado.

FIX/OBJETIVO: (a) `newId` determinista derivado de `(oldId, correction.body)` por sha256
truncado — mismo par, mismo id; el retry re-upserta el mismo nodo sin duplicar. (b) el
seq de compactación se deriva del BATCH (el max `seq` de los turnos vivos compactados):
retry del mismo batch = mismos ids (invariante de C10 intacto); batch nuevo = seqs de
turnos mayores = ids nuevos sin colisión; `last_compaction_seq` persiste ese valor y
sigue siendo entero. (c) los vectores se leen SOLO por API pública del vendor
(`serialize()` u otra equivalente), aislado en UN helper de módulo; cero accesos a
propiedades internas (`vectorStore`, `col`) en todo `agent/`. Invariantes que no cambian:
los 7 tests congelados de `tests/agent-promoter.test.js` siguen verdes SIN editarse; el
orden de efectos de `maybeCompact` se mantiene; ninguna llamada extra al embedder ni al
llm; budget de complejidad de su contrato.

Tests congelados NUEVOS en `tests/agent-promoter-hardening.test.js` (baseline rojo
obligatorio contra la impl actual): retry de `supersede` con mismos argumentos tras fallo
simulado del marcado no duplica (mismo `newId`, count de nodos estable); dos
compactaciones sucesivas de la misma sesión producen conjuntos de ids disjuntos y los
nodos de la primera quedan intactos; `maybeCompact` y `supersede` funcionan sobre una
SemanticCollection envuelta en un Proxy que bloquea el acceso a `vectorStore` y `col`
(solo API pública) sin lanzar; el marcado de compactados y el supersede no agregan
llamadas al embedder.

## CONTRATOS-ESPEJO (T2) — formalizar el invariante del espejo documental

Hoy el espejo documental de `turns` (los docs viven en la colección semántica Y en
`stores.get('turns')` con los mismos ids, para que el assembler lea historial del lado
documental) es policy de glue implementada en ingestor y promoter pero no declarada en
ningún contrato.

FIX/OBJETIVO: los contratos `knowledge/contracts/agent-ingestor.md`,
`knowledge/contracts/agent-assembler.md` y `knowledge/contracts/agent-promoter.md`
declaran el invariante del espejo (quién escribe, quién lee, ids compartidos, tolerancia
a espejo ausente en fixtures); `agent-promoter.md` además refleja los ids deterministas
nuevos de T1 y la regla "solo API pública del vendor". Tarea del PM (los contratos son
artefactos del orquestador): sin delegación, validadores como gate.

## Criterios de aceptación

- [ ] Baseline rojo verificado ANTES de implementar T1:
  `node --test tests/agent-promoter-hardening.test.js` falla contra la impl actual.
- [ ] T1 verde: `node --test tests/agent-promoter.test.js tests/agent-promoter-hardening.test.js`
  100% pass, con sha256 de `tests/agent-promoter.test.js` idéntico al sellado en C10.
- [ ] Cero internos del vendor en la capa agent:
  `grep -rn "vectorStore\|\.col\b" agent/` sin resultados.
- [ ] Suite completa sin regresiones: `node --test` todo verde, 2× idénticas.
- [ ] Validadores KDD: `python scripts/validate_contracts.py knowledge/contracts` exit 0,
  `python scripts/validate_okf.py knowledge` exit 0,
  `python scripts/validate_specs.py specs` exit 0.
- [ ] Final: CI verde tras push.

## Restricciones

- Tocar SOLO: `agent/promoter.js`, `tests/agent-promoter-hardening.test.js`,
  `knowledge/contracts/agent-promoter.md`, `knowledge/contracts/agent-ingestor.md`,
  `knowledge/contracts/agent-assembler.md` y `docs/reports/CONTRACT-11-REPORT.md`.
- `tests/agent-promoter.test.js` (congelado en C10) es READ-ONLY: los fixes se adaptan a
  él, no al revés. `src/**` y `src/vendor/**` READ-ONLY como siempre.
- Cero dependencias nuevas; sin reloj interno ni aleatoriedad en `agent/` (la eliminación
  de `randomUUID` es parte del objetivo, no solo estilo).
- Los fixes no agregan llamadas al embedder ni al llm (contadores congelados de C10).
- NO commitear hasta que el PM verifique (el PM commitea por tarea verificada). Si algo
  no se puede sin romper otro criterio, PARAR y reportar.
- ABORTAR SI: mantener verdes los 7 tests congelados de C10 resulta incompatible con la
  idempotencia o con los ids sin colisión (indicaría que C10 fijó semántica errónea — se
  documenta la contradicción con evidencia y se renegocia, no se fuerza); o la API
  pública del vendor no alcanza para leer vectores en modo memoria o disco. En ese caso
  PARAR, documentar el porqué con evidencia en el reporte y marcar BLOQUEADO.

## Checklist antes de delegar

- [x] RECON corrido: formato de ids libre en los tests congelados (grep verificado);
  contadores de embedder fijados por C10 identificados; `serialize()` público verificado
  con `node -e` contra el vendor real (devuelve `records[].vector` en memoria).
- [x] Todo criterio de aceptación tiene comando + resultado esperado (por máquina).
- [x] Red-team hecho: la idempotencia se verifica por counts + mismo id tras retry (no
  por lectura); la no-colisión por conjuntos disjuntos e integridad de la primera
  compactación; el desacople del vendor por Proxy que bloquea internos (un fix cosmético
  que siga leyendo `vectorStore` no pasa); el costo por contadores del embedder.
- [x] Perímetro declarado; T1 y T2 tocan archivos disjuntos salvo `agent-promoter.md`
  (T2 lo edita DESPUÉS de que T1 cierre — secuencial, sin concurrencia).
- [x] Condiciones de aborto explícitas.

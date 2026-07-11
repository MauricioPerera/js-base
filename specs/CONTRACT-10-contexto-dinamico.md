# Contrato 10 — Agente con contexto dinámico cacheado sobre js-base

Prerrequisitos: contratos 01-09 completados; js-base v0.1.6 con suite JS 180/180 verde.
Este contrato construye la capa `agent/`: un consumidor embebido de js-base que implementa
memoria dinámica para un LLM (log de interacciones + conocimiento curado + ensamblado
determinista de contexto), cerrando el círculo del ecosistema: js-base como backend RAG
de su propio agente.

> Capa: este es un **contrato de ejecución** (nivel proyecto). Las tareas que impliquen código
> delegado a un agente efímero llevan además su **task contract** CCDD en
> `knowledge/contracts/<task>.md` (validado por `scripts/validate_contracts.py`).

Decisiones de diseño fijadas (no re-litigar en las tareas):

- Embeddings: `embeddinggemma` vía Ollama local (`POST http://localhost:11434/api/embed`),
  dim **768**, vectores normalizados. Prefijos de tarea asimétricos obligatorios:
  `task: search result | query: {t}` para queries, `title: none | text: {t}` para documentos.
- Colecciones js-base (todas `vector: { dim: 768 }` salvo las marcadas): `nodes` (conocimiento
  curado, con `supersedes`/`superseded_by`), `turns` (log crudo por sesión), `sessions`
  (metadata + resumen vigente, sin vector), `assemblies` (auditoría sha256, sin vector).
- Corrección = dato, no edición: nodo nuevo `kind: correction` con `supersedes`; el viejo
  recibe `superseded_by` y el retrieval lo excluye con filtro Mongo
  `{ superseded_by: { $exists: false } }` (mismo patrón `$exists` que las rules de js-base).
- Orden de slots por volatilidad creciente (disciplina de caché KV): S0 system+índice
  (estático) - S1 resumen de sesión - S2 historial vivo append-only - S3 retrieval del
  turno - S4 turno actual. Correcciones por apéndice, nunca edición in situ.
- Compactación/promoción cuando el historial vivo supera ~20000 tokens (heurística
  4 chars/token, la misma de `scripts/assemble_context.py`).
- Régimen esporádico: si el tiempo desde el último turno supera el TTL de caché del
  proveedor, el assembler omite S2 y arma contexto mínimo (S0+S1+S3+S4).

## AGENT-EMBEDDER (T1) — cliente de embeddings Ollama con prefijos asimétricos

No existe generación de embeddings en js-base (almacena y busca vectores; no los produce).

FIX/OBJETIVO: existe `agent/embedder.js` con `makeEmbedder({ fetchImpl?, baseUrl?, model? })`
que embebe lotes de textos aplicando el prefijo correcto según `isQuery`, devuelve vectores
dim 768 y cachea por sha256(prefijo+texto) en memoria. `fetchImpl` inyectable: los tests NO
requieren Ollama vivo. Invariante: el mismo texto con `isQuery` distinto produce claves de
caché distintas.

## AGENT-ASSEMBLER (T2) — ensamblador determinista de contexto por slots

FIX/OBJETIVO: existe `agent/assembler.js` con `makeAssembler({ stores, semanticStores,
embedder, config })` que arma el contexto S0-S4 con presupuesto (`max_tokens` -
`output_reserve`), retrieval híbrido sobre `nodes` filtrando superseded con desempate
estable por id, guardrails `regex_deny` con abort sobre S3, firma sha256 del contexto
ensamblado, y modo esporádico (omite S2) cuando `now - lastTurnAt` supera `ttl_ms`.
Determinista: mismos stores + misma tarea = mismo contexto byte a byte. Sin llamadas al
LLM ni a Ollama dentro del assembler (recibe el vector de la query ya embebido o el
embedder inyectado; el reloj entra como parámetro `now`, nunca `Date.now()` interno).

## AGENT-INGESTOR (T3) — persistencia de turnos en js-base

FIX/OBJETIVO: existe `agent/ingestor.js` con `makeIngestor({ semanticStores, stores,
embedder })` que tras cada turno hace upsert del par user/assistant en `turns` (texto
embebido como documento, `session_id`, `seq` monotónico, `compacted` ausente) e inserta
el registro de auditoría en `assemblies`. Idempotente por `(session_id, seq, role)`.

## AGENT-PROMOTER (T4) — compactación y promoción log a conocimiento

FIX/OBJETIVO: existe `agent/promoter.js` con `makePromoter({ stores, semanticStores,
embedder, llm, threshold_tokens })` que cuando los turnos vivos de una sesión superan el
umbral: (1) pide al `llm` inyectado el resumen y los hechos durables, (2) escribe el
resumen en `sessions`, (3) inserta nodos `kind: fact|decision` en `nodes` con
`source_turns`, (4) marca los turnos como `compacted: true`. También expone
`supersede(oldId, correctionNode)` que inserta la corrección y marca el nodo viejo.
`llm` es una función async inyectada: los tests usan un fake determinista.

## AGENT-LOOP (T5) — orquestador del turno

FIX/OBJETIVO: existe `agent/loop.js` con `makeLoop({ assembler, ingestor, promoter, llm,
config })` que por turno: ensambla, llama al `llm` inyectado, persiste vía ingestor, y
dispara promoter si corresponde. Detecta el régimen (interactivo vs esporádico) y se lo
pasa al assembler. Errores del llm no corrompen estado: el turno fallido no se persiste.

## Criterios de aceptación

- [ ] Por tarea: `python scripts/validate_contracts.py knowledge/contracts` exit 0 y
  `node --test tests/agent-embedder.test.js tests/agent-assembler.test.js tests/agent-ingestor.test.js tests/agent-promoter.test.js tests/agent-loop.test.js` verde.
- [ ] Determinismo del assembler: el test lo corre 2 veces con los mismos stores y compara
  sha256 idéntico (`node --test tests/agent-assembler.test.js` incluye ese caso).
- [ ] Corrección efectiva: test que inserta nodo, lo supersede, y verifica que el retrieval
  del assembler ya no lo devuelve (`node --test tests/agent-promoter.test.js`).
- [ ] Suite completa del repo sin regresiones: `node --test` 180 + nuevos, 0 fail.
- [ ] Validadores KDD en verde: `python scripts/validate_okf.py knowledge` exit 0 y
  `python scripts/validate_specs.py specs` exit 0.
- [ ] Final: suite completa 2× verde (dos corridas idénticas); CI verde.

## Restricciones

- Tocar SOLO: `agent/embedder.js`, `agent/assembler.js`, `agent/ingestor.js`,
  `agent/promoter.js`, `agent/loop.js`, `tests/agent-embedder.test.js`,
  `tests/agent-assembler.test.js`, `tests/agent-ingestor.test.js`,
  `tests/agent-promoter.test.js`, `tests/agent-loop.test.js`,
  `knowledge/contracts/agent-embedder.md`, `knowledge/contracts/agent-assembler.md`,
  `knowledge/contracts/agent-ingestor.md`, `knowledge/contracts/agent-promoter.md`,
  `knowledge/contracts/agent-loop.md`. Perímetros por tarea disjuntos: cada T toca su
  módulo + su test + su contrato.
- `src/**` y `src/vendor/**` son READ-ONLY: la capa `agent/` consume js-base embebido
  (`createServer` / stores) sin modificarlo. `bin/`, `scripts/` y el CI no se tocan en
  este contrato (el paso de CI para `tests/agent-*.test.js` ya queda cubierto por
  `npm test` = `node --test`, que descubre los archivos nuevos).
- Cero dependencias de runtime nuevas: solo `node:*` y los módulos del repo. La única
  red permitida es HTTP a Ollama en localhost dentro de `agent/embedder.js`, siempre
  detrás de `fetchImpl` inyectable; los tests no abren red.
- Los tests de `agent/*` usan fakes inyectados (fetchImpl, llm, reloj como parámetro):
  ningún test depende de Ollama vivo ni de un LLM real.
- NO commitear (el PM commitea por tarea verificada). Si algo no se puede sin romper otro
  criterio, PARAR y reportar.
- ABORTAR SI: el retrieval con filtro `$exists` sobre `superseded_by` no excluye los nodos
  superseded en la SemanticCollection real; o el modo disco de js-base no permite dos
  stores (docs y vectores) para las colecciones nuevas sin tocar `src/`; o mantener el
  determinismo del assembler exige acceso a reloj o aleatoriedad interna. En ese caso
  PARAR, documentar el porqué con evidencia en el reporte y marcar BLOQUEADO.

## Checklist antes de delegar

- [x] RECON corrido: dim 768 y norma 1.0 verificadas contra Ollama real
  (`POST /api/embed`, modelo `embeddinggemma`); `matchFilter` soporta `$exists` (es la
  convención de login de las rules); `SemanticCollection.search` acepta `filter` Mongo;
  suite actual 180/180 verde ejecutada; `npm test` = `node --test` descubre
  `tests/*.test.js` nuevos sin tocar CI.
- [x] Todo criterio de aceptación tiene comando + resultado esperado (por máquina).
- [x] Red-team hecho: el determinismo se verifica por sha256 repetido, no por lectura;
  la corrección se verifica por ausencia en retrieval, no por presencia de flag; los
  fakes inyectados impiden que un test pase en vacío por servicios ausentes.
- [x] Perímetro de archivos declarado por tarea, disjunto entre tareas concurrentes.
- [x] Condiciones de aborto explícitas.

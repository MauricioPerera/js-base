---
type: 'Task Contract'
title: 'Cliente de embeddings Ollama (embeddinggemma) con prefijos asimétricos'
description: 'makeEmbedder({ fetchImpl?, baseUrl?, model? }) embebe lotes contra /api/embed de Ollama aplicando prefijos query/documento de EmbeddingGemma, con caché en memoria por hash. fetchImpl inyectable: los tests no requieren Ollama vivo.'
tags: ['js-base', 'agent', 'embeddings', 'ollama', 'kdd']

task: agent-embedder
intent: "Dotar a la capa agent/ de un cliente de embeddings sobre Ollama local (embeddinggemma, dim 768) que aplique los prefijos de tarea asimétricos del modelo (query vs documento), embeba en lote y cachee por sha256(prefijo+texto), con el transporte HTTP inyectable para testear sin red."
target: agent/embedder.js
signature: "makeEmbedder(opts?) -> { async embed(texts, { isQuery? }) -> number[][], cacheSize() -> number }"
language: javascript
test_command: "node --test tests/agent-embedder.test.js"
budget:
  max_cyclomatic_complexity: 7
  max_nesting_depth: 3
tests: "tests/agent-embedder.test.js"
deps_allowed: ['node:crypto']
forbids: ['red-externa', 'subprocess', 'editar-src', 'editar-src-vendor', 'dependencias-npm']
---

# Contract: agent-embedder

## Intent
js-base almacena y busca vectores pero no los produce: esta pieza es la única frontera
con el generador de embeddings. Envuelve `POST {baseUrl}/api/embed` de Ollama (default
`http://localhost:11434`, modelo default `embeddinggemma`) y fija la convención que el
resto de la capa `agent/` asume: **prefijos asimétricos** de EmbeddingGemma (el modelo
fue entrenado con ellos y Ollama no los agrega solo). Metodología:
[metodologia-ejecución](../metodologia-ejecucion.md). Contrato de ejecución padre:
CONTRACT-10 (T1) en `specs/`.

## Interface
```javascript
const { makeEmbedder } = require("../agent/embedder.js");

const embedder = makeEmbedder({
  fetchImpl,                          // opcional; default: globalThis.fetch
  baseUrl: "http://localhost:11434",  // opcional (default)
  model: "embeddinggemma",            // opcional (default)
});

// embed(texts, { isQuery = false }) -> Promise<number[][]>
//   - texts: string[] no vacío.
//   - isQuery: true  -> prefijo "task: search result | query: {t}"
//              false -> prefijo "title: none | text: {t}"
//   - Devuelve un vector number[] de longitud 768 por cada texto, en el mismo orden.
// cacheSize() -> number de entradas en la caché (para tests/observabilidad).
```

## Invariants
- El prefijo se aplica ANTES de llamar a Ollama y ANTES de calcular la clave de caché:
  clave = sha256 del texto YA prefijado. El mismo texto con `isQuery` distinto produce
  claves distintas (espacios de embedding asimétricos, jamás se mezclan).
- La caché es en memoria del proceso (Map), sin límite en v1, y un hit NO llama a
  `fetchImpl`. En un lote mixto solo se envían a Ollama los textos con miss, y el
  resultado se reordena al orden de entrada.
- `embed([])` o `texts` no-array o con elementos no-string -> lanza `Error` con
  `code: 'VALIDATION'` sin llamar a `fetchImpl`.
- Respuesta de Ollama sin `embeddings`, con longitud distinta a los misses enviados, o
  con vectores de dim distinta de 768 -> lanza `Error` con `code: 'EMBEDDER'` (no se
  cachea nada de esa respuesta).
- `fetchImpl` que rechaza o responde `!ok` -> lanza `Error` con `code: 'EMBEDDER'`
  preservando `cause`. Nunca devuelve resultados parciales.
- Cero estado fuera del Map de caché; cero I/O fuera de `fetchImpl`.

## Examples
- `embed(["hola"], { isQuery: true })` envía a Ollama
  `{ model: "embeddinggemma", input: ["task: search result | query: hola"] }` y devuelve
  `[[...768 números...]]`.
- `embed(["hola"])` (documento) envía `input: ["title: none | text: hola"]`; una segunda
  llamada idéntica NO llama a `fetchImpl` (`cacheSize()` sigue en 1, fetch contado 1 vez).
- `embed(["a", "b", "a"])` con caché vacía llama a `fetchImpl` UNA vez con los 2 textos
  únicos con miss y devuelve 3 vectores en el orden de entrada.
- `embed(["hola"], { isQuery: true })` tras `embed(["hola"])` SÍ llama a `fetchImpl`
  (prefijo distinto -> clave distinta) y `cacheSize()` pasa a 2.

## Do / Don't
- DO: inyectar `fetchImpl` en tests con un fake que registre las llamadas y devuelva
  vectores sintéticos de dim 768; el default `globalThis.fetch` solo se usa en runtime.
- DO: usar `node:crypto` (`createHash('sha256')`) para las claves de caché.
- DO: validar inputs antes de tocar la red (mismo estilo que `validateVector` en
  `src/semantic-routes.js`).
- DON'T: reintentar, hacer backoff ni poner timeouts en v1 (el caller decide); no
  normalizar los vectores (embeddinggemma ya devuelve norma 1.0, verificado en RECON).
- DON'T: tocar `src/**`, agregar dependencias npm, abrir red que no sea el `baseUrl`
  configurado, ni persistir la caché a disco.

## Tests
(Los tests están en `tests/agent-embedder.test.js`, congelados, con `fetchImpl` fake.
Cubren: prefijo query vs documento en el body enviado; orden y dim del resultado;
caché hit no re-llama y cacheSize cuenta; lote mixto deduplica misses; claves distintas
por isQuery; VALIDATION en inputs inválidos sin tocar fetch; EMBEDDER en respuesta !ok,
en dim errónea y en longitud desalineada, sin cachear parciales.)

## Constraints
- PARAR y reportar si el shape real de `/api/embed` de Ollama difiere del asumido
  (`{ model, input: string[] }` -> `{ embeddings: number[][] }`): se verificó en RECON
  contra la instancia local (dim 768, norma 1.0) el 2026-07-11.
- PARAR y reportar si cumplir los tests exigiera editar archivos fuera de
  `agent/embedder.js`, `tests/agent-embedder.test.js` y
  `knowledge/contracts/agent-embedder.md`.
- PARAR y reportar si el budget de complejidad no alcanza sin sacrificar los invariantes
  (antes de simplificar invariantes, subdividir en helpers puros).

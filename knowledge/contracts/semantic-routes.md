---
type: 'Task Contract'
title: 'semantic-routes — endpoints de busqueda semantica sobre el nucleo HTTP'
description: 'Rutas /api/collections/:col/vectors, /search, /search/hybrid, /reindex y DELETE /vectors/:id. Carril paralelo al CRUD: solo colecciones con vector.dim. semantic-provider cachea SemanticCollection (memoria o disco). Cero dependencias.'
tags: ['js-base', 'semantic', 'vector', 'search', 'http', 'kdd', 'backend']

task: semantic-routes
intent: "Exponer la busqueda semantica nativa (upsert de vectores, search, search/hybrid, reindex y delete) como un carril HTTP paralelo al CRUD documental, aplicando SOLO a colecciones con vector.dim, delegando autorizacion a rules (inyectadas) y resolucion de token a un authResolver inyectado — sin acoplar las rutas al vendor concreto ni tocar records."
target: src/semantic-routes.js
signature: "registerSemanticRoutes(app, { registry, semanticStores, authResolver }) -> app"
language: javascript
test_command: "node --test tests/semantic.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 4
tests: "tests/semantic.test.js"
deps_allowed: ['src/server.js', 'src/semantic-provider.js', 'src/collections.js', 'src/vendor/js-store/index.js']
forbids: ['network-external', 'subprocess', 'static-files', 'editar-src/records.js', 'editar-src/server.js', 'editar-src/collections.js', 'editar-src/vendor/**', 'editar-knowledge/index.md']
---

# Contract: semantic-routes

## Intent
Ser la capa HTTP de la busqueda semantica: rutas bajo
`/api/collections/:col/vectors`, `/search`, `/search/hybrid`, `/reindex` y
`DELETE /vectors/:id` que operan sobre una `SemanticCollection` (vendor) resuelta
via `semanticStores.get(col)`. Es un CARRIL PARALELO al CRUD documental
(`[[records]]`): no lo toca ni lo reemplaza. Solo aplica a colecciones cuyo
config tiene `vector.dim` entero > 0; las demas (y las inexistentes) dan `404`.
Cada op autoriza contra `app.rules.check` (inyectadas via `createApp`) y resuelve
`auth = await authResolver(ctx.token)` (INYECTADO; fake en tests). Metodologia:
[metodologia-ejecucion](../metodologia-ejecucion.md). Depende de [[http-core]],
[[collections]] y [[hooks]].

## Interface
```javascript
const { registerSemanticRoutes } = require('./semantic-routes.js');
const { makeSemanticStores } = require('./semantic-provider.js');
// const { CollectionRegistry } = require('./collections.js');
// const { createApp } = require('./server.js');

// registerSemanticRoutes(app, { registry, semanticStores, authResolver }) -> app
//   app             : app de createApp({ rules, events }) — provee app.rules
//   registry        : CollectionRegistry (get(name) -> config | null)
//   semanticStores  : { get(colName) -> SemanticCollection | null, closeAll() }
//   authResolver    : async (token: string|null) -> user: object|null  (INYECTADO)

// semanticStores.get(colName) -> SemanticCollection | null:
//   - null si la coleccion no existe o no tiene vector.dim entero > 0.
//   - crea y cachea UNA sola instancia por nombre.
//   - baseDir pasado  -> modo DISCO  new SemanticCollection({ path: <baseDir>/<colName>, dim })
//   - baseDir ausente -> modo MEMORIA new SemanticCollection({ dim })

// Rutas registradas (todas bajo /api/collections/:col):
//   POST   /vectors          op "create" -> 201 { id }                  (id ?? uuid)
//   POST   /search           op "list"   -> { items: [{id,score,doc}] }
//   POST   /search/hybrid    op "list"   -> { items: [{id,score,doc}] }
//   DELETE /vectors/:id      op "delete" -> { ok: true } | 404 NOT_FOUND
//   POST   /reindex          op "update" -> { ok: true }  (admin; solo modo disco)
//
// Body de POST /vectors:   { id?, doc, vector:[number] }  (vector len === dim)
// Body de POST /search:    { vector:[number], limit?=10 (max 100), filter? }
// Body de POST /search/hybrid: { vector, query:string, limit?, textField?="text", filter? }
// Body de POST /reindex:   { nClusters?, nProbe? }
//
// ctx de rules.check (uno por op): { op, collection, auth, record, request:{method,path,query} }
//   record: { id, doc, vector } para create; { id } para delete; null para list/update.
```

## Invariants
- **Cero dependencias de runtime nuevas.** Solo `src/server.js`,
  `src/semantic-provider.js`, `src/collections.js`, `node:crypto`, `node:path` y
  el vendor; sin HTTPS, sin red externa, sin subprocess, sin static files.
- **Carril paralelo al CRUD.** No importa ni modifica `src/records.js`; las rutas
  semanticas conviven con las de records bajo el mismo `app`.
- **Coleccion sin vector.dim -> 404.** Si `semanticStores.get(col)` es `null`
  (coleccion inexistente o sin `vector.dim` entero > 0), TODAS las rutas lanzan
  `NOT_FOUND` (antes de rules y de cualquier I/O del vendor).
- **Autorizacion obligatoria.** Cada op llama
  `await app.rules.check({ op, collection, auth, record, request })` y lanza
  `FORBIDDEN` si `!allow`. `auth` es `await authResolver(ctx.token)` (user o
  null); el modulo NO verifica tokens. `op` por ruta: create=POST /vectors,
  list=/search y /search/hybrid, delete=DELETE /vectors/:id, update=/reindex.
- **Validacion de vector.** POST /vectors, /search y /search/hybrid validan que
  `vector` sea un Array de longitud exacta `config.vector.dim` con numeros
  finitos; si no, lanzan `VALIDATION` (400). La validacion ocurre ANTES de rules
  (input valido -> luego autorizo) salvo en /vectors donde se valida antes de
  upsert; en todos los casos el status final es 400 VALIDATION.
- **POST /vectors: id opcional.** Si `body.id` viene se usa (String); si no,
  `crypto.randomUUID()`. Llama `store.upsert(id, doc, vector)` -> respuesta
  `201` con `{ id }` via `ctx.status`.
- **Limit saneado.** /search y /search/hybrid: `limit` default `10`, clampeado a
  `[1, 100]` (no-numero / <1 -> default; >100 -> 100).
- **filter es objeto Mongo.** Si `body.filter` viene y no es objeto plano (es
  null/array/primitive) -> `VALIDATION`. Ausente -> sin filtro.
- **DELETE /vectors/:id: NOT_FOUND si no existia.** El vendor
  `SemanticCollection.delete(id)` devuelve `boolean`: `true` si el doc existia
  (remove > 0), `false` si no. Mapeamos `false` -> `NOT_FOUND` (404); `true` ->
  `{ ok: true }`.
- **reindex es op de escritor (modo disco).** `SemanticCollection.reindex(nClusters,
  nProbe)` construye un IVF sobre el archivo de vectores del modo disco y lo
  activa para search. En modo MEMORIA/inyeccion el vendor lanza
  `"reindex: solo en modo disco"` -> la ruta propaga el error y el nucleo lo
  mapea a `500 INTERNAL`. Costo: O(n) con kmeans; pesado en datasets grandes —
  caveat de costo documentado, no se pelee aqui. `op` "update" (admin).
- **ensureIndex NO expuesto por HTTP en el MVP.** Queda para admin interno (mismo
  vendor `SemanticCollection.ensureIndex(field)`, solo modo disco). Si se agrega
  via HTTP, mismo patron op "update".
- **Caveat heredado de searchHybrid (RAM).** `searchHybrid` reconstruye un
  `BM25Index` en RAM por query (rebuild-at-query) sobre los docs de la coleccion.
  En modo disco con datasets grandes puede ser costoso en memoria; es un limite
  conocido del vendor, no se pelea aqui (ver [[semantic-collection-hybrid]]).
- **No cachea estado que rompa concurrencia.** `semanticStores` cachea 1
  `SemanticCollection` por nombre; dos providers sobre el mismo baseDir en modo
  disco abren su propio `DiskKV` (1 escritor + N lectores via refresh del vendor).

## Examples
- `POST /api/collections/docs/vectors` con body
  `{ id: "a", doc: { text: "hola", tag: "x" }, vector: [1,0,0] }` -> `201`
  `{ id: "a" }`; `rules.check` recibe `op:"create"`, `record:{id,doc,vector}`.
- `POST /api/collections/docs/search` con body
  `{ vector: [0.99,0,0.01], limit: 5 }` -> `200`
  `{ items: [{ id: "a", score: 0.999..., doc: {...} }, ...] }`.
- `POST /api/collections/docs/search` con body
  `{ vector: [1,1,1], filter: { tag: "a" } }` -> `200` `{ items }` donde todo
  `item.doc.tag === "a"` (filtro Mongo restringe resultados).
- `POST /api/collections/docs/search/hybrid` con body
  `{ vector: [1,0,0], query: "hola", textField: "text" }` -> `200`
  `{ items: [{id,score,doc}] }`.
- `POST /api/collections/docs/vectors` con body
  `{ id: "x", doc: {}, vector: [1,0] }` (dim=3) -> `400` `VALIDATION`.
- `POST /api/collections/plain/vectors` (`plain` con `vector:null`) -> `404`
  `NOT_FOUND` (carril semantico no aplica a colecciones sin vector.dim).
- `createApp({ rules: { async check(c){ return { allow: c.op !== 'create' } } } })` ->
  `POST .../vectors` devuelve `403` y el vector NO se persista (search posterior
  no lo trae).
- `DELETE /api/collections/docs/vectors/a` -> `200` `{ ok: true }`; search
  posterior no incluye `"a"`. `DELETE .../vectors/ghost` -> `404` `NOT_FOUND`.
- Modo disco: `makeSemanticStores({ registry, baseDir: tmp })`; tras
  `upsert + closeAll`, un nuevo provider sobre el mismo `baseDir` ve los datos
  (persistencia en disco via `DiskKV`).

## Do / Don't
- DO: tomar `rules` del `app` inyectado (no instanciar defaults propios).
- DO: resolver `auth = await authResolver(ctx.token)` por request y pasarlo a
  `rules.check`; nunca verificar tokens aqui (delegacion a [[auth-service]]).
- DO: lanzar `Error` con `.code` (`NOT_FOUND`, `FORBIDDEN`, `VALIDATION`) para
  que [[http-core]] mapee a status; no armar respuestas HTTP a mano.
- DO: validar `vector` (Array len===dim, numeros finitos) y sanear `limit`
  (default 10, clamp [1,100]) antes de llamar al vendor.
- DO: mapear `delete(id) === false` -> `NOT_FOUND`; documentar que el vendor
  devuelve boolean.
- DO: llamar `semanticStores.closeAll()` en el lifecycle de tests/proc para no
  dejar locks de modo disco abiertos.
- DON'T: tocar `src/records.js`, `src/server.js`, `src/collections.js`,
  `src/vendor/**`, `knowledge/index.md` ni los tests existentes.
- DON'T: exponer `ensureIndex` por HTTP en el MVP (admin interno).
- DON'T: mutar si `rules.check` deniega — lanzar `FORBIDDEN` antes de cualquier
  I/O del vendor (create/delete).

## Tests
`tests/semantic.test.js` (congelado con `createApp` real + `CollectionRegistry`
real con `{ name:"docs", vector:{dim:3} }` y `{ name:"plain", vector:null }` +
fakes de rules/authResolver, `listen(0)` + `fetch` global, server cerrado y
`semanticStores.closeAll()` en `finally`). Cubre:
- upsert de 3 vectores dim3 -> search por el mas cercano devuelve el id correcto
  con score > 0.
- search con filter Mongo restringe resultados (todo item.doc.tag === "a").
- hybrid con query textual devuelve items con score.
- vector de longitud incorrecta -> 400 VALIDATION (en /vectors y /search).
- coleccion sin vector.dim (`plain`) -> /vectors y /search dan 404 NOT_FOUND.
- rules que deniegan "create" -> 403 y NO persista (search posterior sin el id).
- delete quita el vector (search posterior no lo trae; delete de id inexistente
  -> 404).
- modo DISCO: en tempdir limpiado, upsert + closeAll + nuevo provider sobre el
  mismo baseDir ve los datos (persistencia); proceso de test termina solo
  (closeAll en finally).

## Constraints
- PARAR y reportar si la API real de `src/vendor/js-store/index.js`
  (`SemanticCollection`) difiere de lo descrito (leer antes; detalle menor ->
  adaptarse y documentar; de raiz -> BLOQUEADO con evidencia). Verificado:
  `upsert(id, doc, vector)`, `search(vector, {limit, filter})`,
  `searchHybrid(vector, queryText, {limit, textField, filter})`, `get`,
  `delete(id) -> boolean`, `count`, `reindex(nClusters, nProbe)` (solo disco),
  `ensureIndex(field)` (solo disco), `close()`.
- PARAR y reportar si los tests existentes (`tests/*.test.js` ajenos a este
  batch) estan rojos de base — no avanzar sobre base rota.
- PARAR y reportar si mantener los tests verdes exigiera editar `src/records.js`,
  `src/server.js`, `src/collections.js`, `src/vendor/**`, `knowledge/index.md`
  ni ningun archivo existente fuera de `src/semantic-provider.js`,
  `src/semantic-routes.js`, `tests/semantic.test.js` y
  `knowledge/contracts/semantic-routes.md`.
- PARAR y reportar si `python scripts/validate_okf.py knowledge` exigiera editar
  `knowledge/index.md` (index.md ya enlaza la carpeta `contracts/`, por lo que
  este contrato queda alcanzable sin editarlo).
- Cero dependencias runtime nuevas; sin HTTPS/websockets/static; sin red externa;
  sin subprocess; sin loguear tokens completos.
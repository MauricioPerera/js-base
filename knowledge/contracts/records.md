---
type: 'Task Contract'
title: 'records — rutas CRUD de records sobre el nucleo HTTP'
description: 'Rutas /api/collections/:col/records[/:id] con validacion, rules.check, events.emit y authResolver inyectado. CRUD via store-provider sobre db.collection(). Cero dependencias.'
tags: ['js-base', 'records', 'crud', 'http', 'kdd', 'backend']

task: records
intent: "Exponer el CRUD estilo PocketBase de records de una coleccion sobre el nucleo HTTP, delegando autorizacion a rules (inyectadas), persistencia a un store estrecho sobre DocStore, y resolucion de token a un authResolver inyectado — sin acoplar records a auth-service ni al storage concreto."
target: src/records.js
signature: "registerRecordRoutes(app, { registry, stores, authResolver }) -> app"
language: javascript
test_command: "node --test tests/records.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 4
tests: "tests/records.test.js"
deps_allowed: ['src/server.js', 'src/store-provider.js', 'src/collections.js']
forbids: ['network-external', 'subprocess', 'static-files', 'editar-src/auth-routes.js', 'editar-src/files.js']
---

# Contract: records

## Intent
Ser la capa HTTP de records: rutas `/api/collections/:col/records[/:id]` que validan
contra el `CollectionRegistry`, persisten via un `store` (interfaz estrecha sobre
`db.collection(name)`), autorizan cada op contra `app.rules.check` (inyectadas via
`createApp`) y emiten `app.events.emit` tras persistir. El modulo NO conoce
auth-service: recibe un `authResolver` async `(token|null) -> user|null` que otro
batch cablea contra el real. Metodologia:
[metodologia-ejecucion](../metodologia-ejecucion.md). Depende de [[http-core]],
[[collections]] y [[hooks]].

## Interface
```javascript
const { registerRecordRoutes } = require('./records.js');
// const { makeStores } = require('./store-provider.js');
// const { CollectionRegistry } = require('./collections.js');
// const { createApp } = require('./server.js');

// registerRecordRoutes(app, { registry, stores, authResolver }) -> app
//   app          : app de createApp({ rules, events }) — provee app.rules, app.events
//   registry     : CollectionRegistry (get/validateDoc)
//   stores       : { get(colName) -> store }  (de makeStores(db))
//   authResolver : async (token: string|null) -> user: object|null  (INYECTADO)

// store (interfaz estrecha, de makeStores(db)):
//   insert(id|null, doc) -> doc con _id   // crypto.randomUUID() si id null
//   get(id)              -> doc | null
//   find(filter)          -> array         // copia de los docs que matchean
//   count(filter)         -> number
//   update(id, doc)       -> doc           // REEMPLAZO; NOT_FOUND si no existe
//   remove(id)            -> boolean       // true si borro

// Rutas registradas (todas bajo /api/collections/:col/records[/:id]):
//   GET    /api/collections/:col/records          -> { page, perPage, totalItems, items }
//   GET    /api/collections/:col/records/:id     -> doc
//   POST   /api/collections/:col/records         -> 201 + doc creado
//   PATCH  /api/collections/:col/records/:id     -> doc actualizado
//   DELETE /api/collections/:col/records/:id      -> { ok: true }
//
// Query de list:
//   filter  : JSON URL-encodeado, filtro tipo Mongo (default {}). 400 VALIDATION si no parsea.
//   page    : 1-based, default 1.
//   perPage : default 30, max 200 (clampeado).
//
// ctx de rules.check (uno por op): { op, collection, auth, record, request:{method,path,query} }
// evt de events.emit (solo create/update/delete, DESPUES de persistir):
//   { collection, op, record }
```

## Invariants
- **Cero dependencias de runtime nuevas.** Solo `src/server.js`,
  `src/store-provider.js`, `src/collections.js` y el vendor; sin HTTPS, sin red
  externa, sin subprocess, sin static files.
- **Coleccion inexistente -> 404.** Si `registry.get(col)` es `null`, TODAS las
  rutas lanzan `NOT_FOUND` (antes de rules y de cualquier I/O de storage).
- **Autorizacion obligatoria.** Cada op llama
  `await app.rules.check({ op, collection, auth, record, request })` y lanza
  `FORBIDDEN` si `!allow`. `auth` es el resultado de `await authResolver(ctx.token)`
  (user o null); el modulo NO verifica tokens. `record` es: `null` para list;
  el doc para view/update/delete; el doc a crear para create.
- **Validacion.** POST y PATCH validan con `registry.validateDoc(col, doc)`; si
  `!ok` lanzan `VALIDATION` con `errors.join('; ')` como mensaje.
- **PATCH es merge superficial.** `{ ...existing, ...body, _id: existing._id }`:
  `_id` es inmutable (se ignora `body._id`). Se valida el doc resultante y se
  REEMPLAZA via `store.update(id, merged)`.
- **POST: `_id` opcional.** Si `body._id` viene, se usa como id; si no, el store
  genera `crypto.randomUUID()`. Respuesta `201` via `ctx.status`.
- **Events despues de persistir.** `app.events.emit({ collection, op, record })`
  se invoca SOLO en create/update/delete, con el doc persistido (o el existente
  en delete), DESPUES de confirmar la mutacion. List/view NO emiten.
- **DELETE idempotente.** Devuelve `{ ok: true }`; si el doc no existe (o ya fue
  borrado) lanza `NOT_FOUND`.
- **store.update es reemplazo, no merge.** El merge lo arma el handler; el store
  solo reemplaza el doc con ese `_id` (removeById + insert).
- **No cachea estado que rompa concurrencia.** El store resuelve
  `db.collection(colName)` en cada llamada; dos stores sobre el mismo nombre
  operan sobre la misma coleccion subyacente (DocStore cachea la instancia).

## Examples
- `POST /api/collections/posts/records` con body `{ title: "x", views: 0 }` ->
  `201` `{ _id: "<uuid>", title: "x", views: 0 }`; emite
  `{ collection: "posts", op: "create", record: <doc> }`.
- `GET /api/collections/posts/records?filter=%7B%22views%22%3A%7B%22%24gte%22%3A6%7D%7D&page=2&perPage=5`
  -> `{ page: 2, perPage: 5, totalItems: <n>, items: [...] }` (filter decodificado a
  `{"views":{"$gte":6}}`).
- `PATCH .../records/<id>` con body `{ _id: "hacked", views: 9 }` -> `_id` del doc
  queda igual al existente; `views` pasa a 9.
- `GET /api/collections/nope/records` -> `404` (coleccion no registrada).
- `createApp({ rules: { async check(c){ return { allow: c.op !== 'delete' } } } })` ->
  `DELETE .../records/<id>` devuelve `403` y el doc sigue existiendo.

## Do / Don't
- DO: tomar `rules` y `events` del `app` inyectado (no instanciar defaults propios).
- DO: resolver `auth = await authResolver(ctx.token)` por request y pasarlo a
  `rules.check`; nunca verificar tokens aqui (delegacion a [[auth-service]]).
- DO: lanzar `Error` con `.code` (`NOT_FOUND`, `FORBIDDEN`, `VALIDATION`) para que
  [[http-core]] mapee a status; no armar respuestas HTTP a mano.
- DO: emitir `events.emit` SOLO tras persistir (create/update/delete), con el doc
  resultante; nunca en list/view.
- DO: clampear `perPage` a `max 200`, default `30`; `page` 1-based, default 1.
- DON'T: hacer HTTP/IO propio fuera del nucleo; tocar `src/auth-routes.js`,
  `src/files.js`, `src/vendor/**` ni los tests existentes.
- DON'T: fusionar dentro del store — el merge es responsabilidad del handler.
- DON'T: filtrar el body a campos declarados (validateDoc permite campos extra);
  persistir el doc tal cual lo arma el handler.

## Tests
`tests/records.test.js` (congelado con `createApp` real + `CollectionRegistry` real
+ `MemoryStorageAdapter` + fakes de rules/events/authResolver, `listen(0)` + `fetch`
global, servers cerrados en `finally`). Cubre:
- CRUD happy path completo via fetch real (POST 201 -> GET -> PATCH merge -> DELETE
  -> GET 404).
- List con filter Mongo + paginacion (`totalItems` correcto, `perPage` respetado,
  `perPage>200` clampeado a 200, page 1/2/3); filter invalido -> 400 VALIDATION.
- POST invalido segun schema (required faltante, tipo incorrecto) -> 400 con errors.
- PATCH no pisa `_id` (body._id ignorado).
- Coleccion inexistente -> 404 (GET y POST).
- Rules que deniegan una op -> 403 y NO persiste (create y delete).
- `events.emit` con `{ collection, op, record }` correcto en create/update/delete y
  NO en list/view.
- `authResolver` recibido: `rules.check` recibe `auth` del resolver (Bearer `u1` ->
  `{ id: "u1" }`); sin token -> `auth: null`.

## Constraints
- PARAR y reportar si la API real de `src/server.js` / `src/hooks.js` /
  `src/collections.js` / `src/vendor/js-store/vendor/js-doc-store.js` difiere de lo
  descrito en [[http-core]]/[[collections]] (leer antes; si difiere en detalle menor,
  adaptarse y documentar; si difiere de raiz, BLOQUEADO con evidencia).
- PARAR y reportar si los tests existentes (`tests/*.test.js` ajenos a este batch)
  estan rojos de base — no avanzar sobre base rota.
- PARAR y reportar si mantener los tests verdes exigiera editar
  `src/auth-routes.js`, `src/files.js`, `tests/auth-routes.test.js`,
  `tests/files.test.js`, `knowledge/index.md` ni ningun archivo existente fuera de
  `src/store-provider.js`, `src/records.js`, `tests/records.test.js` y
  `knowledge/contracts/records.md`.
- PARAR y reportar si `python scripts/validate_okf.py knowledge` exigiera editar
  `knowledge/index.md` (index.md ya enlaza la carpeta `contracts/`, por lo que este
  contrato queda alcanzable sin editarlo).
- Cero dependencias runtime nuevas; sin HTTPS/websockets/static; sin red externa;
  sin subprocess; sin loguear passwords ni tokens completos.
---
type: 'Task Contract'
title: 'app-integration — ensamble del server js-base (createServer + CLI)'
description: 'Módulo de integración que ensambla todas las piezas previas (DocStore, registry, auth, stores, semantic, rules, realtime, nucleo HTTP, rutas) en un server real arrancable, sin reimplementar nada. Más el launcher CLI bin/js-base.js.'
tags: ['integration', 'server', 'cli', 'assembly', 'js-base']

task: app-integration
intent: "Cablear constructores y registros de los batches B2–B5 en un createServer({dataDir,secret,filesDir?}) arrancable + bin/js-base.js, sin reimplementar lógica de ningún batch."
target: src/app.js
signature: "async function createServer({ dataDir, secret, filesDir? }) -> { app, db, registry, auth, stores, semanticStores, realtime, rules, listen(port), close() }"
test_command: "node --test tests/integration.test.js"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/integration.test.js"
deps_allowed: []
forbids: ['reimplement-batches', 'edit-other-src', 'network-external', 'subprocess', 'deps-runtime', 'log-secrets']
---

# Contract: app-integration

## Intent
Proveer el punto de entrada único que ensambla un backend js-base completo y
arrancable sobre un `dataDir` real (filesystem atómico), reutilizando al 100%
las piezas de los batches previos: `DocStore` + `AtomicFileStorageAdapter` (B1),
`CollectionRegistry` (B1), `createAuthService` (B1), `makeStores` (B3),
`makeSemanticStores` (B4), `makeRules` (B4), `makeRealtime` (B4), `createApp`
(B2), y los `register*Routes` (B3/B4/B5). El módulo NO reimplementa nada: solo
construye, inyecta y registra. Más un launcher CLI (`bin/js-base.js`) que lee
`PORT`/`DATA_DIR`/`SECRET` del entorno y maneja `SIGINT`/`SIGTERM`.

## Interface
```js
const { createServer } = require('./app.js');        // o require('js-base').createServer

// Construccion (lanza Error plano si dataDir falta o secret < 16 chars):
const server = await createServer({ dataDir, secret, filesDir? });
//   dataDir  : dir raiz de datos (requerido). Crea <dataDir>/system (DocStore),
//              <dataDir>/semantic (SemanticCollection disco) y <dataDir>/files
//              (blobs) salvo que se pase filesDir.
//   secret   : string >= 16 chars (requerido; lo valida createAuthService).
//   filesDir?: dir de blobs (default <dataDir>/files).

// Miembros:
//   server.app             : app del nucleo (createApp)
//   server.db              : DocStore sobre AtomicFileStorageAdapter(<dataDir>/system)
//   server.registry        : CollectionRegistry(db)
//   server.auth            : service de createAuthService({db, secret})
//   server.stores          : makeStores(db)
//   server.semanticStores  : makeSemanticStores({ registry, baseDir: <dataDir>/semantic })
//   server.realtime        : makeRealtime()  (realtime.events === app.events)
//   server.rules           : rules compuesto (ver Invariants — '_files' reservada)
//   server.listen(port)    : delega en app.listen (port=0 => efimero)
//   server.close()         : async; app.close() + semanticStores.closeAll()

// CLI (bin/js-base.js):
//   PORT (default 3000), DATA_DIR (default ./data), SECRET (OBLIGATORIO; si falta
//   o < 16 chars -> error claro y exit 1; NUNCA arranca con secret default).
//   SIGINT/SIGTERM -> server.close() + exit 0. Log: "js-base escuchando en :PORT".
```

## Invariants
- **Ensamblado, no reimplementación.** Toda la lógica vive en los batches previos.
  `app.js` solo: valida args, construye `db`/`registry`/`auth`/`stores`/
  `semanticStores`/`rules`/`realtime`, arma `authResolver`, registra las 5
  familias de rutas + `realtime.register(app)`, y expone `listen`/`close`.
- **Persistencia compartida.** `db` usa `AtomicFileStorageAdapter(<dataDir>/system)`;
  `_users`, `_sessions` y `_collections` viven en el mismo DocStore => mismas
  instancias de Collection => auth y registry comparten estado.
- **authResolver.** `async (token) -> user|null`. Delega en `auth.verify` (payload
  JWT del vendor: `{ sub, email, roles, iat, exp }`). Token ausente/inválido ->
  `null`. TRADE-OFF: la convención canónica de rules y `files.js` usa `auth.id`,
  no `auth.sub`; el resolver mapea `id = payload.sub` para que la regla
  "exigir login" `{ "auth.id": { $exists: true } }` funcione con tokens reales.
  Ver ## Limitaciones.
- **Reservada '_files' (TRADE-OFF de ensamblaje).** `files.js` evalúa rules contra
  la colección `'_files'` (POST/DELETE), pero `makeRules(registry)` deniega por
  defecto toda colección NO registrada, y `'_files'` NO se puede registrar
  (`collections.js` prohíbe `_` inicial vía `NAME_REGEX`). Sin adaptación, todo
  upload/delete de files quedaría 403 y el server no serviría blobs. `app.js`
  compone un `rules` que delega al rules-engine real para colecciones de usuario
  y trata `'_files'` (reservada, sistema) como PÚBLICA — consistente con el MVP
  de files (lectura pública; POST/DELETE permisivos, igual que `defaultRules` en
  `tests/files.test.js`). NO parchea otros batches: es policy de ensamblaje en
  este glue. Una tarea futura puede registrar una policy real para blobs cuando
  el registry soporte reservadas.
- **Directorio semántico.** `makeSemanticStores` NO crea el `baseDir` (ni el
  `SemanticCollection` en modo disco). `app.js` hace
  `fs.mkdirSync(<dataDir>/semantic, { recursive: true })` para que el primer
  upsert/search no falle con `ENOENT`. `registerFileRoutes` crea su propio dir.
- **realtime.events === app.events.** Se pasa `realtime.events` a `createApp` y
  `realtime.register(app)` monta `/api/realtime/:collection`. Los `emit` de
  records (create/update/delete) hacen fanout a los suscriptores SSE.
- **Ciclo de vida limpio.** `close()` = `app.close()` (cierra el server HTTP) +
  `semanticStores.closeAll()` (libera locks de disco). NO llama `db.flush()`
  (ver ## Limitaciones — persistencia). El CLI cierra igual en SIGINT/SIGTERM y
  hace `exit 0`; sin handles/timers huérfanos.
- **Validación de args.** `dataDir` requerido (string); `secret` string >= 16
  chars (lo valida además `createAuthService`). Errores de programación, sin
  `.code`, lanzados antes de construir nada.
- **Sin loguear secrets/tokens/passwords** (regla del proyecto).

## Examples
- `createServer({ dataDir: './data', secret: 'x'.repeat(32) })` construye e
  inicializa todo; `server.listen(3000)` arranca.
- `createServer({ dataDir: tmp, secret: 'integration-test-secret-16' })` +
  `listen(0)` => server efímero para tests; `close()` en `finally`.
- Registro + login => token; `POST /api/collections/posts/records` con
  `Authorization: Bearer <token>` => 201; `GET` list => trae el doc.
- `POST /api/files/blob.bin` (binario, content-type no-JSON) => 200; `GET` =>
  bytes idénticos.
- Colección `{ vector: { dim: 3 } }`: `POST /api/collections/docs/vectors`
  `{id,doc,vector}` => 201; `POST /api/collections/docs/search` `{vector,limit}`
  => el más cercano.
- SSE: `GET /api/realtime/posts` + un `POST` create => el cliente recibe
  `event: create` con `{ collection, op, record }`.
- Colección con `rules.create = { "auth.id": { $exists: true } }`: POST sin
  token => 403 FORBIDDEN; con token => 201.
- CLI: `SECRET=$(node -e "console.log('x'.repeat(32))") DATA_DIR=./data node
  bin/js-base.js` => "js-base escuchando en :3000"; SIGTERM => exit 0.

## Do / Don't
- DO: ensamblar constructores y registros; delegar TODA la lógica a los batches.
- DO: mapear `id = payload.sub` en `authResolver` para honrar la convención
  `auth.id` de rules y `files.js`.
- DO: crear `<dataDir>/semantic` (el provider/SemanticCollection no lo hacen).
- DO: cerrar `app` + `semanticStores` en `close()` y en SIGINT/SIGTERM del CLI.
- DO: exigir `SECRET` en el CLI (exit 1 si falta; nunca secret default inseguro).
- DON'T: reimplementar HTTP, auth, rules, storage ni semántica.
- DON'T: editar `src/*` de otros batches ni `src/vendor/**`.
- DON'T: llamar `db.flush()` en `close()` (no se pidió; ver Limitaciones).
- DON'T: loguear passwords, tokens completos ni el secret.

## Tests
`tests/integration.test.js` (congelado: `createServer` real sobre `mkdtempSync`,
`listen(0)`, `fetch` real, `close()` + `rimraf` en `finally`; sin handles
huérfanos). Cubre:
- (a) colección creada via `registry.create` con rules públicas.
- (b) auth: `register` -> 201 (sin `passwordHash`); `login` -> token.
- (c) records: `POST` con `Bearer` -> 201; `GET` list -> trae el doc (totalItems,
  items[0]._id/title).
- (d) files: `POST` binario (bytes no-UTF8, content-type `image/png`) -> 200;
  `GET` -> bytes idénticos (`Buffer` deepEqual).
- (e) semantic: colección `vector{dim:3}`; `POST /vectors` (a,b) -> 201;
  `POST /search` -> `items[0].id === 'a'` (más cercano) y `score` numérico.
- (f) realtime: cliente SSE real a `/api/realtime/posts`; `POST` create => llega
  `event: create` con `{ collection:'posts', op:'create', record._id }`.
- (g) rules: `rules.create = { "auth.id": { $exists: true } }`; POST sin token ->
  403 FORBIDDEN; con token -> 201.
- health: ruta no registrada -> 404 JSON del nucleo (`error.code === 'NOT_FOUND'`).
- validación: `createServer` sin `dataDir` -> Error `/dataDir/`; sin `secret` ->
  `/secret/`; `secret` corto -> `/secret/`.

## Constraints
- PARAR y reportar si... alguna pieza no ensambla por una incompatibilidad real
  de interfaces (documentar con evidencia: firmas grepadas en el vendor/batches)
  y responder BLOQUEADO sin parchear los módulos de otros batches. Hallazgos al
  ensambla(r detectados y resueltos en el GLUE de `app.js` (no en otros módulos):
  (1) `'_files'` no registrable + `makeRules` deny-by-default => `'_files'`
  tratada como reservada pública; (2) `makeSemanticStores`/`SemanticCollection`
  no crean `baseDir` => `app.js` lo crea; (3) payload `auth.verify` usa `sub` y
  la convención de rules usa `auth.id` => `authResolver` mapea `id=sub`.
- PARAR y reportar si... la suite previa (`node --test`) estuviera roja de base
  (verificado: 167/167 verdes antes de tocar nada).
- No editar `src/*` de otros batches ni `src/vendor/**`; cero dependencias runtime
  nuevas; sin red externa; sin subprocess desde el server; sin loguear secrets/
  tokens/passwords; datos solo en tempdir en los tests; ningún proceso/handle/
  timer vivo al terminar (`close` + `closeAll` + SIGTERM confirmados).

## Limitaciones
- **Persistencia del DocStore.** El vendor `Collection` solo escribe a disco en
  `flush()`; `insert`/`update`/`remove` solo marcan `_dirty`. `close()` NO llama
  `db.flush()` (no se pidió y el spec de `close` es explícito: `app.close()` +
  `semanticStores.closeAll()`). Consecuencia: los datos documentales viven en
  memoria del proceso y NO sobreviven un reinicio del bin. Fix de una línea
  (`db.flush()` en `close()` o un interval) dejado fuera por scope; tarea futura.
  Los tests e2e no prueban persistencia跨-reinicio (no la hay hoy).
- **`'_files'` pública.** Mientras el registry no soporte colecciones reservadas,
  los blobs son públicos (cualquiera sube/borra). Aceptable para MVP; documentar
  en producción.
- **`auth.id` mapeado.** El `authResolver` añade `id` al payload para honrar la
  convención de rules; el payload original (`sub`, etc.) se preserva por spread.
---
type: 'Task Contract'
title: 'http-core — nucleo HTTP generico de js-base'
description: 'Nucleo HTTP sobre node:http/node:url: Router por segmentos, pipeline CORS + JSON body + match + ctx + handler, y mapeo de err.code a status. Cero dependencias.'
tags: ['http', 'server', 'router', 'cors', 'js-base']

task: http-core
intent: "Proveer el nucleo HTTP generico contra el que otros devs registran endpoints: router por segmentos, pipeline por request (CORS, JSON body, match, ctx, handler) y mapeo estable de err.code a status HTTP, sin acoplar la logica de negocio (rules/events/auth son inyectados o delegados)."
target: src/server.js
signature: "createApp(opts) -> app"
language: javascript
test_command: "node --test tests/server.test.js tests/router.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 4
tests: "tests/server.test.js"
deps_allowed: []
forbids: ['network-external', 'subprocess', 'https', 'static-files']
---

# Contract: http-core

## Intent
Ser la pieza HTTP sobre la que el resto del backend se construye: otros devs
registran handlers con `app.route(method, pattern, handler)` contra este nucleo y
programan la logica de negocio (auth, rules, events, colecciones) encima. El nucleo
NO conoce auth, ni colecciones, ni reglas: solo rutea, parsea JSON, arma el `ctx`,
invoca el handler y mapea los errores tipados (los `.code` del enum de
[[auth-service]] y `VALIDATION`) a status HTTP. Rules y events son inyectados via
`createApp({ rules, events })` con defaults stub (ver [[hooks]]). El nucleo NO llama
`rules.check`/`events.emit` automaticamente — eso lo hacen los handlers.

## Interface
```javascript
const { createApp } = require('./server.js');

// createApp({ rules?, events? } = {}) -> app
//   rules  : objeto con async check(ctx) -> { allow: boolean, ...? } (default: defaultRules)
//   events : objeto con emit(evt) -> void                     (default: defaultEvents)
const app = createApp();

// app expone:
app.router              // Router (ver abajo)
app.rules               // el inyectado o defaultRules
app.events              // el inyectado o defaultEvents
app.route(method, pattern, handler)  // atajo de app.router.add; retorna app (chainable)
app.listen(port)        // -> Promise<http.Server>; port=0 => puerto efimero (server.address().port)
app.close()             // -> Promise<void>; no lanza si no hay server

// Router (src/router.js):
class Router {
  add(method, pattern, handler)                 // pattern con segmentos ":param"
  match(method, pathname) -> { handler, params } | null   // matching exacto por segmentos
}

// ctx que el nucleo construye y pasa al handler (DISTINTO del ctx de rules):
//   { req, res, params, query, body, token }
//   req/res      : request/response nativos de node:http
//   params       : objeto con los ":param" capturados ({} si no hay)
//   query        : URLSearchParams -> objeto plano (ultima gana en claves repetidas)
//   body         : JSON parseado | undefined (solo si Content-Type: application/json)
//   token        : string del Bearer del header Authorization, o null (SOLO extraccion)

// Handler: async (ctx) => objeto | void | throw
//   - devuelve objeto  -> 200 JSON (o ctx.status para otro 2xx)
//   - lanza Error con .code -> mapeo a status (ver Invariants)
//   - lanza Error sin .code -> 500 { error: { code: 'INTERNAL', message: 'internal error' } }
//   El handler puede setear ctx.status (2xx) y mutar ctx.res directamente.
```

## Invariants
- **Solo node:http y node:url.** Sin HTTPS, sin websockets, sin static files, sin
  dependencias runtime. El router usa matching **exacto por segmentos**: NO regex
  de usuario, NO wildcards, NO opcionalidad. `":param"` captura un segmento.
- **CORS.** Toda respuesta lleva `Access-Control-Allow-Origin: *`. El preflight
  `OPTIONS` responde `204` + `Access-Control-Allow-Methods` y
  `Access-Control-Allow-Headers` (Content-Type, Authorization).
- **Body JSON.** Solo se parsea si `Content-Type` incluye `application/json`. Limite
  **1 MiB** (`1024*1024`): excederlo -> `413` con
  `{ error: { code: 'PAYLOAD_TOO_LARGE' } }`. JSON invalido -> `400` con
  `{ error: { code: 'INVALID_JSON' } }`. Body vacio -> `ctx.body === undefined`.
- **404.** Si el router no matchea -> `404` con `{ error: { code: 'NOT_FOUND' } }`.
- **Token.** `ctx.token` = el Bearer del header `Authorization` (`/^Bearer\s+(.+)$/i`)
  o `null`. Solo extraccion: NO verifica el token (eso es de [[auth-service]]).
- **Mapeo err.code -> status:**
  - `EMAIL_TAKEN` -> 409
  - `INVALID_CREDENTIALS` -> 401
  - `INVALID_TOKEN` -> 401
  - `WEAK_PASSWORD` -> 400
  - `FORBIDDEN` -> 403
  - `NOT_FOUND` -> 404
  - `VALIDATION` -> 400
  Body: `{ error: { code, message } }` donde `message` es `err.message` del handler.
- **Error sin .code -> 500.** Body: `{ error: { code: 'INTERNAL', message: 'internal error' } }`.
  El mensaje interno NUNCA se filtra al cliente; se loguea a `console.error` (no
  passwords ni tokens completos — regla del proyecto).
- **Rules/events son inyectados, no invocados por el nucleo.** `app.rules`/
  `app.events` son el objeto inyectado o los defaults stub de [[hooks]]. El nucleo
  NO llama `rules.check` ni `events.emit`: son los handlers quienes los usan. Esto
  permite que el nucleo sea generico y que la logica de autorizacion viva en los
  handlers/endpoints del batch siguiente.
- **ctx del handler != ctx de rules.** El nucleo construye el ctx del handler
  (`{ req, res, params, query, body, token }`). El ctx que recibe `rules.check`
  (shape `{ op, collection, auth, record, request }`) lo construye el handler a
  partir del ctx del handler — es contrato de [[hooks]], no de este modulo.
- **Ciclo de vida.** `listen(port)` devuelve `Promise<server>` con
  `server.address().port` (valido para `port=0`). `close()` devuelve `Promise`, no
  lanza si no hay server, y detiene el listen. El nucleo nunca deja una peticion sin
  responder (toda rama termina el response, incluso ante throws).

## Examples
- `const app = createApp(); app.route('GET','/ping', c => ({ pong: true }));`
  + `listen(0)` + `fetch('/ping')` -> `200` `{ pong: true }` con header CORS `*`.
- `app.route('GET','/u/:id', c => ({ id: c.params.id }))` con `/u/42` ->
  `{ id: '42' }`; `/u/42/extra` -> `404`.
- `app.route('POST','/echo', c => ({ got: c.body }))` con `Content-Type: application/json`
  y body `{"a":1}` -> `200` `{ got: { a: 1 } }`. Body `'{bad'` -> `400 INVALID_JSON`.
- Handler que lanza `Error` con `code:'FORBIDDEN'` -> `403`
  `{ error: { code: 'FORBIDDEN', message } }`; handler que lanza `Error` comun ->
  `500 { error: { code: 'INTERNAL', message: 'internal error' } }` (mensaje interno
  al log, no al cliente).
- `createApp({ rules: { async check() { return { allow: false } } } })` ->
  `app.rules` es el inyectado; un handler que hace `if (!(await app.rules.check(c)).allow) throw FORBIDDEN`
  devuelve `403`. El nucleo solo provee el objeto; no lo invoca.
- `fetch('/x', { method:'OPTIONS' })` -> `204` + headers
  `Access-Control-Allow-Origin: *`, `-Methods`, `-Headers`.

## Do / Don't
- DO: usar solo `node:http` y `node:url`; pipeline determinista (CORS -> body ->
  match -> ctx -> handler) por request.
- DO: mapear `err.code` a status y devolver `{ error: { code, message } }` con el
  `message` del handler (excepto 500, que usa `internal error`).
- DO: extraer el token Bearer en `ctx.token` SIN verificarlo (delegacion a
  [[auth-service]]).
- DO: responder `OPTIONS` con `204` antes de tocar el router (preflight corto).
- DO: garantizar que toda rama termine el response (incluso ante throws del handler
  o errores de lectura del body).
- DON'T: llamar `rules.check`/`events.emit` automaticamente — eso es de los handlers.
- DON'T: filtrar mensajes internos al cliente en el 500; loguearlos a `console.error`.
- DON'T: aceptar regex de usuario, wildcards u opcionalidad en los patterns del router.
- DON'T: usar HTTPS, websockets, static files ni dependencias runtime nuevas.
- DON'T: tocar `src/auth-service.js`, `src/collections.js`, `src/atomic-file-adapter.js`,
  `src/index.js`, `src/vendor/**` ni los tests existentes.

## Tests
`tests/server.test.js` y `tests/router.test.js` (congelados). Cubren:
- Router unit: match con multiples params, no-match, metodo distinto, normalizacion
  de CASE, trailing slash, orden de registro, validacion de args.
- Server: GET ok -> 200 + JSON; 404 ruta desconocida; params y query al handler;
  handler setea `ctx.status`; POST JSON -> handler recibe body; JSON invalido -> 400;
  body >1MiB -> 413; POST sin body -> `body === undefined`; handler lanza `FORBIDDEN`
  -> 403 con `{ error: { code } }`; handler lanza Error comun -> 500 `INTERNAL` sin
  mensaje interno; mapeo de cada code a su status; `OPTIONS` -> 204 + headers CORS;
  CORS `*` en todas las respuestas (incluido 404); `Authorization: Bearer abc` ->
  `ctx.token === 'abc'`; sin Authorization -> `null`; rules inyectado es `app.rules`
  y un handler lo usa para devolver 403; rules default permite continuar;
  `close()` detiene el listen (conexion rechazada tras close).
- Todos los tests usan `listen(0)` + `fetch` global y CIERRAN el server en `finally`.

## Constraints
- PARAR y reportar si... `fetch` global no estuviera disponible en el Node del entorno
  (verificar `node -e "console.log(typeof fetch)"`); si falta, usar `node:http` como
  cliente y documentarlo — NO abortar por eso (solo si tampoco funciona el cliente
  `node:http`). Abortar SI la suite existente tiene fallos preexistentes (verificar con
  `git stash` si dudas) o si mantener los 57 tests verdes exigiera tocar archivos
  fuera de `src/router.js`, `src/hooks.js`, `src/server.js`,
  `tests/server.test.js`, `tests/router.test.js` y `knowledge/contracts/http-core.md`.
- PARAR y reportar si... `python scripts/validate_okf.py knowledge` exigiera editar
  `knowledge/index.md` (otro proceso lo registra): reportar la exigencia, no
  parchear en silencio (index.md ya enlaza la carpeta `contracts/`, por lo que el
  contrato nuevo queda alcanzable sin editarlo).
- Cero dependencias runtime nuevas; sin HTTPS/websockets/static; sin red externa;
  sin subprocess; sin loguear passwords ni tokens completos.
---
type: 'Task Contract'
title: 'auth-routes — registro de endpoints de auth sobre el nucleo HTTP'
description: 'Registra POST /api/auth/register, /login, /logout, GET /api/auth/me y POST /api/auth/change-password sobre el nucleo HTTP (src/server.js), delegando TODA la logica de auth en el service (src/auth-service.js). Solo valida shape del body (VALIDATION), setea ctx.status y sanea la respuesta para que passwordHash/password no viajen.'
tags: ['auth', 'http', 'routes', 'js-base']

task: auth-routes
intent: "Exponer los endpoints de auth sobre el nucleo HTTP sin reimplementar auth: validar shape del body antes de llamar al service, mapear ctx.status para los 2xx y garantizar que campos sensibles no viajen en el JSON. Toda la logica de auth (crypto/JWT/sesiones) queda en [[auth-service]]; este modulo es solo capa HTTP."
target: src/auth-routes.js
signature: "registerAuthRoutes(app, { auth }) -> app"
test_command: "node --test tests/auth-routes.test.js"
budget:
  max_cyclomatic_complexity: 10
  max_nesting_depth: 3
tests: "tests/auth-routes.test.js"
deps_allowed: []
forbids: ['network-external', 'subprocess', 'auth-logic-own', 'crypto-own', 'log-passwords-tokens']
---

# Contract: auth-routes

## Intent
Ser la capa HTTP de auth: registrar los 5 endpoints de autenticacion contra el
nucleo generico ([[http-core]]) y delegar toda la logica de dominio al service
([[auth-service]]). Este modulo NO hashea, NO firma JWT, NO maneja sesiones, NO
verifica politicas de contrasena; solo (a) valida que el body tenga shape correcto
(campos requeridos presentes y string) lanzando `VALIDATION` *antes* de llamar
al service, (b) setea `ctx.status` para los 2xx no-200 (registro -> 201),
(c) arma las respuestas `{ user }` / `{ token, user }` / `{ ok: true }` y
(d) garantiza que `passwordHash` y `password` no viajen en el JSON (sanitizacion
defense-in-depth; el service ya descarta `passwordHash`, pero se re-verifica).

## Interface
```javascript
const { registerAuthRoutes } = require('./auth-routes.js');
const { createApp } = require('./server.js');
const { createAuthService } = require('./auth-service.js');

const app = createApp();
const auth = await createAuthService({ db, secret });
registerAuthRoutes(app, { auth });   // registra y retorna app (chainable)

// Endpoints registrados (handler recibe ctx={ req, res, params, query, body, token }):
// POST /api/auth/register        body {email,password,profile?} -> 201 { user }
// POST /api/auth/login            body {email,password}          -> 200 { token, user }
// POST /api/auth/logout           requiere ctx.token             -> 200 { ok: true }
// GET  /api/auth/me               verifica ctx.token             -> 200 { user }
// POST /api/auth/change-password  requiere token valido + body {oldPassword,newPassword}
//                                                                -> 200 { ok: true }
```

## Invariants
- **Delegacion total al service.** Ningun endpoint implementa logica de auth
  propia: register/login/change-password llaman al metodo homologo del service;
  me y change-password verifican el token con `auth.verify`; logout llama a
  `auth.logout`. Los errores del service (con `.code` del enum de
  [[auth-service]]) burbujean y el nucleo ([[http-core]]) los mapea a status:
  `EMAIL_TAKEN` -> 409, `INVALID_CREDENTIALS` -> 401, `INVALID_TOKEN` -> 401,
  `WEAK_PASSWORD` -> 400, `FORBIDDEN` -> 403, `NOT_FOUND` -> 404,
  `VALIDATION` -> 400.
- **Validacion de shape antes del service.** Los endpoints con body
  (register, login, change-password) validan que los campos requeridos esten
  presentes y sean string no vacio, lanzando `Error` con `code:'VALIDATION'`
  ANTES de invocar al service. Si el body no es objeto (o es array), tambien
  `VALIDATION`. profile, si se provee, debe ser objeto (sino `VALIDATION`).
- **register -> 201 via ctx.status.** El handler setea `ctx.status = 201` y
  devuelve `{ user }` (el nucleo responde 201 JSON). login/logout/me/
  change-password dejan el default 200.
- **Campos sensibles no viajan.** Toda `user` devuelta (register, login, me) se
  pasa por `sanitizeUser`, que elimina `passwordHash` y `password` si existen.
  El service ya descarta `passwordHash` en register/login; esta sanitizacion es
  defense-in-depth, no logica de auth.
- **me / change-password (token invalido burbujea).** `auth.verify(ctx.token)`
  lanza `INVALID_TOKEN` si el token es `null`, vacio, invalido o expirado (o su
  sesion ya no existe). El handler NO atrapa: deja burbujear -> 401.
- **logout exige ctx.token.** `auth.logout` no valida el token (remove sobre
  `{token}` devuelve 0 sin lanzar si no existe). Por eso el handler verifica
  `ctx.token` aca: `null` -> `Error` con `code:'INVALID_TOKEN'` -> 401. Con token
  presente, delega en `auth.logout(token)` y responde `{ ok: true }`.
- **change-password usa el sub del payload.** Tras `auth.verify`, el `userId`
  para `auth.changePassword` se toma de `payload.sub` (el vendor firma `sub =
  user._id`). El handler NO recibe/exige un `userId` en el body.
- **Sin estado propio.** El modulo no guarda estado entre requests: el service y
  el DocStore son inyectados. Dos apps con el mismo service comparten sesiones.

## Examples
- `registerAuthRoutes(app, { auth })` registra los 5 endpoints y retorna `app`.
- `POST /api/auth/register` con `{"email":"a@b.com","password":"password123"}`
  -> `201 {"user":{"_id":...,"email":"a@b.com","roles":["user"],"active":true,...}}`
  (sin `passwordHash`, sin `password`).
- `POST /api/auth/register` con email ya registrado -> `409`
  `{"error":{"code":"EMAIL_TAKEN","message":...}}` (burbuja del service).
- `POST /api/auth/login` con password incorrecto -> `401`
  `{"error":{"code":"INVALID_CREDENTIALS"}}`; `GET /api/auth/me` sin header
  `Authorization` -> `401 {"error":{"code":"INVALID_TOKEN"}}`.
- `POST /api/auth/logout` con token valido -> `200 {"ok":true}`; un `me`
  posterior con el MISMO token -> `401 INVALID_TOKEN` (sesion removida).
- `POST /api/auth/register` con body `{}` -> `400 VALIDATION` (antes del
  service); con password de 3 chars -> `400 WEAK_PASSWORD` (burbuja del
  service, politica minLength=6 del vendor).

## Do / Don't
- DO: delegar TODA la logica de auth (hash, JWT, sesiones, politicas) al service.
- DO: validar shape del body y lanzar `VALIDATION` antes de llamar al service.
- DO: setear `ctx.status = 201` en register y dejar 200 implicito en el resto.
- DO: sanitizar toda `user` devuelta para que `passwordHash`/`password` no
  viajen (defense-in-depth).
- DO: dejar que los errores `.code` del service burbujeen (el nucleo mapea).
- DON'T: reimplementar hashing, JWT, manejo de sesiones ni politicas de password.
- DON'T: atrapar y re-mapear los codes del service a mano (doble mapeo); dejar
  burbujear.
- DON'T: aceptar `userId` del body en change-password (se usa `payload.sub`).
- DON'T: loguear passwords ni tokens completos (regla del proyecto).
- DON'T: tocar `src/server.js`, `src/auth-service.js`, `src/vendor/**`, ni los
  tests/contratos existentes.

## Tests
`tests/auth-routes.test.js` (congelado). Stack real: `createApp` +
`createAuthService` sobre `DocStore` + `MemoryStorageAdapter` del vendor, secret
>= 16 chars, `fetch` global contra `app.listen(0)`. Cada test levanta y CIERRA
su propio server en `finally` (servidores siempre cerrados). Cubre:
- register -> 201 y `user` sin `passwordHash`/`password` en el JSON.
- register duplicado -> 409 `EMAIL_TAKEN`.
- login ok -> token utilizable (me con ese token devuelve user); user sin hash.
- login password incorrecto -> 401 `INVALID_CREDENTIALS`.
- me con token valido -> user (sin hash); me sin token -> 401 `INVALID_TOKEN`;
  me con token basura -> 401 `INVALID_TOKEN`.
- logout con token valido -> `{ ok: true }` y el MISMO token en me posterior ->
  401 `INVALID_TOKEN`; logout sin token -> 401.
- change-password ok -> `{ ok: true }`; login con el nuevo password funciona
  (200 + token) y con el viejo -> 401 `INVALID_CREDENTIALS`; sin token -> 401;
  con token pero body sin campos -> 400 `VALIDATION`.
- validacion de shape: register/login con body `{}` -> 400 `VALIDATION`;
  register con email no-string -> 400 `VALIDATION`; register con password debil
  -> 400 `WEAK_PASSWORD` (burbuja del service).
- servers siempre cerrados: tras `close()` un fetch posterior falla (conexion
  rechazada).

## Constraints
- PARAR y reportar si... la API real de `src/server.js` (firma de `createApp`,
  `app.route(method, pattern, handler)`, shape del `ctx`, mapeo `err.code` ->
  status) o de `src/auth-service.js` (metodos `register/login/verify/logout/
  changePassword`, enum de codes, `verify` devuelve payload con `sub`) difiere
  de lo descrito en [[http-core]] y [[auth-service]]: leer ambos archivos
  primero y documentar la divergencia; si es de raiz, responder BLOQUEADO con
  evidencia (cita de linea). Un detalle menor se adapta y se documenta en el
  REPORT.
- PARAR y reportar si... la suite existente tiene fallos preexistentes (ver
  con `node --test tests/` antes de tocar nada) o si mantenerla verde exigiera
  tocar archivos fuera de `src/auth-routes.js`, `tests/auth-routes.test.js` y
  `knowledge/contracts/auth-routes.md`.
- Cero dependencias runtime nuevas; sin red externa; sin subprocess; sin
  loguear passwords ni tokens completos; sin HTTPS/websockets/static.
---
type: 'Task Contract'
title: 'auth-service — wrapper del Auth del vendor para js-base'
description: 'Wrapper fino del Auth de js-store que delega crypto/JWT/sesiones al vendor y mapea sus errores a un enum estable de .code para el futuro mapeo HTTP.'
tags: ['auth', 'wrapper', 'vendor', 'rbac', 'js-base']

task: auth-service
intent: "Envolver el Auth del vendor sin reimplementar crypto/JWT/sesiones, mapeando los errores esperables del vendor a un enum estable de .code."
target: src/auth-service.js
signature: "async function createAuthService({ db, secret }) -> service"
test_command: "node --test tests/auth-service.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 3
tests: "tests/auth-service.test.js"
deps_allowed: []
forbids: ['network', 'subprocess']
---

# Contract: auth-service

## Intent
Proveer un servicio de autenticacion para js-base (backend estilo PocketBase)
reutilizando al 100% la clase `Auth` del vendor `js-doc-store.js` (PBKDF2-SHA256,
JWT HS256, sesiones persistidas en la coleccion `_sessions`). El wrapper NO
reimplementa nada criptografico ni de sesiones: solo valida la construccion,
inicializa (`await auth.init()`) y mapea los errores esperables del vendor a un
enum estable de `err.code` para que la capa HTTP futura lo mapee a status codes
(401, 403, 404, 409) sin acoplarse a los mensajes internos del vendor.

## Interface
```js
const { createAuthService, CODE } = require('./auth-service.js');

// Construccion (lanza Error plano, sin .code, si los args son invalidos):
const svc = await createAuthService({ db, secret });
//   db    : DocStore ya instanciado (requerido)
//   secret: string >= 16 chars (requerido)

// API del service (todas async):
await svc.register(email, password, profile?)   // -> user (sin passwordHash)
await svc.login(email, password)                // -> { token, user }
await svc.verify(token)                         // -> payload | throws INVALID_TOKEN
await svc.logout(token)                          // -> count de sesiones removidas
await svc.logoutAll(userId)                      // -> count de sesiones removidas
await svc.changePassword(userId, oldPw, newPw)   // -> true | throws
await svc.assignRole(userId, role)               // -> undefined | throws NOT_FOUND
await svc.hasRole(userId, role)                  // -> boolean (false si no existe)
await svc.authorize(token, requiredRole?)        // -> payload | throws INVALID_TOKEN|FORBIDDEN

// Enum estable exportado:
//   CODE = { EMAIL_TAKEN, INVALID_CREDENTIALS, INVALID_TOKEN,
//            WEAK_PASSWORD, FORBIDDEN, NOT_FOUND }
```

## Invariants
- **Delegacion total:** crypto (PBKDF2), JWT (HS256) y sesiones
  (coleccion `_sessions`) los hace el vendor. El wrapper no implementa ninguno.
- **Mapeo de errores estable.** Toda operacion que falle por causa esperable
  lanza un `Error` con `err.code` del enum. El mensaje original del vendor se
  preserva en `err.message`; el vendor error original queda en `err.cause`.
- **Tabla de mapeo** (mensaje del vendor -> code):
  - `Unique constraint violated: email = "..."` -> `EMAIL_TAKEN` (409)
  - `Invalid credentials` (login, usuario inexistente o password malo) -> `INVALID_CREDENTIALS` (401)
  - `Invalid current password` (changePassword) -> `INVALID_CREDENTIALS` (401)
  - `Account disabled` (login de usuario inactivo) -> `FORBIDDEN` (403)
  - `User not found` (changePassword/assignRole sobre id inexistente) -> `NOT_FOUND` (404)
  - `Password must ...` (politica de password en register/changePassword) -> `WEAK_PASSWORD` (400)
  - vendor `verify()` devuelve `null` (token invalido, expirado o sin sesion) -> `INVALID_TOKEN` (401)
  - `authorize` con token valido pero rol faltante -> `FORBIDDEN` (403);
    con token invalido -> `INVALID_TOKEN` (401) — distinguir 401 vs 403
- **Errores de programacion sin .code:** `Email and password required` e
  `Invalid email format` (validacion de input del vendor) se propagan como
  `Error` plano SIN `.code` porque el enum no tiene un code para "email mal
  formado". Es un hueco documentado (ver ## Limitaciones), no un feature.
- **Errores de construccion sin .code:** `createAuthService` lanza `Error`
  plano (sin `.code`) si falta `db` o `secret < 16 chars`. Son errores del
  programador, no esperables en runtime.
- **Persistencia:** dos services sobre el mismo `DocStore` y mismo `secret`
  comparten `_users` y `_sessions` (mismas instancias de Collection via el cache
  del DocStore), por lo que un token emitido por uno es verificable por el otro.
- **No agrega features que el vendor no tenga:** no resetPassword, no
  disableUser, no listUsers en la API exportada (aunque el vendor los tiene, no
  fueron pedidos).

## Examples
- `createAuthService({ db, secret: 'x'.repeat(16) })` construye e inicializa.
- `await svc.register('a@b.com','password123',{name:'A'})` -> `{ _id, email:'a@b.com', roles:['user'], name:'A', active:true, createdAt, passwordHash:undefined }`.
- `await svc.verify('garbage')` lanza `Error` con `code: 'INVALID_TOKEN'`.
- `await svc.authorize(token, 'admin')` con token valido y rol -> payload; sin
  rol -> `Error` con `code: 'FORBIDDEN'`; token malo -> `code: 'INVALID_TOKEN'`.
- Segundo service `svcB = await createAuthService({ db, secret })` sobre el
  mismo `db` verifica un token emitido por `svcA` (sesion persistida en `_sessions`).

## Do / Don't
- DO: delegar TODO lo criptografico y de sesiones al vendor.
- DO: preservar el mensaje original del vendor en `err.message` y el error
  original en `err.cause` para trazabilidad.
- DO: distinguir `INVALID_TOKEN` de `FORBIDDEN` en `authorize` (401 vs 403).
- DON'T: reimplementar hashing, JWT, manejo de sesiones ni indices unicos.
- DON'T: agregar codes fuera del enum ni metodos no pedidos (resetPassword,
  disableUser, etc.).
- DON'T: loguear passwords ni tokens completos (regla del proyecto).
- DON'T: editar `src/vendor/**`.

## Tests
`tests/auth-service.test.js` (congelado, usa `DocStore` + `MemoryStorageAdapter`
reales del vendor — sin mocks de crypto/JWT). Cubre:
- Construccion: falta db -> Error plano; secret < 16 chars -> Error; secret no
  string -> Error.
- Happy path: register+login+verify (verify devuelve el payload con sub/email/
  roles/exp; register no expone passwordHash).
- login password incorrecto -> `INVALID_CREDENTIALS`; usuario inexistente ->
  `INVALID_CREDENTIALS`.
- register duplicado -> `EMAIL_TAKEN`.
- verify de basura / token de otro secret / null / undefined -> `INVALID_TOKEN`.
- logout invalida el token (verify posterior -> `INVALID_TOKEN`).
- roles: assignRole + authorize con rol correcto pasa; rol faltante ->
  `FORBIDDEN`; token invalido en authorize -> `INVALID_TOKEN`; assignRole de id
  inexistente -> `NOT_FOUND`; authorize sin requiredRole solo verifica token.
- changePassword: oldPassword malo -> `INVALID_CREDENTIALS`; nuevo debil ->
  `WEAK_PASSWORD`; usuario inexistente -> `NOT_FOUND`; cambio exitoso invalida
  sesiones previas y permite login con el nuevo password.
- register con password debil -> `WEAK_PASSWORD`.
- Persistencia: segundo service sobre mismo db+secret verifica token del
  primero; logout del segundo invalida para el primero.
- logoutAll invalida todas las sesiones del usuario.

## Constraints
- PARAR y reportar si... el `Auth` del vendor no cubre alguna operacion pedida
  (documentar cual con evidencia: grep de la firma en el vendor) y responder
  BLOQUEADO en vez de reimplementarla; o si la suite Python de la plantilla
  (`scripts/validate_contracts.py` / `scripts/validate_okf.py`) tiene fallos
  preexistentes antes de tocar nada.
- No editar `src/vendor/**`; cero dependencias runtime nuevas; sin red; sin
  subprocess; sin loguear passwords ni tokens completos.
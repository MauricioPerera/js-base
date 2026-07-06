---
type: 'Task Contract'
title: 'Motor de reglas de autorización de js-base'
description: 'Construye el objeto rules inyectado via createApp({ rules }); check(ctx) evalúa config.rules[op] con matchFilter. Sin estado, sin I/O: solo el registry y el vendor.'
tags: ['js-base', 'rules', 'auth', 'kdd', 'backend']

task: rules-engine
intent: "Dotar a js-base de un motor de reglas que traduzca la config.rules[op] declarada por colección (objeto-filtro estilo Mongo o null) en una decisión allow/deny, evaluando con el matchFilter del vendor sobre un ctx de evaluación {auth, record, request}. Sin estado, sin I/O propio."
target: src/rules-engine.js
signature: "makeRules(registry, opts?) -> { async check(ctx) -> { allow: boolean } }"
language: javascript
test_command: "node --test tests/rules-engine.test.js"
budget:
  max_cyclomatic_complexity: 6
  max_nesting_depth: 3
tests: "tests/rules-engine.test.js"
deps_allowed: ['src/collections.js', 'src/vendor/js-store/vendor/js-doc-store.js']
forbids: ['network', 'subprocess', 'state', 'io', 'editar-src-vendor']
---

# Contract: rules-engine

## Intent
Otra fase del backend: la que decide autorización. El nucleo (server) NO llama a
`rules.check` automáticamente; son los handlers quienes lo invocan, inyectado via
`createApp({ rules })`. Este módulo produce ese objeto `rules` a partir de un
`CollectionRegistry`: para cada operación busca la config de la colección, toma
`config.rules[op]` y lo evalúa con el `matchFilter` del vendor. Cero dependencias de
runtime, sin estado, sin I/O (solo el registry y el vendor). Metodología:
[metodologia-ejecución](../metodologia-ejecucion.md). Config del registry:
[collections](./collections.md). Contrato de hooks: [hooks](../architecture/).

## Interface
```javascript
const { makeRules } = require("./rules-engine.js");
// const { CollectionRegistry } = require("./collections.js");

const rules = makeRules(registry /* CollectionRegistry */, opts?);
// rules.check(ctx) -> Promise<{ allow: boolean }>
//
// ctx (contrato de hooks):
//   { op: "list"|"view"|"create"|"update"|"delete",
//     collection: string,
//     auth: object | null,           // payload del token verificado, o null
//     record: object | null,          // doc sobre el que opera, o null
//     request: { method, path, query } }
//
// ctx de evaluación (lo que ve matchFilter):
//   evalCtx = { auth: ctx.auth ?? null, record: ctx.record ?? null, request: ctx.request }
//   Las reglas acceden con dot-paths: "auth.id", "auth.role", "record.public", "record.owner", ...
```

## Invariants
- `registry.get(ctx.collection) === null` -> `{ allow: false }`. Una colección
  desconocida NUNCA se autoriza (no hay lista blanca implícita).
- `config.rules[op]`:
  - `rule === null` -> operación PÚBLICA -> `{ allow: true }` (sin importar `auth`/`record`).
  - `rule === undefined` (la op no figura en `config.rules`) -> DENY por defecto ->
    `{ allow: false }` (seguro por defecto: lo no declarado se niega).
  - `rule === objeto-filtro` -> `{ allow: !!matchFilter(evalCtx, rule) }`.
- `evalCtx` SIEMPRE tiene `auth` y `record` como `object | null` (nunca `undefined`):
  `ctx.auth ?? null`, `ctx.record ?? null`. Así `matchFilter` con `doc=null` no se
  rompe (internamente trata `doc` ausente como `{}`).
- El módulo NO guarda estado entre llamadas; NO hace HTTP ni I/O. Solo lee el registry
  y evalúa el filtro. `opts` está reservado y hoy no se usa.
- `makeRules` lanza `Error` si `registry` no expone `get(name)`.

## Examples
- `rules: { list: null, view: null }` -> `list`/`view` públicas; `create`/`update`/
  `delete` ausentes -> deny. `check({op:"list",collection:"posts",auth:null,...})`
  -> `{ allow: true }`.
- `rules: { create: { "auth.id": { $exists: true } } }` -> exige login:
  `check({op:"create",auth:null,...})` -> `{ allow: false }`;
  `check({op:"create",auth:{id:"u1"},...})` -> `{ allow: true }`.
- `rules: { view: { "record.public": true } }` -> solo visibles los públicos:
  `record:{public:true}` -> allow; `record:{public:false}` o `record:{}` -> deny.
- `rules: { delete: { "auth.role": "admin" } }` -> solo admin: `auth:{role:"admin"}`
  -> allow; `auth:{role:"user"}` o `auth:null` -> deny.
- AND implícito (varias claves en el filtro): `{ "auth.id": { $exists: true },
  "auth.role": "editor" }` -> exige login Y rol editor.

## Do / Don't
- DO: usar `matchFilter` del vendor tal cual (soporta dot-paths y operadores:
  `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$regex`,
  `$contains`, `$size`, `$text`, `$and`, `$or`, `$not`).
- DO: normalizar `auth`/`record` a `null` (no `undefined`) en `evalCtx`.
- DO: tratar `null` = pública y `undefined` = deny: son casos distintos, no
  intercambiables.
- DON'T: inventar un motor nuevo, agregar operadores custom ni comparar campos del
  ctx entre sí (matchFilter no lo soporta — ver limitación en Constraints).
- DON'T: tocar `src/vendor/**`, `src/hooks.js`, `src/server.js`, `src/realtime.js`,
  `tests/realtime.test.js` ni `knowledge/index.md`; hacer HTTP, red, subprocess o
  mantener estado.
- DON'T: usar `{ "auth.id": { $ne: null } }` como "exigir login": con `auth=null`,
  `auth.id` resuelve a `undefined` y `undefined !== null` -> NO niega. La convención
  canónica es `{ "auth.id": { $exists: true } }`.

## Tests
(Los tests están en `tests/rules-engine.test.js`, congelados con un registry real de
`src/collections.js` sobre DocStore + MemoryStorageAdapter, más un fake mínimo con
solo `get()`. Cubren: colección inexistente -> deny; rule null -> allow con/sin auth;
rule undefined (op ausente) -> deny; convención login `$exists:true` deny/allow;
`$ne:null` NO exige login (limitación); visibilidad `record.public`; rol `auth.role`;
AND implícito; limitación de ownership; registry sin `get()` lanza.)

## Constraints
- PARAR y reportar si `matchFilter` del vendor no soporta lo que el diseño asume
  (dot-paths anidados, `$exists`, operadores de igualdad/comparación). Se verificó
  con `node -e` antes de implementar: `matchFilter({auth:{id:"u1"},record:{owner:"u1"}},
  {"auth.id":"u1","record.owner":{$ne:"u2"}}) === true`, y `{"auth.id":{$exists:true}}`
  discrimina auth=null (deny) vs auth={id} (allow). `$ne:null` NO discrimina
  (auth=null -> allow) — por eso la convención canónica de login es `$exists:true`,
  no `$ne:null`.
- PARAR y reportar si mantener los tests verdes exigiera editar archivos fuera de
  `src/rules-engine.js`, `tests/rules-engine.test.js` y
  `knowledge/contracts/rules-engine.md`.
- PARAR y reportar si `python scripts/validate_okf.py knowledge` exigiera editar
  `knowledge/index.md` (otro proceso lo registra). No se toca: `index.md` enlaza la
  carpeta `./contracts/`, por lo que este contrato queda alcanzable automáticamente.
- LIMITACIÓN CONOCIDA (no bloqueante, documentada): "owner == current user" NO es
  expresable con `matchFilter` puro. El motor compara campos del ctx contra VALORES
  LITERALES del filtro, no entre campos del ctx entre sí; no hay forma de decir
  "record.owner == auth.id". La regla práctica para ownership es que el HANDLER ya
  pasó `record` y `auth` en el ctx y la decisión fina (comparar `record.owner` contra
  `auth.id`) se hace en código del handler, no en el filtro. Como workaround parcial,
  un filtro con valores literales concretos (`{"record.owner":"u1","auth.id":"u1"}`)
  valida un caso estático, pero NO expresa ownership dinámica — se documenta, no se
  simula con un motor nuevo.
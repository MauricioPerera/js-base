---
type: 'Task Contract'
title: 'files — almacen plano de blobs sobre el nucleo HTTP'
description: 'Modulo src/files.js: registerFileRoutes(app,{dir,authResolver,maxBytes}) sube bodies CRUDOS no-JSON en streaming atomico (temp+fsync+rename), sirve en streaming y borra, con sanitizacion estricta de :name y defensa path.resolve dentro de dir. Cero dependencias.'
tags: ['http', 'files', 'streaming', 'atomic', 'security', 'js-base']

task: files
intent: "Proveer almacen plano de blobs sobre el nucleo HTTP de [[http-core]]: subida en streaming del body CRUDO (cualquier content-type NO json, que el nucleo NO consume) a disco de forma atomica, descarga en streaming preservando el Content-Type de un sidecar, y borrado; con sanitizacion estricta de :name y defensa en profundidad (path.resolve dentro de dir)."
target: src/files.js
signature: "registerFileRoutes(app, { dir, authResolver, maxBytes = 10*1024*1024 }) -> app"
language: javascript
test_command: "node --test tests/files.test.js"
budget:
  max_cyclomatic_complexity: 14
  max_nesting_depth: 4
tests: "tests/files.test.js"
deps_allowed: []
forbids: ['network-external', 'subprocess', 'https', 'deps-runtime']
---

# Contract: files

## Intent
Encima del nucleo [[http-core]] (que SOLO parsea bodies `application/json` y deja
`ctx.req` intacto como stream para todo otro content-type), montar un almacen plano
de blobs en `dir`: subida atomica en streaming del body crudo, sidecar `<name>.meta.json`
con metadatos, descarga en streaming con el Content-Type del sidecar, y borrado. La
autorizacion se delega a `app.rules.check` (inyectado, como pide [[hooks]]); el
authResolver (token -> user|null) tambien es inyectado. La sanitizacion de `:name`
es la linea de defensa principal: un nombre invalido NUNCA toca el filesystem.

## Interface
```javascript
const { registerFileRoutes } = require('./files.js');

// registerFileRoutes(app, { dir, authResolver, maxBytes = 10*1024*1024 }) -> app
//   app           : instancia de createApp() (usa app.route y app.rules)
//   dir           : directorio plano de storage (creado recursivo si falta)
//   authResolver  : async (token|null) -> user|null   (INYECTADO; fake en tests)
//   maxBytes      : limite de tamano del body crudo; excederlo -> 413
//
// Registra tres rutas sobre el router del nucleo:
//   POST   /api/files/:name  -> subida atomica en streaming
//   GET    /api/files/:name  -> descarga en streaming (lectura publica, MVP)
//   DELETE /api/files/:name  -> borrado de archivo + sidecar
//
// POST /api/files/:name
//   - sanitiza :name (ver Invariants); invalido -> throw VALIDATION -> 400
//   - authResolver(ctx.token) -> user|null; rules.check({op:"create",collection:"_files",
//     auth:user, record:{name}, request:{method,path,query}}); !allow -> FORBIDDEN 403
//   - stream del body CRUDO (ctx.req) a temp en el mismo dir + fsync + rename (atomico)
//   - si size > maxBytes: aborta, borra el temp, responde 413 (escrito directo en res)
//   - sidecar <name>.meta.json = { contentType, size, uploadedAt(ISO), uploadedBy }
//   - responde { name, size, contentType }
//
// GET /api/files/:name
//   - sanitiza :name; invalido -> 400. Sin rules (lectura publica en MVP)
//   - stat; falta -> NOT_FOUND 404
//   - Content-Type del sidecar (o application/octet-stream), Content-Length, 200
//   - streamea el archivo (createReadStream + pipe); devuelve undefined al nucleo
//     SOLO cuando el pipe termina (res 'finish') -> el nucleo NO aplica el 204 por
//     defecto (mecanismo real de [[http-core]]: handler que devuelve undefined tras
//     escribir res deja res.writableEnded=true)
//
// DELETE /api/files/:name
//   - sanitiza; rules.check op "delete"; !allow -> 403. Falta -> NOT_FOUND 404
//   - borra archivo + sidecar; responde { ok: true }
```

## Invariants
- **Cero dependencias runtime.** Solo `node:fs` y `node:path`. El nucleo [[http-core]]
  NO consume bodies no-JSON: `ctx.req` llega intacto como stream legible y el handler
  lo lee directamente (streaming real, sin bufferizar).
- **Sanitizacion de :name (linea de defensa principal).** Acepta SOLO
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. ADEMAS rechaza (VALIDATION -> 400):
  (a) `..` en cualquier posicion (`name.includes('..')`),
  (b) nombres que terminen en `.meta.json` (colision con sidecars),
  (c) nombres que terminen en `.tmp` (colision con temps internos).
  Un name invalido NUNCA toca el filesystem: la validacion va antes de cualquier I/O.
- **Defensa en profundidad.** Tras sanitizar, `path.resolve(dir, name)` debe quedar
  DENTRO de `dir` (`isInside`: el `path.relative(dir,target)` no empieza con `..` ni
  es absoluto ni vacio). Si no, VALIDATION. (Nota: con la sanitizacion anterior esto
  es redundante, pero protege frente a cambios futuros en el nucleo/router.)
- **Subida atomica.** El body se streamea a un temp en el MISMO dir que el destino
  (misma particion => `rename` es cambio de inodo, atomico); al final `fsync` del fd,
  close y `rename(temp, destino)`. Un crash a mitad deja el destino anterior intacto
  (si existia) y un temp residual; nunca el destino a mitad. Sobreescritura = rename
  atomico sobre el destino (GET nunca ve mezcla).
- **maxBytes -> 413.** Si el body excede `maxBytes`, se aborta la lectura (NO se
  destruye el socket: se pausa, igual que el nucleo, para que el 413 viaje por la
  MISMA conexion), se borra el temp y se responde `413` escrito directo en `res`.
  El nucleo [[http-core]] NO mapea 413 en `CODE_STATUS` (no hay code de error para
  413), por eso se escribe el status directo; como `res.writableEnded` queda true,
  el nucleo NO vuelve a responder (mecanismo del `else if (!res.writableEnded)`).
- **No queda residual.** Tras 413 o error de escritura, el temp se borra y el destino
  NUNCA se crea (el rename solo ocurre en el camino de exito).
- **Sidecar.** `<name>.meta.json` junto al archivo con
  `{ contentType, size, uploadedAt(ISO), uploadedBy: user?.id ?? null }`.
  GET lee el `contentType` del sidecar; si falta o esta corrupto, cae a
  `application/octet-stream` (la lectura NO falla por un sidecar malo).
- **Lectura publica (MVP).** GET NO invoca `app.rules.check` (decision de producto:
  lectura publica en el MVP). POST y DELETE SI aplican rules. Documentado.
- **authResolver inyectado.** `async (token) -> user|null`. En tests se inyecta un
  fake; en produccion delega a [[auth-service]]. El `auth` que recibe `rules.check`
  es el `user` resuelto (o `null`), conforme al shape de [[hooks]].
- **Servidores cerrados y tempdir limpiado.** Los tests usan `app.close()` en
  `finally` y borran el tempdir al final (patron de [[http-core]]).

## Examples
- `POST /api/files/blob.bin` con body binario no-UTF8 y `content-type: image/png` ->
  `200 { name:'blob.bin', size, contentType:'image/png' }`; `GET` devuelve bytes
  identicos con `content-type: image/png` y `content-length` correctos.
- `POST` con body > `maxBytes` -> `413 { error:{ code:'PAYLOAD_TOO_LARGE' } }` y el
  dir queda sin archivo ni temp residual.
- `POST /api/files/a..b` -> `400 VALIDATION` (contiene `..`); `POST .sec` -> `400`
  (primer char `.`); `POST x.meta.json` -> `400` (sufijo reservado); `POST x.tmp` ->
  `400` (sufijo reservado); en todos, el dir no gana archivos.
- `POST a%2F..%2Fb` (barras codificadas, llega como un segmento con `..` real al
  handler) -> `400 VALIDATION`; no toca FS.
- `DELETE /api/files/blob.bin` -> `200 { ok:true }`; `GET` posterior -> `404`; el
  sidecar `blob.bin.meta.json` tambien se borra.
- `rules.check` devuelve `{allow:false}` para `op:'create'` -> `403 FORBIDDEN` y no se
  escribe nada en disco.
- Sobreescritura: `POST over.bin` (8x 0x11) luego `POST over.bin` (8x 0x22) -> `GET`
  devuelve 8x 0x22; sin temps residuales.

## Do / Don't
- DO: leer el body crudo directo de `ctx.req` (streaming); el nucleo ya dejo intacto
  el stream para content-types no-JSON.
- DO: subida atomica con temp en el mismo dir + fsync + rename (patron del
  ecosistema, ver [[atomic-file-adapter]]).
- DO: sanitizar `:name` ANTES de cualquier I/O; defender con `path.resolve` + isInside.
- DO: aplicar backpressure en la subida (pausa `ctx.req` mientras espera cada write
  del FileHandle) para no acumular chunks en memoria.
- DO: responder 413 escribiendo directo en `res` (el nucleo no mapea 413) y devolver
  `undefined` para que el nucleo no doble-responda (`res.writableEnded` true).
- DO: en GET, devolver una promesa que resuelva recien en `res 'finish'` (no `'close'`:
  con keep-alive el socket persiste y `'close'` se retrasa colgando el handler).
- DON'T: tocar `src/server.js` (el nucleo es solo lectura; si bufferizara bodies
  no-JSON, ABORTAR y reportar — no parchear).
- DON'T: destruir `ctx.req` en el 413 (rompe la entrega del 413 al cliente); pausar.
- DON'T: usar `res 'close'` para resolver el GET (keep-alive lo retrasa).
- DON'T: aceptar `..`, sufijos `.meta.json`/`.tmp`, ni nombres fuera del regex.
- DON'T: depender de que la capa URL del nucleo rechace `..` por si sola: la
  sanitizacion del handler es la garantia (la capa URL colapsa dot-segments literales
  `..`/`../x` a 404 y `a/../b` a `b` ANTES del router; esas formas no llegan al
  validador — ver Constraints).

## Tests
`tests/files.test.js` (congelado: `createApp` real, `mkdtempSync` limpiado al final,
`fetch` real). Cubre: upload binario (bytes no-UTF8) + download byte-identico con
Content-Type preservado y sidecar correcto; upload > maxBytes (1KB) -> 413 sin archivo
ni temp residual; path traversal: nombres que alcanzan el handler (`a..b`, `.sec`,
`x.meta.json`, `x.tmp`, `a%2F..%2Fb`) -> 400 y dir limpio (POST/GET/DELETE); `..` y
`../x` literales -> 404 (capa URL) y dir limpio; `a/../b` -> 404 (colapsa a `b`,
dentro de dir, sin escape); delete -> ok + GET 404 + sidecar borrado; delete/get
inexistente -> 404; rules deniegan create -> 403 sin escritura; sobreescritura
atomica (contenido final, sin temps); authResolver inyectado (`uploadedBy` en
sidecar); dir creado recursivo si falta; GET sin sidecar -> octet-stream.

## Constraints
- PARAR y reportar si... el nucleo [[http-core]] consumiera/bufferizara bodies
  no-JSON impidiendo el streaming (verificado leyendo `src/server.js`: SOLO parsea
  `application/json`; para otros content-types `ctx.req` queda intacto — NO hay
  bloqueo). Si lo bufferizara, documentar la evidencia y responder BLOQUEADO sin
  parchear `src/server.js`.
- PARAR y reportar si... la suite existente (`node --test tests/*.test.js`) tuviera
  fallos preexistentes ajenos a este modulo (no los tiene: 89/89 verdes al inicio).
- PARAR y reportar si... la sanitizacion de `:name` no pudiera garantizar que un
  nombre invalido nunca toca el filesystem (si garantiza: validacion antes de I/O +
  isInside). La capa URL del nucleo (`new URL(req.url).pathname`) normaliza
  dot-segments literales (`..`, `../x` -> 404; `a/../b` -> `b`) ANTES del router, por
  lo que esas formas literales NO llegan al validador como traversal y NO pueden
  devolver 400 desde aca (lo hacen 404 o colapsan a un nombre in-dir). El atacante
  que entrega un name traversal real al handler lo hace via barras codificadas
  (`a%2F..%2Fb`), que SI se rechazan con 400. Esto es comportamiento del nucleo, no
  editable (no tocar `src/server.js`); el almacen sigue seguro (sin escape de dir).
- Cero dependencias runtime nuevas; sin HTTPS/websockets/static; sin red externa;
  sin subprocess; sin loguear passwords ni tokens completos; los archivos de test
  SOLO en el tempdir; ningun proceso que no termine solo.
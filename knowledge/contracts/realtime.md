---
type: 'Task Contract'
title: 'realtime — fanout SSE (Server-Sent Events) sobre el nucleo HTTP'
description: 'Modulo src/realtime.js: makeRealtime(opts) -> { events, register(app), subscriberCount }. events.emit(evt) implementa el contrato de hooks y hace fanout SSE a los clientes suscritos a evt.collection (y al comodin "*"). register(app) monta GET /api/realtime/:collection con stream SSE mantenido abierto. Cero dependencias, todo en memoria.'
tags: ['http', 'sse', 'realtime', 'streaming', 'events', 'js-base']

task: realtime
intent: "Encima del nucleo [[http-core]] y del contrato de events de [[hooks]], proveer fanout SSE en memoria: un cliente abre GET /api/realtime/:collection, el server mantiene la conexion abierta (patron de streaming de [[files]]) y events.emit(evt) difunde el evt a todos los suscritos a evt.collection (y a los del comodin \"*\"), en frames SSE estandar. Sin storage, sin deps, sin timers colgados."
target: src/realtime.js
signature: "makeRealtime(opts?) -> { events, register(app), subscriberCount(collection?) }"
language: javascript
test_command: "node --test tests/realtime.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 4
tests: "tests/realtime.test.js"
deps_allowed: []
forbids: ['network-external', 'subprocess', 'https', 'deps-runtime', 'persistent-timers', 'storage']
---

# Contract: realtime

## Intent
Sumar fanout en tiempo real al backend: un cliente se suscribe con
`GET /api/realtime/:collection`; el server abre un stream SSE y lo mantiene abierto
(patrón de "handler que ya respondió" de [[http-core]], mismo mecanismo que [[files]]
usa para streaming). El objeto `events` retornado implementa el contrato de hooks de
[[hooks]] (`emit(evt)`), así que cableado con `createApp({ events })` cualquier handler
que llame `app.events.emit(evt)` difunde el evento a los suscriptores SSE de
`evt.collection` (y a los del comodín `"*"`). Todo en memoria del proceso: no hay
persistencia, no hay dependencias runtime, no hay timers que cuelguen el proceso.

## Interface
```javascript
const { makeRealtime } = require('./realtime.js');

// makeRealtime(opts?) -> { events, register(app), subscriberCount(collection?) }
//   opts.heartbeatMs : intervalo (ms) del ping SSE periódico; 0/omitido => sin ping.
//                      Si se habilita, el timer usa unref() (no cuelga el proceso/tests).
const rt = makeRealtime();
//   rt.events         : objeto con emit(evt) -> void  (contrato de [[hooks]])
//   rt.register(app)  : registra GET /api/realtime/:collection; retorna app
//   rt.subscriberCount(collection?) -> number  (sin arg = total; con arg = esa coleccion)

// Cableado real (lo usan los handlers y los tests):
const app = createApp({ events: rt.events });
rt.register(app);

// evt que recibe events.emit (shape del contrato de [[hooks]]):
//   { collection: string, op: "create"|"update"|"delete"|"list"|"view",
//     record: object | null }

// GET /api/realtime/:collection
//   - status 200; headers Content-Type: text/event-stream, Cache-Control: no-cache,
//     Connection: keep-alive (CORS * ya lo pone el nucleo; se reafirma).
//   - escribe el comentario inicial ": connected\n\n".
//   - registra el res como suscriptor de :collection (o de "*" si el segmento es "*").
//   - NO cierra la respuesta: devuelve una Promise que resuelve en res 'close'
//     (mecanismo de [[http-core]]/[[files]] para mantener viva la conexion).
//   - desuscribe en req/res 'close'; si hay heartbeat, limpia su timer en close.

// Frame SSE emitido por events.emit (estandar):
//   "event: <op>\n"
//   "data: <json del evt>\n\n"
```

## Invariants
- **Cero dependencias runtime.** Solo estructuras en memoria (`Map`/`Set`) y `res.write`
  sobre el `ctx.res` nativo que el nucleo [[http-core]] entrega intacto (la ruta es GET,
  sin body JSON, así que el nucleo no consume el stream). Sin `node:events`, sin libs.
- **events implementa el contrato de [[hooks]].** `emit(evt)` con `evt = { collection, op,
  record }`. Es síncrono y **NUNCA lanza**: captura errores de escritura por cliente y
  limpia ese suscriptor. `evt` inválido (no objeto, o `collection` no string) se ignora
  sin lanzar. Esto cumple la regla de [[hooks]]: el handler invoca `app.events.emit` y no
  debe romper aunque un cliente esté muerto.
- **Fanout.** Al emitir, se difunde a todos los `res` suscritos a `evt.collection` y a
  todos los suscritos al comodín `"*"` (unión deduplicada). Formato SSE estándar:
  `event: <op>\n` + `data: <json del evt>\n\n`. El `data` es el `evt` serializado entero
  (incluye `collection`, `op`, `record`), así el cliente reconstruye el evento completo.
- **Comodín `"*"`.** Se suscribe vía `GET /api/realtime/*` (el router [[http-core]]
  captura `*` como valor de `:collection`). Un cliente `"*"` recibe eventos de cualquier
  colección. Documentado y cubierto por tests.
- **Respuesta abierta (streaming).** El handler de la ruta NO llama `res.end()`: devuelve
  una `Promise` que resuelve en `res 'close'`. Así el nucleo mantiene la conexión viva
  (mismo patrón que [[files]] con `'finish'`; aquí usamos `'close'` porque el stream SSE
  no termina naturalmente — el cierre lo dispara el cliente). Al resolver, el nucleo ve
  `res.writableEnded === false` y aplica su `res.end()` por defecto sobre un `res` ya
  cerrado (no-op, sin doble respuesta ni crash). Verificado leyendo `src/server.js`.
- **Limpieza en close.** Tanto `ctx.req` `'close'` como `res` `'close'` desuscriben
  (idempotente). Tras desconectar el cliente, `subscriberCount(collection)` baja a 0.
- **emit a cliente muerto no lanza.** `writeFrame` chequea `res.destroyed`/`writableEnded`
  y envuelve `res.write` en try/catch; un `res` muerto se descarta y se purga de todas las
  colecciones (defensa en profundidad, por si un mismo `res` estuviera en varias claves).
- **Heartbeat opcional con unref.** Si `opts.heartbeatMs > 0`, se crea un `setInterval`
  que envía `: ping\n\n` (comentario SSE) y se llama a `timer.unref()`: el timer NO impide
  que el proceso (ni `node --test`) termine. Se limpia en `close`. Por defecto (0) no hay
  heartbeat — los tests no lo usan y el proceso termina solo.
- **Sin storage.** Todo en memoria del proceso. Cerrar el server o reiniciar el proceso
  pierde los suscriptores. No hay persistencia (es realtime efímero, no colecciones).
- **`subscriberCount(collection?)`.** Sin argumento: total de suscriptores (suma de todos
  los `Set`). Con argumento: tamaño del `Set` de esa colección exacta (`"*"` cuenta como
  una clave más). Para tests; no se persiste.

## Examples
- Flujo real: `const rt = makeRealtime(); const app = createApp({ events: rt.events });
  rt.register(app); app.route('POST','/api/:collection', async c => {
  app.events.emit({ collection: c.params.collection, op:'create', record: c.body });
  return c.body; });` + `app.listen(0)`; un cliente `GET /api/realtime/posts` recibe
  `event: create\ndata: {"collection":"posts","op":"create","record":{...}}\n\n` tras el
  `POST /api/posts` (parsea y compara `collection`/`op`/`record`).
- Un suscriptor a `posts` NO recibe un `emit` para `comments`: el fanout solo alcanza los
  `Set` de `comments` y de `"*"`, no el de `posts`. Cubierto por test (emite `comments`
  luego `posts`; el cliente de `posts` recibe un único frame, el de `posts`).
- `subscriberCount('posts')` pasa de 1 (tras `: connected`) a 0 (tras cerrar el cliente y
  dejar propagar el `'close'` del server).
- `rt.events.emit({ collection:'x', op:'create', record:null })` sin suscriptores: no
  lanza, no op.
- `GET /api/realtime/*` + `emit` para `posts`/`comments`: el cliente `"*"` recibe ambos.
- Cliente desconectado + `emit`: `res.write` falla/está destruido → se descarta y purga;
  `emit` no lanza, `subscriberCount` queda en 0.

## Do / Don't
- DO: cablear SIEMPRE con `createApp({ events: rt.events })` (el flujo real
  create→emit→cliente pasa por el `app.events` inyectado, no por una referencia suelta).
- DO: mantener la respuesta abierta devolviendo una `Promise` que resuelva en `res 'close'`
  (patrón de [[files]]/[[http-core]]); NO llamar `res.end()` en el handler SSE.
- DO: capturar errores de escritura por cliente en `emit` y purgar el suscriptor muerto;
  `emit` NUNCA lanza (contrato de [[hooks]]).
- DO: si se habilita heartbeat, llamar `timer.unref()` y limpiar el timer en `close`.
- DO: cerrar el server (`app.close()`) y los clientes en `finally`/after en los tests.
- DON'T: tocar `src/server.js`, `src/hooks.js`, `src/files.js`, `src/rules-engine.js`,
  `knowledge/index.md` ni nada existente (otro dev trabaja en paralelo).
- DON'T: dejar timers/sockets vivos al terminar los tests (unref en timers, close en
  finally) — si `node --test` no retorna, es FAIL.
- DON'T: agregar persistencia, deps runtime, HTTPS, websockets ni red externa.
- DON'T: usar `res 'finish'` para resolver el handler SSE (el stream no termina; colgaría).
  Usar `res 'close'`.

## Tests
`tests/realtime.test.js` (congelado). Cliente SSE real con `node:http` (`req.on('data')`),
timeout y `finally` que cierra todo. Cubre:
- Suscriptor a `posts` recibe el `evt` emitido para `posts` vía `POST /api/posts`
  (parsea el frame SSE y compara `collection`/`op`/`record`).
- Suscriptor a `posts` NO recibe un `evt` de `comments` (emite `comments` luego `posts`;
  el cliente recibe un único frame, el de `posts`; 0 frames de `comments`).
- `subscriberCount('posts')` y `subscriberCount()` reflejan alta (1) y baja (0) tras
  cerrar el cliente (esperando al `'close'` del server).
- `emit` sin suscriptores no lanza (con `record` y con `record: null`).
- `emit` hacia un cliente ya desconectado no lanza y deja `subscriberCount('posts')` en 0.
- Comodín `"*"` recibe eventos de cualquier colección.
- El proceso termina solo (sin heartbeat en tests; si lo hubiera, `unref`).

## Constraints
- PARAR y reportar si... el nucleo [[http-core]] no permitiera mantener una respuesta
  abierta para streaming (verificado leyendo `src/server.js` + `src/files.js`: el handler
  puede devolver una `Promise` que resuelva tarde y el nucleo no doble-responde mientras
  `res` no esté `writableEnded`; [[files]] ya lo usa para GET streaming — NO hay bloqueo).
  Si no se pudiera, responder BLOQUEADO con evidencia y NO parchear `src/server.js`.
- PARAR y reportar si... la suite existente tuviera fallos preexistentes ajenos a este
  modulo (verificar antes de empezar; si los hay, no tocarlos — otro dev los cubre).
- PARAR y reportar si... `python scripts/validate_okf.py knowledge` exigiera editar
  `knowledge/index.md` (no lo exige: `index.md` enlaza la carpeta `contracts/`, por lo que
  el contrato nuevo queda alcanzable vía carpeta sin editarlo).
- Cero dependencias runtime nuevas; sin HTTPS/websockets/static; sin red externa; sin
  subprocess; sin storage; sin loguear passwords ni tokens completos; ningún timer/socket
  que no termine solo (unref + close en finally).
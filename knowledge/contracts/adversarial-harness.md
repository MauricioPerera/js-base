---
type: 'Task Contract'
title: 'Harness adversarial de durabilidad y seguridad'
description: 'Suite de tests adversariales (node:test) que ATACA las garantias YA COMMITEADAS del sistema: atomicidad de escritura, durabilidad modo disco, lock 1-escritor, auth y rules. Inyecta crashes via SIGKILL a procesos hijo.'
tags: ['test', 'adversarial', 'durability', 'crash-injection', 'fuzz', 'security']

task: adversarial-harness
intent: "Atacar (no implementar) las garantias de durabilidad y seguridad del sistema commiteado: escritura atomica, durabilidad disco, lock 1-escritor, auth y rules. Exponer hallazgos reales dejandolos en rojo."
target: tests/adversarial.test.js
signature: "node --test tests/adversarial.test.js -> bloques A..E que ejercitan AtomicFileStorageAdapter, SemanticCollection (disco/lock), createAuthService y makeRules bajo crash/fuzz"
language: javascript
test_command: "node --test tests/adversarial.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 4
tests: "tests/adversarial.test.js"
deps_allowed: ['node:test', 'node:assert', 'node:fs', 'node:os', 'node:path', 'node:child_process']
forbids: ['touch-production', 'patch-vendor', 'weaken-asserts', 'hide-failures', 'network', 'math-random']
---

# Contract: adversarial-harness

## Intent
El sistema ya commiteado declara garantias de durabilidad (escritura atomica,
modo disco con fsync por append, lock 1-escritor) y seguridad (auth PBKDF2+JWT,
rules deny-by-default). Este harness NO implementa: las ATACA. Inyecta crashes
reales (SIGKILL a procesos hijo a mitad de operacion), fuzz de inputs borde y
configs aleatorias, y aserta los invariantes. Si un invariante cae, es un
HALLAZGO del sistema: se documenta con la reproduccion exacta y el test queda
ROJO (o expone el fallo). Nunca se parchea produccion ni se debilita un assert
para ocultar un fallo.

## Interface
```javascript
// tests/adversarial.test.js  (node:test)
// tests/harness/crash-child.cjs  (proceso hijo; modos: atomic | disk | lock)

// Hijos spawneados SOLO escriben en tempdirs (mkdtempSync). El padre mata SOLO
// sus propios hijos (guarda pid) con SIGKILL y aguarda 'exit' (no huerfanos).
spawn(process.execPath, [CHILD, "atomic", dir])        // escribe f.json en loop
spawn(process.execPath, [CHILD, "disk", prefix, dim])  // upserts 0.. en loop
spawn(process.execPath, [CHILD, "lock", prefix, dim])  // lock:true, vive hasta kill

// Bloques del harness:
// A  AtomicFileStorageAdapter  SIGKILL mid-write -> dest .json nunca corrupto
// B1 SemanticCollection disco  SIGKILL mid-upsert -> confirmados sobreviven, reopen ok
// B2 DiskKV                    registro torn (post-SIGKILL mid-append) -> reopen (hallazgo)
// C  SemanticCollection lock   2da apertura rechaza mientras 1ra vive; roba stale
// D  createAuthService         fuzz N>=240 -> no crash; login sin token para no-registrados
// E  makeRules                 fuzz configs+ctx -> check() nunca lanza, {allow:boolean}
```

## Invariants
- **A.** Tras SIGKILL a mitad de writeJson: todo archivo `.json` presente en el
  dir es JSON parseable (el destino nunca queda a medias); `listKeys()` no
  expone `.tmp` residuales de escrituras abortadas. Repetido N ciclos (5).
- **B1.** Tras SIGKILL a mitad de upserts en modo disco (`{path,dim}` sin lock):
  reabrir la coleccion NO tira excepcion de corrupcion y todo upsert confirmado
  (ambos appends fsync'd, reportado por el hijo antes del kill) sigue presente.
  Repetido N ciclos (5).
- **B2.** (Hallazgo) `DiskKV._scan` NO tolera un registro "torn" final (header
  persistido, payload no) — el estado exacto que deja un SIGKILL entre los dos
  `writeSync` de `_appendRecord`. Reabrir lanza `SyntaxError` al `JSON.parse`
  del payload ausente/parcial. `refresh()` si tolera torn; `_scan` (apertura)
  no. Invariante deseado (reabrir nunca tira) NO se sostiene -> test ROJO.
- **C.** Con `lock:true`, dos `SemanticCollection` sobre el mismo path: la
  segunda rechaza (`recurso bloqueado`) mientras la primera vive. Tras muerte
  del dueño, `acquireLock` roba el lock stale (proceso muerto via `process.kill
  (pid,0)` -> ESRCH) y la reapertura exita. Semantica real del vendor asertada.
- **D.** N>=240 intentos con emails/passwords borde (vacios, muy largos, unicode,
  con `:` y `=`, sin `@`, control): ninguno crashea el proceso (siempre `Error`
  tipado o exito); `login` jamas devuelve token para credenciales no registradas.
- **E.** N>=240 configs de rule aleatorias + contextos aleatorios: `check()`
  nunca lanza, siempre devuelve `{allow: boolean}`. (Si `rules-engine` no
  existiera, `it.skip` con comentario.)
- **Terminacion:** el proceso de test termina solo: sin hijos huerfanos, sin
  timers colgados, todos los tempdir limpiados (`fs.rmSync` en `finally`),
  todos los SIGKILL confirmados (`killAndAwait` aguarda `exit`).

## Examples
- A: hijo escribe `f.json` en loop (payload 200KB para ensanchar write+fsync);
  padre SIGKILL a los 70ms; `new AtomicFileStorageAdapter(dir).listKeys()` ->
  los `.json` parsean, los `.tmp` no se listan.
- B1: hijo hace upserts 0..N imprimiendo `UPSERT k` tras cada uno; padre SIGKILL
  tras confirmar >=25; `new SemanticCollection({path,dim}).get("12")` -> doc
  presente para todo k confirmado.
- B2: log con 2 registros validos + header torn (N=200, sin payload); `new
  DiskKV(file)` -> lanza `SyntaxError` (corrupcion en reapertura).
- C: hijo `lock` toma el lock y vive; padre `new SemanticCollection({path,dim,
  lock:true})` -> `throws /recurso bloqueado/`; padre SIGKILL hijo; padre
  reintenta -> exito (stale robado).
- D2: servicio limpio (nada registrado); 240 `login` con inputs borde -> 0
  tokens devueltos, todos rechazados con `Error`.

## Do / Don't
- DO: spawnear hijos que SOLO escriben en tempdirs (`mkdtempSync`); matar SOLO
  hijos propios (guardar pid) con SIGKILL y aguardar `exit`.
- DO: PRNG sembrado con constante (`mulberry32`, semilla del prompt); sin
  `Math.random` (determinismo del fuzz).
- DO: dejar un HALLAZGO en ROJO con su reproduccion exacta en el REPORT.
- DO: limpiar todo tempdir en `finally` y drenar stderr de los hijos.
- DON'T: tocar codigo de produccion (`src/**` fuera del harness), el vendor,
  `src/semantic-*.js`, `src/server.js`, `src/records.js`, `knowledge/index.md`,
  ni otros tests.
- DON'T: debilitar un assert, parchear produccion o envolver en try/catch para
  OCULTAR un fallo (los try/catch de D/E son para COLECTAR N resultados y
  asertarlos, no para ocultar).
- DON'T: depender de red o de `Math.random`.

## Tests
`tests/adversarial.test.js` con `node --test`:
- A: 5 ciclos de SIGKILL mid-write -> `.json` parseables, `.tmp` no listados.
- B1: 5 ciclos de SIGKILL mid-upsert -> confirmados presentes, reopen sin throw.
- B2: registro torn determinista -> `assert.doesNotThrow(new DiskKV(file))`
  FALLA (hallazgo: `_scan` no tolera torn) -> test ROJO.
- C: lock cross-process -> 2da rechaza, stale robado tras kill.
- D1/D2: fuzz 240 inputs -> 0 crashes, 0 tokens para no-registrados.
- E: fuzz 240 configs -> `check()` 0 throws, 0 no-bool.
Hijo: `tests/harness/crash-child.cjs` (modos atomic/disk/lock).

## Constraints
- PARAR y reportar si... no se puede spawnear procesos hijo en el entorno
  (verificado con spawn trivial ANTES): degradar el bloque A a inyeccion de
  fallo in-process (monkey-patch de `fs.renameSync`/`fs.writeSync`) reportando
  la limitacion — NO abortar todo el harness por eso.
- PARAR y reportar si... los tests existentes estuvieran rojos de base por otra
  causa ajena a este harness (verificar baseline antes de atacar).
- PARAR y reportar si... un invariante falla: es un HALLAZGO real; documentar la
  reproduccion exacta en `B5-T10-REPORT.md` y dejar el test en ROJO. PROHIBIDO
  parchear produccion, debilitar asserts o envolver en try/catch para ocultar.
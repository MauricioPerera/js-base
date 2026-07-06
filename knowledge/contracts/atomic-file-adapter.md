---
type: 'Task Contract'
title: 'AtomicFileStorageAdapter — FileStorageAdapter atómico'
description: 'Drop-in replacement del FileStorageAdapter del vendor (js-doc-store) con writeJson atómico (temp + fsync + renameSync). Misma interfaz exacta; cero dependencias.'
tags: ['atomic', 'storage-adapter', 'durability', 'vendor']

task: atomic-file-adapter
intent: "Reemplazar el writeJson directo del FileStorageAdapter del vendor por una escritura atómica que no corrompa el destino si el proceso cae a mitad."
target: src/atomic-file-adapter.js
signature: "class AtomicFileStorageAdapter { constructor(dir); readJson(filename); writeJson(filename, data); delete(filename); listKeys() }"
language: javascript
test_command: "node --test tests/atomic-file-adapter.test.js"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/atomic-file-adapter.test.js"
deps_allowed: []
forbids: ['network', 'subprocess']
---

# Contract: atomic-file-adapter

## Intent
El `FileStorageAdapter` del vendor escribe con `fs.writeFileSync` directo sobre el
destino: un crash a mitad de escritura deja el JSON truncado/corrupto. Para las
colecciones de sistema (`_users`/`_sessions`/`collections`) eso es intolerable. Este
módulo expone la MISMA interfaz exacta pero con `writeJson` atómico, para inyectarse
como adapter de un `DocStore` del vendor sin tocar el vendor.

## Interface
```javascript
const fs = require("node:fs");
const path = require("node:path");

class AtomicFileStorageAdapter {
  constructor(dir)                                  // crea dir recursivo si falta
  readJson(filename)        // -> obj | null  (null si no existe)
  writeJson(filename, data) // -> void        (atómico: temp + fsync + rename)
  delete(filename)          // -> void        (no lanza si no existe)
  listKeys()                // -> string[]    (sin .tmp residuales)
}
```
Drop-in de `FileStorageAdapter` del vendor: `new DocStore(new AtomicFileStorageAdapter(dir))`.

## Invariants
- Misma interfaz y semántica que `FileStorageAdapter` (vendor): `readJson` devuelve
  `null` si el archivo no existe, `JSON.parse(readFileSync(utf8))` si existe; `delete`
  no lanza si el archivo no existe; `listKeys` devuelve `readdirSync(dir)` (o `[]` si
  el dir no existe) SIN archivos temporales residuales.
- `writeJson` es atómico respecto a fallos: escribe a un temp en el MISMO directorio
  que el destino, hace `fsyncSync` del fd, y recién entonces `renameSync(temp, dest)`.
  Si el proceso cae antes del `renameSync`, el destino conserva su contenido anterior
  íntegro y parseable; nunca queda a mitad.
- El temp se nombra `<filename>.<pid>.<contador>.tmp` (único por proceso) y vive en
  el mismo dir que el destino (misma partición => `renameSync` es cambio de inodo,
  atómico, no copia).
- `listKeys` filtra cualquier archivo con sufijo `.tmp` (residuales de escrituras
  fallidas); el ecosistema nunca usa `.tmp` como extensión de datos reales.
- Cero dependencias runtime: solo `node:fs` y `node:path`.

## Examples
- `a.writeJson("u.docs.json", [...]); a.readJson("u.docs.json")` -> mismo array (roundtrip).
- `a.writeJson("f.json", {v:1}); a.writeJson("f.json", {v:2}); a.readJson("f.json")` -> `{v:2}` (sobreescritura completa, sin mezcla de campos).
- `a.delete("f.json"); a.readJson("f.json")` -> `null`.
- `fs.renameSync` lanza durante una escritura: `readJson(destino)` sigue devolviendo el contenido anterior íntegro y parseable; `listKeys()` no expone el `.tmp` residual.
- `new DocStore(new AtomicFileStorageAdapter(dir))` + `col.insert(...)` + `db.flush()`: un segundo `DocStore` sobre el mismo dir lee lo insertado.

## Do / Don't
- DO: mirror del patrón atómico del ecosistema (`semantic-collection.saveToFile`: open + write + fsync + close + rename).
- DO: temp en el MISMO dir que el destino (mismo volumen) para que `renameSync` sea atómico.
- DO: filtrar `.tmp` por sufijo en `listKeys` (robusto frente a residuales de crashes).
- DON'T: tocar `src/vendor/**` (el vendor es solo lectura; se reemplaza por inyección del adapter).
- DON'T: dependencias fuera de `node:fs`/`node:path`; red; subprocess.
- DON'T: escribir directo sobre el destino (`writeFileSync` al destino rompe la atomicidad).

## Tests
En `tests/atomic-file-adapter.test.js` (tempdir con `fs.mkdtempSync`, limpieza al final):
roundtrip write+read; `readJson` null si no existe; sobreescritura reemplaza completo;
`delete` + inexistente no lanza; `listKeys` sin `.tmp` tras N escrituras y excluye un
temp residual plantado; constructor crea dir recursivo; DROP-IN real con `DocStore`
del vendor (insert + flush + segundo `DocStore` lee lo insertado); ATOMICIDAD: monkey-patch
de `fs.renameSync` que lanza en una escritura -> destino intacto y parseable, escritura
siguiente funciona, `listKeys` sin residuales.

## Constraints
- PARAR y reportar si... la interfaz real del `FileStorageAdapter` del vendor fuera
  incompatible de raíz con la descrita (no lo es: verificada leyendo
  `src/vendor/js-store/vendor/js-doc-store.js` — interfaz idéntica), o si la suite
  Python de la plantilla (`validate_contracts.py` / `validate_okf.py`) tuviera fallos
  preexistentes ajenos a este contrato.
- PARAR y reportar si... `node --test tests/atomic-file-adapter.test.js` no diera 0
  fails, o si el adapter no sirviera como drop-in real de un `DocStore` del vendor.
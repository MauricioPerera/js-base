---
type: 'Task Contract'
title: 'Registro de colecciones de js-base'
description: 'Registro de colecciones con config persistida en la colección de sistema _collections de un DocStore inyectado; valida config y docs, sin HTTP ni I/O propio.'
tags: ['js-base', 'collections', 'kdd', 'backend']

task: collections
intent: "Permitir declarar y validar colecciones de js-base persistiendo su configuración en un DocStore inyectado, sin acoplar el módulo a ningún storage propio."
target: src/collections.js
signature: "class CollectionRegistry { constructor(db); create(config); get(name); list(); update(name, partial); remove(name); validateDoc(name, doc) }"
language: javascript
test_command: "node --test tests/collections.test.js"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 4
tests: "tests/collections.test.js"
deps_allowed: []
forbids: ['network', 'subprocess']
---

# Contract: collections

## Intent
Primera pieza del modelo de datos de js-base: un registro de colecciones que viva sobre el
mismo DocStore del backend, de modo que la configuración sea persistente y compartida entre
quien la lee y quien la escribe. Mantiene el módulo desacoplado del storage concreto: recibe
el DocStore por parámetro y no crea ninguno propio. La sección `rules` es OPACA — se acata su
shape pero NO se evalúa (eso es de otra fase). Metodología:
[metodologia-ejecucion](../metodologia-ejecucion.md).

## Interface
```javascript
const { CollectionRegistry } = require("./collections.js");
// const { DocStore, MemoryStorageAdapter } = require("./vendor/js-store/vendor/js-doc-store.js");
// const db = new DocStore(new MemoryStorageAdapter());

class CollectionRegistry {
  constructor(db);                       // db: DocStore inyectado (no crea storage propio)
  create(config)        -> config;       // valida + persiste; lanza Error si inválida o duplicada
  get(name)             -> config | null;
  list()                -> config[];
  update(name, partial)  -> config;      // merge superficial, revalida; lanza Error si no existe/inválida
  remove(name)          -> boolean;      // true si borró, false si no existía
  validateDoc(name, doc) -> { ok: boolean, errors: string[] }; // lanza si la colección no existe
}
// config: { name: regex ^[a-z][a-z0-9_]{0,49}$ (único, no empieza con "_"),
//           fields: [{ name, type: "string"|"number"|"boolean"|"object"|"array", required? }],
//           rules: { list, view, create, update, delete: objeto-filtro-o-null } (OPACO),
//           vector: { dim: entero>0 } | null }
```

## Invariants
- Toda config se persiste como un documento con `_id === name` en la colección de sistema
  `_collections` del DocStore inyectado. El nombre es la PK; no se generan ids propios.
- `name` debe matchear `^[a-z][a-z0-9_]{0,49}$` (implícitamente no empieza con "_") y ser único.
- `create` y `update` validan la config completa y lanzan `Error` con mensaje claro (no
  devuelven silenciosamente) si es inválida; `update` revalida la config resultante del merge.
- `update` hace merge **superficial a nivel top-level** (name, fields, rules, vector): lo no
  tocado se preserva tal cual; `name` es inmutable vía update (es la PK, se ignora `partial.name`).
- `validateDoc` valida solo tipo + required de los `fields` declarados; los campos extra del
  doc son **permitidos** (no generan error). Lanza si la colección `name` no existe.
- `rules` es OPACO: solo se acata que cada sub-clave sea objeto-filtro o null; no se evalúa.
- El módulo NO hace HTTP ni I/O propio; todo I/O pasa por el DocStore inyectado.
- Cero dependencias de runtime; solo `src/vendor/js-store/vendor/js-doc-store.js`.

## Examples
- `new CollectionRegistry(db).create({ name: "users", fields: [...], rules: {...}, vector: null })`
  persiste la config; `get("users")` la devuelve y `list()` la incluye.
- `create({ name: "_priv" })` lanza `Error` (no cumple el regex); `create` dos veces con el
  mismo nombre lanza `Error` por duplicado.
- `update("users", { vector: { dim: 4 } })` reemplaza solo `vector` y preserva `fields` y
  `rules`; `validateDoc("users", { email: 1 })` devuelve `{ ok: false, errors: [...] }`.
- Dos `CollectionRegistry` construidos sobre el MISMO `DocStore` ven la misma config: un
  `create` en uno es visible para el `get`/`list` del otro.

## Do / Don't
- DO: recibir el DocStore por constructor; nunca instanciar storage propio.
- DO: usar `_id === name` para lookup directo por PK (`findById`/`removeById`).
- DO: revalidar la config tras el merge en `update` antes de persistir.
- DON'T: evaluar `rules` (es OPACO — shape sí, semántica no); tocar `src/vendor/**`; hacer HTTP,
  red o subprocess; generar ids propios (usa el nombre como `_id`).
- DON'T: devolver el `_id` ni metadatos del store en las configs retornadas.

## Tests
(Los tests están en `tests/collections.test.js`, congelados con `MemoryStorageAdapter`:
create válido + get/list; nombre inválido/duplicado/tipo desconocido lanza; update parcial
preserva lo no tocado y revalida; remove true/false; validateDoc válido, required faltante,
tipo incorrecto, campo extra permitido; persistencia compartida entre dos registros sobre
el mismo DocStore.)

## Constraints
- PARAR y reportar si el DocStore del vendor no soporta algo esencial (lookup por PK, insert
  con `_id` explícito, remove por id, find all) — documenta con evidencia y responde BLOQUEADO.
- PARAR y reportar si mantener los tests verdes exigiera editar `src/vendor/**` o un archivo
  fuera de `src/collections.js`, `tests/collections.test.js` y `knowledge/contracts/collections.md`.
- PARAR y reportar si `python scripts/validate_okf.py knowledge` exigiera editar
  `knowledge/index.md` (otro proceso lo registra): reportar la exigencia, no parchear en silencio.
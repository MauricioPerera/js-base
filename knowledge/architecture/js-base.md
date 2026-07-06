---
type: 'Architecture'
title: 'js-base'
description: 'Qué es js-base, la decisión de vendorizar js-store congelado con manifest, y los 3 límites heredados del vendor.'
tags: ['arquitectura', 'js-base', 'vendor', 'js-store']
---

# js-base

## Qué es

js-base es un **backend estilo PocketBase** (REST + auth + rules + SSE + búsqueda
semántica) construido sobre [js-store](https://github.com/MauricioPerera/js-store),
con **cero dependencias de runtime** y metodología [KDD](../metodologia-ejecucion.md).
El proyecto vive sobre la plantilla KDD: su tooling de validación (contratos, OKF,
specs) es Python y permanece Python; el código del producto es Node ≥18.

La fachada raíz del producto es `src/index.js`, que reexpone el vendor bajo el
namespace `store`. El resto del producto consume la API a través de js-base y no se
acopla directamente a `src/vendor/js-store/`. La API unificada (REST, auth, rules,
SSE, búsqueda semántica) se construye tarea por tarea vía contratos CCDD en
`knowledge/contracts/`.

## Decisión: vendorizar js-store congelado con manifest

js-store v0.1.2 está **vendorizado** en `src/vendor/js-store/` (copia del commit
`642a52c` de `MauricioPerera/js-store`). La razón es de cero-dependencias: un
backend sin `npm install` y reproducible. Para que "vendorizado" sea una
restricción verificable y no una convención, el vendor está **congelado por hash**:

- `docs/vendor-manifest.json` registra el `source` y el `sha256` de **cada**
  archivo bajo `src/vendor/js-store/` (recursivo, incluye el `vendor/` interno,
  `VENDORED.txt` y `LICENSE`).
- `tests/test_vendor_sync.py` recomputa esos hashes y compara contra el manifest:
  falla si un archivo falta, sobra, o difiere. Editar un archivo vendorizado rompe
  CI.
- Regla: los archivos bajo `src/vendor/js-store/` **no se editan jamás**. Una
  actualización de js-store se hace **re-vendoreando** (y regenerando el manifest),
  no parcheando in situ.

## Límites heredados

js-base hereda los límites del vendor js-store v0.1.2. Son tres:

1. **Sin ACID multi-doc en disco.** El modo disco (`SemanticCollection({path, dim})`)
   persiste, pero no garantiza atomicidad transaccional sobre múltiples documentos:
   una escritura interrumpida puede dejar la base en un estado parcial. No asumir
   consistencia transaccional al escribir lotes.

2. **Caveat de RAM en `searchHybrid`.** La búsqueda híbrida (vectorial + BM25) carga
   en memoria estructuras adicionales; en colecciones grandes el consumo de RAM
   puede ser relevante. Dimensionar teniendo eso en cuenta antes de escalar.

3. **Single-process, 1 escritor.** js-store usa un lock de proceso; está pensado para
   un único proceso escritor. No es seguro abrir la misma base en disco desde varios
   procesos que escriban concurrentemente.
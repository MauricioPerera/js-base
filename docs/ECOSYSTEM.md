# Ecosistema — bases de datos embebidas en JavaScript puro, cero dependencias

Una familia de librerías **embebidas**, en **JavaScript puro (CommonJS)** y con **cero dependencias
de runtime**, que se apilan de un core documental/vectorial hasta un backend estilo PocketBase con
búsqueda semántica. Cada capa **vendoriza** (copia congelada por hash) a la de abajo, así que cualquier
componente corre solo, sin `npm install` de dependencias.

```
js-base          Backend estilo PocketBase: REST + auth JWT + reglas + realtime (SSE) + búsqueda semántica
  └── vendoriza js-store
                 Integración doc+vector: SemanticCollection, persistencia en disco, IVF, WAL, transacciones
        ├── vendoriza js-doc-store
                 Core documental: queries tipo Mongo, índices, joins, aggregation, full-text, graph, JWT auth
        └── vendoriza js-vector-store
                 Core vectorial: cuantización, IVF, BM25, búsqueda híbrida
```

## Componentes

| Componente | Rol | Qué provee | Repo |
|---|---|---|---|
| **js-doc-store** | Core documental (1 archivo) | Queries estilo MongoDB, índices (hash/sorted/text), joins, aggregation, full-text search, graph traversal, field encryption, JWT auth. Corre en Node, browser, Cloudflare Workers, Deno, Bun. | [MauricioPerera/js-doc-store](https://github.com/MauricioPerera/js-doc-store) |
| **js-vector-store** | Core vectorial | Almacén de embeddings: cuantización, IVF, BM25, `HybridSearch`, reranking. | [MauricioPerera/js-vector-store](https://github.com/MauricioPerera/js-vector-store) |
| **js-store** | Integración doc+vector | `SemanticCollection` (documento + embedding unificados), búsqueda vectorial e híbrida, persistencia en disco (no depende de RAM), índice IVF, WAL + transacciones, lock 1-escritor. Vendoriza los dos cores. | [MauricioPerera/js-store](https://github.com/MauricioPerera/js-store) |
| **js-base** | Backend (aplicación) | Servidor estilo PocketBase: REST (records/auth/files), reglas de acceso por colección, realtime por SSE, y **búsqueda semántica por HTTP**. Un solo proceso, cero dependencias. Vendoriza js-store. | [MauricioPerera/js-base](https://github.com/MauricioPerera/js-base) |

> El diferenciador de la familia frente a alternativas como PocketBase: **búsqueda semántica nativa**
> (vectorial e híbrida vector + BM25) sin ningún servicio externo, en cualquier runtime de JavaScript.

## ¿Cuál uso?

- **Solo documentos** (queries tipo Mongo, índices, auth, sin vectores) → **js-doc-store**.
- **Solo vectores** (embeddings, similitud, IVF/BM25) → **js-vector-store**.
- **Documentos + embeddings en una colección** (RAG embebido, búsqueda semántica en tu app o agente),
  con persistencia en disco opcional → **js-store**.
- **Un backend listo** con REST, auth, reglas y realtime **más** búsqueda semántica, para apps
  chicas/medianas o agentes → **js-base**.

## Cómo se componen (modelo de vendoring)

Cada capa **copia** a la de abajo dentro de `src/vendor/` y **congela** esa copia por un manifest de
`sha256` verificado en CI (en js-base, `tests/test_vendor_sync.py`). Ventajas:

- **Cero dependencias de runtime**: no hay `npm install` de terceros; el código de las capas
  inferiores viaja en el repo.
- **Reproducibilidad**: la copia vendorizada está fijada a un commit concreto (`// Vendored from …@<sha>`).
- **Aislamiento**: editar un archivo vendorizado rompe el test de sincronía; los fixes van **upstream**
  (en el repo de origen) y se **re-vendorizan** hacia arriba.

## Estado (2026-07-06)

| Componente | Versión | Tests | CI |
|---|---|---|---|
| js-doc-store | v1.2.1 | verde | — |
| js-store | v0.1.9 | 319 verde | success |
| js-base | v0.1.6 | 180 verde | success |

Los tres repos pasaron auditorías externas (21 hallazgos entre las tres, todos fixeados o
documentados según severidad). Detalle completo en el
[reporte de análisis](reports/ANALISIS-2026-07-06.md).

## Stack de agentes (adyacente)

js-doc-store y js-vector-store también son la base de un stack para agentes LLM (comandos shell
sandboxeados): **just-bash-data** (expone `db`/`vec` como comandos) y **just-bash-wiki** (wiki
persistente mantenida por LLMs). Ver la sección *Ecosistema* del
[README de js-doc-store](https://github.com/MauricioPerera/js-doc-store#readme).

## Licencia

Todos los componentes son **MIT** © Mauricio Perera.

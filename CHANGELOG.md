# Changelog

Todas las versiones notables de **js-base**. Formato basado en
[Keep a Changelog](https://keepachangelog.com/); versionado [SemVer](https://semver.org/).

## [0.1.0] — 2026-07-06

Primer MVP: backend embebido estilo PocketBase con búsqueda semántica nativa, en
JavaScript puro (CommonJS) y **cero dependencias de runtime**, sobre
[js-store](https://github.com/MauricioPerera/js-store) v0.1.3 vendorizado y congelado.
Construido por batches, cada pieza con contrato KDD + tests congelados. **175 tests JS
verdes (incluye e2e de integración y harness adversarial de crash-injection).**

### Núcleo HTTP
- `createApp({ rules, events })`: router por segmentos (`:param`), pipeline CORS →
  JSON (límite 1 MiB) → match → contexto, mapeo de errores tipados a status HTTP, `500`
  opaco (no filtra internals). Hooks `rules`/`events` inyectables.

### REST
- **Records (CRUD)**: `GET/POST /api/collections/:col/records`,
  `GET/PATCH/DELETE /api/collections/:col/records/:id` — paginación, filtros tipo Mongo,
  validación de schema, reglas y eventos por operación.
- **Auth**: `register` / `login` / `logout` / `me` / `change-password` (PBKDF2 + JWT +
  sesiones persistidas; delega en el `Auth` de js-doc-store). Nunca expone el hash.
- **Files**: `POST/GET/DELETE /api/files/:name` — subida raw en streaming con escritura
  atómica (temp + fsync + rename), sidecar de metadata y sanitización anti path-traversal.

### Reglas de acceso
- Motor de reglas por colección/operación evaluado con `matchFilter` sobre
  `{ auth, record, request }`. **Deny por defecto**; `null` = pública;
  `{ "auth.id": { "$exists": true } }` exige login (`$ne: null` fallaba abierto — evitado).

### Realtime
- `GET /api/realtime/:collection` (SSE): fanout de eventos `create`/`update`/`delete` por
  colección (con comodín), sin timers colgados.

### Búsqueda semántica (el diferenciador)
- `POST /api/collections/:col/vectors` (upsert de vector), `/search` (vectorial),
  `/search/hybrid` (vector + BM25), `DELETE .../vectors/:id`, `POST .../reindex` (IVF).

### Integración y operación
- `createServer({ dataDir, secret })` ensambla todo sobre un `AtomicFileStorageAdapter`
  (colecciones de sistema durables ante crash). CLI `bin/js-base` (`npm start`): arranca
  con `SECRET` obligatorio, apagado limpio en SIGINT/SIGTERM.

### Durabilidad (verificada adversarialmente)
- Harness de crash-injection (SIGKILL real) sobre la escritura atómica, el modo disco de
  `SemanticCollection`, el lock de 1 escritor y fuzz de auth/reglas. Encontró un bug real
  de durabilidad en `DiskKV` (registro torn intolerante al reabrir), **arreglado upstream
  en js-store v0.1.3** y re-vendorizado; el test queda como guardián de regresión.

### Metodología
- KDD (OKF + CCDD): contratos con tests congelados en `knowledge/contracts/`, validadores
  deterministas, CI en GitHub Actions (Python + Node). Vendor congelado por manifest sha256.

### Límites conocidos
- Un solo proceso (1 escritor + N lectores); sin multi-escritor ni cluster.
- Sin ACID multi-documento en disco (transacciones solo en modo memoria — heredado).
- `searchHybrid` materializa documentos en RAM en modo disco (caveat heredado).
- Sin admin UI ni OAuth2; colección `_files` tratada como pública en el MVP; schema de
  colecciones vía `CollectionRegistry` (sin API de administración por HTTP).

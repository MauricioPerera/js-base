# Changelog

Todas las versiones notables de **js-base**. Formato basado en
[Keep a Changelog](https://keepachangelog.com/); versionado [SemVer](https://semver.org/).

## [0.1.3] — 2026-07-06

### Performance
- **Re-vendorizado js-store v0.1.5**: la carga masiva en modo disco pasa de O(N²) a O(N)
  (fast-path de clave primaria en `DiskCollection.remove`, que `upsert` invoca por registro).
  Medido: upsert a 10k docs de ~60 a ~675 docs/s (plano, ya no colapsa). Beneficia
  directamente al upsert de vectores por HTTP de js-base. Manifest sha256 regenerado.

## [0.1.2] — 2026-07-06

### Security
- **Re-vendorizado js-store v0.1.4** (que a su vez re-vendoriza js-doc-store v1.2.1):
  la comparación del hash de password en `Auth._verifyPassword` ahora es de tiempo
  constante (antes `===` con early-exit sobre el hash base64 → canal de timing débil).
  Best-practice de la superficie de auth; hallazgo de la auditoría externa. Manifest
  sha256 del vendor regenerado.

## [0.1.1] — 2026-07-06

### Security
- **Files: escritura y borrado ahora exigen autenticación.** `POST`/`DELETE`
  `/api/files/:name` requieren un usuario autenticado; la lectura (`GET`) sigue pública. El glue de integración trataba la colección de sistema
  `_files` como pública para toda operación (`{ allow: true }`), lo que permitía subir
  (hasta 10 MiB) y borrar blobs de forma anónima — un DoS de disco y hosting de contenido
  arbitrario. Ahora el policy es `allow: ctx.auth != null` para `_files`. Hallazgo de una
  auditoría externa; test de regresión congelado en `tests/files-auth.test.js`.

### Docs
- **Límites conocidos** ampliados con dos ítems que faltaban: ausencia de rate limiting /
  protección de fuerza bruta en `/api/auth/login`, y crecimiento sin límite de `_sessions`
  (la verificación de token es stateless; las sesiones expiradas no se purgan solas).

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

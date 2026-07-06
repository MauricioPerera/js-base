'use strict';

// src/app.js — módulo de INTEGRACIÓN de js-base.
// Ensambla TODAS las piezas de los batches previos en un server real arrancable,
// sin reimplementar nada: solo cablea constructores y registra rutas.
//
// Contract: knowledge/contracts/app-integration.md
//
// Cero dependencias de runtime nuevas: solo node:path y los módulos del repo.

const path = require('node:path');
const fs = require('node:fs');

const { DocStore } = require('./vendor/js-store/vendor/js-doc-store.js');
const { AtomicFileStorageAdapter } = require('./atomic-file-adapter.js');
const { CollectionRegistry } = require('./collections.js');
const { createAuthService } = require('./auth-service.js');
const { makeStores } = require('./store-provider.js');
const { makeSemanticStores } = require('./semantic-provider.js');
const { makeRules } = require('./rules-engine.js');
const { makeRealtime } = require('./realtime.js');
const { createApp } = require('./server.js');
const { registerRecordRoutes } = require('./records.js');
const { registerAuthRoutes } = require('./auth-routes.js');
const { registerFileRoutes } = require('./files.js');
const { registerSemanticRoutes } = require('./semantic-routes.js');

/**
 * Ensambla un server js-base completo sobre un dataDir real (filesystem atómico).
 *
 * @param {object} opts
 * @param {string} opts.dataDir   Directorio raíz de datos (requerido). Crea
 *                                <dataDir>/system (DocStore) y <dataDir>/semantic
 *                                (SemanticCollection disco) y <dataDir>/files
 *                                (blobs) si no se pasa filesDir.
 * @param {string} opts.secret    Secret de firma JWT (string >= 16 chars, requerido).
 * @param {string} [opts.filesDir] Directorio de blobs (default <dataDir>/files).
 * @returns {Promise<object>} { app, db, registry, auth, stores, semanticStores,
 *                              realtime, rules, listen(port), close() }
 */
async function createServer({ dataDir, secret, filesDir } = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createServer: dataDir es requerido (string)');
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createServer: secret debe ser string de >= 16 chars');
  }

  // (1) Núcleo de persistencia: DocStore sobre adapter atómico en <dataDir>/system.
  // El adapter crea el dir si falta. _users, _sessions y _collections viven acá
  // (mismo DocStore => mismas instancias de Collection => estado compartido).
  const systemDir = path.join(dataDir, 'system');
  const db = new DocStore(new AtomicFileStorageAdapter(systemDir));

  // (2) Registro de colecciones (persiste configs en _collections del mismo db).
  const registry = new CollectionRegistry(db);

  // (3) Auth service (inicializa _users/_sessions + índices del vendor).
  const auth = await createAuthService({ db, secret });

  // (4) Stores documentales y semánticos.
  const stores = makeStores(db);
  // makeSemanticStores NO crea el baseDir (es responsabilidad del caller); el
  // SemanticCollection en modo disco tampoco. Lo creamos acá para que el primer
  // upsert/search no falle con ENOENT. (registerFileRoutes crea su propio dir.)
  const semanticDir = path.join(dataDir, 'semantic');
  fs.mkdirSync(semanticDir, { recursive: true });
  const semanticStores = makeSemanticStores({
    registry,
    baseDir: semanticDir,
  });

  // (5) Rules + realtime, inyectados al nucleo via createApp.
  //
  // TRADE-OFF (reservado '_files'): files.js evalúa rules contra la colección
  // '_files' (POST/DELETE), pero makeRules(registry) deniega por defecto toda
  // colección NO registrada, y '_files' NO se puede registrar (collections.js
  // prohíbe nombres con '_' inicial via NAME_REGEX). Sin adaptación, todo
  // upload/delete de files quedaría 403 y el server no serviría blobs.
  // El integration layer compone un rules que delega al rules-engine real para
  // las colecciones de usuario y trata '_files' (reservada, sistema) como
  // PÚBLICA — consistente con el MVP de files (lectura pública; POST/DELETE
  // permitivos, igual que defaultRules en tests/files.test.js). No parchea
  // otros batches: es policy de ensamblaje en este glue. Una tarea futura puede
  // registrar una policy real para blobs cuando el registry soporte reservadas.
  const baseRules = makeRules(registry);
  const rules = {
    async check(ctx) {
      if (ctx && ctx.collection === '_files') return { allow: true };
      return baseRules.check(ctx);
    },
  };
  const realtime = makeRealtime();
  const app = createApp({ rules, events: realtime.events });

  // (6) authResolver: async (token|null) -> user|null.
  // El vendor Auth.verify devuelve el PAYLOAD JWT ({ sub, email, roles, iat, exp }).
  // La convención canónica de rules (ver rules-engine.md) y files.js (uploadedBy)
  // usan `auth.id`, no `auth.sub`. El glue mapea id = sub para que la regla
  // canónica "exigir login" { "auth.id": { $exists: true } } funcione con tokens
  // reales. Token ausente o inválido -> null (deny). Ver trade-off en el contrato.
  const authResolver = async (token) => {
    if (!token) return null;
    try {
      const payload = await auth.verify(token);
      if (!payload) return null;
      return { ...payload, id: payload.sub };
    } catch {
      return null;
    }
  };

  // (7) Registro de TODAS las rutas sobre el mismo app.
  registerRecordRoutes(app, { registry, stores, authResolver });
  registerAuthRoutes(app, { auth });
  registerFileRoutes(app, { dir: filesDir || path.join(dataDir, 'files'), authResolver });
  registerSemanticRoutes(app, { registry, semanticStores, authResolver });
  realtime.register(app);

  return {
    app,
    db,
    registry,
    auth,
    stores,
    semanticStores,
    realtime,
    rules,
    // listen(port) delega en app.listen (port=0 => efímero).
    listen(port) {
      return app.listen(port);
    },
    // close() cierra el server HTTP + los stores semánticos (locks de disco).
    // NOTA: NO llama db.flush() — ver trade-off "persistencia" en el contrato.
    async close() {
      await app.close();
      semanticStores.closeAll();
    },
  };
}

module.exports = { createServer };
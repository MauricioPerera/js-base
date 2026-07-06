'use strict';

// src/semantic-routes.js — rutas de busqueda semantica sobre el nucleo HTTP.
// registerSemanticRoutes(app, { registry, semanticStores, authResolver }) registra
// /api/collections/:col/vectors, .../search, .../search/hybrid, .../reindex y
// DELETE .../vectors/:id. rules se toma del app inyectado (createApp({ rules, events }));
// authResolver es async (token|null) -> user|null INYECTADO (fake en tests).
//
// Carril PARALELO al CRUD documental: NO toca records. Solo aplica a colecciones con
// vector.dim (semanticStores.get(col) non-null); el resto -> 404.
//
// Contract: knowledge/contracts/semantic-routes.md

const crypto = require('node:crypto');

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

/** Construye un Error tipado (.code mapea a HTTP en server.js). */
function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** request: { method, path, query } para el ctx de rules (contrato de hooks). */
function requestOf(ctx) {
  return { method: ctx.req.method, path: ctx.req.url, query: ctx.query };
}

/** Valida que `vector` sea un Array de numeros finitos de longitud exacta `dim`. */
function validateVector(vector, dim) {
  if (!Array.isArray(vector) || vector.length !== dim) {
    throw err('VALIDATION', `vector debe ser un Array de longitud ${dim} con numeros finitos`);
  }
  for (let i = 0; i < vector.length; i++) {
    const el = vector[i];
    if (typeof el !== 'number' || !Number.isFinite(el)) {
      throw err('VALIDATION', `vector debe ser un Array de longitud ${dim} con numeros finitos`);
    }
  }
}

/** Sanea limit: default 10, clamp a [1, 100]. */
function sanitizeLimit(raw) {
  let limit = raw;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    limit = DEFAULT_SEARCH_LIMIT;
  }
  limit = Math.floor(limit);
  if (limit < 1) limit = 1;
  if (limit > MAX_SEARCH_LIMIT) limit = MAX_SEARCH_LIMIT;
  return limit;
}

/** Valida que `filter` (si viene) sea un objeto Mongo plano (no null/array). */
function validateFilter(filter) {
  if (filter === undefined || filter === null) return null;
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw err('VALIDATION', 'filter debe ser un objeto (filtro tipo Mongo)');
  }
  return filter;
}

/** Autoriza la op contra app.rules.check; lanza FORBIDDEN si !allow. */
async function authorize(app, ctx, op, collection, auth, record) {
  const verdict = await app.rules.check({
    op,
    collection,
    auth,
    record,
    request: requestOf(ctx),
  });
  if (!verdict || !verdict.allow) throw err('FORBIDDEN', `op "${op}" denegada`);
}

function registerSemanticRoutes(app, { registry, semanticStores, authResolver }) {
  if (!app || typeof app.route !== 'function') {
    throw new Error('registerSemanticRoutes requiere un app');
  }
  if (!registry || typeof registry.get !== 'function') {
    throw new Error('registerSemanticRoutes requiere un registry');
  }
  if (!semanticStores || typeof semanticStores.get !== 'function') {
    throw new Error('registerSemanticRoutes requiere semanticStores');
  }
  if (typeof authResolver !== 'function') {
    throw new Error('registerSemanticRoutes requiere un authResolver');
  }

  // Resuelve el store semantico o lanza NOT_FOUND. Devuelve { store, dim }.
  function resolveStore(col) {
    const store = semanticStores.get(col);
    if (!store) throw err('NOT_FOUND', `coleccion semantica "${col}" no existe o sin vector.dim`);
    const config = registry.get(col);
    const dim = config.vector.dim;
    return { store, dim };
  }

  // --- POST /api/collections/:col/vectors (create) ------------------------
  app.route('POST', '/api/collections/:col/vectors', async (ctx) => {
    const col = ctx.params.col;
    const { store, dim } = resolveStore(col);

    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? ctx.body : {};
    const doc = body.doc;
    const vector = body.vector;
    const id = body.id != null ? String(body.id) : crypto.randomUUID();

    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw err('VALIDATION', 'doc debe ser un objeto plano (no null, no array)');
    }
    validateVector(vector, dim);

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'create', col, auth, { id, doc, vector });

    store.upsert(id, doc, vector);
    ctx.status = 201;
    return { id };
  });

  // --- POST /api/collections/:col/search (list) ---------------------------
  app.route('POST', '/api/collections/:col/search', async (ctx) => {
    const col = ctx.params.col;
    const { store, dim } = resolveStore(col);

    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? ctx.body : {};
    validateVector(body.vector, dim);
    const limit = sanitizeLimit(body.limit);
    const filter = validateFilter(body.filter);

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'list', col, auth, null);

    const items = store.search(body.vector, { limit, filter });
    return { items };
  });

  // --- POST /api/collections/:col/search/hybrid (list) --------------------
  app.route('POST', '/api/collections/:col/search/hybrid', async (ctx) => {
    const col = ctx.params.col;
    const { store, dim } = resolveStore(col);

    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? ctx.body : {};
    validateVector(body.vector, dim);
    if (typeof body.query !== 'string' || body.query.length === 0) {
      throw err('VALIDATION', 'query debe ser un string no vacio');
    }
    const limit = sanitizeLimit(body.limit);
    const textField = typeof body.textField === 'string' && body.textField.length > 0
      ? body.textField : 'text';
    const filter = validateFilter(body.filter);

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'list', col, auth, null);

    // Caveat heredado: searchHybrid construye un BM25Index en RAM por query (rebuild-at-query).
    // En modo disco con datasets grandes esto puede ser costoso en memoria; es un limite
    // conocido del vendor, no se pelea aqui. Ver contrato semantic-routes.md.
    const items = store.searchHybrid(body.vector, body.query, { limit, textField, filter });
    return { items };
  });

  // --- DELETE /api/collections/:col/vectors/:id (delete) ------------------
  // El vendor SemanticCollection.delete(id) devuelve boolean: true si el doc existia
  // (remove > 0), false si no. Mapeamos false -> NOT_FOUND.
  app.route('DELETE', '/api/collections/:col/vectors/:id', async (ctx) => {
    const col = ctx.params.col;
    const { store } = resolveStore(col);
    const id = ctx.params.id;

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'delete', col, auth, { id });

    const removed = store.delete(id);
    if (!removed) throw err('NOT_FOUND', `vector "${id}" no existe`);
    return { ok: true };
  });

  // --- POST /api/collections/:col/reindex (update, admin) -----------------
  // reindex es op de ESCRITOR en modo DISCO: construye un IVF sobre el archivo de
  // vectores y lo activa para search. En modo memoria/inyexion el vendor lanza
  // ("reindex: solo en modo disco") -> 500 INTERNAL. Costo: O(n kmeans); pesado en
  // datasets grandes. No expone ensureIndex por HTTP en el MVP (admin interno).
  app.route('POST', '/api/collections/:col/reindex', async (ctx) => {
    const col = ctx.params.col;
    const { store } = resolveStore(col);

    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? ctx.body : {};
    const nClusters = body.nClusters != null ? body.nClusters : undefined;
    const nProbe = body.nProbe != null ? body.nProbe : undefined;

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'update', col, auth, null);

    store.reindex(nClusters, nProbe);
    return { ok: true };
  });

  return app;
}

module.exports = { registerSemanticRoutes };
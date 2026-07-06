'use strict';

// src/records.js — rutas CRUD de records estilo PocketBase sobre el nucleo HTTP.
// registerRecordRoutes(app, { registry, stores, authResolver }) registra las rutas
// /api/collections/:col/records[/:id]. rules y events se toman del app inyectado
// (createApp({ rules, events })); authResolver es async (token|null) -> user|null
// INYECTADO (otro batch cablea el real contra auth-service).
//
// Contract: knowledge/contracts/records.md

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 200;

/** Construye un Error tipado (.code mapea a HTTP en server.js). */
function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** request: { method, path, query } para el ctx de rules (contrato de hooks). */
function requestOf(ctx) {
  return {
    method: ctx.req.method,
    path: ctx.req.url,
    query: ctx.query,
  };
}

/** Valida y normaliza page/perPage; clamp a [1, MAX_PER_PAGE]. */
function parsePaging(query) {
  let page = Number(query.page);
  page = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;

  let perPage = Number(query.perPage);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
  perPage = Math.min(Math.floor(perPage), MAX_PER_PAGE);

  return { page, perPage };
}

/** Parsea el filtro Mongo URL-encodeado del query string. 400 VALIDATION si no parsea. */
function parseFilter(query) {
  const raw = query.filter;
  if (raw === undefined || raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw err('VALIDATION', 'filter debe ser JSON valido');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw err('VALIDATION', 'filter debe ser un objeto');
  }
  return parsed;
}

/**
 * Autoriza la op contra app.rules.check con el shape del contrato de hooks.
 * Lanza FORBIDDEN si !allow.
 */
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

function registerRecordRoutes(app, { registry, stores, authResolver }) {
  if (!app || typeof app.route !== 'function') {
    throw new Error('registerRecordRoutes requiere un app');
  }
  if (!registry || typeof registry.get !== 'function' || typeof registry.validateDoc !== 'function') {
    throw new Error('registerRecordRoutes requiere un registry');
  }
  if (!stores || typeof stores.get !== 'function') {
    throw new Error('registerRecordRoutes requiere stores');
  }
  if (typeof authResolver !== 'function') {
    throw new Error('registerRecordRoutes requiere un authResolver');
  }

  // --- GET /api/collections/:col/records (list) ---------------------------
  app.route('GET', '/api/collections/:col/records', async (ctx) => {
    const col = ctx.params.col;
    if (!registry.get(col)) throw err('NOT_FOUND', `coleccion "${col}" no existe`);

    const filter = parseFilter(ctx.query);
    const { page, perPage } = parsePaging(ctx.query);

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'list', col, auth, null);

    const store = stores.get(col);
    const totalItems = store.count(filter);
    const all = store.find(filter);
    const offset = (page - 1) * perPage;
    const items = all.slice(offset, offset + perPage);

    return { page, perPage, totalItems, items };
  });

  // --- GET /api/collections/:col/records/:id (view) -----------------------
  app.route('GET', '/api/collections/:col/records/:id', async (ctx) => {
    const col = ctx.params.col;
    if (!registry.get(col)) throw err('NOT_FOUND', `coleccion "${col}" no existe`);

    const store = stores.get(col);
    const doc = store.get(ctx.params.id);
    if (!doc) throw err('NOT_FOUND', `record "${ctx.params.id}" no existe`);

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'view', col, auth, doc);

    return doc;
  });

  // --- POST /api/collections/:col/records (create) -----------------------
  app.route('POST', '/api/collections/:col/records', async (ctx) => {
    const col = ctx.params.col;
    if (!registry.get(col)) throw err('NOT_FOUND', `coleccion "${col}" no existe`);

    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? ctx.body : {};
    const { _id, ...rest } = body;     // _id opcional; el store lo asigna
    const id = _id != null ? _id : null;

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'create', col, auth, rest);

    const { ok, errors } = registry.validateDoc(col, rest);
    if (!ok) throw err('VALIDATION', errors.join('; '));

    const store = stores.get(col);
    const created = store.insert(id, rest);
    ctx.status = 201;
    app.events.emit({ collection: col, op: 'create', record: created });
    return created;
  });

  // --- PATCH /api/collections/:col/records/:id (update) -------------------
  app.route('PATCH', '/api/collections/:col/records/:id', async (ctx) => {
    const col = ctx.params.col;
    if (!registry.get(col)) throw err('NOT_FOUND', `coleccion "${col}" no existe`);

    const store = stores.get(col);
    const existing = store.get(ctx.params.id);
    if (!existing) throw err('NOT_FOUND', `record "${ctx.params.id}" no existe`);

    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? ctx.body : {};
    // Merge superficial; _id inmutable (se ignora body._id).
    const merged = { ...existing, ...body, _id: existing._id };

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'update', col, auth, merged);

    const { ok, errors } = registry.validateDoc(col, merged);
    if (!ok) throw err('VALIDATION', errors.join('; '));

    const updated = store.update(ctx.params.id, merged);
    app.events.emit({ collection: col, op: 'update', record: updated });
    return updated;
  });

  // --- DELETE /api/collections/:col/records/:id (delete) -----------------
  app.route('DELETE', '/api/collections/:col/records/:id', async (ctx) => {
    const col = ctx.params.col;
    if (!registry.get(col)) throw err('NOT_FOUND', `coleccion "${col}" no existe`);

    const store = stores.get(col);
    const existing = store.get(ctx.params.id);
    if (!existing) throw err('NOT_FOUND', `record "${ctx.params.id}" no existe`);

    const auth = await authResolver(ctx.token);
    await authorize(app, ctx, 'delete', col, auth, existing);

    const removed = store.remove(ctx.params.id);
    if (!removed) throw err('NOT_FOUND', `record "${ctx.params.id}" no existe`);

    app.events.emit({ collection: col, op: 'delete', record: existing });
    return { ok: true };
  });

  return app;
}

module.exports = { registerRecordRoutes };
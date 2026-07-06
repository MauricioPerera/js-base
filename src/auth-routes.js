'use strict';

// src/auth-routes.js — registro de endpoints de auth sobre el nucleo HTTP.
// Delega TODA la logica de auth en el service (src/auth-service.js).
// Este modulo NO hace crypto/JWT/sesiones: solo valida shape del body
// (lanza VALIDATION antes de llamar al service), setea ctx.status, arma
// las respuestas y garantiza que campos sensibles (passwordHash/password)
// no viajen en el JSON. Ver contrato: knowledge/contracts/auth-routes.md

// Error tipado con .code para que el nucleo (src/server.js) lo mapee a status.
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validationError(message) {
  return codedError('VALIDATION', message);
}

// Exige que body sea objeto y que cada key de `keys` este presente y sea
// string no vacio. Lanza VALIDATION antes de tocar el service.
function requireStringFields(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('body requerido');
  }
  for (const k of keys) {
    const v = body[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw validationError(`campo requerido faltante o invalido: ${k}`);
    }
  }
}

// Defense-in-depth: el service ya descarta passwordHash, pero re-verificamos
// que ningun campo sensible viaje al cliente. No es logica de auth: es
// sanitizacion de la respuesta.
function sanitizeUser(user) {
  if (!user || typeof user !== 'object') return user;
  const safe = { ...user };
  delete safe.passwordHash;
  delete safe.password;
  return safe;
}

/**
 * Registra las rutas de auth sobre un `app` del nucleo HTTP.
 * @param {object} app   app creado por createApp() (src/server.js)
 * @param {object} opts
 * @param {object} opts.auth  service ya creado por createAuthService()
 * @returns {object} app (chainable)
 */
function registerAuthRoutes(app, { auth } = {}) {
  if (!app || typeof app.route !== 'function') {
    throw new Error('registerAuthRoutes: app del nucleo HTTP requerido');
  }
  if (!auth) {
    throw new Error('registerAuthRoutes: auth service requerido');
  }

  // POST /api/auth/register — body {email,password,profile?} -> 201 { user }
  app.route('POST', '/api/auth/register', async (ctx) => {
    requireStringFields(ctx.body, ['email', 'password']);
    const profile = ctx.body.profile;
    if (
      profile !== undefined &&
      (typeof profile !== 'object' || profile === null || Array.isArray(profile))
    ) {
      throw validationError('profile debe ser objeto si se provee');
    }
    const user = await auth.register(ctx.body.email, ctx.body.password, profile);
    ctx.status = 201;
    return { user: sanitizeUser(user) };
  });

  // POST /api/auth/login — body {email,password} -> { token, user }
  app.route('POST', '/api/auth/login', async (ctx) => {
    requireStringFields(ctx.body, ['email', 'password']);
    const result = await auth.login(ctx.body.email, ctx.body.password);
    return { token: result.token, user: sanitizeUser(result.user) };
  });

  // POST /api/auth/logout — requiere ctx.token -> { ok: true }
  // auth.logout no valida el token (remove sobre {token} no lanza si no existe),
  // por eso exigimos ctx.token aca: null -> INVALID_TOKEN (401).
  app.route('POST', '/api/auth/logout', async (ctx) => {
    if (!ctx.token) throw codedError('INVALID_TOKEN', 'Invalid or expired token');
    await auth.logout(ctx.token);
    return { ok: true };
  });

  // GET /api/auth/me — verifica ctx.token -> { user }
  // auth.verify lanza INVALID_TOKEN si token es null/invalido/expirado: burbujea.
  app.route('GET', '/api/auth/me', async (ctx) => {
    const payload = await auth.verify(ctx.token);
    return { user: sanitizeUser(payload) };
  });

  // POST /api/auth/change-password — requiere token valido (verify primero),
  // body {oldPassword,newPassword} -> { ok: true }
  app.route('POST', '/api/auth/change-password', async (ctx) => {
    const payload = await auth.verify(ctx.token);
    requireStringFields(ctx.body, ['oldPassword', 'newPassword']);
    await auth.changePassword(payload.sub, ctx.body.oldPassword, ctx.body.newPassword);
    return { ok: true };
  });

  return app;
}

module.exports = { registerAuthRoutes };
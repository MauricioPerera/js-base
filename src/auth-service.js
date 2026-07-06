'use strict';

// auth-service.js — wrapper FINO del Auth del vendor para js-base.
// NO reimplementa crypto/JWT/sesiones: delega TODO en el vendor
// (src/vendor/js-store/vendor/js-doc-store.js, class Auth).
// Mapea los errores esperables del vendor a un enum estable de .code
// para el futuro mapeo HTTP. Ver contrato:
// knowledge/contracts/auth-service.md

const { Auth } = require('./vendor/js-store/vendor/js-doc-store.js');

// Enum estable de codes (contrato de errores). Mapeo HTTP futuro.
const CODE = Object.freeze({
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
});

// Construye un Error con .code preservando el mensaje original del vendor.
function authError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// Mapea un Error lanzado por el vendor al code correspondiente.
// Reglas basadas en los mensajes que emite la class Auth del vendor
// (ver seccion ## Invariants del contrato para la tabla completa).
function mapVendorError(err) {
  if (!err || typeof err.message !== 'string') {
    throw err; // no es un Error esperable: propagar tal cual
  }
  const m = err.message;

  // Email duplicado (unique index del vendor sobre _users.email).
  if (m.startsWith('Unique constraint violated')) return authError(CODE.EMAIL_TAKEN, m, err);

  // Credenciales invalidas: login con password incorrecto o usuario inexistente,
  // y cambio de password con oldPassword incorrecto.
  if (m === 'Invalid credentials' || m === 'Invalid current password') {
    return authError(CODE.INVALID_CREDENTIALS, m, err);
  }

  // Cuenta deshabilitada en login -> 403.
  if (m === 'Account disabled') return authError(CODE.FORBIDDEN, m, err);

  // Usuario no encontrado (changePassword / assignRole).
  if (m === 'User not found') return authError(CODE.NOT_FOUND, m, err);

  // Politica de password (register / changePassword). El vendor emite
  // mensajes que empiezan con "Password must ...".
  if (m.startsWith('Password must')) return authError(CODE.WEAK_PASSWORD, m, err);

  // Resto (p. ej. "Email and password required", "Invalid email format"):
  // errores de validacion de input sin code propio en el enum. Se propagan
  // tal cual (Error plano sin .code). Documentado en el contrato.
  throw err;
}

// Ejecuta una operacion del vendor que Lanza, mapeando el resultado.
async function callThrowing(fn) {
  try {
    return await fn();
  } catch (err) {
    throw mapVendorError(err);
  }
}

/**
 * Crea un auth service sobre un DocStore ya construido.
 * @param {object} opts
 * @param {object} opts.db       DocStore requerido (ya instanciado).
 * @param {string} opts.secret   Secret de firma JWT (string >= 16 chars).
 * @returns {Promise<object>}   service listo para usar (init() ya hecho).
 */
async function createAuthService({ db, secret } = {}) {
  if (!db) {
    throw new Error('createAuthService: db es requerido (DocStore)');
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createAuthService: secret debe ser string de >= 16 chars');
  }

  const auth = new Auth(db, { secret });
  await auth.init();

  // ── API del service ──────────────────────────────────────
  return {
    async register(email, password, profile) {
      return callThrowing(() => auth.register(email, password, profile));
    },

    async login(email, password) {
      return callThrowing(() => auth.login(email, password));
    },

    // verify: el vendor devuelve null si el token es invalido/expirado o su
    // sesion ya no existe. El wrapper lo convierte en un Error con code
    // INVALID_TOKEN para que la capa HTTP lo mapee a 401.
    async verify(token) {
      if (typeof token !== 'string' || token.length === 0) {
        throw authError(CODE.INVALID_TOKEN, 'Invalid or expired token');
      }
      const payload = await auth.verify(token);
      if (!payload) throw authError(CODE.INVALID_TOKEN, 'Invalid or expired token');
      return payload;
    },

    // logout: delega en el vendor (remove de la sesion). No lanza si el token
    // ya no existe; remove devuelve 0 en ese caso. Retorna el count removido.
    async logout(token) {
      return auth.logout(token);
    },

    // logoutAll: invalida todas las sesiones de un usuario. No lanza si no
    // hay sesiones. Retorna el count removido.
    async logoutAll(userId) {
      return auth.logoutAll(userId);
    },

    async changePassword(userId, oldPassword, newPassword) {
      return callThrowing(() => auth.changePassword(userId, oldPassword, newPassword));
    },

    // assignRole: lanza NOT_FOUND si el usuario no existe.
    async assignRole(userId, role) {
      return callThrowing(() => auth.assignRole(userId, role));
    },

    // hasRole: devuelve booleano (false si el usuario no existe). No lanza.
    async hasRole(userId, role) {
      return auth.hasRole(userId, role);
    },

    // authorize: verifica token Y rol. Distingue INVALID_TOKEN (token malo)
    // de FORBIDDEN (token valido pero rol faltante) para mapear 401 vs 403.
    async authorize(token, requiredRole) {
      if (typeof token !== 'string' || token.length === 0) {
        throw authError(CODE.INVALID_TOKEN, 'Invalid or expired token');
      }
      const payload = await auth.verify(token);
      if (!payload) throw authError(CODE.INVALID_TOKEN, 'Invalid or expired token');
      if (requiredRole && !Array.isArray(payload.roles)) {
        throw authError(CODE.FORBIDDEN, 'Missing required role');
      }
      if (requiredRole && !payload.roles.includes(requiredRole)) {
        throw authError(CODE.FORBIDDEN, 'Missing required role: ' + requiredRole);
      }
      return payload;
    },
  };
}

module.exports = { createAuthService, CODE };
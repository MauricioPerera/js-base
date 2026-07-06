'use strict';

// tests/auth-service.test.js — tests congelados del auth-service.
// Usa DocStore + MemoryStorageAdapter del vendor (NO mocks de crypto/JWT).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DocStore, MemoryStorageAdapter } = require('../src/vendor/js-store/vendor/js-doc-store.js');
const { createAuthService, CODE } = require('../src/auth-service.js');

const SECRET = 'supersecret-key-0123456789-abcdef'; // >= 16 chars
const SHORT_SECRET = 'short'; // < 16 chars

function makeDb() {
  return new DocStore(new MemoryStorageAdapter());
}

function isCode(err, code) {
  return err && err.code === code;
}

async function rejectsCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `esperaba code ${code}, vino ${err && err.code} (msg: ${err && err.message})`);
    return err;
  }
  assert.fail(`esperaba que rechazara con code ${code}, pero resolvio`);
}

describe('createAuthService — validacion de construccion', () => {
  test('lanza si falta db (Error plano, sin .code)', async () => {
    let threw = false;
    try { await createAuthService({ secret: SECRET }); } catch (e) {
      threw = true;
      assert.ok(/db/i.test(e.message));
      assert.equal(e.code, undefined, 'error de programacion: sin .code');
    }
    assert.ok(threw, 'debio lanzar por falta de db');
  });

  test('lanza si secret es < 16 chars', async () => {
    const db = makeDb();
    let threw = false;
    try { await createAuthService({ db, secret: SHORT_SECRET }); } catch (e) {
      threw = true;
      assert.ok(/16/.test(e.message));
    }
    assert.ok(threw, 'debio lanzar por secret corto');
  });

  test('lanza si secret no es string', async () => {
    const db = makeDb();
    let threw = false;
    try { await createAuthService({ db, secret: 1234567890123456 }); } catch (e) { threw = true; }
    assert.ok(threw);
  });
});

describe('register + login + verify — happy path', () => {
  test('register devuelve user sin passwordHash; login emite token; verify devuelve payload', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });

    const user = await svc.register('alice@example.com', 'password123', { name: 'Alice' });
    assert.ok(user._id, 'user debe tener _id');
    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.name, 'Alice');
    assert.equal(user.passwordHash, undefined, 'no debe exponer passwordHash');
    assert.deepEqual(user.roles, ['user']);

    const { token, user: loginUser } = await svc.login('alice@example.com', 'password123');
    assert.equal(typeof token, 'string');
    assert.ok(token.split('.').length === 3, 'token con 3 partes JWT');
    assert.equal(loginUser.email, 'alice@example.com');

    const payload = await svc.verify(token);
    assert.ok(payload, 'verify debe devolver el payload');
    assert.equal(payload.sub, user._id);
    assert.equal(payload.email, 'alice@example.com');
    assert.deepEqual(payload.roles, ['user']);
    assert.ok(payload.exp > payload.iat);
  });
});

describe('login — password incorrecto', () => {
  test('INVALID_CREDENTIALS', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await svc.register('bob@example.com', 'password123');
    const err = await rejectsCode(svc.login('bob@example.com', 'WRONG-password'), CODE.INVALID_CREDENTIALS);
    assert.ok(/Invalid credentials/.test(err.message), 'preserva mensaje del vendor');
  });

  test('INVALID_CREDENTIALS si el usuario no existe', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.login('nobody@example.com', 'password123'), CODE.INVALID_CREDENTIALS);
  });
});

describe('register — duplicado', () => {
  test('EMAIL_TAKEN', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await svc.register('dup@example.com', 'password123');
    const err = await rejectsCode(svc.register('dup@example.com', 'password123'), CODE.EMAIL_TAKEN);
    assert.ok(/Unique constraint/.test(err.message));
  });
});

describe('verify — token invalido/basura', () => {
  test('basura -> INVALID_TOKEN', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.verify('garbage.token.here'), CODE.INVALID_TOKEN);
  });

  test('token de otro secret -> INVALID_TOKEN', async () => {
    const db = makeDb();
    const svcA = await createAuthService({ db, secret: SECRET });
    const svcB = await createAuthService({ db, secret: 'other-secret-0123456789-xyz' });
    await svcA.register('x@example.com', 'password123');
    const { token } = await svcA.login('x@example.com', 'password123');
    // token firmado con SECRET, verificado con otro secret -> Invalid or expired
    await rejectsCode(svcB.verify(token), CODE.INVALID_TOKEN);
  });

  test('null/undefined -> INVALID_TOKEN', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.verify(null), CODE.INVALID_TOKEN);
    await rejectsCode(svc.verify(undefined), CODE.INVALID_TOKEN);
  });
});

describe('logout — invalida el token', () => {
  test('despues de logout, verify falla con INVALID_TOKEN', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await svc.register('logout@example.com', 'password123');
    const { token } = await svc.login('logout@example.com', 'password123');
    const payload = await svc.verify(token);
    assert.ok(payload, 'token valido antes de logout');

    const removed = await svc.logout(token);
    assert.ok(removed >= 1, 'logout removio >=1 sesion');

    await rejectsCode(svc.verify(token), CODE.INVALID_TOKEN);
  });
});

describe('roles — assignRole + authorize', () => {
  test('authorize con rol correcto pasa; con rol faltante -> FORBIDDEN', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    const user = await svc.register('admin@example.com', 'password123');

    // Sin el rol 'admin' -> FORBIDDEN
    const { token: tokenNoAdmin } = await svc.login('admin@example.com', 'password123');
    await rejectsCode(svc.authorize(tokenNoAdmin, 'admin'), CODE.FORBIDDEN);

    // asignar rol
    await svc.assignRole(user._id, 'admin');
    assert.equal(await svc.hasRole(user._id, 'admin'), true);

    // re-login para reflejar el nuevo rol en el JWT
    const { token: tokenAdmin } = await svc.login('admin@example.com', 'password123');
    const payload = await svc.authorize(tokenAdmin, 'admin');
    assert.ok(payload);
    assert.ok(payload.roles.includes('admin'));

    // rol faltante distinto sigue FORBIDDEN
    await rejectsCode(svc.authorize(tokenAdmin, 'superuser'), CODE.FORBIDDEN);
  });

  test('authorize con token invalido -> INVALID_TOKEN (no FORBIDDEN)', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.authorize('garbage.token.here', 'admin'), CODE.INVALID_TOKEN);
  });

  test('assignRole de usuario inexistente -> NOT_FOUND', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.assignRole('nonexistent-id', 'admin'), CODE.NOT_FOUND);
  });

  test('authorize sin requiredRole solo verifica el token', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await svc.register('plain@example.com', 'password123');
    const { token } = await svc.login('plain@example.com', 'password123');
    const payload = await svc.authorize(token);
    assert.ok(payload);
  });
});

describe('changePassword', () => {
  test('oldPassword incorrecto -> INVALID_CREDENTIALS', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    const user = await svc.register('cp@example.com', 'password123');
    await rejectsCode(svc.changePassword(user._id, 'WRONG', 'newpass456'), CODE.INVALID_CREDENTIALS);
  });

  test('nuevo password debil -> WEAK_PASSWORD', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    const user = await svc.register('cp2@example.com', 'password123');
    await rejectsCode(svc.changePassword(user._id, 'password123', '123'), CODE.WEAK_PASSWORD);
  });

  test('usuario inexistente -> NOT_FOUND', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.changePassword('nope', 'old', 'newpass456'), CODE.NOT_FOUND);
  });

  test('cambio exitoso invalida sesiones previas', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    const user = await svc.register('cp3@example.com', 'password123');
    const { token } = await svc.login('cp3@example.com', 'password123');
    assert.ok(await svc.verify(token));
    await svc.changePassword(user._id, 'password123', 'newpass456');
    await rejectsCode(svc.verify(token), CODE.INVALID_TOKEN);
    // login con el nuevo password funciona
    const { token: t2 } = await svc.login('cp3@example.com', 'newpass456');
    assert.ok(await svc.verify(t2));
  });
});

describe('register — politica de password', () => {
  test('password muy corto -> WEAK_PASSWORD', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    await rejectsCode(svc.register('weak@example.com', '123'), CODE.WEAK_PASSWORD);
  });
});

describe('persistencia de sesion — segundo service sobre mismo db+secret', () => {
  test('un SEGUNDO service verifica un token emitido por el primero', async () => {
    const db = makeDb();
    const svcA = await createAuthService({ db, secret: SECRET });
    const svcB = await createAuthService({ db, secret: SECRET });

    await svcA.register('persist@example.com', 'password123');
    const { token } = await svcA.login('persist@example.com', 'password123');

    // El segundo service, construido sobre el MISMO DocStore y secret,
    // verifica el token emitido por el primero (sesion persistida en _sessions).
    const payload = await svcB.verify(token);
    assert.ok(payload);
    assert.equal(payload.email, 'persist@example.com');

    // Y el logout del segundo service invalida para el primero.
    await svcB.logout(token);
    await rejectsCode(svcA.verify(token), CODE.INVALID_TOKEN);
  });
});

describe('logoutAll', () => {
  test('invalida todas las sesiones de un usuario', async () => {
    const db = makeDb();
    const svc = await createAuthService({ db, secret: SECRET });
    const user = await svc.register('la@example.com', 'password123');
    const { token: t1 } = await svc.login('la@example.com', 'password123');
    const { token: t2 } = await svc.login('la@example.com', 'password123');
    assert.ok(await svc.verify(t1));
    assert.ok(await svc.verify(t2));

    const removed = await svc.logoutAll(user._id);
    assert.ok(removed >= 2, 'logoutAll removio >=2 sesiones');
    await rejectsCode(svc.verify(t1), CODE.INVALID_TOKEN);
    await rejectsCode(svc.verify(t2), CODE.INVALID_TOKEN);
  });
});
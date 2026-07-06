'use strict';

// tests/router.test.js — tests congelados del Router (matching por segmentos).
// Unit puro: sin red. Cubre match con params multiples, no-match y metodo distinto.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/router.js');
const { defaultRules, defaultEvents } = require('../src/hooks.js');

const h = () => () => 'ok'; // handler de prueba

describe('Router — matching exacto por segmentos', () => {
  test('match con multiples params captura todos', () => {
    const r = new Router();
    r.add('GET', '/api/collections/:col/records/:id', h());
    const m = r.match('GET', '/api/collections/users/records/42');
    assert.ok(m, 'debio matchear');
    assert.deepEqual(m.params, { col: 'users', id: '42' });
    assert.equal(typeof m.handler, 'function');
  });

  test('match literal sin params', () => {
    const r = new Router();
    r.add('GET', '/health', h());
    assert.ok(r.match('GET', '/health'));
  });

  test('no-match si el path difiere', () => {
    const r = new Router();
    r.add('GET', '/api/users/:id', h());
    assert.equal(r.match('GET', '/api/users'), null);
    assert.equal(r.match('GET', '/api/users/1/extra'), null);
    assert.equal(r.match('GET', '/otro'), null);
  });

  test('metodo distinto no matchea (mismo path)', () => {
    const r = new Router();
    r.add('GET', '/api/users/:id', h());
    assert.equal(r.match('POST', '/api/users/1'), null);
    assert.equal(r.match('delete', '/api/users/1'), null);
  });

  test('metodo en CASE distinto matchea (normaliza a MAYUSCULAS)', () => {
    const r = new Router();
    r.add('get', '/x/:a', h());
    assert.ok(r.match('GET', '/x/1'));
    assert.ok(r.match('get', '/x/1'));
  });

  test('param en el medio entre literales', () => {
    const r = new Router();
    r.add('GET', '/a/:b/c', h());
    const m = r.match('GET', '/a/VAL/c');
    assert.deepEqual(m.params, { b: 'VAL' });
  });

  test('trailing slash se normaliza (segmentos vacios descartados)', () => {
    const r = new Router();
    r.add('GET', '/a/b', h());
    assert.ok(r.match('GET', '/a/b/'));
  });

  test('add valida args', () => {
    const r = new Router();
    assert.throws(() => r.add('', '/x', h()), /method/);
    assert.throws(() => r.add('GET', '', h()), /pattern/);
    assert.throws(() => r.add('GET', '/x', null), /handler/);
  });

  test('devuelve la PRIMERA ruta que matchea (orden de registro)', () => {
    const r = new Router();
    r.add('GET', '/x/:a', () => 'first');
    r.add('GET', '/x/:a', () => 'second');
    const m = r.match('GET', '/x/1');
    assert.equal(m.handler(), 'first');
  });
});

describe('hooks — defaults son stubs reemplazables', () => {
  test('defaultRules.check resuelve { allow: true }', async () => {
    const r = await defaultRules.check({});
    assert.deepEqual(r, { allow: true });
  });

  test('defaultEvents.emit es no-op (no lanza)', () => {
    assert.equal(defaultEvents.emit({ collection: 'x', op: 'create', record: null }), undefined);
  });
});
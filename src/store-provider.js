'use strict';

// src/store-provider.js — adaptador estrecho sobre db.collection(name) de js-store.
// Expone una interfaz minimal (insert/get/find/count/update/remove) para que los
// handlers de records no dependan de los detalles del vendor. Cero dependencias
// de runtime; solo node:crypto y el DocStore inyectado.
//
// Contract: knowledge/contracts/records.md (seccion store-provider)

const crypto = require('node:crypto');

/**
 * makeStores(db) -> { get(colName) -> store }
 *
 * Cada store resuelve la coleccion fresca en cada llamada via `db.collection(colName)`
 * (DocStore cachea la misma instancia de Collection para un nombre, asi que dos stores
 * sobre el mismo nombre operan sobre la MISMA coleccion subyacente — no se cachea nada
 * propio que pueda desincronizar).
 */
function makeStores(db) {
  if (!db || typeof db.collection !== 'function') {
    throw new Error('makeStores requiere un DocStore inyectado');
  }

  function get(colName) {
    return {
      /**
       * insert(id|null, doc) -> doc con _id.
       * Si id es null genera crypto.randomUUID(). Reemplaza cualquier _id del doc.
       */
      insert(id, doc) {
        const col = db.collection(colName);
        const toInsert = { ...doc };
        toInsert._id = id != null ? String(id) : crypto.randomUUID();
        return col.insert(toInsert); // insert respeta _id y clona
      },

      /** get(id) -> doc | null */
      get(id) {
        const col = db.collection(colName);
        return col.findById(String(id));
      },

      /** find(filter) -> array (copia de los docs que matchean) */
      find(filter) {
        const col = db.collection(colName);
        return col.find(filter || {}).toArray();
      },

      /** count(filter) -> number */
      count(filter) {
        const col = db.collection(colName);
        return col.count(filter || {});
      },

      /**
       * update(id, doc) -> doc (REEMPLAZO del doc con ese _id; NOT_FOUND si no existe).
       * Reemplazo atomico: removeById + insert con el mismo _id. No mergea — el caller
       * arma el doc resultante (records.js hace el merge superficial en PATCH).
       */
      update(id, doc) {
        const col = db.collection(colName);
        const idStr = String(id);
        const existing = col.findById(idStr);
        if (!existing) {
          const e = new Error(`No existe el documento "${idStr}"`);
          e.code = 'NOT_FOUND';
          throw e;
        }
        const replacement = { ...doc, _id: idStr };
        col.removeById(idStr);
        return col.insert(replacement);
      },

      /** remove(id) -> boolean (true si borro, false si no existia) */
      remove(id) {
        const col = db.collection(colName);
        return col.removeById(String(id)) === 1;
      },
    };
  }

  return { get };
}

module.exports = { makeStores };
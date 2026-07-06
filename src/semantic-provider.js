'use strict';

// src/semantic-provider.js — adaptador estrecho sobre SemanticCollection del vendor.
// Devuelve (y cachea 1 sola vez por nombre) una SemanticCollection para colecciones
// del registry con vector.dim entero > 0. Modo memoria ({ dim }) por defecto, o disco
// ({ path: <baseDir>/<colName>, dim }) si se pasa baseDir. Cero dependencias de
// runtime; solo el vendor y node:path.
//
// Contract: knowledge/contracts/semantic-routes.md (seccion semantic-provider)

const path = require('node:path');
const { SemanticCollection } = require('./vendor/js-store/index.js');

/**
 * makeSemanticStores({ registry, baseDir? }) -> { get(colName), closeAll() }
 *
 *   registry : CollectionRegistry (get(name) -> config | null)
 *   baseDir  : si se pasa, modo DISCO (new SemanticCollection({ path, dim }));
 *              si no, modo MEMORIA (new SemanticCollection({ dim })).
 *
 * get(colName) -> SemanticCollection | null
 *   - null si la coleccion no existe o no tiene vector.dim entero > 0.
 *   - crea y cachea UNA sola instancia por nombre (reutiliza en llamadas posteriores).
 *
 * closeAll() cierra todas las instancias cacheadas (libera locks de modo disco; no-op
 *   en memoria). Para tests/lifecycle: llamar en finally para no dejar handles.
 */
function makeSemanticStores({ registry, baseDir } = {}) {
  if (!registry || typeof registry.get !== 'function') {
    throw new Error('makeSemanticStores requiere un registry con get(name)');
  }
  const cache = new Map(); // colName -> SemanticCollection

  function get(colName) {
    if (cache.has(colName)) return cache.get(colName);

    const config = registry.get(colName);
    const dim = config && config.vector ? config.vector.dim : null;
    if (typeof dim !== 'number' || !Number.isInteger(dim) || dim <= 0) {
      return null;
    }

    let sc;
    if (baseDir != null && baseDir !== '') {
      sc = new SemanticCollection({ path: path.join(String(baseDir), colName), dim });
    } else {
      sc = new SemanticCollection({ dim });
    }
    cache.set(colName, sc);
    return sc;
  }

  function closeAll() {
    for (const sc of cache.values()) {
      try { sc.close(); } catch { /* close nunca lanza en no-lock; defensive */ }
    }
    cache.clear();
  }

  return { get, closeAll };
}

module.exports = { makeSemanticStores };
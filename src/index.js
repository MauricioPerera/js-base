// js-base — fachada raíz del backend (CommonJS, cero dependencias de runtime).
//
// js-base será un backend estilo PocketBase construido sobre js-store. Por ahora
// este módulo solo REEXPONE el vendor bajo un namespace estable, para que el resto
// del producto consuma la API a través de js-base y no acoplese directamente a
// src/vendor/js-store/. La API unificada (REST, auth, rules, SSE, búsqueda
// semántica) se construye tarea por tarea vía contratos CCDD en knowledge/contracts/.
//
// El vendor está congelado: su integridad se verifica con tests/test_vendor_sync.py
// + docs/vendor-manifest.json. NO editar archivos bajo src/vendor/js-store/.
//
// Arquitectura: knowledge/architecture/js-base.md.

module.exports = {
  VERSION: "0.1.5",
  store: require("./vendor/js-store/index.js"),
  createServer: require("./app.js").createServer,
};
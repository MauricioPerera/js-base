// js-store — fachada pública (CommonJS, zero-dependencias).
//
// Capa de INTEGRACIÓN sobre dos cores propios vendorizados (ver src/vendor/):
//   - js-doc-store    → base de documentos (queries tipo Mongo, índices, agregación…)
//   - js-vector-store → almacén vectorial (cuantización, IVF, BM25, HybridSearch…)
//
// Por ahora esta fachada solo REEXPONE ambos cores bajo namespaces estables. La API
// unificada doc+vector (p. ej. una colección con búsqueda semántica nativa) se construye
// tarea por tarea vía contratos CCDD en knowledge/contracts/. Arquitectura:
// knowledge/architecture/overview.md.

const docStore = require("./vendor/js-doc-store.js");
const vectorStore = require("./vendor/js-vector-store.js");
const { SemanticCollection } = require("./semantic-collection.js");

module.exports = {
  VERSION: "0.1.7",
  // API de integración de js-store:
  SemanticCollection,
  // Cores vendorizados, expuestos tal cual bajo namespace:
  doc: docStore,
  vector: vectorStore,
};

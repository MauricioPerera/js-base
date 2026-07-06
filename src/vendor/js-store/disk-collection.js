// Colección de documentos DURABLE en disco: los documentos viven en un DiskKV (por _id) y se
// leen bajo demanda; nunca se retiene el dataset completo en RAM. Fase 2 del motor en disco.
// Contrato: knowledge/contracts/disk-collection.md

const { DiskKV } = require("./disk-kv.js");
const { matchFilter } = require("./vendor/js-doc-store.js");

class DiskCollection {
  constructor(dataPath) {
    this._kv = new DiskKV(dataPath);
    this._counter = 0;
    this._indexes = new Map(); // field -> Map(valorString -> Set(id))
  }

  // Índice secundario sobre un campo: construye/reconstruye valor -> ids en RAM escaneando disco.
  // Contrato: knowledge/contracts/disk-collection-index.md
  ensureIndex(field) {
    const m = new Map();
    this._indexes.set(field, m);
    for (const id of this._kv.keys()) {
      const doc = this._kv.get(id);
      const key = String(doc[field]);
      if (!m.has(key)) m.set(key, new Set());
      m.get(key).add(id);
    }
  }

  // Re-corre ensureIndex para cada campo YA indexado (los que están en this._indexes),
  // dejándolos al día con lo anexado al log por el escritor (tras un refresh). Itera sobre
  // una copia de las keys porque ensureIndex reemplaza el Map de cada campo. No-op si no hay
  // índices creados. Contrato: knowledge/contracts/disk-collection-index.md
  rebuildIndexes() {
    for (const field of [...this._indexes.keys()]) this.ensureIndex(field);
  }

  // Agrega doc._id a cada índice existente bajo la clave String(doc[field]).
  _addToIndexes(d) {
    for (const [field, m] of this._indexes) {
      const key = String(d[field]);
      if (!m.has(key)) m.set(key, new Set());
      m.get(key).add(d._id);
    }
  }

  // Retira doc._id de cada índice bajo la clave String(doc[field]).
  _removeFromIndexes(doc) {
    for (const [field, m] of this._indexes) {
      m.get(String(doc[field]))?.delete(doc._id);
    }
  }

  insert(doc) {
    const d = { ...doc };
    if (d._id === undefined || d._id === null) {
      d._id = String(Date.now()) + "_" + this._counter++;
    }
    this._kv.put(d._id, d);
    this._addToIndexes(d);
    return d;
  }

  findById(id) {
    return this._kv.get(id);
  }

  // Relee la cola del log subyacente (habilita lectores de larga vida). STUB — lo
  // implementa el dev. Contrato: knowledge/contracts/semantic-collection-disk-refresh.md
  refresh() {
    this._kv.refresh();
  }

  // Compacta el log subyacente (dropea tombstones/versiones viejas). STUB — lo implementa
  // el dev. Contrato: knowledge/contracts/semantic-collection-disk-compact.md
  compact() {
    this._kv.compact();
  }

  // Escanea los ids en disco leyendo de a uno (sin cargar todo a RAM) y aplica `cb`
  // por cada documento que matchea el filtro. `cb` recibe (id, doc) y puede devolver
  // false para detener el escaneo. Normaliza filter vacio/undefined a "matchea todo".
  _scan(filter, cb) {
    const ids = this._kv.keys();
    for (const id of ids) {
      const doc = this._kv.get(id);
      if (matchFilter(doc, filter) && cb(id, doc) === false) break;
    }
  }

  // Devuelve el array de ids resuelto por índice si el filtro es igualdad simple sobre
  // un campo indexado ({ field: valorPrimitivo }); null en caso contrario (caer a escaneo).
  _indexLookup(filter) {
    const ks = Object.keys(filter || {});
    if (ks.length !== 1) return null;
    const f = ks[0];
    if (!this._indexes.has(f)) return null;
    if (typeof filter[f] === "object") return null;
    const ids = this._indexes.get(f).get(String(filter[f]));
    return ids ? [...ids] : [];
  }

  find(filter) {
    const ids = this._indexLookup(filter);
    if (ids) return ids.map((id) => this._kv.get(id));
    const out = [];
    this._scan(filter, (_id, doc) => { out.push(doc); });
    return out;
  }

  count(filter) {
    // Igualdad simple sobre campo indexado: cuenta los ids del índice sin escanear.
    const ids = this._indexLookup(filter);
    if (ids) return ids.length;
    let n = 0;
    this._scan(filter, () => { n++; });
    return n;
  }

  remove(filter) {
    // Igualdad simple sobre campo indexado: resuelve los docs a borrar por índice sin escanear.
    const ids = this._indexLookup(filter);
    const toDelete = ids ? ids.map((id) => this._kv.get(id)) : [];
    if (!ids) this._scan(filter, (_id, doc) => { toDelete.push(doc); });
    for (const doc of toDelete) {
      this._kv.delete(doc._id);
      this._removeFromIndexes(doc);
    }
    return toDelete.length;
  }
}

module.exports = { DiskCollection };
// Store de vectores DURABLE en disco: los vectores viven en un DiskKV y la búsqueda los lee
// de a uno (streaming), sin retener todos los vectores en RAM. Fase 3a del motor en disco.
// Contrato: knowledge/contracts/disk-vectors.md

const { DiskKV } = require("./disk-kv.js");

// Similitud coseno entre dos vectores. Devuelve 0 si alguna norma es 0.
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  return na * nb === 0 ? 0 : dot / (na * nb);
}

class DiskVectorStore {
  constructor(dataPath) {
    this._kv = new DiskKV(dataPath);
  }

  set(id, vector) {
    this._kv.put(id, vector);
  }

  get(id) {
    return this._kv.get(id);
  }

  remove(id) {
    this._kv.delete(id);
  }

  keys() {
    return this._kv.keys();
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

  search(queryVector, k) {
    const out = [];
    for (const id of this._kv.keys()) {
      const v = this._kv.get(id);
      const score = cosine(queryVector, v);
      out.push({ id, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}

module.exports = { DiskVectorStore };
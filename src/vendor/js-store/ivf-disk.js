// Índice IVF sobre disco: build() clusteriza los vectores (centroides en RAM, posting lists
// cluster->ids), y search() lee de disco SOLO los clusters probados (no todos los vectores).
// Contrato: knowledge/contracts/ivf-disk.md

const fs = require("node:fs");
const { DiskVectorStore } = require("./disk-vectors.js");
const { kmeans } = require("./kmeans.js");

// Distancia euclídea al cuadrado entre dos vectores (suma de cuadrados de diferencias).
function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

// Índice del centroide de menor dist2 al vector. Empate: el primero encontrado.
function nearestCentroid(v, centroids) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = dist2(v, centroids[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Coseno de similitud: dot/(||a||*||b||); 0 si alguna norma es 0.
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Asigna cada id a su cluster más cercano, escribiendo en postings (streaming, uno a la vez).
function assignAll(ids, dv, centroids, postings) {
  for (const id of ids) {
    const v = dv.get(id);
    const c = nearestCentroid(v, centroids);
    postings[c].push(id);
  }
}

// Devuelve los índices de centroide ordenados por cercanía a la query, limitados a nProbe.
function pickProbes(queryVector, centroids, nProbe) {
  const order = [];
  for (let i = 0; i < centroids.length; i++) order.push(i);
  order.sort((x, y) => dist2(queryVector, centroids[x]) - dist2(queryVector, centroids[y]));
  return order.slice(0, nProbe);
}

class IVFDiskIndex {
  constructor(dataPath) {
    this._dv = new DiskVectorStore(dataPath);
    this._centroids = null;
    this._postings = null;
  }

  set(id, vector) {
    this._dv.set(id, vector);
  }

  remove(id) {
    this._dv.remove(id);
  }

  build(nClusters, sampleSize) {
    const ids = this._dv.keys();
    const n = ids.length;
    if (n === 0) {
      this._centroids = [];
      this._postings = [];
      return;
    }
    const sampleIds = ids.slice(0, Math.min(sampleSize, n));
    const sample = sampleIds.map((id) => this._dv.get(id));
    const { centroids } = kmeans(sample, nClusters, 20);
    this._centroids = centroids;
    this._postings = centroids.map(() => []);
    assignAll(ids, this._dv, this._centroids, this._postings);
  }

  // Persistencia del índice (centroides + posting lists): STUBS — los implementa el dev.
  // Contrato: knowledge/contracts/ivf-persist.md
  save(indexPath) {
    if (this._centroids == null) throw new Error("save: construir el indice (build) antes de guardar");
    fs.writeFileSync(indexPath, JSON.stringify({ centroids: this._centroids, postings: this._postings }), "utf8");
    return indexPath;
  }

  load(indexPath) {
    if (!fs.existsSync(indexPath)) return false;
    const data = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    this._centroids = data.centroids;
    this._postings = data.postings;
    return true;
  }

  search(queryVector, k, nProbe) {
    if (!this._centroids || this._centroids.length === 0) return [];
    const probes = pickProbes(queryVector, this._centroids, nProbe);
    const out = [];
    for (const c of probes) {
      for (const id of this._postings[c]) {
        const v = this._dv.get(id);
        out.push({ id, score: cosine(queryVector, v) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}

module.exports = { IVFDiskIndex };
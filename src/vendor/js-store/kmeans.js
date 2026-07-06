// K-means determinista (init = primeros k vectores, iteraciones de Lloyd). Base del IVF.

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function nearest(vec, centroids) {
  let best = 0;
  let bestD = dist2(vec, centroids[0]);
  for (let c = 1; c < centroids.length; c++) {
    const d = dist2(vec, centroids[c]);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function assignAll(vectors, centroids) {
  const assignments = new Array(vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    assignments[i] = nearest(vectors[i], centroids);
  }
  return assignments;
}

function mean(list) {
  const dim = list[0].length;
  const out = new Array(dim).fill(0);
  for (const v of list) {
    for (let i = 0; i < dim; i++) {
      out[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    out[i] /= list.length;
  }
  return out;
}

function recompute(vectors, assignments, k, prevCentroids) {
  const dim = prevCentroids[0].length;
  const groups = new Array(k);
  for (let c = 0; c < k; c++) groups[c] = [];
  for (let i = 0; i < vectors.length; i++) {
    groups[assignments[i]].push(vectors[i]);
  }
  const centroids = new Array(k);
  for (let c = 0; c < k; c++) {
    centroids[c] = groups[c].length === 0 ? prevCentroids[c] : mean(groups[c]);
  }
  return centroids;
}

function eqArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function copyVec(v) {
  return v.slice();
}

function kmeans(vectors, k, maxIters) {
  const n = vectors.length;
  if (n === 0) return { centroids: [], assignments: [] };
  if (k >= n) {
    const centroids = vectors.map(copyVec);
    const assignments = [];
    for (let i = 0; i < n; i++) assignments[i] = i;
    return { centroids, assignments };
  }
  let centroids = vectors.slice(0, k).map(copyVec);
  let assignments = assignAll(vectors, centroids);
  for (let it = 0; it < maxIters; it++) {
    const next = recompute(vectors, assignments, k, centroids);
    const nextAssign = assignAll(vectors, next);
    const same = eqArr(nextAssign, assignments);
    centroids = next;
    assignments = nextAssign;
    if (same) break;
  }
  return { centroids, assignments };
}

module.exports = { kmeans };
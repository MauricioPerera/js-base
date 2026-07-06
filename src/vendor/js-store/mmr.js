// Maximal Marginal Relevance (diversificación de resultados) — task dura del A/B v1 vs v2.
// Contrato: knowledge/contracts/mmr.md. Función pura, no muta la entrada.

function cosineSimilarity(v1, v2) {
  if (!v1 || !v2 || v1.length !== v2.length) return 0;
  let dot = 0, norm1 = 0, norm2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    norm1 += v1[i] * v1[i];
    norm2 += v2[i] * v2[i];
  }
  const denom = Math.sqrt(norm1 * norm2);
  return denom === 0 ? 0 : dot / denom;
}

function maxSimilarity(candidate, selected) {
  if (selected.length === 0) return 0;
  let max = 0;
  for (let i = 0; i < selected.length; i++) {
    const sim = cosineSimilarity(candidate.vector, selected[i].vector);
    if (sim > max) max = sim;
  }
  return max;
}

function mmr(candidates, options) {
  const { k, lambda } = options || {};

  if (!candidates || candidates.length === 0) return [];
  if (k <= 0) return [];

  const limit = Math.min(k, candidates.length);
  const selected = [];
  const remaining = candidates.slice();

  for (let step = 0; step < limit; step++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const maxSim = maxSimilarity(candidate, selected);
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const chosen = remaining.splice(bestIdx, 1)[0];
    selected.push({ id: chosen.id, score: chosen.score, vector: chosen.vector });
  }

  return selected;
}

module.exports = { mmr };

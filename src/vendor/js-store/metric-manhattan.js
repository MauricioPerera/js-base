// Distancia Manhattan (L1). Contrato: knowledge/contracts/metric-manhattan.md
function manhattan(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum;
}
module.exports = { manhattan };

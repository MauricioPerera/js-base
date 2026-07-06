// Norma euclídea (L2). Contrato: knowledge/contracts/metric-l2.md
function l2(v) {
  return Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
}
module.exports = { l2 };

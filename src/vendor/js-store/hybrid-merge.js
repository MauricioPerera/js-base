// Target del contrato: knowledge/contracts/hybrid-merge.md
// Función pura: fusiona el ranking vectorial con el filtro documental.

// Normaliza allowedIds a un predicado de pertenencia (una sola vez).
// Devuelve null = sin filtro (todos pasan).
function buildAllowed(allowedIds) {
  if (allowedIds == null) return null;
  if (allowedIds instanceof Set) return (id) => allowedIds.has(id);
  if (Array.isArray(allowedIds)) return (id) => allowedIds.includes(id);
  // Tipo no soportado: filtra todo (total, no lanza).
  return () => false;
}

// limit finito => max(0, floor(limit)); no finito/ausente => sin límite.
function clampLimit(limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return Infinity;
  const n = Math.floor(limit);
  return n < 0 ? 0 : n;
}

function hybridMerge(vectorHits, allowedIds, limit) {
  if (!Array.isArray(vectorHits)) return [];
  const allowed = buildAllowed(allowedIds);
  const max = clampLimit(limit);
  if (max === 0) return [];
  const out = [];
  for (let i = 0; i < vectorHits.length; i++) {
    const hit = vectorHits[i];
    const id = hit == null ? undefined : hit.id;
    if (allowed !== null && !allowed(id)) continue;
    out.push(hit);
    if (out.length === max) break;
  }
  return out;
}

module.exports = { hybridMerge };
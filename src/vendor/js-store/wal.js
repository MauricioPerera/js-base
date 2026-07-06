// Write-Ahead Log (journal append-only) para js-store — Fase B de durabilidad.
// Contrato: knowledge/contracts/wal.md

const fs = require("node:fs");

// Añade una operación como línea JSON al WAL, de forma durable (fsync).
function appendOp(walPath, op) {
  const line = JSON.stringify(op) + "\n";
  const fd = fs.openSync(walPath, "a");
  try {
    fs.writeFileSync(fd, line, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Lee todas las operaciones del WAL. Tolera SOLO una última línea incompleta (torn tail
// por crash a mitad de append). Como el WAL es append-only + fsync por op, una línea que no
// parsea SOLO puede ser la última con contenido; una corrupta con ops válidas después es
// corrupción del medio y se señala lanzando (antes se dropeaba en silencio).
function readOps(walPath) {
  if (!fs.existsSync(walPath)) return [];
  const raw = fs.readFileSync(walPath, "utf8");
  const lines = raw.split("\n");
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    try {
      ops.push(JSON.parse(line));
    } catch {
      // Hay contenido después de esta línea? Si sí, es corrupción del medio (no torn tail).
      if (lines.slice(i + 1).some((l) => l !== "")) {
        throw new Error(`readOps: WAL corrupto en la línea ${i + 1} (no es la última)`);
      }
      break; // torn tail: última línea con contenido, crash a mitad de append -> se tolera.
    }
  }
  return ops;
}

module.exports = { appendOp, readOps };
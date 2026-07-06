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

// Lee todas las operaciones del WAL. Tolera una última línea incompleta (crash a mitad).
function readOps(walPath) {
  if (!fs.existsSync(walPath)) return [];
  const raw = fs.readFileSync(walPath, "utf8");
  const lines = raw.split("\n");
  const ops = [];
  for (const line of lines) {
    if (line === "") continue;
    try {
      ops.push(JSON.parse(line));
    } catch {
      // Línea torn (crash a mitad de append): se ignora.
    }
  }
  return ops;
}

module.exports = { appendOp, readOps };
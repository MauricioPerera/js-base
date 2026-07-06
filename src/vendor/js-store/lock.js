// Lock de un solo escritor (lockfile con PID) para js-store — Fase D.
// Contrato: knowledge/contracts/lock.md

const fs = require("node:fs");

// ¿El proceso `pid` sigue vivo? (para detectar locks huérfanos/stale)
function _isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // EPERM = vivo (sin permiso); ESRCH/otros = muerto
  }
}

// Adquiere el lock exclusivo en `lockPath`. Lanza si lo tiene un proceso VIVO.
function acquireLock(lockPath) {
  // 1. Intento de creación atómica exclusiva.
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, String(process.pid), "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return;
  } catch (e) {
    if (e.code !== "EEXIST") throw e; // error real distinto a "ya existe"
  }
  // 2. El lock existe: leer el dueño.
  const owner = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
  if (!Number.isNaN(owner) && _isAlive(owner)) {
    throw new Error("recurso bloqueado por el proceso " + owner);
  }
  // 3. Lock stale (dueño muerto): robarlo.
  fs.unlinkSync(lockPath);
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeFileSync(fd, String(process.pid), "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Libera el lock (idempotente).
function releaseLock(lockPath) {
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
}

module.exports = { acquireLock, releaseLock, _isAlive };
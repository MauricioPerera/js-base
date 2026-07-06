// Target del contrato: knowledge/contracts/atomic-file-adapter.md
// Drop-in replacement del FileStorageAdapter del vendor (js-doc-store) con
// writeJson ATOMICO: escribe a un temp en el MISMO dir, fsync, renameSync.
// Misma interfaz exacta: constructor(dir), readJson, writeJson, delete, listKeys.
// Cero dependencias runtime (solo node:fs / node:path).

const fs = require("node:fs");
const path = require("node:path");

class AtomicFileStorageAdapter {
  constructor(dir) {
    this.dir = dir;
    this.fs = fs;
    this.path = path;
    this._counter = 0;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Nombre unico por proceso: <filename>.<pid>.<contador>.tmp. El contador
  // crece por escritura => nunca colisiona dentro del mismo proceso; el pid
  // separa entre procesos. El temp vive en el MISMO dir que el destino para
  // que el rename sea atómico (mismo volumen: rename = cambio de inodo, no
  // copia) — condición necesaria para la atomicidad real.
  _tempName(filename) {
    this._counter += 1;
    return `${filename}.${process.pid}.${this._counter}.tmp`;
  }

  readJson(filename) {
    const file = path.join(this.dir, filename);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  // Escritura atomica: open(w) -> write -> fsync -> close -> rename. Si algo
  // falla ANTES del rename, el destino queda INTACTO (contenido previo) y el
  // JSON del destino sigue parseable; el temp queda como residual (lo filtra
  // listKeys). El fsync fuerza el flush a disco antes del rename para no
  // dejar el destino con contenido parcial en un crash.
  writeJson(filename, data) {
    const file = path.join(this.dir, filename);
    const tmp = path.join(this.dir, this._tempName(filename));
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(data), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  delete(filename) {
    const file = path.join(this.dir, filename);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  // NO lista temporales residuales (.tmp) dejados por escrituras fallidas.
  // El ecosistema nunca usa .tmp como extensión de datos reales, así que
  // filtrar por sufijo es seguro y no descarta archivos legítimos.
  listKeys() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((n) => !n.endsWith(".tmp"));
  }
}

module.exports = { AtomicFileStorageAdapter };
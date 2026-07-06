// Store clave-valor DURABLE en disco: los valores viven en disco y se leen bajo demanda
// (no se retienen en RAM). Base para que js-store no dependa de RAM.
// Log append-only con registros length-prefixed: [4 bytes BE: N][N bytes: JSON].
// Contrato: knowledge/contracts/disk-kv.md

const fs = require("node:fs");

class DiskKV {
  constructor(dataPath) {
    this._path = dataPath;
    this._index = new Map(); // key -> { offset, length } (offset del payload)
    this._deleted = new Set();
    // Limpia un "<dataPath>.compact" huerfano de un compact que crasheo antes del rename.
    // Siempre es basura parcial (el archivo real es dataPath); seguro de borrar.
    const orphan = dataPath + ".compact";
    if (fs.existsSync(orphan)) { try { fs.unlinkSync(orphan); } catch {} }
    if (!fs.existsSync(dataPath)) fs.writeFileSync(dataPath, "");
    this._fd = fs.openSync(dataPath, "r+");
    this._scan();
    this._scanPos = fs.fstatSync(this._fd).size;
  }

  // Reconstruye el indice escaneando el log de principio a fin (sin retener valores).
  // Tolera un registro TORN al final (crash mid-append): chequea limites antes de leer
  // (header incompleto: pos+4>size; payload incompleto: pos+4+N>size) y CORTA el barrido
  // en el primer registro incompleto, igual que refresh(). Tras un tail torn, TRUNCA el
  // archivo al último offset bueno para que el log quede limpio y los appends siguientes
  // (que escriben en fstat().size) no dejen los bytes torn stranded en el medio.
  // append-only: un crash mid-append solo puede tornar el último registro; lo previo está
  // fsynced e intacto. Esta truncación es recuperación del ESCRITOR al reabrir tras crash;
  // refresh() (camino del lector) NO trunca y debe seguir sin truncar.
  _scan() {
    const size = fs.fstatSync(this._fd).size;
    let pos = 0;
    let lastGoodEnd = 0;
    while (pos < size) {
      if (pos + 4 > size) break;                       // header incompleto (torn): cortar
      const N = this._readAt(pos, 4).readUInt32BE(0);
      if (pos + 4 + N > size) break;                   // payload incompleto (torn): no avanzar, cortar
      const payloadOffset = pos + 4;
      const rec = JSON.parse(this._readAt(payloadOffset, N).toString("utf8"));
      pos = pos + 4 + N;
      if (rec.deleted) {
        this._deleted.add(rec.key);
        this._index.delete(rec.key);
      } else {
        this._index.set(rec.key, { offset: payloadOffset, length: N });
        this._deleted.delete(rec.key);
      }
      lastGoodEnd = pos;                               // avanza SOLO tras un registro completo
    }
    if (lastGoodEnd < size) fs.ftruncateSync(this._fd, lastGoodEnd);
  }

  // Lee exactamente `length` bytes desde `offset` (IO posicionado, no carga el archivo).
  _readAt(offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(this._fd, buf, 0, length, offset);
    return buf;
  }

  // Añade un registro al final del log (append); devuelve { offset, length } del payload.
  _appendRecord(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const size = fs.fstatSync(this._fd).size;
    fs.writeSync(this._fd, header, 0, 4, size);
    fs.writeSync(this._fd, payload, 0, payload.length, size + 4);
    fs.fsyncSync(this._fd);
    return { offset: size + 4, length: payload.length };
  }

  put(key, value) {
    const meta = this._appendRecord({ key, value });
    this._index.set(key, meta);
    this._deleted.delete(key);
  }

  get(key) {
    if (this._deleted.has(key) || !this._index.has(key)) return null;
    const { offset, length } = this._index.get(key);
    return JSON.parse(this._readAt(offset, length).toString("utf8")).value;
  }

  delete(key) {
    this._appendRecord({ key, deleted: true });
    this._deleted.add(key);
    this._index.delete(key);
  }

  keys() {
    return Array.from(this._index.keys());
  }

  // Relee la COLA del log (registros anexados por otro proceso/instancia desde el último
  // scan) y actualiza el índice. Tolera un último registro incompleto (torn). Habilita
  // 1 escritor + N lectores. STUB — lo implementa el dev. Contrato: knowledge/contracts/disk-kv-refresh.md
  refresh() {
    const size = fs.fstatSync(this._fd).size;
    let pos = this._scanPos;
    while (pos < size) {
      if (pos + 4 > size) break;                       // header incompleto
      const N = this._readAt(pos, 4).readUInt32BE(0);
      if (pos + 4 + N > size) break;                   // payload incompleto (torn): no avanzar
      const payloadOffset = pos + 4;
      const rec = JSON.parse(this._readAt(payloadOffset, N).toString("utf8"));
      pos = pos + 4 + N;
      if (rec.deleted) { this._deleted.add(rec.key); this._index.delete(rec.key); }
      else { this._index.set(rec.key, { offset: payloadOffset, length: N }); this._deleted.delete(rec.key); }
      this._scanPos = pos;                             // avanza SOLO tras un registro completo
    }
  }

  // Compacta el log: reescribe solo los registros vivos (dropea tombstones y versiones
  // superadas) y reemplaza el archivo atómicamente. STUB — lo implementa el dev.
  // Contrato: knowledge/contracts/disk-kv-compact.md
  compact() {
    const tmp = this._path + ".compact";
    const fd = fs.openSync(tmp, "w");
    const newIndex = new Map();
    let pos = 0;
    for (const key of this._index.keys()) {          // solo claves vivas
      const { offset, length } = this._index.get(key);
      const payload = this._readAt(offset, length);  // lee del archivo ACTUAL (this._fd)
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length, 0);
      fs.writeSync(fd, header, 0, 4, pos);
      fs.writeSync(fd, payload, 0, length, pos + 4);
      newIndex.set(key, { offset: pos + 4, length });
      pos += 4 + length;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.closeSync(this._fd);           // cierra el fd viejo
    try {
      fs.renameSync(tmp, this._path); // reemplazo atomico
    } catch (e) {
      // El rename fallo (p.ej. EPERM en Windows si un lector tiene el archivo abierto):
      // el archivo original sigue intacto (el rename no ocurrio) -> reabrirlo deja la
      // instancia USABLE sin compactar. Limpia el tmp huerfano y lanza un Error de dominio.
      // this._index/_deleted/_scanPos NO se mutaron: siguen apuntando al archivo original.
      this._fd = fs.openSync(this._path, "r+");
      try { fs.unlinkSync(tmp); } catch {}
      throw new Error(
        `compact: no se pudo reemplazar el archivo (${e.code || e.message}); la coleccion sigue usable sin compactar (cerra lectores abiertos y reintenta)`
      );
    }
    this._fd = fs.openSync(this._path, "r+");
    this._index = newIndex;
    this._deleted = new Set();
    this._scanPos = fs.fstatSync(this._fd).size;
  }
}

module.exports = { DiskKV };
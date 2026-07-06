// crash-child.cjs — proceso hijo DEL HARNESS adversarial (tests/adversarial.test.js).
//
// Se invoca con un modo y argumentos posicionales. NUNCA toca codigo de
// produccion: solo USA los modulos committeados (AtomicFileStorageAdapter,
// SemanticCollection) para ejercitarlos bajo crash. Los hijos SOLO escriben
// en tempdirs / rutas que les pasa el padre (que son temporales).
//
// Uso:
//   node crash-child.cjs atomic <dir>
//       Abre AtomicFileStorageAdapter(<dir>) y escribe "f.json" en loop con
//       un payload GRANDE (para ensanchar la ventana de write+fsync y que el
//       SIGKILL del padre aterrice a mitad de escritura). Imprime "READY\n".
//
//   node crash-child.cjs disk <pathPrefix> <dim>
//       Abre SemanticCollection modo disco ({path: <pathPrefix>, dim}) SIN
//       lock y hace upserts 0,1,2,... en loop. Imprime "UPSERT <k>\n" tras
//       cada upsert completado (ambos appends fsync'd) para que el padre sepa
//       cuantos estan confirmados antes del kill.
//
//   node crash-child.cjs lock <pathPrefix> <dim>
//       Abre SemanticCollection modo disco con lock:true sobre <pathPrefix>,
//       imprime "LOCKED\n" y se mantiene vivo (setInterval) hasta que el
//       padre lo mate. Sirve al bloque C (lock 1-escritor cross-process).

"use strict";

const path = require("node:path");
const { AtomicFileStorageAdapter } = require(
  path.resolve(__dirname, "..", "..", "src", "atomic-file-adapter.js"),
);
const { SemanticCollection } = require(
  path.resolve(__dirname, "..", "..", "src", "vendor", "js-store", "semantic-collection.js"),
);

function write(line) {
  process.stdout.write(line + "\n");
}

function modeAtomic(dir) {
  const a = new AtomicFileStorageAdapter(dir);
  // Payload grande: ensancha writeFileSync + fsync para castigar el timing
  // del crash. El contenido varia por iteracion para no escribir lo mismo.
  function payload(i) {
    const big = "x".repeat(200000);
    return { i, tag: "iter-" + i, bulk: big, nested: { i, bulk: big } };
  }
  write("READY");
  let i = 0;
  while (true) {
    a.writeJson("f.json", payload(i));
    i += 1;
  }
}

function modeDisk(prefix, dim) {
  const sc = new SemanticCollection({ path: prefix, dim });
  let k = 0;
  while (true) {
    const vec = new Array(dim).fill(k % 7);
    sc.upsert(String(k), { idx: k, text: "doc-" + k }, vec);
    write("UPSERT " + k);
    k += 1;
  }
}

function modeLock(prefix, dim) {
  // lock:true adquiere <prefix>.lock; lanza si lo tiene otro proceso vivo.
  const sc = new SemanticCollection({ path: prefix, dim, lock: true });
  write("LOCKED");
  // Mantener el proceso vivo hasta que el padre lo mate (SIGKILL). SIN unref:
  // el interval DEBE mantener el event loop vivo (es el punto del bloque C).
  setInterval(() => {}, 1000);
}

function main() {
  const [, , mode, ...rest] = process.argv;
  try {
    if (mode === "atomic") return modeAtomic(rest[0]);
    if (mode === "disk") return modeDisk(rest[0], Number(rest[1]));
    if (mode === "lock") return modeLock(rest[0], Number(rest[1]));
    process.stderr.write("modo desconocido: " + mode + "\n");
    process.exit(2);
  } catch (e) {
    // Error tipado antes de cualquier crash: el padre lo ve en stderr.
    process.stderr.write("CHILD_ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n");
    process.exit(3);
  }
}

main();
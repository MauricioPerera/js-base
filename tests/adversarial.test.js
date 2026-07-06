// tests/adversarial.test.js — HARNESS ADVERSARIAL de durabilidad y seguridad.
//
// NO implementa features: ATACA las garantias YA COMMITEADAS del sistema:
//   A. AtomicFileStorageAdapter: crash-injection (SIGKILL a mitad de escritura
//      atomica) -> el destino .json nunca queda corrupto; listKeys no expone .tmp.
//   B. SemanticCollection modo disco: durabilidad de upserts confirmados pre-kill
//      + reapertura sin corrupcion. Incluye reproduccion determinista del estado
//      "registro torn" que deja un SIGKILL a mitad de _appendRecord (hallazgo).
//   C. SemanticCollection modo disco lock:true: 1 escritor cross-process; la
//      segunda apertura rechaza mientras la primera vive; roba lock stale.
//   D. createAuthService: fuzz N>=200 con inputs aleatorios/borde -> ningun crash
//      del proceso (siempre Error tipado o exito); login jamas devuelve token para
//      credenciales no registradas.
//   E. makeRules (rules-engine): fuzz configs + contextos -> check() nunca lanza,
//      siempre {allow:boolean}.
//
// CLAUSULA CRITICA: si un INVARIANTE FALLA, es un HALLAZGO REAL. Se documenta en
// B5-T10-REPORT.md y el test queda ROJO (o expone el fallo). PROHIBIDO parchear
// produccion, debilitar asserts o envolver en try/catch para OCULTAR fallos. Los
// try/catch de los bloques D/E son para COLECTAR resultados de N intentos (fuzz),
// no para ocultar: cada intento se aserta.
//
// Hijos SOLO escriben en tempdirs (mkdtempSync); mato SOLO mis hijos (guardo pid);
// nada fuera del repo. Limpieza total en finally. Ejecutar:
//   node --test tests/adversarial.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { AtomicFileStorageAdapter } = require("../src/atomic-file-adapter.js");
const { SemanticCollection } = require("../src/vendor/js-store/semantic-collection.js");
const { DiskKV } = require("../src/vendor/js-store/disk-kv.js");
const { createAuthService } = require("../src/auth-service.js");
const {
  DocStore,
  MemoryStorageAdapter,
} = require("../src/vendor/js-store/vendor/js-doc-store.js");
const { makeRules } = require("../src/rules-engine.js");

const CHILD = path.resolve(__dirname, "harness", "crash-child.cjs");
const DIM = 4; // dim pequena: vectores chicos, loop rapido
const ATOMIC_CYCLES = 5;
const DISK_CYCLES = 5;
const AUTH_N = 240;
const RULES_N = 240;
const MS = (n) => n;

// ───────────────────────── helpers de spawn / crash ─────────────────────────

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function spawnHarness(mode, args) {
  const child = spawn(process.execPath, [CHILD, mode, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child._stderr = "";
  child.stderr.on("data", (d) => {
    child._stderr += d.toString();
  });
  return child;
}

// Mata el hijo con SIGKILL y aguarda su 'exit'. Resuelve {code, signal, pid}.
// Sin esto un hijo "looper" quedaria huerfano (FAIL del punto 4 de definicion).
function killAndAwait(child) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (info) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(info);
    };
    child.once("exit", (code, signal) => finish({ code, signal, pid: child.pid }));
    child.once("error", (e) => {
      clearTimeout(safety);
      reject(e);
    });
    try {
      child.kill("SIGKILL");
    } catch {
      // ya muerto: el 'exit' resolvera igual
    }
    const safety = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 3000);
  });
}

// Recolecta lineas de stdout del hijo hasta que predicate(lines) sea true o
// venza el deadline. Devuelve las lineas. No mata al hijo (lo hace el caller).
function collectUntil(child, predicate, deadlineMs) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = "";
    const done = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ lines, reason });
    };
    let settled = false;
    const timer = setTimeout(() => done("deadline"), deadlineMs);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) lines.push(line);
        if (predicate(lines)) done("predicate");
      }
    });
    child.on("error", (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
    // Si el hijo se cae solo (no esperado en loopers): devolver lo recolectado.
    child.on("exit", () => done("exit"));
  });
}

// ───────────────────────── PRNG determinista (semilla del prompt) ───────────
// mulberry32: PRNG sembrado con constante. NO usa Math.random (determinismo).
const SEED = 0xb5c01010; // constante del prompt (B5-T10)
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE A — crash-injection de escritura atomica (AtomicFileStorageAdapter)
// ════════════════════════════════════════════════════════════════════════════

test("A: AtomicFileStorageAdapter — SIGKILL mid-write nunca corrompe el destino .json", { timeout: 20000 }, async () => {
  for (let cycle = 0; cycle < ATOMIC_CYCLES; cycle++) {
    const dir = mkdtemp("adv-atomic-");
    let child;
    try {
      child = spawnHarness("atomic", [dir]);
      // esperar READY, dejar escribir un rato, luego SIGKILL en caliente
      await collectUntil(child, (ls) => ls.includes("READY"), 5000);
      await collectUntil(child, () => false, 70); // 70ms de escritura en loop
      const info = await killAndAwait(child);
      child = null; // ya muerto
      assert.ok(info.pid, `ciclo ${cycle}: el hijo fue SIGKILL'd (pid=${info.pid})`);

      // INVARIANTE: todo .json presente es parseable (nunca a medias).
      const reader = new AtomicFileStorageAdapter(dir);
      const keys = reader.listKeys();
      for (const k of keys) {
        assert.ok(!k.endsWith(".tmp"), `ciclo ${cycle}: listKeys expuso un .tmp (${k})`);
        const v = reader.readJson(k);
        assert.ok(v !== null, `ciclo ${cycle}: readJson(${k}) = null (deberia parsear)`);
      }
      // Doble check directo al filesystem: ningun .json truncado.
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".json")) {
          const raw = fs.readFileSync(path.join(dir, name), "utf8");
          assert.doesNotThrow(() => JSON.parse(raw), `ciclo ${cycle}: ${name} NO parseable`);
        }
      }
      // .tmp residuales pueden quedar (escritura abortada), pero NO son datos.
      const tmps = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
      for (const t of tmps) {
        assert.ok(!keys.includes(t), `ciclo ${cycle}: listKeys listop un .tmp (${t})`);
      }
    } finally {
      if (child) await killAndAwait(child);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE B1 — durabilidad SemanticCollection modo disco (crash injection real)
// ════════════════════════════════════════════════════════════════════════════

test("B1: SemanticCollection disco — upserts confirmados pre-kill sobreviven y reopen no tira excepcion", { timeout: 30000 }, async () => {
  for (let cycle = 0; cycle < DISK_CYCLES; cycle++) {
    const dir = mkdtemp("adv-disk-");
    const prefix = path.join(dir, "col");
    let child;
    try {
      child = spawnHarness("disk", [prefix, String(DIM)]);
      // Recolectar hasta >=25 upserts confirmados (o deadline 600ms).
      const { lines } = await collectUntil(
        child,
        (ls) => {
          const ups = ls.filter((l) => l.startsWith("UPSERT "));
          if (ups.length === 0) return false;
          const last = Number(ups[ups.length - 1].split(" ")[1]);
          return last >= 25;
        },
        600,
      );
      const ups = lines.filter((l) => l.startsWith("UPSERT "));
      const maxK = ups.length ? Number(ups[ups.length - 1].split(" ")[1]) : -1;
      const info = await killAndAwait(child);
      child = null;
      assert.ok(info.pid, `ciclo ${cycle}: hijo SIGKILL'd (pid=${info.pid})`);
      assert.ok(maxK >= 0, `ciclo ${cycle}: el hijo no confirmo ningun upsert (stderr=${child && child._stderr})`);

      // Reabrir (mismo path, sin lock) NO debe tirar excepcion de corrupcion.
      const sc = new SemanticCollection({ path: prefix, dim: DIM });

      // INVARIANTE: todo upsert confirmado antes del kill sigue presente.
      let presentes = 0;
      for (let k = 0; k <= maxK; k++) {
        const doc = sc.get(String(k));
        if (doc != null) presentes++;
      }
      assert.equal(presentes, maxK + 1,
        `ciclo ${cycle}: confirmados 0..${maxK} (${maxK + 1}), presentes=${presentes} — un upsert fsync'd se perdio`);
      sc.close();
    } finally {
      if (child) await killAndAwait(child);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE B2 — HALLAZGO: reapertura NO tolera un registro torn (reproduccion
// determinista del estado que deja un SIGKILL a mitad de _appendRecord).
// ════════════════════════════════════════════════════════════════════════════
// DiskKV._appendRecord hace dos writeSync separados: header(4B BE N) y payload(NB),
// seguidos de fsync. Un SIGKILL entre el writeSync del header y el del payload
// persiste el header (page cache) pero no el payload -> registro "torn".
// _scan() (a diferencia de refresh()) NO tolera un ultimo registro torn:
// lee N del header, intenta JSON.parse(payload ausente/parcial) -> lanza.
// Construimos ese estado EXACTO a mano y asertamos el invariante DESEADO
// (reabrir no debe tirar). Si tira, es HALLAZGO: el test queda ROJO.
test("B2: DiskKV reabrir tras SIGKILL mid-append NO debe tirar corrupcion (registro torn)", { timeout: 10000 }, () => {
  const dir = mkdtemp("adv-torn-");
  try {
    const file = path.join(dir, "log.kv");
    // 2 registros validos (formato length-prefixed: [4B BE N][N bytes JSON]).
    function rec(obj) {
      const p = Buffer.from(JSON.stringify(obj), "utf8");
      const h = Buffer.alloc(4);
      h.writeUInt32BE(p.length, 0);
      return Buffer.concat([h, p]);
    }
    const rec0 = rec({ key: "a", value: { x: 1 } });
    const rec1 = rec({ key: "b", value: { x: 2 } });
    // registro torn: SOLO el header (N=200), sin payload. = estado post-SIGKILL
    // entre los dos writeSync de _appendRecord.
    const tornHeader = Buffer.alloc(4);
    tornHeader.writeUInt32BE(200, 0);
    fs.writeFileSync(file, Buffer.concat([rec0, rec1, tornHeader]));

    // Invariante deseado: reabrir nunca tira excepcion de corrupcion.
    assert.doesNotThrow(() => {
      const kv = new DiskKV(file);
      // si abrio, los registros sanos deben seguir legibles
      assert.deepEqual(kv.get("a"), { x: 1 });
      assert.deepEqual(kv.get("b"), { x: 2 });
    }, "DiskKV._scan no tolera un registro torn final -> corrupcion en reapertura");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE C — lock 1-escritor cross-process (SemanticCollection disco lock:true)
// ════════════════════════════════════════════════════════════════════════════

test("C: SemanticCollection disco lock:true — 2da apertura rechaza mientras la 1ra vive; roba lock stale", { timeout: 15000 }, async () => {
  const dir = mkdtemp("adv-lock-");
  const prefix = path.join(dir, "col");
  let child;
  try {
    child = spawnHarness("lock", [prefix, String(DIM)]);
    const { lines } = await collectUntil(child, (ls) => ls.includes("LOCKED"), 5000);
    assert.ok(lines.includes("LOCKED"), "el hijo no tomo el lock (sin LOCKED en stdout)");
    assert.ok(child._stderr === "" || !child._stderr.includes("CHILD_ERROR"),
      "el hijo fallo al tomar el lock: " + child._stderr);

    // Mientras el hijo vive: la apertura con lock:true debe RECHAZAR.
    assert.throws(
      () => new SemanticCollection({ path: prefix, dim: DIM, lock: true }),
      /recurso bloqueado/,
      "la 2da apertura con lock:true no rechazo mientras la 1ra vivia",
    );

    // SIGKILL del hijo -> el lock queda stale (owner muerto).
    const info = await killAndAwait(child);
    child = null;
    assert.ok(info.pid, `hijo lock-holder SIGKILL'd (pid=${info.pid})`);

    // Reapertura con lock:true: debe ROBAR el lock stale y exitir (semantica
    // real del vendor: acquireLock roba locks de procesos muertos).
    let sc2;
    assert.doesNotThrow(() => {
      sc2 = new SemanticCollection({ path: prefix, dim: DIM, lock: true });
    }, "no robo el lock stale del proceso muerto (deberia)");
    sc2.close();
  } finally {
    if (child) await killAndAwait(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE D — fuzz de auth (createAuthService)
// ════════════════════════════════════════════════════════════════════════════

// Genera un email/password "de borde" por indice. Sin Math.random.
function edgeInput(i, rnd) {
  const cats = [
    { e: "", p: "" },                                  // vacios
    { e: "x" + i + "@y.com", p: "ab" + i },            // normal
    { e: "u" + i + "@y.com", p: "A" + i },             // normal alt
    { e: "a".repeat(500) + "@y.com", p: "p".repeat(300) }, // muy largos
    { e: "uni" + i + "@ño.çom", p: "pä§§w" + i },      // unicode
    { e: "a:b=c@" + i + ".com", p: "p:a=s" + i },      // con : y =
    { e: "no-at-" + i, p: "123456" },                  // email sin @
    { e: " " + i + "@y.com", p: " " },                 // espacio
    { e: "UP@Y.COM", p: "ABCDEF" },                    // mayus
    { e: "tab\t" + i + "@y.com", p: "\t" },            // control
  ];
  return cats[i % cats.length];
}

test("D1: createAuthService fuzz — ningun input borde crashea el proceso (Error tipado o exito)", { timeout: 30000 }, async () => {
  const db = new DocStore(new MemoryStorageAdapter());
  const auth = await createAuthService({ db, secret: "supersecret-key-0123456789-abcdef" });
  const rnd = mulberry32(SEED);
  const registered = new Map(); // email -> password con la que se registro
  let crashes = 0;
  let nonErrorThrows = 0;

  for (let i = 0; i < AUTH_N; i++) {
    const { e, p } = edgeInput(i, rnd);
    const action = (Math.floor(rnd() * 2)) | 0; // 0=register, 1=login
    try {
      if (action === 0) {
        const user = await auth.register(e, p);
        // registro exitoso: recordar credenciales reales.
        if (user) registered.set(e, p);
      } else {
        await auth.login(e, p);
        // login exitoso solo es valido si las credenciales matchean un registro.
        // (lo valida D2 en un servicio limpio; aca solo importa no-crash.)
      }
    } catch (err) {
      // INVARIANTE: siempre Error tipado (nunc throws no-Error ni crashea).
      if (!(err instanceof Error)) {
        nonErrorThrows++;
      }
    }
  }
  assert.equal(nonErrorThrows, 0, `${AUTH_N} intentos: ${nonErrorThrows} lanzaron algo que no es Error`);
  assert.equal(crashes, 0, `${AUTH_N} intentos: ${crashes} crashes`);
});

test("D2: createAuthService login JAMAS devuelve token para credenciales no registradas", { timeout: 30000 }, async () => {
  // Servicio LIMPIO: nada registrado. Todo login debe rechazar (nunca token).
  const db = new DocStore(new MemoryStorageAdapter());
  const auth = await createAuthService({ db, secret: "supersecret-key-0123456789-abcdef" });
  const rnd = mulberry32(SEED ^ 0x1234);
  let tokensParaNoRegistrados = 0;
  let rechazos = 0;

  for (let i = 0; i < AUTH_N; i++) {
    const { e, p } = edgeInput(i, rnd);
    let gotToken = false;
    try {
      const res = await auth.login(e, p);
      // login resuelve -> devuelve un token (string). Para no-registrado = fuga.
      if (typeof res === "string" && res.length > 0) gotToken = true;
    } catch (err) {
      // esperado: INVALID_CREDENTIALS u otro Error. NO es token.
      assert.ok(err instanceof Error, `login no-registrado lanzo no-Error: ${err}`);
      rechazos++;
    }
    if (gotToken) tokensParaNoRegistrados++;
  }
  assert.equal(tokensParaNoRegistrados, 0,
    `login devolvio token para ${tokensParaNoRegistrados} credenciales no registradas (fuga de autenticacion)`);
  assert.ok(rechazos > 0, "ningun login fue rechazado (sospechoso): el fuzz no cubrio el path de fallo");
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE E — fuzz de rules-engine (makeRules + check)
// ════════════════════════════════════════════════════════════════════════════

// Si src/rules-engine.js NO existiera, este bloque se SKIP. Existe -> corre.
const rulesEnginePresent = (() => {
  try { require("../src/rules-engine.js"); return true; } catch { return false; }
})();

(rulesEnginePresent ? test : test.skip)(
  "E: makeRules fuzz — check() nunca lanza, siempre {allow:boolean}",
  { timeout: 15000 },
  async () => {
    // Registry stub: get(name) -> config | null. Mismo config para c1/c2, null
    // para colecciones desconocidas (deny por coleccion inexistente).
    function makeStubRegistry(config) {
      return { get(name) { return name === "c1" || name === "c2" ? config : null; } };
    }
    const rnd = mulberry32(SEED ^ 0xe);
    const ops = ["list", "view", "create", "update", "delete"];
    const auths = [null, { id: "u1", role: "admin" }, { id: "u2", role: "user" }, { id: "u3" }];
    const records = [null, {}, { public: true, n: 5 }, { public: false, n: 99 }, { n: 0 }];
    const filters = [
      null,                              // publica
      undefined,                         // op ausente -> deny
      { "auth.id": { $exists: true } },  // exigir login
      { "record.public": true },         // visibilidad
      { "auth.role": "admin" },          // por rol
      { "auth.role": { $ne: "admin" } }, // no-admin
      { "record.n": 5 },                 // igualdad
      {},                                // filtro vacio (matchea todo)
      { "auth.id": { $exists: true }, "record.public": true }, // AND
    ];
    const req = { method: "GET", path: "/api/x", query: {} };
    let noBool = 0;
    let throws = 0;

    for (let i = 0; i < RULES_N; i++) {
      const opRule = ops[Math.floor(rnd() * ops.length)];
      const rule = filters[Math.floor(rnd() * filters.length)];
      // Construir config.rules: si rule===undefined -> omitir la op (deny por defecto).
      const rules = {};
      if (rule !== undefined) rules[opRule] = rule;
      const config = { rules };
      const registry = makeStubRegistry(config);

      const rulesApi = makeRules(registry);
      const ctx = {
        op: opRule,
        collection: rnd() < 0.2 ? "unknown" : (rnd() < 0.5 ? "c1" : "c2"),
        auth: auths[Math.floor(rnd() * auths.length)],
        record: records[Math.floor(rnd() * records.length)],
        request: req,
      };
      try {
        const r = await rulesApi.check(ctx);
        // INVARIANTE: siempre {allow: boolean}.
        if (!r || typeof r.allow !== "boolean") noBool++;
      } catch (err) {
        // check() NO debe lanzar nunca. Si lanza = hallazgo.
        throws++;
      }
    }
    assert.equal(noBool, 0, `${RULES_N} configs: ${noBool} devolvieron algo sin allow:boolean`);
    assert.equal(throws, 0, `${RULES_N} configs: ${throws} hicieron que check() lanzara (debe {allow})`);
  },
);
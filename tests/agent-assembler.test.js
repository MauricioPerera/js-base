// Tests congelados del módulo agent/assembler.js.
//
// Cubren la semántica fijada en knowledge/contracts/agent-assembler.md:
//   - orden FIJO de slots S0..S4 (verificable por índices de substring en el context)
//   - determinismo: mismos stores + mismos args -> mismo sha256 (calculado con node:crypto)
//   - modo esporádico por ttl_ms: S2 se omite (included:false), sha256 distinto, resto estable
//   - sesión nueva sin turnos previos: modo interactivo con S2 vacío (included:true, tokens:0)
//   - retrieval (S3) excluye nodos con superseded_by aunque tengan mejor score vectorial
//   - desempate estable por id ascendente en empates de score
//   - presupuesto: S3 se recorta primero, item a item por score, y el reporte lo marca
//   - presupuesto: S2 NUNCA se trunca parcialmente (si no entra completo: included:false,
//     truncated:true, sin contenido parcial en el context)
//   - guardrail: config.regex_deny matcheando contenido recuperado aborta con err.code
//     'GUARDRAIL' nombrando el patrón
//   - patrón regex inválido en config.regex_deny falla con err.code 'VALIDATION' al
//     CONSTRUIR makeAssembler, no al ensamblar
//   - heurística de tokens: ceil(chars/4), verificable en slots[i].tokens
//
// Supuestos de esquema documentados (agent/ingestor.js y agent/promoter.js aún no
// existen; los shapes de abajo replican lo que sus propios contratos declaran, para
// que las fixtures sean consistentes con el resto de la capa agent/):
//   - turns:    { session_id, role, text, seq, created_at (ISO), compacted? }
//     (poblado directo vía stores.get("turns"), NO vía semanticStores: el assembler
//      lee S2 como historial documental por seq, no por búsqueda vectorial)
//   - sessions: { session_id, summary }
//   - nodes:    { title, body, superseded_by? } — retrieval vectorial vía
//     semanticStores.get("nodes").searchHybrid(...), textField "body"
//   - ids de slot asumidos: "S0","S1","S2","S3","S4" (nomenclatura usada en todo el
//     contrato para los 5 slots de volatilidad creciente)
//
// Usa js-base real en memoria (DocStore + MemoryStorageAdapter + CollectionRegistry +
// SemanticCollection vía store-provider/semantic-provider) y un embedder fake
// determinista (embed siempre devuelve [1,0,0], dim 3, registra isQuery recibido).
//
// Ejecutar: node --test tests/agent-assembler.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  DocStore,
  MemoryStorageAdapter,
} = require("../src/vendor/js-store/vendor/js-doc-store.js");
const { CollectionRegistry } = require("../src/collections.js");
const { makeStores } = require("../src/store-provider.js");
const { makeSemanticStores } = require("../src/semantic-provider.js");
const { makeAssembler } = require("../agent/assembler.js");

// Epoch base fijo para que las fixtures de tiempo sean deterministas y legibles.
const BASE_MS = 1700000000000;

// ---------------------------------------------------------------------------
// Helpers de fixtures
// ---------------------------------------------------------------------------

function crearEmbedderFake() {
  const llamadas = [];
  return {
    llamadas,
    async embed(textos, opts) {
      llamadas.push({ textos: textos.slice(), isQuery: !!(opts && opts.isQuery) });
      return textos.map(() => [1, 0, 0]);
    },
  };
}

function crearEntorno() {
  const db = new DocStore(new MemoryStorageAdapter());
  const registry = new CollectionRegistry(db);
  const rulesNulas = { list: null, view: null, create: null, update: null, delete: null };
  registry.create({ name: "nodes", fields: [], rules: rulesNulas, vector: { dim: 3 } });
  registry.create({ name: "turns", fields: [], rules: rulesNulas, vector: { dim: 3 } });
  registry.create({ name: "sessions", fields: [], rules: rulesNulas, vector: null });
  registry.create({ name: "assemblies", fields: [], rules: rulesNulas, vector: null });
  const stores = makeStores(db);
  const semanticStores = makeSemanticStores({ registry }); // sin baseDir -> modo memoria
  const embedder = crearEmbedderFake();
  return { db, registry, stores, semanticStores, embedder };
}

function configBase(overrides) {
  return Object.assign(
    {
      system: "SISTEMA",
      max_tokens: 16000,
      output_reserve: 3000,
      retrieval_k: 8,
      ttl_ms: 300000,
      regex_deny: [],
    },
    overrides
  );
}

function insertarTurno(stores, { sessionId, seq, role, text, createdAtMs, compacted }) {
  const doc = {
    session_id: sessionId,
    seq,
    role,
    text,
    created_at: new Date(createdAtMs).toISOString(),
  };
  if (compacted) doc.compacted = true;
  stores.get("turns").insert(`${sessionId}:${seq}:${role}`, doc);
}

function slotPorId(resultado, id) {
  return resultado.slots.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Orden de slots
// ---------------------------------------------------------------------------

test("orden FIJO de slots S0<S1<S2<S3<S4 (verificable por indices en el context) y query embebida con isQuery:true", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-orden";

  stores.get("sessions").insert(sessionId, {
    session_id: sessionId,
    summary: "RESUMEN_MARCA contenido del resumen de la sesion.",
  });
  insertarTurno(stores, {
    sessionId,
    seq: 0,
    role: "user",
    text: "TURNO0_MARCA mensaje del usuario",
    createdAtMs: BASE_MS,
  });
  insertarTurno(stores, {
    sessionId,
    seq: 1,
    role: "assistant",
    text: "TURNO1_MARCA respuesta del asistente",
    createdAtMs: BASE_MS + 1000,
  });
  semanticStores.get("nodes").upsert(
    "n1",
    { title: "Nodo relevante", body: "NODO_MARCA contenido relevante del nodo sobre reintentos" },
    [1, 0, 0]
  );

  const config = configBase({ system: "SISTEMA_MARCA texto fijo del sistema" });
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const turnText = "TURNOACTUAL_MARCA que decidimos del retry";
  const now = BASE_MS + 1000 + 500; // dentro del ttl -> interactivo

  const resultado = await assembler.assemble({ sessionId, turnText, now });

  assert.equal(resultado.mode, "interactivo");
  assert.deepEqual(resultado.slots.map((s) => s.id), ["S0", "S1", "S2", "S3", "S4"]);

  const idx = (marca) => resultado.context.indexOf(marca);
  assert.ok(idx("SISTEMA_MARCA") >= 0, "S0 debe estar en el context");
  assert.ok(idx("RESUMEN_MARCA") > idx("SISTEMA_MARCA"), "S1 debe ir despues de S0");
  assert.ok(idx("TURNO0_MARCA") > idx("RESUMEN_MARCA"), "S2 debe ir despues de S1");
  assert.ok(idx("TURNO1_MARCA") > idx("TURNO0_MARCA"), "dentro de S2, orden por seq ascendente");
  assert.ok(idx("NODO_MARCA") > idx("TURNO1_MARCA"), "S3 debe ir despues de S2");
  assert.ok(idx("TURNOACTUAL_MARCA") > idx("NODO_MARCA"), "S4 debe ir despues de S3");

  const llamadaQuery = embedder.llamadas.find((l) => l.isQuery === true);
  assert.ok(llamadaQuery, "se esperaba al menos una llamada al embedder con isQuery:true");
  assert.ok(llamadaQuery.textos.includes(turnText), "el vector de query se pide sobre turnText");
});

// ---------------------------------------------------------------------------
// Determinismo
// ---------------------------------------------------------------------------

test("determinismo: dos llamadas identicas devuelven el mismo context y el mismo sha256 real", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-determinismo";

  stores.get("sessions").insert(sessionId, { session_id: sessionId, summary: "resumen estable" });
  insertarTurno(stores, {
    sessionId,
    seq: 0,
    role: "user",
    text: "primer turno vivo",
    createdAtMs: BASE_MS,
  });
  semanticStores.get("nodes").upsert("n1", { title: "t", body: "contenido de nodo determinista" }, [1, 0, 0]);

  const config = configBase();
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const args = { sessionId, turnText: "consulta repetible", now: BASE_MS + 1000 };

  const r1 = await assembler.assemble(args);
  const r2 = await assembler.assemble(args);

  assert.equal(r1.context, r2.context);
  assert.equal(r1.sha256, r2.sha256);

  const esperado = crypto.createHash("sha256").update(r1.context, "utf8").digest("hex");
  assert.equal(r1.sha256, esperado, "sha256 debe calcularse sobre el context exacto en utf8");
});

// ---------------------------------------------------------------------------
// Modo esporadico
// ---------------------------------------------------------------------------

test("modo esporadico por ttl_ms: S2 omitido (included:false) y sha256 distinto del interactivo; resto de slots estable", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-esporadico";

  stores.get("sessions").insert(sessionId, { session_id: sessionId, summary: "RESUMEN_ESP contenido" });
  const ultimoTurno = BASE_MS;
  insertarTurno(stores, {
    sessionId,
    seq: 0,
    role: "user",
    text: "TURNO_VIVO_ESP mensaje",
    createdAtMs: ultimoTurno,
  });
  semanticStores.get("nodes").upsert("n-esp", { title: "t", body: "NODO_ESP contenido relevante" }, [1, 0, 0]);

  const config = configBase({ system: "SISTEMA_ESP" });
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const turnText = "TURNOACTUAL_ESP consulta";

  const nowInteractivo = ultimoTurno + 1000; // dentro del ttl (300000ms)
  const nowEsporadico = ultimoTurno + config.ttl_ms + 1000; // fuera del ttl

  const interactivo = await assembler.assemble({ sessionId, turnText, now: nowInteractivo });
  const esporadico = await assembler.assemble({ sessionId, turnText, now: nowEsporadico });

  assert.equal(interactivo.mode, "interactivo");
  assert.equal(esporadico.mode, "esporadico");
  assert.notEqual(interactivo.sha256, esporadico.sha256);

  assert.equal(slotPorId(interactivo, "S2").included, true);
  assert.equal(slotPorId(esporadico, "S2").included, false);

  assert.ok(interactivo.context.includes("TURNO_VIVO_ESP"));
  assert.equal(esporadico.context.includes("TURNO_VIVO_ESP"), false);

  for (const id of ["S0", "S1", "S3", "S4"]) {
    const a = slotPorId(interactivo, id);
    const b = slotPorId(esporadico, id);
    assert.equal(a.tokens, b.tokens, `slot ${id} no deberia cambiar de tamaño entre modos`);
    assert.equal(a.included, b.included, `slot ${id} no deberia cambiar de inclusion entre modos`);
  }
});

test("sesion nueva sin turnos previos: modo interactivo con S2 vacio (included:true, tokens:0)", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-nueva";
  // Deliberadamente sin insertar turnos ni doc de sesion: sesion recien creada.

  const config = configBase({ system: "SISTEMA_NUEVA" });
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const resultado = await assembler.assemble({ sessionId, turnText: "hola", now: BASE_MS });

  assert.equal(resultado.mode, "interactivo");
  const s2 = slotPorId(resultado, "S2");
  assert.equal(s2.included, true);
  assert.equal(s2.tokens, 0);
});

// ---------------------------------------------------------------------------
// Retrieval: superseded_by y desempate
// ---------------------------------------------------------------------------

test("retrieval S3 excluye nodos con superseded_by aunque tengan mejor score vectorial", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-superseded";

  semanticStores.get("nodes").upsert(
    "node-old",
    { title: "viejo", body: "CONTENIDO_A candidato con mejor score", superseded_by: "node-new" },
    [1, 0, 0] // score vectorial perfecto: peor candidato "en papel" seria justo este
  );
  semanticStores.get("nodes").upsert(
    "node-new",
    { title: "nuevo", body: "CONTENIDO_B candidato vigente" },
    [0, 1, 0]
  );

  const config = configBase({ system: "SISTEMA_SUP" });
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const resultado = await assembler.assemble({ sessionId, turnText: "consulta generica", now: BASE_MS });

  assert.equal(resultado.context.includes("CONTENIDO_B"), true);
  assert.equal(resultado.context.includes("CONTENIDO_A"), false);
});

test("desempate estable por id ascendente cuando dos nodos empatan exactamente en score", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-empate";

  // RRF fusiona por RANKING (no por score crudo), así que un empate de score CRUDO
  // (mismo vector) en realidad NO empata el score fusionado: el orden de insercion en
  // el heap del vector store desempata el ranking vectorial, y ESE MISMO desempate se
  // propaga al ranking BM25 (ambos ordenados por el mismo orden de insercion) -> en la
  // práctica el resultado ya sale determinista sin que el assembler haga nada, lo cual
  // NO ejercita la regla del contrato.
  //
  // Para forzar un empate real y verificable en el score FUSIONADO se usan dos nodos
  // con rankings OPUESTOS en cada sistema: n-alpha gana en BM25 (cuerpo corto, mayor
  // densidad del termino de la consulta) pero pierde en vector; n-zulu gana en vector
  // (match perfecto) pero pierde en BM25 (cuerpo largo, penalizado por normalizacion
  // de longitud). Con 2 candidatos, rank(alpha)=0 en un sistema y 1 en el otro, y
  // simetricamente para zulu -> score_fusionado(alpha) = 1/(k+1) + 1/(k+2) =
  // score_fusionado(zulu), EXACTAMENTE igual (suma conmutativa), sin importar el orden
  // de insercion. Verificado con un probe directo sobre SemanticCollection: ambos dan
  // 0.032522 y el orden crudo (sin desempate por id) sale n-zulu antes que n-alpha.
  const relleno = "relleno ".repeat(20).trim();
  semanticStores.get("nodes").upsert("n-alpha", { title: "a", body: "marcador breve" }, [1, 1, 0]);
  semanticStores.get("nodes").upsert("n-zulu", { title: "z", body: `marcador ${relleno}` }, [1, 0, 0]);

  const config = configBase({ system: "SISTEMA_EMPATE" });
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const resultado = await assembler.assemble({
    sessionId,
    turnText: "marcador",
    now: BASE_MS,
  });

  const posAlpha = resultado.context.indexOf("breve");
  const posZulu = resultado.context.indexOf("relleno");
  assert.ok(posAlpha >= 0 && posZulu >= 0, "ambos nodos empatados deben estar incluidos");
  assert.ok(
    posAlpha < posZulu,
    "en empate exacto de score fusionado, el orden debe ser por id ascendente (n-alpha antes que n-zulu, aunque el orden crudo del ranking sea n-zulu primero)"
  );
});

// ---------------------------------------------------------------------------
// Presupuesto
// ---------------------------------------------------------------------------

test("presupuesto: S3 se recorta primero, item a item desde el score mas bajo, y el reporte lo marca truncated", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-budget-s3";

  stores.get("sessions").insert(sessionId, { session_id: sessionId, summary: "RES1" });
  insertarTurno(stores, { sessionId, seq: 0, role: "user", text: "A".repeat(40), createdAtMs: BASE_MS });
  insertarTurno(stores, {
    sessionId,
    seq: 1,
    role: "assistant",
    text: "B".repeat(40),
    createdAtMs: BASE_MS + 1000,
  });

  // vocabulario de la consulta deliberadamente ausente de los cuerpos de los nodos,
  // para que el ranking de S3 dependa solo del score vectorial (sin ruido de BM25).
  const turnText = "consulta sobre presupuesto real";

  semanticStores.get("nodes").upsert("n-hi", { title: "hi", body: "H".repeat(40) }, [1, 0, 0]); // score 1.0
  semanticStores.get("nodes").upsert("n-mid", { title: "mid", body: "M".repeat(40) }, [1, 1, 0]); // score ~0.707
  semanticStores.get("nodes").upsert("n-lo", { title: "lo", body: "L".repeat(40) }, [0, 1, 0]); // score 0

  const now = BASE_MS + 1000 + 1000; // interactivo (ttl por defecto 300000ms)
  const configComun = { system: "SYS0", retrieval_k: 3, ttl_ms: 300000, regex_deny: [] };

  // Paso 1: presupuesto amplio -> medimos el tamaño real de S0/S1/S2/S4 (sin asumir
  // el contenido exacto de S0, que el contrato describe como "system + indice de
  // nodos pinned") y confirmamos que con espacio de sobra entran los 3 nodos.
  const amplio = makeAssembler({
    stores,
    semanticStores,
    embedder,
    config: Object.assign({}, configComun, { max_tokens: 100000, output_reserve: 0 }),
  });
  const baseline = await amplio.assemble({ sessionId, turnText, now });
  assert.equal(baseline.context.includes("H".repeat(40)), true);
  assert.equal(baseline.context.includes("M".repeat(40)), true);
  assert.equal(baseline.context.includes("L".repeat(40)), true);

  const s0 = slotPorId(baseline, "S0").tokens;
  const s1 = slotPorId(baseline, "S1").tokens;
  const s2 = slotPorId(baseline, "S2").tokens;
  const s4 = slotPorId(baseline, "S4").tokens;
  assert.equal(s2, 20, "S2 = 2 turnos de 40 chars = 10 tokens cada uno");
  assert.equal(s4, 8, "S4 = ceil(len(turnText)/4)");

  // Paso 2: presupuesto ajustado para que entren S0+S1+S2+S4 completos mas
  // exactamente 1 nodo (10 tokens) de S3 -> el de mejor score sobrevive, el resto
  // se recorta.
  const maxTokensAjustado = s0 + s1 + s2 + s4 + 10;
  const ajustado = makeAssembler({
    stores,
    semanticStores,
    embedder,
    config: Object.assign({}, configComun, { max_tokens: maxTokensAjustado, output_reserve: 0 }),
  });
  const resultado = await ajustado.assemble({ sessionId, turnText, now });

  assert.equal(resultado.context.includes("H".repeat(40)), true, "el nodo de mejor score sobrevive");
  assert.equal(resultado.context.includes("M".repeat(40)), false);
  assert.equal(resultado.context.includes("L".repeat(40)), false);

  const s3rep = slotPorId(resultado, "S3");
  assert.equal(s3rep.included, true);
  assert.equal(s3rep.truncated, true);
  assert.equal(s3rep.tokens, 10);

  // S2 no se vio afectado por el recorte: le tocó su presupuesto completo.
  const s2rep = slotPorId(resultado, "S2");
  assert.equal(s2rep.included, true);
  assert.equal(s2rep.truncated, false);
});

test("presupuesto: S2 nunca se trunca parcialmente (si no entra completo: included:false, truncated:true, sin contenido parcial)", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-budget-s2";

  stores.get("sessions").insert(sessionId, { session_id: sessionId, summary: "RES1" });
  insertarTurno(stores, { sessionId, seq: 0, role: "user", text: "C".repeat(200), createdAtMs: BASE_MS });
  insertarTurno(stores, {
    sessionId,
    seq: 1,
    role: "assistant",
    text: "D".repeat(200),
    createdAtMs: BASE_MS + 1000,
  });

  const turnText = "consulta sobre presupuesto real";
  semanticStores.get("nodes").upsert("n-hi", { title: "hi", body: "H".repeat(40) }, [1, 0, 0]);

  const now = BASE_MS + 1000 + 1000; // interactivo
  const configComun = { system: "SYS0", retrieval_k: 1, ttl_ms: 300000, regex_deny: [] };

  const amplio = makeAssembler({
    stores,
    semanticStores,
    embedder,
    config: Object.assign({}, configComun, { max_tokens: 100000, output_reserve: 0 }),
  });
  const baseline = await amplio.assemble({ sessionId, turnText, now });
  const s0 = slotPorId(baseline, "S0").tokens;
  const s1 = slotPorId(baseline, "S1").tokens;
  assert.equal(slotPorId(baseline, "S2").tokens, 100, "S2 = 2 turnos de 200 chars = 50 tokens cada uno");
  assert.equal(slotPorId(baseline, "S3").tokens, 10);

  // Presupuesto ajustado: tras S0+S1, solo quedan 50 tokens disponibles — menos que
  // los 100 que exige S2 completo -> S2 se excluye ENTERO (no se recorta a la mitad).
  // Esos 50 tokens sobrantes fluyen a S4 (8) y S3 (10), que sí entran completos.
  const maxTokensAjustado = s0 + s1 + 50;
  const ajustado = makeAssembler({
    stores,
    semanticStores,
    embedder,
    config: Object.assign({}, configComun, { max_tokens: maxTokensAjustado, output_reserve: 0 }),
  });
  const resultado = await ajustado.assemble({ sessionId, turnText, now });

  const s2rep = slotPorId(resultado, "S2");
  assert.equal(s2rep.included, false);
  assert.equal(s2rep.truncated, true);
  assert.equal(s2rep.tokens, 0);
  assert.equal(resultado.context.includes("C".repeat(200)), false);
  assert.equal(resultado.context.includes("D".repeat(200)), false);
  // Ni siquiera un fragmento corto del turno vivo debe colarse (cero contenido parcial).
  assert.equal(resultado.context.includes("C".repeat(10)), false);

  for (const id of ["S0", "S1", "S4", "S3"]) {
    assert.equal(slotPorId(resultado, id).included, true, `slot ${id} deberia estar incluido`);
  }
  assert.equal(resultado.context.includes("H".repeat(40)), true);
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

test("guardrail: regex_deny matcheando contenido recuperado aborta con err.code GUARDRAIL nombrando el patron", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-guard";

  semanticStores.get("nodes").upsert(
    "n-secreto",
    { title: "secreto", body: "informacion secreto: 12345 del sistema" },
    [1, 0, 0]
  );

  const config = configBase({ system: "SISTEMA_GUARD", regex_deny: ["secreto:"] });
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });

  await assert.rejects(
    () => assembler.assemble({ sessionId, turnText: "dame detalles", now: BASE_MS }),
    (err) => {
      assert.equal(err.code, "GUARDRAIL");
      assert.ok(err.message.includes("secreto:"), "el mensaje debe nombrar el patron matcheado");
      return true;
    }
  );
});

test("patron regex invalido en config.regex_deny falla con err.code VALIDATION al CONSTRUIR makeAssembler, no al ensamblar", () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const config = configBase({ regex_deny: ["["] }); // "[" es un patron regex invalido

  assert.throws(
    () => makeAssembler({ stores, semanticStores, embedder, config }),
    (err) => {
      assert.equal(err.code, "VALIDATION");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Heuristica de tokens
// ---------------------------------------------------------------------------

test("tokens = ceil(chars/4), verificable en slots[i].tokens de un slot con contenido conocido", async () => {
  const { stores, semanticStores, embedder } = crearEntorno();
  const sessionId = "s-tokens";
  const turnText = "Y".repeat(13); // 13 chars -> ceil(13/4) = 4 tokens

  const config = configBase();
  const assembler = makeAssembler({ stores, semanticStores, embedder, config });
  const resultado = await assembler.assemble({ sessionId, turnText, now: BASE_MS });

  const s4 = slotPorId(resultado, "S4");
  assert.equal(s4.included, true);
  assert.equal(s4.tokens, Math.ceil(turnText.length / 4));
  assert.equal(s4.tokens, 4);
});

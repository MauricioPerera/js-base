// Tests congelados del módulo agent/embedder.js.
//
// Cubren la semántica fijada en knowledge/contracts/agent-embedder.md:
//   - prefijo asimétrico query vs documento en el body enviado a fetchImpl
//   - orden y dim 768 del resultado
//   - caché hit no re-llama a fetchImpl y cacheSize() cuenta
//   - lote mixto ["a","b","a"] deduplica misses (1 llamada, 2 textos únicos, 3 vectores)
//   - claves de caché distintas por isQuery (mismo texto, segunda llamada SÍ llama fetch)
//   - VALIDATION (err.code) en inputs inválidos, sin tocar fetchImpl
//   - EMBEDDER (err.code) en respuesta !ok, en dim distinta de 768 y en longitud
//     desalineada vs misses enviados, y en esos casos no se cachea nada
//
// fetchImpl es un fake inyectado: no requiere Ollama vivo.
// Ejecutar: node --test tests/agent-embedder.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeEmbedder } = require("../agent/embedder.js");

const DIM = 768;

// Genera un vector sintético determinista de dim 768 a partir de un texto.
function vectorFor(text) {
  const v = new Array(DIM);
  for (let i = 0; i < DIM; i += 1) {
    v[i] = ((text.length + i) % 97) / 97;
  }
  return v;
}

// fetchImpl fake: registra cada llamada (body parseado) y responde con vectores
// sintéticos deterministas para cada texto de `input`, en el mismo orden.
function makeFakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return {
      ok: true,
      json: async () => ({ embeddings: body.input.map((t) => vectorFor(t)) }),
    };
  };
  fn.calls = calls;
  return fn;
}

test("embed de query envía el prefijo 'task: search result | query: {t}' en el body", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await embedder.embed(["hola"], { isQuery: true });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(fetchImpl.calls[0].body.input, ["task: search result | query: hola"]);
});

test("embed de documento (default) envía el prefijo 'title: none | text: {t}' en el body", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await embedder.embed(["hola"]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(fetchImpl.calls[0].body.input, ["title: none | text: hola"]);
});

test("el resultado respeta el orden de entrada y cada vector tiene dim 768", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  const res = await embedder.embed(["uno", "dos", "tres"]);
  assert.equal(res.length, 3);
  for (const vec of res) {
    assert.equal(vec.length, DIM);
  }
  // El orden del resultado corresponde al orden de entrada, no al orden interno.
  assert.deepEqual(res[0], vectorFor("title: none | text: uno"));
  assert.deepEqual(res[1], vectorFor("title: none | text: dos"));
  assert.deepEqual(res[2], vectorFor("title: none | text: tres"));
});

test("caché hit no re-llama a fetchImpl y cacheSize() cuenta las entradas", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await embedder.embed(["hola"]);
  assert.equal(embedder.cacheSize(), 1);
  await embedder.embed(["hola"]);
  assert.equal(fetchImpl.calls.length, 1); // segunda llamada fue 100% caché
  assert.equal(embedder.cacheSize(), 1);
});

test("lote mixto ['a','b','a'] deduplica misses: 1 llamada, 2 textos únicos, 3 vectores en orden", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  const res = await embedder.embed(["a", "b", "a"]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.input.length, 2); // "a" y "b" únicos
  assert.equal(res.length, 3);
  assert.deepEqual(res[0], res[2]); // ambas entradas de "a" traen el mismo vector
  assert.deepEqual(res[0], vectorFor("title: none | text: a"));
  assert.deepEqual(res[1], vectorFor("title: none | text: b"));
});

test("mismo texto con isQuery distinto usa claves de caché distintas (segunda llamada SÍ llama fetch)", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await embedder.embed(["hola"]); // documento
  assert.equal(embedder.cacheSize(), 1);
  await embedder.embed(["hola"], { isQuery: true }); // query: prefijo distinto
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(embedder.cacheSize(), 2);
});

test("VALIDATION: embed([]) lanza Error con code 'VALIDATION' sin llamar a fetchImpl", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await assert.rejects(
    () => embedder.embed([]),
    (err) => err instanceof Error && err.code === "VALIDATION"
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("VALIDATION: texts no-array lanza Error con code 'VALIDATION' sin llamar a fetchImpl", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await assert.rejects(
    () => embedder.embed("hola"),
    (err) => err instanceof Error && err.code === "VALIDATION"
  );
  await assert.rejects(
    () => embedder.embed(null),
    (err) => err instanceof Error && err.code === "VALIDATION"
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("VALIDATION: elementos no-string en texts lanza Error con code 'VALIDATION' sin llamar a fetchImpl", async () => {
  const fetchImpl = makeFakeFetch();
  const embedder = makeEmbedder({ fetchImpl });
  await assert.rejects(
    () => embedder.embed(["hola", 123]),
    (err) => err instanceof Error && err.code === "VALIDATION"
  );
  await assert.rejects(
    () => embedder.embed([null]),
    (err) => err instanceof Error && err.code === "VALIDATION"
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("EMBEDDER: fetchImpl responde !ok -> Error con code 'EMBEDDER', no se cachea nada", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: false, json: async () => ({ error: "boom" }) };
  };
  const embedder = makeEmbedder({ fetchImpl });
  await assert.rejects(
    () => embedder.embed(["hola"]),
    (err) => err instanceof Error && err.code === "EMBEDDER"
  );
  assert.equal(embedder.cacheSize(), 0);

  // Una llamada posterior exitosa sí debe llamar a fetchImpl (nada quedó cacheado).
  const fetchOk = makeFakeFetch();
  const embedder2 = makeEmbedder({ fetchImpl: fetchOk });
  await embedder2.embed(["hola"]);
  assert.equal(fetchOk.calls.length, 1);
});

test("EMBEDDER: vector de dim distinta de 768 -> Error con code 'EMBEDDER', no se cachea nada", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ embeddings: body.input.map(() => new Array(5).fill(0)) }),
    };
  };
  const embedder = makeEmbedder({ fetchImpl });
  await assert.rejects(
    () => embedder.embed(["hola"]),
    (err) => err instanceof Error && err.code === "EMBEDDER"
  );
  assert.equal(embedder.cacheSize(), 0);

  const fetchOk = makeFakeFetch();
  const embedder2 = makeEmbedder({ fetchImpl: fetchOk });
  await embedder2.embed(["hola"]);
  assert.equal(fetchOk.calls.length, 1);
});

test("EMBEDDER: longitud de embeddings desalineada vs misses enviados -> Error con code 'EMBEDDER', no se cachea nada", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); // 2 textos únicos esperados ("a", "b")
    return {
      ok: true,
      json: async () => ({ embeddings: [vectorFor(body.input[0])] }), // solo 1, desalineado
    };
  };
  const embedder = makeEmbedder({ fetchImpl });
  await assert.rejects(
    () => embedder.embed(["a", "b"]),
    (err) => err instanceof Error && err.code === "EMBEDDER"
  );
  assert.equal(embedder.cacheSize(), 0);

  const fetchOk = makeFakeFetch();
  const embedder2 = makeEmbedder({ fetchImpl: fetchOk });
  await embedder2.embed(["a", "b"]);
  assert.equal(fetchOk.calls.length, 1);
});

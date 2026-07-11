'use strict';

const crypto = require('node:crypto');

const DIM = 768;

function codedError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause !== undefined) {
    err.cause = cause;
  }
  return err;
}

function validateInputs(texts) {
  if (!Array.isArray(texts)) {
    throw codedError('VALIDATION', 'texts must be a non-empty array of strings');
  }
  if (texts.length === 0) {
    throw codedError('VALIDATION', 'texts array must not be empty');
  }
  for (const t of texts) {
    if (typeof t !== 'string') {
      throw codedError('VALIDATION', 'all elements in texts must be strings');
    }
  }
}

function computeKey(prefixedText) {
  return crypto.createHash('sha256').update(prefixedText).digest('hex');
}

function applyPrefix(text, isQuery) {
  if (isQuery) {
    return `task: search result | query: ${text}`;
  }
  return `title: none | text: ${text}`;
}

function findMisses(cache, keys, prefixedTexts) {
  const misses = [];
  const missKeys = new Set();
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!cache.has(key) && !missKeys.has(key)) {
      misses.push(prefixedTexts[i]);
      missKeys.add(key);
    }
  }
  return misses;
}

function validateResponse(data, missesLength) {
  if (!Array.isArray(data.embeddings)) {
    throw codedError('EMBEDDER', 'response missing embeddings array');
  }
  if (data.embeddings.length !== missesLength) {
    throw codedError(
      'EMBEDDER',
      `embeddings length mismatch: got ${data.embeddings.length}, expected ${missesLength}`
    );
  }
  for (const vec of data.embeddings) {
    if (!Array.isArray(vec) || vec.length !== DIM) {
      throw codedError('EMBEDDER', `vector has invalid dimension (expected ${DIM})`);
    }
  }
}

async function fetchEmbeddings(fetchImpl, url, model, inputs) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs }),
  };
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw codedError('EMBEDDER', 'failed to fetch embeddings', err);
  }
  if (!response.ok) {
    throw codedError('EMBEDDER', 'embedder response not ok');
  }
  try {
    return await response.json();
  } catch (err) {
    throw codedError('EMBEDDER', 'failed to parse embeddings response', err);
  }
}

function makeEmbedder(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const baseUrl = opts.baseUrl || 'http://localhost:11434';
  const model = opts.model || 'embeddinggemma';
  const cache = new Map();

  async function embed(texts, embedOpts = {}) {
    validateInputs(texts);
    const isQuery = embedOpts.isQuery || false;
    const prefixedTexts = texts.map((text) => applyPrefix(text, isQuery));
    const keys = prefixedTexts.map((prefixedText) => computeKey(prefixedText));
    const misses = findMisses(cache, keys, prefixedTexts);

    if (misses.length > 0) {
      const data = await fetchEmbeddings(fetchImpl, `${baseUrl}/api/embed`, model, misses);
      validateResponse(data, misses.length);
      for (let i = 0; i < misses.length; i += 1) {
        cache.set(computeKey(misses[i]), data.embeddings[i]);
      }
    }

    return keys.map((key) => cache.get(key));
  }

  function cacheSize() {
    return cache.size;
  }

  return { embed, cacheSize };
}

module.exports = { makeEmbedder };

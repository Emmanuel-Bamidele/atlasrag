//
//  ai.js
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// ai.js
// This file talks to OpenAI to create embeddings (vectors)
// Embeddings = numbers that represent the meaning of text

// We use the official OpenAI JS client
const OpenAI = require("openai");
const crypto = require("crypto");
const { DEFAULT_EMBED_MODEL, normalizeModelId } = require("./model_config");

let defaultClient = null;
function createClient(key) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) {
    throw new Error("OPENAI_API_KEY not set on server");
  }
  const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
  const options = { apiKey: cleanKey };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    options.timeout = timeoutMs;
  }
  return new OpenAI(options);
}

function getClient(apiKey = "") {
  const overrideKey = String(apiKey || "").trim();
  if (overrideKey) {
    return createClient(overrideKey);
  }
  if (defaultClient) return defaultClient;
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY not set on server");
  }
  defaultClient = createClient(key);
  return defaultClient;
}

const DEFAULT_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);
const FALLBACK_DIM = parseInt(process.env.EMBED_FALLBACK_DIM || "1536", 10);
const EMBED_FALLBACK_ON_ERROR = process.env.EMBED_FALLBACK_ON_ERROR !== "0";
let fallbackWarned = false;

function resolveEmbedModel(options = {}) {
  return normalizeModelId(options?.embedModel)
    || normalizeModelId(process.env.EMBED_MODEL)
    || DEFAULT_EMBED_MODEL;
}

function warnFallback(reason) {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(`[embed] OpenAI embeddings unavailable, using deterministic local fallback (${reason})`);
}

function normalizeVector(values) {
  let normSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    normSq += values[i] * values[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return values;
  for (let i = 0; i < values.length; i += 1) {
    values[i] /= norm;
  }
  return values;
}

function estimateTokensFromText(text) {
  const chars = String(text || "").length;
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function fallbackEmbedding(text) {
  const dim = Number.isFinite(FALLBACK_DIM) && FALLBACK_DIM > 8 ? Math.floor(FALLBACK_DIM) : 1536;
  const vector = new Array(dim).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9._:@-]+/g)
    .filter(Boolean);

  if (!tokens.length) return vector;

  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest();
    for (let i = 0; i + 3 < digest.length; i += 4) {
      const idx = ((digest[i] << 8) | digest[i + 1]) % dim;
      const sign = (digest[i + 2] & 1) === 1 ? 1 : -1;
      const magnitude = 0.25 + (digest[i + 3] / 255) * 0.75;
      vector[idx] += sign * magnitude;
    }
  }

  return normalizeVector(vector);
}

function fallbackEmbeddings(texts, reason, usage) {
  warnFallback(reason);
  let estimatedPromptTokens = 0;
  for (const text of texts) {
    estimatedPromptTokens += estimateTokensFromText(text);
  }
  usage.prompt_tokens += estimatedPromptTokens;
  usage.total_tokens += estimatedPromptTokens;
  usage.estimated = true;
  const vectors = texts.map((text) => fallbackEmbedding(text));
  usage.fallback = true;
  return vectors;
}

// embedTexts takes an array of strings and returns an array of vectors
function normalizeEmbedOptions(batchSizeOrOptions) {
  if (typeof batchSizeOrOptions === "number") {
    return { batchSize: batchSizeOrOptions };
  }
  if (batchSizeOrOptions && typeof batchSizeOrOptions === "object") {
    return batchSizeOrOptions;
  }
  return {};
}

async function embedTexts(texts, batchSizeOrOptions = DEFAULT_BATCH_SIZE) {
  const out = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  const options = normalizeEmbedOptions(batchSizeOrOptions);
  const safeBatch = Number.isFinite(options.batchSize) && options.batchSize > 0 ? options.batchSize : 64;
  const list = Array.isArray(texts) ? texts : [];

  let client = null;
  try {
    client = getClient(options.apiKey);
  } catch (err) {
    if (!EMBED_FALLBACK_ON_ERROR) throw err;
    return {
      vectors: fallbackEmbeddings(list, String(err?.message || err || "client init failed"), usage),
      usage
    };
  }

  for (let i = 0; i < list.length; i += safeBatch) {
    const slice = list.slice(i, i + safeBatch);

    try {
      // Call OpenAI embeddings API
      const resp = await client.embeddings.create({
        model: resolveEmbedModel(options),
        input: slice
      });

      // resp.data is an array, each item has .embedding (float array)
      out.push(...resp.data.map(x => x.embedding));
      if (resp.usage) {
        usage.prompt_tokens += Number(resp.usage.prompt_tokens || 0);
        usage.total_tokens += Number(resp.usage.total_tokens || 0);
      }
    } catch (err) {
      if (!EMBED_FALLBACK_ON_ERROR) throw err;
      out.push(...fallbackEmbeddings(slice, String(err?.message || err || "request failed"), usage));
    }
  }

  return { vectors: out, usage };
}

module.exports = {
  embedTexts,
  __testHooks: {
    resolveEmbedModel
  }
};

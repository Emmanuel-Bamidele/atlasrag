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

let defaultClient = null;
function getClient() {
  if (defaultClient) return defaultClient;
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY not set on server");
  }
  const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
  const options = { apiKey: key };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    options.timeout = timeoutMs;
  }
  defaultClient = new OpenAI(options);
  return defaultClient;
}

const DEFAULT_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);

// embedTexts takes an array of strings and returns an array of vectors
async function embedTexts(texts, batchSize = DEFAULT_BATCH_SIZE) {
  const client = getClient();
  const out = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  const safeBatch = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 64;

  for (let i = 0; i < texts.length; i += safeBatch) {
    const slice = texts.slice(i, i + safeBatch);

    // Call OpenAI embeddings API
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small", // good default
      input: slice
    });

    // resp.data is an array, each item has .embedding (float array)
    out.push(...resp.data.map(x => x.embedding));
    if (resp.usage) {
      usage.prompt_tokens += Number(resp.usage.prompt_tokens || 0);
      usage.total_tokens += Number(resp.usage.total_tokens || 0);
    }
  }

  return { vectors: out, usage };
}

module.exports = { embedTexts };

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
  defaultClient = new OpenAI({ apiKey: key });
  return defaultClient;
}

const DEFAULT_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);

// embedTexts takes an array of strings and returns an array of vectors
async function embedTexts(texts, batchSize = DEFAULT_BATCH_SIZE) {
  const client = getClient();
  const out = [];
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
  }

  return out;
}

module.exports = { embedTexts };

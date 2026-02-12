//
//  ai.js
//  mini_redis
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// ai.js
// This file talks to OpenAI to create embeddings (vectors)
// Embeddings = numbers that represent the meaning of text

// We use the official OpenAI JS client
const OpenAI = require("openai");

// Create client using API key from environment variables
// process.env = environment variables in Node
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const DEFAULT_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);

// embedTexts takes an array of strings and returns an array of vectors
async function embedTexts(texts, batchSize = DEFAULT_BATCH_SIZE) {
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

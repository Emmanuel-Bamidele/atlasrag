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

// embedTexts takes an array of strings and returns an array of vectors
async function embedTexts(texts) {

  // Call OpenAI embeddings API
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small", // good default
    input: texts
  });

  // resp.data is an array, each item has .embedding (float array)
  return resp.data.map(x => x.embedding);
}

module.exports = { embedTexts };


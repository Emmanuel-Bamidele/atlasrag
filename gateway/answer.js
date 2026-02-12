//
//  answer.js
//  mini_redis
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// answer.js
// This file generates an answer using retrieved chunks (RAG = Retrieval-Augmented Generation).

const OpenAI = require("openai");

// Create OpenAI client using OPENAI_API_KEY env var
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Build a prompt that forces the model to use only the provided context.
// We also request citations by chunk_id.
function buildPrompt(question, chunks) {

  // chunks is an array like: [{ chunk_id, text, doc_id, idx }, ...]
  // We will format them so the model can cite them.
  const context = chunks.map((c) => {
    return `SOURCE ${c.chunk_id}\n${c.text}`;
  }).join("\n\n---\n\n");

  return `
You are an assistant answering questions using ONLY the sources below.
If the sources do not contain the answer, say: "I don't know based on the provided sources."

When you answer, add a "Citations:" line at the end listing the SOURCE ids you used.

Question:
${question}

Sources:
${context}
`.trim();
}

// Generate answer text from OpenAI Responses API
async function generateAnswer(question, chunks) {

  // If no chunks, we can't answer
  if (!chunks || chunks.length === 0) {
    return {
      answer: "I don't know based on the provided sources.",
      citations: []
    };
  }

  const input = buildPrompt(question, chunks);

  // Use Responses API with a lightweight model
  // The docs show using openai.responses.create({ model, input }) :contentReference[oaicite:1]{index=1}
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    input
  });

  // openai SDK returns combined text via output_text
  const text = (resp.output_text || "").trim();

  // Simple citation parsing:
  // We asked it to output: "Citations: doc#0, doc#3"
  let citations = [];
  const match = text.match(/Citations:\s*(.*)$/i);
  if (match && match[1]) {
    citations = match[1]
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  return { answer: text, citations };
}

module.exports = { generateAnswer };

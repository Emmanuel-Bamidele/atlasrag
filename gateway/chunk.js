//
//  chunk.js
//  mini_redis
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// chunk.js
// Very simple chunking: split by paragraphs and keep chunks under a max length.
// This is not perfect token-based chunking, but it's good for MVP.

function chunkText(docId, text, maxChars = 900) {

  // Split by blank lines or newlines
  const parts = text.split(/\n\s*\n/);

  const chunks = [];
  let current = "";

  for (const p of parts) {

    const paragraph = p.trim();
    if (!paragraph) continue;

    // If adding this paragraph would exceed maxChars, flush current chunk
    if ((current + "\n\n" + paragraph).length > maxChars) {
      if (current.trim().length > 0) {
        chunks.push(current.trim());
      }
      current = paragraph;
    } else {
      current = current ? (current + "\n\n" + paragraph) : paragraph;
    }
  }

  // Flush last chunk
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  // Create chunk objects with IDs like: doc1#0, doc1#1...
  return chunks.map((chunkText, i) => ({
    chunkId: `${docId}#${i}`,
    text: chunkText
  }));
}

module.exports = { chunkText };

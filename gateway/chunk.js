//
//  chunk.js
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// chunk.js
// Very simple chunking: split by paragraphs and keep chunks under a max length.
// This is not perfect token-based chunking, but it's good for MVP.

function splitLongParagraph(paragraph, maxChars) {
  const parts = [];
  let remaining = paragraph.trim();

  while (remaining.length > maxChars) {
    let cut = -1;
    const window = remaining.slice(0, maxChars + 1);
    for (let i = window.length - 1; i >= 0; i -= 1) {
      if (/\s/.test(window[i])) {
        cut = i;
        break;
      }
    }

    if (cut < Math.floor(maxChars * 0.6)) {
      cut = maxChars;
    }

    const piece = remaining.slice(0, cut).trim();
    if (piece) parts.push(piece);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function chunkText(docId, text, maxChars = 900) {

  // Split by blank lines or newlines
  const parts = text.split(/\n\s*\n/);

  const chunks = [];
  let current = "";

  for (const p of parts) {

    const paragraph = p.trim();
    if (!paragraph) continue;

    const pieces = paragraph.length > maxChars
      ? splitLongParagraph(paragraph, maxChars)
      : [paragraph];

    for (const piece of pieces) {
      // If adding this piece would exceed maxChars, flush current chunk
      if ((current + "\n\n" + piece).length > maxChars) {
        if (current.trim().length > 0) {
          chunks.push(current.trim());
        }
        current = piece;
      } else {
        current = current ? (current + "\n\n" + piece) : piece;
      }
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

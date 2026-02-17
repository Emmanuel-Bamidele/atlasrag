//
//  chunk.js
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// chunk.js
// Supports two chunking strategies:
// - "char": paragraph-aware by max chars (legacy behavior)
// - "token": approximate token windows with overlap

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_MAX_TOKENS = 220;
const DEFAULT_OVERLAP_TOKENS = 40;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeStrategy(value) {
  const strategy = String(value || "char").trim().toLowerCase();
  return strategy === "token" ? "token" : "char";
}

function resolveChunkOptions(optionsOrMaxChars) {
  if (Number.isFinite(optionsOrMaxChars)) {
    return {
      strategy: "char",
      maxChars: toPositiveInt(optionsOrMaxChars, DEFAULT_MAX_CHARS),
      maxTokens: DEFAULT_MAX_TOKENS,
      overlapTokens: DEFAULT_OVERLAP_TOKENS
    };
  }

  const opts = optionsOrMaxChars && typeof optionsOrMaxChars === "object" ? optionsOrMaxChars : {};
  const strategy = normalizeStrategy(opts.strategy);
  const maxChars = toPositiveInt(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxTokens = toPositiveInt(opts.maxTokens, DEFAULT_MAX_TOKENS);
  const rawOverlap = toNonNegativeInt(opts.overlapTokens, DEFAULT_OVERLAP_TOKENS);
  const overlapTokens = Math.max(0, Math.min(rawOverlap, Math.max(0, maxTokens - 1)));

  return { strategy, maxChars, maxTokens, overlapTokens };
}

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

function chunkByChars(text, maxChars) {
  const parts = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const part of parts) {
    const paragraph = part.trim();
    if (!paragraph) continue;

    const pieces = paragraph.length > maxChars
      ? splitLongParagraph(paragraph, maxChars)
      : [paragraph];

    for (const piece of pieces) {
      if (current && (current.length + 2 + piece.length) > maxChars) {
        chunks.push(current.trim());
        current = piece;
        continue;
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }
  return chunks;
}

function collectTokenSpans(text) {
  const spans = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return spans;
}

function chunkByApproxTokens(text, maxTokens, overlapTokens) {
  const spans = collectTokenSpans(text);
  if (spans.length === 0) return [];

  const stride = Math.max(1, maxTokens - overlapTokens);
  const chunks = [];

  for (let start = 0; start < spans.length; start += stride) {
    const endExclusive = Math.min(start + maxTokens, spans.length);
    const startChar = spans[start].start;
    const endChar = spans[endExclusive - 1].end;
    const chunk = text.slice(startChar, endChar).trim();
    if (chunk) chunks.push(chunk);
    if (endExclusive >= spans.length) break;
  }

  return chunks;
}

function chunkText(docId, text, optionsOrMaxChars = DEFAULT_MAX_CHARS) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return [];

  const options = resolveChunkOptions(optionsOrMaxChars);
  let chunks = options.strategy === "token"
    ? chunkByApproxTokens(cleanText, options.maxTokens, options.overlapTokens)
    : chunkByChars(cleanText, options.maxChars);

  if (chunks.length === 0) {
    chunks = chunkByChars(cleanText, options.maxChars);
  }

  return chunks.map((chunk, i) => ({
    chunkId: `${docId}#${i}`,
    text: chunk
  }));
}

module.exports = { chunkText };

// index.js
const express = require("express");

const { embedTexts } = require("./ai");
const { chunkText } = require("./chunk");
const { sendCmd, buildVset, buildVsearch, parseVsearchReply } = require("./tcp");

const { saveChunk, getChunksByIds, deleteDoc } = require("./db");
const { requireApiKey, limiter } = require("./security");
const { generateAnswer } = require("./answer");

const app = express();

app.use(express.json());

// Static UI is public (safe)
app.use(express.static("public"));

// Apply rate limiting to ALL API routes
app.use(limiter);

const MAX_DOC_CHARS = 200000;
const MAX_FETCH_CHARS = 1000000;

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  const map = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };

  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    const lower = code.toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const num = parseInt(isHex ? lower.slice(2) : lower.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(num)) return m;
      try {
        return String.fromCodePoint(num);
      } catch {
        return m;
      }
    }
    return map[lower] ?? m;
  });
}

function extractTextFromHtml(html) {
  let out = String(html || "");
  out = out.replace(/<script[\s\S]*?<\/script>/gi, " ");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, " ");
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  out = out.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr|td|th|blockquote)>/gi, "\n");
  out = out.replace(/<li[^>]*>/gi, "- ");
  out = out.replace(/<[^>]+>/g, " ");
  out = decodeHtmlEntities(out);
  return out;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase();

  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(n => parseInt(n, 10));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
}

async function fetchUrlText(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http/https URLs are supported.");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error("URL host is blocked for safety.");
  }

  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Fetch failed with ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";
  let raw = await res.text();
  let truncated = false;
  if (raw.length > MAX_FETCH_CHARS) {
    raw = raw.slice(0, MAX_FETCH_CHARS);
    truncated = true;
  }

  let text;
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    text = extractTextFromHtml(raw);
  } else if (contentType.startsWith("text/") || contentType.includes("application/json") || contentType.includes("application/xml")) {
    text = raw;
  } else {
    throw new Error(`Unsupported content-type: ${contentType || "unknown"}`);
  }

  text = normalizeWhitespace(text);
  if (!text.trim()) {
    throw new Error("No extractable text found at URL.");
  }

  return { text, contentType, truncated };
}

async function indexDocument(docId, text) {
  let cleanText = String(text || "");
  cleanText = cleanText.trim();
  if (!cleanText) {
    throw new Error("text produced no chunks");
  }

  let truncated = false;
  if (cleanText.length > MAX_DOC_CHARS) {
    cleanText = cleanText.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }

  const chunks = chunkText(docId, cleanText);
  if (chunks.length === 0) {
    throw new Error("text produced no chunks");
  }

  const texts = chunks.map(c => c.text);
  const vectors = await embedTexts(texts);

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = chunks[i].chunkId;
    const chunkTxt = chunks[i].text;

    // Save chunk text persistently
    await saveChunk({
      chunkId,
      docId,
      idx: i,
      text: chunkTxt
    });

    // Store embedding in C++ vector DB
    const cmd = buildVset(chunkId, vectors[i]);
    await sendCmd(cmd);
  }

  return { chunksIndexed: chunks.length, truncated };
}

// --------------------------
// Health check (public)
// --------------------------
app.get("/health", async (req, res) => {
  try {
    const reply = await sendCmd("PING");
    res.json({ ok: true, tcp: reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------------------
// Stats (protected)
// --------------------------
app.get("/stats", requireApiKey, async (req, res) => {
  const reply = await sendCmd("STATS");
  res.json(JSON.parse(reply));
});

// =======================================================
// SEMANTIC / GENAI ENDPOINTS (protected)
// =======================================================

// POST /docs { docId, text }
// - chunk text
// - embed chunks
// - store vectors in C++ (VSET)
// - store chunk text in Postgres
app.post("/docs", requireApiKey, async (req, res) => {
  const { docId, text } = req.body || {};

  const cleanDocId = String(docId || "").trim();

  if (!cleanDocId || !text) {
    return res.status(400).json({ error: "docId and text required" });
  }

  try {
    const { chunksIndexed, truncated } = await indexDocument(cleanDocId, text);
    res.json({ ok: true, docId: cleanDocId, chunksIndexed, truncated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// POST /docs/url { docId, url }
// - fetch URL
// - extract text
// - index like /docs
app.post("/docs/url", requireApiKey, async (req, res) => {
  const { docId, url } = req.body || {};
  const cleanDocId = String(docId || "").trim();
  const cleanUrl = String(url || "").trim();

  if (!cleanDocId || !cleanUrl) {
    return res.status(400).json({ error: "docId and url required" });
  }

  try {
    const fetched = await fetchUrlText(cleanUrl);
    const { chunksIndexed, truncated } = await indexDocument(cleanDocId, fetched.text);

    res.json({
      ok: true,
      docId: cleanDocId,
      url: cleanUrl,
      contentType: fetched.contentType || null,
      extractedChars: fetched.text.length,
      fetchTruncated: fetched.truncated,
      docTruncated: truncated,
      chunksIndexed
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});


// POST /ask
// Body: { question, k? }
// Steps:
//  1) embed question
//  2) VSEARCH top-k
//  3) fetch chunks from Postgres
//  4) call OpenAI to generate answer using sources
app.post("/ask", requireApiKey, async (req, res) => {

  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "5", 10);

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  // 1) Embed question (uses text-embedding-3-small by default in your ai.js) :contentReference[oaicite:2]{index=2}
  const [qvec] = await embedTexts([question]);

  // 2) Ask C++ for top-k chunk IDs
  const cmd = buildVsearch(k, qvec);
  const line = await sendCmd(cmd);
  const matches = parseVsearchReply(line);

  // 3) Fetch chunk text from Postgres
  const ids = matches.map(m => m.id);
  const chunkMap = await getChunksByIds(ids);

  // Build ordered chunk list (same order as matches)
  const chunks = matches
    .map(m => chunkMap.get(m.id))
    .filter(Boolean);

  // 4) Generate answer from OpenAI using retrieved chunks :contentReference[oaicite:3]{index=3}
  const { answer, citations } = await generateAnswer(question, chunks);

  // Return answer + retrieval details
  res.json({
    question,
    answer,
    citations,     // chunk ids the model claims it used
    matches: matches.map(m => ({
      id: m.id,
      score: m.score,
      preview: chunkMap.get(m.id)?.text?.slice(0, 160) || null
    }))
  });
});


// DELETE /docs/:docId
// - remove text rows from Postgres
// - NOTE: vectors remain unless you also track chunk IDs.
// For MVP, we just delete text. Next iteration we can also delete vectors.
app.delete("/docs/:docId", requireApiKey, async (req, res) => {
  const docId = req.params.docId;
  await deleteDoc(docId);
  res.json({ ok: true, docId, note: "Deleted chunk text; vector deletion is a next improvement." });
});

// GET /search?q=...&k=5
// - embed query
// - VSEARCH top-k
// - fetch chunk texts from Postgres for previews
app.get("/search", requireApiKey, async (req, res) => {
  const q = req.query.q;
  const k = parseInt(req.query.k || "5", 10);

  if (!q) return res.status(400).json({ error: "q query param required" });

  const [qvec] = await embedTexts([q]);

  const cmd = buildVsearch(k, qvec);
  const line = await sendCmd(cmd);

  const matches = parseVsearchReply(line);

  // fetch chunk text for matches
  const ids = matches.map(m => m.id);
  const chunkMap = await getChunksByIds(ids);

  const results = matches.map(m => {
    const row = chunkMap.get(m.id);
    const preview = row ? row.text.slice(0, 180) : "(missing chunk text)";
    return {
      id: m.id,
      score: m.score,
      docId: row ? row.doc_id : null,
      preview
    };
  });

  res.json({ query: q, results });
});

app.listen(3000, () => {
  console.log("HTTP gateway listening on http://localhost:3000");
});

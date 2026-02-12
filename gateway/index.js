// index.js
const express = require("express");

const { embedTexts } = require("./ai");
const { chunkText } = require("./chunk");
const { sendCmd, buildVset, buildVsearch, parseVsearchReply } = require("./tcp");

const {
  saveChunk,
  getChunksByIds,
  deleteDoc,
  listDocsByTenant,
  recordFailedLogin,
  recordSuccessfulLogin,
  runMigrations,
  upsertSsoUser
} = require("./db");
const { requireJwt, limiter, loginLimiter } = require("./security");
const { generateAnswer } = require("./answer");
const { verifyCredentials, issueToken } = require("./auth");
const { recordLatency, getLatencyStats } = require("./metrics");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const {
  generators,
  getClient,
  getRedirectUri,
  buildStateCookie,
  resolveTenant,
  getUserProfile
} = require("./sso");

const app = express();

app.use(express.json({ limit: "8mb" }));
app.use(cookieParser(process.env.COOKIE_SECRET || process.env.JWT_SECRET || "atlasrag-cookie-secret"));

// Static UI is public (safe)
app.use(express.static("public"));

// Apply rate limiting to ALL API routes
app.use(limiter);

// Latency tracking (API routes only)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const routePath = req.route?.path || req.path || "";
    const isApi = routePath.startsWith("/docs") ||
      routePath.startsWith("/ask") ||
      routePath.startsWith("/search") ||
      routePath.startsWith("/stats") ||
      routePath.startsWith("/health") ||
      routePath.startsWith("/login") ||
      routePath.startsWith("/auth");

    if (!isApi) return;
    const key = `${req.method} ${routePath}`;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    recordLatency(key, ms, res.statusCode);
  });
  next();
});

const MAX_DOC_CHARS = 200000;
const MAX_FETCH_CHARS = 1000000;
const DEBUG_INDEX = process.env.DEBUG_INDEX === "1";
const DOC_ID_RE = /^[a-zA-Z0-9._-]+$/;
const TENANT_RE = /^[a-zA-Z0-9._-]+$/;
const TENANT_SEARCH_MULTIPLIER = parseInt(process.env.TENANT_SEARCH_MULTIPLIER || "5", 10);
const TENANT_SEARCH_CAP = parseInt(process.env.TENANT_SEARCH_CAP || "50", 10);

function logIndex(message) {
  if (DEBUG_INDEX) {
    console.log(`[index] ${message}`);
  }
}

function isValidDocId(docId) {
  return DOC_ID_RE.test(docId);
}

function getTenantId(req) {
  const tenant = req.user?.tenant || req.user?.tid || req.user?.sub;
  const clean = String(tenant || "").trim();
  if (!clean || !TENANT_RE.test(clean)) {
    throw new Error("Invalid tenant in token");
  }
  return clean;
}

function namespaceDocId(tenantId, docId) {
  return `${tenantId}::${docId}`;
}

function stripTenantPrefix(tenantId, value) {
  const prefix = `${tenantId}::`;
  return String(value || "").startsWith(prefix) ? String(value).slice(prefix.length) : String(value || "");
}

function parseDocFilter(raw) {
  if (!raw) return [];
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    list = raw.split(",");
  } else {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean || !isValidDocId(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

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

async function indexDocument(tenantId, docId, text) {
  const startAt = Date.now();
  let cleanText = String(text || "");
  cleanText = cleanText.trim();
  if (!cleanText) {
    throw new Error("text produced no chunks");
  }

  const namespacedDocId = namespaceDocId(tenantId, docId);

  let truncated = false;
  if (cleanText.length > MAX_DOC_CHARS) {
    cleanText = cleanText.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }

  logIndex(`start tenant=${tenantId} docId=${docId} chars=${cleanText.length} truncated=${truncated}`);

  const chunks = chunkText(namespacedDocId, cleanText);
  if (chunks.length === 0) {
    throw new Error("text produced no chunks");
  }

  logIndex(`chunked docId=${docId} chunks=${chunks.length}`);

  const texts = chunks.map(c => c.text);
  const embedStart = Date.now();
  const vectors = await embedTexts(texts);
  logIndex(`embedded docId=${docId} vectors=${vectors.length} ms=${Date.now() - embedStart}`);

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = chunks[i].chunkId;
    const chunkTxt = chunks[i].text;

    // Save chunk text persistently
    await saveChunk({
      chunkId,
      docId: namespacedDocId,
      idx: i,
      text: chunkTxt
    });

    // Store embedding in C++ vector DB
    const cmd = buildVset(chunkId, vectors[i]);
    const vsetStart = Date.now();
    await sendCmd(cmd);
    if (DEBUG_INDEX) {
      logIndex(`vset ${i + 1}/${chunks.length} chunkId=${chunkId} ms=${Date.now() - vsetStart}`);
    }
  }

  logIndex(`done tenant=${tenantId} docId=${docId} chunks=${chunks.length} totalMs=${Date.now() - startAt}`);
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
// Login (public)
// --------------------------
app.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "").trim();

  if (!cleanUser || !cleanPass) {
    return res.status(400).json({ error: "username and password required" });
  }

  const maxAttempts = parseInt(process.env.AUTH_MAX_ATTEMPTS || "5", 10);
  const lockMinutes = parseInt(process.env.AUTH_LOCK_MINUTES || "15", 10);

  const result = await verifyCredentials(cleanUser, cleanPass);
  if (!result.ok) {
    if (result.reason === "locked") {
      return res.status(423).json({ error: "Account locked. Try later." });
    }
    if (result.reason === "disabled") {
      return res.status(403).json({ error: "Account disabled." });
    }
    if (result.reason === "sso_only") {
      return res.status(403).json({ error: "Account requires SSO login." });
    }
    if (result.user) {
      await recordFailedLogin(cleanUser, maxAttempts, lockMinutes);
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  try {
    await recordSuccessfulLogin(result.user.id);
    const token = issueToken(result.user);
    res.json({
      ok: true,
      token,
      tenant: result.user.tenant || result.user.username
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --------------------------
// SSO Login (public)
// --------------------------
app.get("/auth/:provider/login", async (req, res) => {
  const provider = String(req.params.provider || "").trim();
  try {
    const { client, cfg } = await getClient(provider);
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    const cookieName = buildStateCookie(provider);
    const payload = JSON.stringify({ state, nonce, codeVerifier });
    res.cookie(cookieName, payload, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "1",
      maxAge: 5 * 60 * 1000,
      signed: true
    });

    const redirectUri = getRedirectUri(provider);
    const authUrl = client.authorizationUrl({
      scope: cfg.scopes,
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    return res.redirect(authUrl);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/auth/:provider/callback", async (req, res) => {
  const provider = String(req.params.provider || "").trim();
  try {
    const { client, cfg } = await getClient(provider);
    const cookieName = buildStateCookie(provider);
    const raw = req.signedCookies[cookieName];
    if (!raw) {
      return res.status(400).json({ error: "Missing login state" });
    }

    res.clearCookie(cookieName);

    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "Invalid login state" });
    }

    const params = client.callbackParams(req);
    const tokenSet = await client.callback(
      getRedirectUri(provider),
      params,
      { state: saved.state, nonce: saved.nonce, code_verifier: saved.codeVerifier }
    );

    const claims = tokenSet.claims();
    const tenant = resolveTenant(claims, cfg);
    if (!tenant || !TENANT_RE.test(tenant)) {
      return res.status(400).json({ error: "Invalid tenant from IdP" });
    }

    const subject = String(claims.sub || "").trim();
    if (!subject) {
      return res.status(400).json({ error: "Invalid subject from IdP" });
    }

    const profile = getUserProfile(claims);
    const randomPass = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPass, 12);

    const user = await upsertSsoUser({
      provider,
      subject,
      tenantId: tenant,
      email: profile.email,
      fullName: profile.name,
      passwordHash
    });

    const token = issueToken({
      username: user.username,
      tenant: user.tenant_id,
      roles: user.roles || []
    });

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>SSO Login</title></head>
  <body>
    <script>
      localStorage.setItem("atlasragJwt", ${JSON.stringify(token)});
      window.location.href = "/";
    </script>
  </body>
</html>`;
    return res.status(200).send(html);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
});

// --------------------------
// Stats (protected)
// --------------------------
app.get("/stats", requireJwt, async (req, res) => {
  const reply = await sendCmd("STATS");
  const tcpStats = JSON.parse(reply);
  const gatewayStats = {
    latency: getLatencyStats()
  };
  res.json({ ...tcpStats, gateway: gatewayStats });
});

// =======================================================
// SEMANTIC / GENAI ENDPOINTS (protected)
// =======================================================

// GET /docs
// - list docs for the current tenant
app.get("/docs", requireJwt, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const rows = await listDocsByTenant(tenantId);
    const docs = rows
      .map((row) => ({
        docId: stripTenantPrefix(tenantId, row.doc_id),
        chunks: Number(row.chunks || 0)
      }))
      .filter((row) => row.docId);
    res.json({ docs, totalDocs: docs.length });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// POST /docs { docId, text }
// - chunk text
// - embed chunks
// - store vectors in C++ (VSET)
// - store chunk text in Postgres
app.post("/docs", requireJwt, async (req, res) => {
  const { docId, text } = req.body || {};

  const cleanDocId = String(docId || "").trim();

  if (!cleanDocId || !text) {
    return res.status(400).json({ error: "docId and text required" });
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)" });
  }

  try {
    const tenantId = getTenantId(req);
    const { chunksIndexed, truncated } = await indexDocument(tenantId, cleanDocId, text);
    res.json({ ok: true, docId: cleanDocId, chunksIndexed, truncated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// POST /docs/url { docId, url }
// - fetch URL
// - extract text
// - index like /docs
app.post("/docs/url", requireJwt, async (req, res) => {
  const { docId, url } = req.body || {};
  const cleanDocId = String(docId || "").trim();
  const cleanUrl = String(url || "").trim();

  if (!cleanDocId || !cleanUrl) {
    return res.status(400).json({ error: "docId and url required" });
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)" });
  }

  try {
    const tenantId = getTenantId(req);
    const fetched = await fetchUrlText(cleanUrl);
    const { chunksIndexed, truncated } = await indexDocument(tenantId, cleanDocId, fetched.text);

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
app.post("/ask", requireJwt, async (req, res) => {

  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "5", 10);
  const docIds = parseDocFilter(req.body?.docIds);

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  // 1) Embed question (uses text-embedding-3-small by default in your ai.js) :contentReference[oaicite:2]{index=2}
  const [qvec] = await embedTexts([question]);

  // 2) Ask C++ for top-k chunk IDs
  const tenantId = getTenantId(req);
  const multiplier = Number.isFinite(TENANT_SEARCH_MULTIPLIER) && TENANT_SEARCH_MULTIPLIER > 0 ? TENANT_SEARCH_MULTIPLIER : 5;
  const cap = Number.isFinite(TENANT_SEARCH_CAP) && TENANT_SEARCH_CAP > 0 ? TENANT_SEARCH_CAP : 50;
  const hasDocFilter = docIds.length > 0;
  const internalK = Math.min(k * multiplier * (hasDocFilter ? 2 : 1), cap);
  const cmd = buildVsearch(internalK, qvec);
  const line = await sendCmd(cmd);
  const matches = parseVsearchReply(line)
    .filter(m => m.id.startsWith(`${tenantId}::`));

  // 3) Fetch chunk text from Postgres
  const ids = matches.map(m => m.id);
  const chunkMap = await getChunksByIds(ids);

  // Build ordered chunk list (same order as matches)
  const filterSet = hasDocFilter
    ? new Set(docIds.map((docId) => namespaceDocId(tenantId, docId)))
    : null;
  const chunks = [];
  for (const m of matches) {
    const row = chunkMap.get(m.id);
    if (!row) continue;
    if (filterSet && !filterSet.has(row.doc_id)) continue;
    chunks.push(row);
    if (chunks.length >= k) break;
  }

  // 4) Generate answer from OpenAI using retrieved chunks :contentReference[oaicite:3]{index=3}
  const { answer, citations } = await generateAnswer(question, chunks);
  const safeCitations = citations.map(c => stripTenantPrefix(tenantId, c));

  // Return answer + retrieval details
  res.json({
    question,
    answer,
    citations: safeCitations
  });
});


// DELETE /docs/:docId
// - remove text rows from Postgres
// - NOTE: vectors remain unless you also track chunk IDs.
// For MVP, we just delete text. Next iteration we can also delete vectors.
app.delete("/docs/:docId", requireJwt, async (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return res.status(400).json({ error: "docId required" });
  if (!isValidDocId(docId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)" });
  }
  const tenantId = getTenantId(req);
  const namespaced = namespaceDocId(tenantId, docId);
  await deleteDoc(namespaced);
  res.json({ ok: true, docId, note: "Deleted chunk text; vector deletion is a next improvement." });
});

// GET /search?q=...&k=5
// - embed query
// - VSEARCH top-k
// - fetch chunk texts from Postgres for previews
app.get("/search", requireJwt, async (req, res) => {
  const q = req.query.q;
  const k = parseInt(req.query.k || "5", 10);
  const docIds = parseDocFilter(req.query.docIds || req.query.docs);

  if (!q) return res.status(400).json({ error: "q query param required" });

  const [qvec] = await embedTexts([q]);

  const tenantId = getTenantId(req);
  const multiplier = Number.isFinite(TENANT_SEARCH_MULTIPLIER) && TENANT_SEARCH_MULTIPLIER > 0 ? TENANT_SEARCH_MULTIPLIER : 5;
  const cap = Number.isFinite(TENANT_SEARCH_CAP) && TENANT_SEARCH_CAP > 0 ? TENANT_SEARCH_CAP : 50;
  const hasDocFilter = docIds.length > 0;
  const internalK = Math.min(k * multiplier * (hasDocFilter ? 2 : 1), cap);
  const cmd = buildVsearch(internalK, qvec);
  const line = await sendCmd(cmd);

  const matches = parseVsearchReply(line)
    .filter(m => m.id.startsWith(`${tenantId}::`));

  // fetch chunk text for matches
  const ids = matches.map(m => m.id);
  const chunkMap = await getChunksByIds(ids);

  const filterSet = hasDocFilter
    ? new Set(docIds.map((docId) => namespaceDocId(tenantId, docId)))
    : null;
  const results = [];
  for (const m of matches) {
    const row = chunkMap.get(m.id);
    if (!row) continue;
    if (filterSet && !filterSet.has(row.doc_id)) continue;
    const preview = row.text.slice(0, 180);
    results.push({
      id: stripTenantPrefix(tenantId, m.id),
      score: m.score,
      docId: stripTenantPrefix(tenantId, row.doc_id),
      preview
    });
    if (results.length >= k) break;
  }

  res.json({ query: q, results });
});

async function start() {
  try {
    await runMigrations();
    app.listen(3000, () => {
      console.log("HTTP gateway listening on http://localhost:3000");
    });
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
}

start();

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
    const isApi = routePath.startsWith("/v1") ||
      routePath.startsWith("/docs") ||
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
const COLLECTION_RE = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_COLLECTION = process.env.DEFAULT_COLLECTION || "default";
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

function normalizeCollection(value) {
  const clean = String(value || "").trim();
  if (!clean) return DEFAULT_COLLECTION;
  if (!COLLECTION_RE.test(clean)) {
    throw new Error("collection must use only letters, numbers, dot, dash, or underscore (no spaces)");
  }
  return clean;
}

function getTenantId(req) {
  const tenant = req.user?.tenant || req.user?.tid || req.user?.sub;
  const clean = String(tenant || "").trim();
  if (!clean || !TENANT_RE.test(clean)) {
    throw new Error("Invalid tenant in token");
  }
  return clean;
}

function resolveTenantId(req) {
  const tenantId = getTenantId(req);
  const provided = req.body?.tenantId || req.body?.tenantID || req.query?.tenantId || req.query?.tenantID;
  if (provided && String(provided).trim() !== tenantId) {
    throw new Error("tenantId mismatch");
  }
  return tenantId;
}

function resolveCollection(req) {
  const provided = req.body?.collection || req.query?.collection;
  return normalizeCollection(provided);
}

function namespaceDocId(tenantId, collection, docId) {
  return `${tenantId}::${collection}::${docId}`;
}

function parseNamespacedDocId(value) {
  const raw = String(value || "");
  if (!raw) return null;
  const parts = raw.split("::");
  if (parts.length === 2) {
    return { tenantId: parts[0], collection: DEFAULT_COLLECTION, docId: parts[1], legacy: true };
  }
  if (parts.length === 3) {
    return { tenantId: parts[0], collection: parts[1], docId: parts[2], legacy: false };
  }
  return null;
}

function parseChunkId(value) {
  const raw = String(value || "");
  if (!raw) return null;
  const docPart = raw.split("#")[0];
  const parsed = parseNamespacedDocId(docPart);
  if (!parsed) return null;
  return { ...parsed, chunkId: raw, docPart };
}

function stripChunkNamespace(value) {
  const raw = String(value || "");
  const docPart = raw.split("#")[0];
  const parsed = parseNamespacedDocId(docPart);
  if (!parsed) return raw;
  const suffix = raw.slice(docPart.length);
  return `${parsed.docId}${suffix}`;
}

function buildMeta(tenantId, collection) {
  return {
    tenantId: tenantId || null,
    collection: collection || null,
    timestamp: new Date().toISOString()
  };
}

function sendOk(res, data, tenantId, collection) {
  res.json({ ok: true, data, meta: buildMeta(tenantId, collection) });
}

function sendError(res, status, message, code, tenantId, collection) {
  res.status(status).json({
    ok: false,
    error: { message: String(message || "Request failed"), code: code || null },
    meta: buildMeta(tenantId, collection)
  });
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

async function indexDocument(tenantId, collection, docId, text) {
  const startAt = Date.now();
  let cleanText = String(text || "");
  cleanText = cleanText.trim();
  if (!cleanText) {
    throw new Error("text produced no chunks");
  }

  const namespacedDocId = namespaceDocId(tenantId, collection, docId);

  let truncated = false;
  if (cleanText.length > MAX_DOC_CHARS) {
    cleanText = cleanText.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }

  logIndex(`start tenant=${tenantId} collection=${collection} docId=${docId} chars=${cleanText.length} truncated=${truncated}`);

  const chunks = chunkText(namespacedDocId, cleanText);
  if (chunks.length === 0) {
    throw new Error("text produced no chunks");
  }

  logIndex(`chunked collection=${collection} docId=${docId} chunks=${chunks.length}`);

  const texts = chunks.map(c => c.text);
  const embedStart = Date.now();
  const vectors = await embedTexts(texts);
  logIndex(`embedded collection=${collection} docId=${docId} vectors=${vectors.length} ms=${Date.now() - embedStart}`);

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

  logIndex(`done tenant=${tenantId} collection=${collection} docId=${docId} chunks=${chunks.length} totalMs=${Date.now() - startAt}`);
  return { chunksIndexed: chunks.length, truncated };
}

async function listDocsForTenant(tenantId, collection) {
  const rows = await listDocsByTenant(tenantId);
  const docs = [];
  for (const row of rows) {
    const parsed = parseNamespacedDocId(row.doc_id);
    if (!parsed || parsed.tenantId !== tenantId) continue;
    if (collection && parsed.collection !== collection) continue;
    docs.push({
      docId: parsed.docId,
      collection: parsed.collection,
      chunks: Number(row.chunks || 0)
    });
  }
  return docs;
}

async function searchChunks({ tenantId, collection, query, k, docIds }) {
  const [qvec] = await embedTexts([query]);

  const multiplier = Number.isFinite(TENANT_SEARCH_MULTIPLIER) && TENANT_SEARCH_MULTIPLIER > 0 ? TENANT_SEARCH_MULTIPLIER : 5;
  const cap = Number.isFinite(TENANT_SEARCH_CAP) && TENANT_SEARCH_CAP > 0 ? TENANT_SEARCH_CAP : 50;
  const hasDocFilter = docIds.length > 0;
  const internalK = Math.min(k * multiplier * (hasDocFilter ? 2 : 1), cap);

  const cmd = buildVsearch(internalK, qvec);
  const line = await sendCmd(cmd);

  const matches = parseVsearchReply(line)
    .filter(m => m.id.startsWith(`${tenantId}::`));

  const ids = matches.map(m => m.id);
  const chunkMap = await getChunksByIds(ids);
  const docFilter = hasDocFilter ? new Set(docIds) : null;

  const results = [];
  for (const m of matches) {
    const row = chunkMap.get(m.id);
    if (!row) continue;
    const parsed = parseNamespacedDocId(row.doc_id);
    if (!parsed || parsed.tenantId !== tenantId) continue;
    if (collection && parsed.collection !== collection) continue;
    if (docFilter && !docFilter.has(parsed.docId)) continue;
    results.push({
      chunkId: stripChunkNamespace(m.id),
      score: m.score,
      docId: parsed.docId,
      collection: parsed.collection,
      preview: row.text.slice(0, 180),
      _row: row
    });
    if (results.length >= k) break;
  }

  return results;
}

async function answerQuestion({ tenantId, collection, question, k, docIds }) {
  const results = await searchChunks({ tenantId, collection, query: question, k, docIds });
  const chunks = results.map(r => r._row).filter(Boolean);

  const { answer, citations } = await generateAnswer(question, chunks);
  const mapped = citations.map((c) => {
    const parsed = parseChunkId(c);
    if (!parsed) {
      return { chunkId: c, docId: null, collection: null };
    }
    return {
      chunkId: stripChunkNamespace(c),
      docId: parsed.docId,
      collection: parsed.collection
    };
  });

  return { answer, citations: mapped, chunksUsed: chunks.length };
}

// --------------------------
// Health check (public)
// --------------------------
app.get("/health", async (req, res) => {
  try {
    const reply = await sendCmd("PING");
    res.json({ ok: true, tcp: reply, tenantId: null, collection: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), tenantId: null, collection: null });
  }
});

app.get("/v1/health", async (req, res) => {
  try {
    const reply = await sendCmd("PING");
    sendOk(res, { status: "ok", tcp: reply }, null, null);
  } catch (e) {
    sendError(res, 500, e, "HEALTH_CHECK_FAILED", null, null);
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
    return res.status(400).json({ error: "username and password required", tenantId: null, collection: null });
  }

  const maxAttempts = parseInt(process.env.AUTH_MAX_ATTEMPTS || "5", 10);
  const lockMinutes = parseInt(process.env.AUTH_LOCK_MINUTES || "15", 10);

  const result = await verifyCredentials(cleanUser, cleanPass);
  if (!result.ok) {
    if (result.reason === "locked") {
      return res.status(423).json({ error: "Account locked. Try later.", tenantId: null, collection: null });
    }
    if (result.reason === "disabled") {
      return res.status(403).json({ error: "Account disabled.", tenantId: null, collection: null });
    }
    if (result.reason === "sso_only") {
      return res.status(403).json({ error: "Account requires SSO login.", tenantId: null, collection: null });
    }
    if (result.user) {
      await recordFailedLogin(cleanUser, maxAttempts, lockMinutes);
    }
    return res.status(401).json({ error: "Invalid credentials", tenantId: null, collection: null });
  }

  try {
    await recordSuccessfulLogin(result.user.id);
    const token = issueToken(result.user);
    res.json({
      ok: true,
      token,
      tenant: result.user.tenant || result.user.username,
      tenantId: result.user.tenant || result.user.username,
      collection: DEFAULT_COLLECTION
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), tenantId: null, collection: null });
  }
});

app.post("/v1/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "").trim();

  if (!cleanUser || !cleanPass) {
    return sendError(res, 400, "username and password required", "INVALID_REQUEST", null, null);
  }

  const maxAttempts = parseInt(process.env.AUTH_MAX_ATTEMPTS || "5", 10);
  const lockMinutes = parseInt(process.env.AUTH_LOCK_MINUTES || "15", 10);

  const result = await verifyCredentials(cleanUser, cleanPass);
  if (!result.ok) {
    if (result.reason === "locked") {
      return sendError(res, 423, "Account locked. Try later.", "ACCOUNT_LOCKED", null, null);
    }
    if (result.reason === "disabled") {
      return sendError(res, 403, "Account disabled.", "ACCOUNT_DISABLED", null, null);
    }
    if (result.reason === "sso_only") {
      return sendError(res, 403, "Account requires SSO login.", "SSO_ONLY", null, null);
    }
    if (result.user) {
      await recordFailedLogin(cleanUser, maxAttempts, lockMinutes);
    }
    return sendError(res, 401, "Invalid credentials", "INVALID_CREDENTIALS", null, null);
  }

  try {
    await recordSuccessfulLogin(result.user.id);
    const token = issueToken(result.user);
    sendOk(res, {
      token,
      user: result.user,
      note: "Use this token in Authorization: Bearer <token>"
    }, result.user.tenant, DEFAULT_COLLECTION);
  } catch (err) {
    sendError(res, 500, "Failed to generate token", "TOKEN_FAILURE", null, null);
  }
});

// --------------------------
// SSO Login (public)
// --------------------------
app.get(["/auth/:provider/login", "/v1/auth/:provider/login"], async (req, res) => {
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

app.get(["/auth/:provider/callback", "/v1/auth/:provider/callback"], async (req, res) => {
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
  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req);
  const reply = await sendCmd("STATS");
  const tcpStats = JSON.parse(reply);
  const gatewayStats = {
    latency: getLatencyStats()
  };
  res.json({ ...tcpStats, gateway: gatewayStats, tenantId, collection });
});

app.get("/v1/stats", requireJwt, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const reply = await sendCmd("STATS");
    const tcpStats = JSON.parse(reply);
    const gatewayStats = {
      latency: getLatencyStats()
    };
    sendOk(res, { ...tcpStats, gateway: gatewayStats }, tenantId, collection);
  } catch (e) {
    sendError(res, 500, e, "STATS_FAILED", tenantId, collection);
  }
});

// =======================================================
// SEMANTIC / GENAI ENDPOINTS (protected)
// =======================================================

// GET /docs
// - list docs for the current tenant
app.get("/docs", requireJwt, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection);
    res.json({ docs, totalDocs: docs.length, tenantId, collection });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/docs", requireJwt, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection);
    sendOk(res, { docs, totalDocs: docs.length }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "DOCS_LIST_FAILED", tenantId, collection);
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
    const tenantId = resolveTenantId(req);
    const collection = resolveCollection(req);
    const { chunksIndexed, truncated } = await indexDocument(tenantId, collection, cleanDocId, text);
    res.json({ ok: true, docId: cleanDocId, collection, tenantId, chunksIndexed, truncated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/docs", requireJwt, async (req, res) => {
  const { docId, text } = req.body || {};

  const cleanDocId = String(docId || "").trim();

  if (!cleanDocId || !text) {
    return sendError(res, 400, "docId and text required", "INVALID_REQUEST", null, null);
  }
  if (!isValidDocId(cleanDocId)) {
    return sendError(res, 400, "docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const { chunksIndexed, truncated } = await indexDocument(tenantId, collection, cleanDocId, text);
    sendOk(res, { docId: cleanDocId, chunksIndexed, truncated }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "INDEX_FAILED", tenantId, collection);
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
    const tenantId = resolveTenantId(req);
    const collection = resolveCollection(req);
    const fetched = await fetchUrlText(cleanUrl);
    const { chunksIndexed, truncated } = await indexDocument(tenantId, collection, cleanDocId, fetched.text);

    res.json({
      ok: true,
      docId: cleanDocId,
      collection,
      tenantId,
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

app.post("/v1/docs/url", requireJwt, async (req, res) => {
  const { docId, url } = req.body || {};
  const cleanDocId = String(docId || "").trim();
  const cleanUrl = String(url || "").trim();

  if (!cleanDocId || !cleanUrl) {
    return sendError(res, 400, "docId and url required", "INVALID_REQUEST", null, null);
  }
  if (!isValidDocId(cleanDocId)) {
    return sendError(res, 400, "docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const fetched = await fetchUrlText(cleanUrl);
    const { chunksIndexed, truncated } = await indexDocument(tenantId, collection, cleanDocId, fetched.text);

    sendOk(res, {
      docId: cleanDocId,
      url: cleanUrl,
      contentType: fetched.contentType || null,
      extractedChars: fetched.text.length,
      fetchTruncated: fetched.truncated,
      docTruncated: truncated,
      chunksIndexed
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "INDEX_URL_FAILED", tenantId, collection);
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

  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req);

  const result = await answerQuestion({ tenantId, collection, question, k, docIds });
  const citationIds = result.citations.map(c => c.chunkId);

  res.json({
    question,
    answer: result.answer,
    citations: citationIds,
    sources: result.citations,
    tenantId,
    collection
  });
});

app.post("/v1/ask", requireJwt, async (req, res) => {
  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "5", 10);
  const docIds = parseDocFilter(req.body?.docIds);

  if (!question || !question.trim()) {
    return sendError(res, 400, "question is required", "INVALID_REQUEST", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const result = await answerQuestion({ tenantId, collection, question, k, docIds });
    sendOk(res, {
      question,
      answer: result.answer,
      citations: result.citations,
      chunksUsed: result.chunksUsed,
      k
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "ASK_FAILED", tenantId, collection);
  }
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
  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req);
  const namespaced = namespaceDocId(tenantId, collection, docId);
  await deleteDoc(namespaced);
  if (collection === DEFAULT_COLLECTION) {
    const legacy = `${tenantId}::${docId}`;
    if (legacy !== namespaced) {
      await deleteDoc(legacy);
    }
  }
  res.json({
    ok: true,
    docId,
    collection,
    tenantId,
    note: "Deleted chunk text; vector deletion is a next improvement."
  });
});

app.delete("/v1/docs/:docId", requireJwt, async (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return sendError(res, 400, "docId required", "INVALID_REQUEST", null, null);
  if (!isValidDocId(docId)) {
    return sendError(res, 400, "docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const namespaced = namespaceDocId(tenantId, collection, docId);
    await deleteDoc(namespaced);
    if (collection === DEFAULT_COLLECTION) {
      const legacy = `${tenantId}::${docId}`;
      if (legacy !== namespaced) {
        await deleteDoc(legacy);
      }
    }
    sendOk(res, {
      docId,
      note: "Deleted chunk text; vector deletion is a next improvement."
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "DELETE_FAILED", tenantId, collection);
  }
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

  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req);

  const results = await searchChunks({
    tenantId,
    collection,
    query: q,
    k,
    docIds
  });

  res.json({
    query: q,
    results: results.map(r => ({
      id: r.chunkId,
      score: r.score,
      docId: r.docId,
      collection: r.collection,
      preview: r.preview
    })),
    tenantId,
    collection
  });
});

app.get("/v1/search", requireJwt, async (req, res) => {
  const q = req.query.q;
  const k = parseInt(req.query.k || "5", 10);
  const docIds = parseDocFilter(req.query.docIds || req.query.docs);

  if (!q) return sendError(res, 400, "q query param required", "INVALID_REQUEST", null, null);

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds
    });
    sendOk(res, {
      query: q,
      results: results.map(r => ({
        chunkId: r.chunkId,
        score: r.score,
        docId: r.docId,
        collection: r.collection,
        preview: r.preview
      }))
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "SEARCH_FAILED", tenantId, collection);
  }
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

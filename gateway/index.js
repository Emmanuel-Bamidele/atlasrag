// index.js
const express = require("express");

const { embedTexts } = require("./ai");
const { chunkText } = require("./chunk");
const { sendCmd, buildVset, buildVsearch, buildVdel, parseVsearchReply } = require("./tcp");

const {
  saveChunk,
  getChunksByIds,
  getChunksByDocId,
  deleteDoc,
  countChunks,
  listChunksAfter,
  listDocsByTenant,
  upsertMemoryArtifact,
  upsertMemoryItem,
  getMemoryItemsByNamespaceIds,
  getMemoryItemById,
  deleteMemoryItemById,
  getArtifactByExternalId,
  listExpiredMemoryItems,
  listMemoryItemsForCompaction,
  createMemoryLink,
  createMemoryJob,
  updateMemoryJob,
  getMemoryJobById,
  listMemoryJobs,
  deleteMemoryItemsByCollection,
  beginIdempotencyKey,
  touchIdempotencyKey,
  completeIdempotencyKey,
  recordFailedLogin,
  recordSuccessfulLogin,
  createServiceToken,
  listServiceTokens,
  revokeServiceToken,
  runMigrations,
  upsertSsoUser
} = require("./db");
const { requireJwt, limiter, loginLimiter } = require("./security");
const { generateAnswer } = require("./answer");
const { reflectMemories, summarizeMemories } = require("./memory_reflect");
const { verifyCredentials, issueToken } = require("./auth");
const { recordLatency, getLatencyStats } = require("./metrics");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const openApiSpec = require("./openapi.json");
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
    const rawPath = req.route?.path ?? req.path ?? "";
    const routePath = typeof rawPath === "string" ? rawPath : String(rawPath);
    const isApi = routePath.startsWith("/v1") ||
      routePath.startsWith("/docs") ||
      routePath.startsWith("/openapi") ||
      routePath.startsWith("/ask") ||
      routePath.startsWith("/search") ||
      routePath.startsWith("/stats") ||
      routePath.startsWith("/health") ||
      routePath.startsWith("/login") ||
      routePath.startsWith("/auth");

    if (!isApi) return;
    const key = `${req.method} ${routePath}`;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tenantId = resolveTenantForMetrics(req);
    recordLatency(key, ms, res.statusCode, tenantId);
  });
  next();
});

const MAX_DOC_CHARS = 200000;
const MAX_FETCH_CHARS = 1000000;
const MAX_REFLECT_CHARS = parseInt(process.env.REFLECT_MAX_CHARS || "12000", 10);
const MAX_COMPACT_CHARS = parseInt(process.env.COMPACT_MAX_CHARS || "12000", 10);
const DEBUG_INDEX = process.env.DEBUG_INDEX === "1";
const REINDEX_MODE = String(process.env.REINDEX_ON_START || "auto").toLowerCase();
const REINDEX_BATCH_SIZE = parseInt(process.env.REINDEX_BATCH_SIZE || "64", 10);
const REINDEX_FETCH_SIZE = parseInt(process.env.REINDEX_FETCH_SIZE || "256", 10);
const REINDEX_SLEEP_MS = parseInt(process.env.REINDEX_SLEEP_MS || "0", 10);
const REINDEX_LOG_EVERY = parseInt(process.env.REINDEX_LOG_EVERY || "500", 10);
const REINDEX_TCP_ATTEMPTS = parseInt(process.env.REINDEX_TCP_ATTEMPTS || "12", 10);
const REINDEX_TCP_DELAY_MS = parseInt(process.env.REINDEX_TCP_DELAY_MS || "2000", 10);
let reindexStarted = false;
const DOC_ID_RE = /^[a-zA-Z0-9._-]+$/;
const TENANT_RE = /^[a-zA-Z0-9._-]+$/;
const COLLECTION_RE = /^[a-zA-Z0-9._-]+$/;
const ITEM_TYPE_RE = /^[a-zA-Z0-9._-]+$/;
const PRINCIPAL_RE = /^[a-zA-Z0-9._:@-]+$/;
const DEFAULT_COLLECTION = process.env.DEFAULT_COLLECTION || "default";
const TENANT_SEARCH_MULTIPLIER = parseInt(process.env.TENANT_SEARCH_MULTIPLIER || "5", 10);
const TENANT_SEARCH_CAP = parseInt(process.env.TENANT_SEARCH_CAP || "50", 10);

function buildOpenApiDoc(req) {
  const envBase = process.env.OPENAPI_BASE_URL || process.env.PUBLIC_BASE_URL;
  const host = req.get("host");
  const baseUrl = envBase || (host ? `${req.protocol}://${host}` : "http://localhost:3000");
  return {
    ...openApiSpec,
    servers: [{ url: baseUrl }]
  };
}

function resolveTenantForMetrics(req) {
  const candidate = req.user?.tenant || req.user?.tid || req.user?.sub;
  const clean = String(candidate || "").trim();
  if (!clean || !TENANT_RE.test(clean)) return null;
  return clean;
}

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

function normalizeItemType(value) {
  const clean = String(value || "").trim();
  if (!clean) return "memory";
  if (!ITEM_TYPE_RE.test(clean)) {
    throw new Error("type must use only letters, numbers, dot, dash, or underscore (no spaces)");
  }
  return clean;
}

function normalizeVisibility(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return "tenant";
  if (!["tenant", "private", "acl"].includes(clean)) {
    throw new Error("visibility must be one of: tenant, private, acl");
  }
  return clean;
}

function normalizeAclList(raw, principalId) {
  if (!raw) {
    return principalId ? [principalId] : [];
  }
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    if (!PRINCIPAL_RE.test(clean)) {
      throw new Error("acl principals must use only letters, numbers, dot, dash, underscore, colon, or @");
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  if (principalId && !seen.has(principalId)) {
    out.push(principalId);
  }
  return out;
}

function parseTypeFilter(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    if (!ITEM_TYPE_RE.test(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function normalizeReflectTypes(raw) {
  const allowed = new Set(["semantic", "procedural", "summary"]);
  const list = parseTypeFilter(raw);
  if (!list.length) return Array.from(allowed);
  const filtered = list.filter(t => allowed.has(t));
  if (!filtered.length) {
    throw new Error("types must include semantic, procedural, or summary");
  }
  return filtered;
}

function parseTimeInput(value, label) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return date;
}

function resolveExpiresAt(input) {
  if (!input) return null;
  if (input.expiresAt) {
    return parseTimeInput(input.expiresAt, "expiresAt");
  }
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null && input.ttlSeconds !== "") {
    const ttl = Number(input.ttlSeconds);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error("ttlSeconds must be a positive number");
    }
    return new Date(Date.now() + ttl * 1000);
  }
  return null;
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

function resolvePrincipalId(req) {
  const tokenPrincipal = req.user?.principal_id || req.user?.sub;
  const clean = String(tokenPrincipal || "").trim();
  if (!clean || !PRINCIPAL_RE.test(clean)) {
    throw new Error("Invalid principal in token");
  }
  const provided = req.body?.principalId || req.body?.principal_id || req.query?.principalId || req.query?.principal_id;
  if (provided && String(provided).trim() !== clean) {
    throw new Error("principalId mismatch");
  }
  return clean;
}

function normalizeRoles(input) {
  if (Array.isArray(input)) {
    return input
      .map(value => String(value || "").trim())
      .filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
  }
  return [];
}

function formatServiceToken(record) {
  if (!record) return null;
  return {
    id: record.id,
    tenantId: record.tenant_id,
    name: record.name,
    principalId: record.principal_id,
    roles: record.roles || [],
    lastUsedAt: record.last_used_at,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at,
    createdAt: record.created_at
  };
}

function buildCollectionsFromDocs(docs) {
  const map = new Map();
  for (const doc of docs || []) {
    const collection = doc.collection || DEFAULT_COLLECTION;
    if (!map.has(collection)) {
      map.set(collection, { collection, totalDocs: 0, titles: [] });
    }
    const entry = map.get(collection);
    entry.totalDocs += 1;
    if (doc.docId) entry.titles.push(doc.docId);
  }
  return Array.from(map.values()).sort((a, b) => a.collection.localeCompare(b.collection));
}

function hasTokenAdminAccess(req) {
  const roles = req.user?.roles || [];
  if (Array.isArray(roles) && (roles.includes("admin") || roles.includes("owner"))) {
    return true;
  }
  const principal = req.user?.principal_id || req.user?.sub;
  const tenant = req.user?.tenant || req.user?.tid || req.user?.sub;
  if (!principal || !tenant) return false;
  return String(principal).trim() === String(tenant).trim();
}

function requireAdmin(req, res, next) {
  if (!hasTokenAdminAccess(req)) {
    if (req.path.startsWith("/v1")) {
      return sendError(res, 403, "Admin or owner role required", "FORBIDDEN", null, null);
    }
    return res.status(403).json({ error: "Admin or owner role required" });
  }
  next();
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

function buildOkPayload(data, tenantId, collection) {
  return { ok: true, data, meta: buildMeta(tenantId, collection) };
}

function buildErrorPayload(message, code, tenantId, collection) {
  return {
    ok: false,
    error: { message: String(message || "Request failed"), code: code || null },
    meta: buildMeta(tenantId, collection)
  };
}

function sendOk(res, data, tenantId, collection) {
  res.json(buildOkPayload(data, tenantId, collection));
}

function sendError(res, status, message, code, tenantId, collection) {
  res.status(status).json(buildErrorPayload(message, code, tenantId, collection));
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function hashPayload(payload) {
  const raw = stableStringify(payload);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReindexMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (["1", "true", "yes", "on", "always", "force"].includes(raw)) return "always";
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return "off";
  return "auto";
}

async function waitForVectorStore() {
  const attempts = Number.isFinite(REINDEX_TCP_ATTEMPTS) && REINDEX_TCP_ATTEMPTS > 0 ? REINDEX_TCP_ATTEMPTS : 12;
  const delayMs = Number.isFinite(REINDEX_TCP_DELAY_MS) && REINDEX_TCP_DELAY_MS >= 0 ? REINDEX_TCP_DELAY_MS : 2000;
  let lastError = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const reply = await sendCmd("PING");
      if (String(reply || "").trim() === "PONG") return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(delayMs);
  }

  if (lastError) {
    throw lastError;
  }
  return false;
}

async function getVectorCount() {
  const reply = await sendCmd("STATS");
  const stats = JSON.parse(reply);
  return Number(stats.vectors || 0);
}

async function reindexChunkBatch(rows) {
  if (!rows.length) return;
  const texts = rows.map(r => r.text);
  const vectors = await embedTexts(texts);

  for (let i = 0; i < rows.length; i += 1) {
    const chunkId = rows[i].chunk_id;
    const cmd = buildVset(chunkId, vectors[i]);
    await sendCmd(cmd);
  }
}

async function reindexAllChunks() {
  const mode = normalizeReindexMode(REINDEX_MODE);
  if (mode === "off") return;

  if (!process.env.OPENAI_API_KEY) {
    console.warn("[reindex] OPENAI_API_KEY not set; skipping auto reindex.");
    return;
  }

  const totalChunks = await countChunks();
  if (!totalChunks) {
    console.log("[reindex] No stored chunks found; skipping.");
    return;
  }

  await waitForVectorStore();

  if (mode === "auto") {
    try {
      const vectors = await getVectorCount();
      if (vectors > 0) {
        console.log(`[reindex] Vector store already has ${vectors} vectors; skipping auto reindex.`);
        return;
      }
    } catch (err) {
      console.warn("[reindex] Failed to read vector stats; continuing with reindex.");
    }
  }

  const batchSize = Number.isFinite(REINDEX_BATCH_SIZE) && REINDEX_BATCH_SIZE > 0 ? REINDEX_BATCH_SIZE : 64;
  const fetchSize = Number.isFinite(REINDEX_FETCH_SIZE) && REINDEX_FETCH_SIZE > 0 ? REINDEX_FETCH_SIZE : 256;
  const logEvery = Number.isFinite(REINDEX_LOG_EVERY) && REINDEX_LOG_EVERY > 0 ? REINDEX_LOG_EVERY : 500;
  const sleepMs = Number.isFinite(REINDEX_SLEEP_MS) && REINDEX_SLEEP_MS > 0 ? REINDEX_SLEEP_MS : 0;

  console.log(`[reindex] Starting reindex of ${totalChunks} chunks...`);
  let processed = 0;
  let lastId = null;
  let buffer = [];

  while (true) {
    const rows = await listChunksAfter({ afterId: lastId, limit: fetchSize });
    if (!rows.length) break;

    for (const row of rows) {
      buffer.push(row);
      if (buffer.length >= batchSize) {
        await reindexChunkBatch(buffer);
        processed += buffer.length;
        buffer = [];
        if (processed % logEvery === 0 || processed >= totalChunks) {
          console.log(`[reindex] Progress ${processed}/${totalChunks} chunks`);
        }
        if (sleepMs) {
          await sleep(sleepMs);
        }
      }
    }
    lastId = rows[rows.length - 1].chunk_id;
  }

  if (buffer.length) {
    await reindexChunkBatch(buffer);
    processed += buffer.length;
  }

  console.log(`[reindex] Completed: ${processed}/${totalChunks} chunks indexed.`);
}

function scheduleAutoReindex() {
  if (reindexStarted) return;
  reindexStarted = true;
  setTimeout(() => {
    reindexAllChunks().catch((err) => {
      console.warn("[reindex] Failed:", err?.message || err);
    });
  }, 1500);
}

function extractIdempotencyKey(req) {
  const headerKey = req.header("Idempotency-Key");
  const bodyKey = req.body?.idempotencyKey;
  const key = String(headerKey || bodyKey || "").trim();
  return key || null;
}

function normalizeIdempotencyBody(body, tenantId, collection, principalId) {
  if (!body || typeof body !== "object") return body;
  const copy = Array.isArray(body) ? body.slice() : { ...body };
  delete copy.idempotencyKey;
  delete copy.tenantID;
  delete copy.principal_id;
  if (tenantId && copy.tenantId === undefined) {
    copy.tenantId = tenantId;
  }
  if (collection && copy.collection === undefined) {
    copy.collection = collection;
  }
  if (principalId && copy.principalId === undefined) {
    copy.principalId = principalId;
  }
  return copy;
}

async function handleIdempotentRequest({ req, res, tenantId, collection, principalId, endpoint, payloadForHash, handler }) {
  const key = extractIdempotencyKey(req);
  if (!key) {
    const payload = buildErrorPayload("Idempotency-Key is required", "IDEMPOTENCY_KEY_REQUIRED", tenantId, collection);
    return res.status(400).json(payload);
  }
  if (key.length > 200) {
    const payload = buildErrorPayload("Idempotency-Key too long", "IDEMPOTENCY_KEY_INVALID", tenantId, collection);
    return res.status(400).json(payload);
  }

  const normalized = normalizeIdempotencyBody(payloadForHash ?? req.body, tenantId, collection, principalId);
  const requestHash = hashPayload(normalized);

  const { inserted, record } = await beginIdempotencyKey({
    tenantId,
    endpoint,
    idempotencyKey: key,
    requestHash
  });

  if (!inserted && record) {
    if (record.request_hash && record.request_hash !== requestHash) {
      const payload = buildErrorPayload("Idempotency-Key already used with a different payload", "IDEMPOTENCY_KEY_REUSED", tenantId, collection);
      return res.status(409).json(payload);
    }

    if (record.status === "completed" && record.response_body) {
      const status = record.response_status || 200;
      return res.status(status).json(record.response_body);
    }

    const ttlMs = parseInt(process.env.IDEMPOTENCY_TTL_MS || "300000", 10);
    const updatedAt = record.updated_at ? new Date(record.updated_at).getTime() : 0;
    const ageMs = Date.now() - updatedAt;
    if (record.status === "in_progress" && ttlMs > 0 && ageMs < ttlMs) {
      const payload = buildErrorPayload("Request already in progress", "IDEMPOTENCY_IN_PROGRESS", tenantId, collection);
      return res.status(409).json(payload);
    }

    await touchIdempotencyKey({ tenantId, endpoint, idempotencyKey: key });
  }

  const { status, payload } = await handler();
  await completeIdempotencyKey({
    tenantId,
    endpoint,
    idempotencyKey: key,
    responseStatus: status,
    responseBody: payload
  });
  return res.status(status).json(payload);
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

async function indexDocument(tenantId, collection, docId, text, source) {
  const startAt = Date.now();
  let cleanText = String(text || "");
  cleanText = cleanText.trim();
  if (!cleanText) {
    throw new Error("text produced no chunks");
  }

  const namespacedDocId = namespaceDocId(tenantId, collection, docId);
  const principalId = source?.principalId || null;
  const resolvedVisibility = normalizeVisibility(source?.visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(source?.acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    throw new Error("acl list is required when visibility is acl");
  }

  await upsertMemoryArtifact({
    tenantId,
    collection,
    externalId: docId,
    namespaceId: namespacedDocId,
    title: docId,
    sourceType: source?.type || "text",
    sourceUrl: source?.url || null,
    metadata: source?.metadata || null,
    expiresAt: source?.expiresAt || null,
    principalId,
    visibility: resolvedVisibility,
    acl: aclList
  });

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

async function listDocsForTenant(tenantId, collection, principalId) {
  const rows = await listDocsByTenant(tenantId, principalId);
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

async function searchChunks({ tenantId, collection, query, k, docIds, principalId, enforceArtifactVisibility }) {
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

  if (enforceArtifactVisibility && principalId) {
    const namespaceIds = results.map(r => r._row.doc_id);
    const artifactMap = await getMemoryItemsByNamespaceIds({
      namespaceIds,
      types: ["artifact"],
      excludeExpired: true,
      principalId
    });
    return results.filter(r => artifactMap.has(r._row.doc_id));
  }

  return results;
}

async function answerQuestion({ tenantId, collection, question, k, docIds, principalId }) {
  const results = await searchChunks({
    tenantId,
    collection,
    query: question,
    k,
    docIds,
    principalId,
    enforceArtifactVisibility: true
  });
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

async function indexMemoryText(namespaceId, text) {
  const startAt = Date.now();
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

  logIndex(`start memory namespace=${namespaceId} chars=${cleanText.length} truncated=${truncated}`);

  const chunks = chunkText(namespaceId, cleanText);
  if (chunks.length === 0) {
    throw new Error("text produced no chunks");
  }

  const texts = chunks.map(c => c.text);
  const vectors = await embedTexts(texts);

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = chunks[i].chunkId;
    const chunkTxt = chunks[i].text;

    await saveChunk({
      chunkId,
      docId: namespaceId,
      idx: i,
      text: chunkTxt
    });

    const cmd = buildVset(chunkId, vectors[i]);
    await sendCmd(cmd);
  }

  logIndex(`done memory namespace=${namespaceId} chunks=${chunks.length} totalMs=${Date.now() - startAt}`);
  return { chunksIndexed: chunks.length, truncated };
}

async function deleteVectorsForDoc(namespaceId) {
  const rows = await getChunksByDocId(namespaceId);
  let deleted = 0;
  for (const row of rows) {
    try {
      await sendCmd(buildVdel(row.chunk_id));
      deleted += 1;
    } catch {
      // ignore vector delete failures to avoid blocking cleanup
    }
  }
  await deleteDoc(namespaceId);
  return deleted;
}

async function memoryWriteCore(req) {
  const { text, type, title, externalId, metadata, sourceType, sourceUrl, createdAt, visibility, acl } = req.body || {};
  const tenantId = resolveTenantId(req);
  const principalId = resolvePrincipalId(req);
  const collection = resolveCollection(req);
  const itemType = normalizeItemType(type);
  const createdTime = createdAt ? parseTimeInput(createdAt, "createdAt") : null;
  const expiresAt = resolveExpiresAt(req.body);
  const resolvedVisibility = normalizeVisibility(visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    throw new Error("acl list is required when visibility is acl");
  }
  const memoryId = crypto.randomUUID();
  const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);

  const memory = await upsertMemoryItem({
    tenantId,
    collection,
    itemType,
    externalId,
    namespaceId,
    itemId: memoryId,
    title,
    sourceType,
    sourceUrl,
    metadata,
    createdAt: createdTime,
    expiresAt,
    principalId,
    visibility: resolvedVisibility,
    acl: aclList
  });

  const { chunksIndexed, truncated } = await indexMemoryText(memory.namespace_id, text);

  return {
    tenantId,
    principalId,
    collection,
    memory,
    chunksIndexed,
    truncated
  };
}

function parseJsonPayload(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function loadArtifactText(namespaceId) {
  const rows = await getChunksByDocId(namespaceId);
  if (!rows.length) return "";
  return rows.map(r => r.text).join("\n\n");
}

async function runReflectionJob(jobId, tenantId) {
  try {
    await updateMemoryJob({ id: jobId, status: "running" });
    const job = await getMemoryJobById(jobId, tenantId);
    if (!job) {
      return;
    }

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const types = Array.isArray(input.types) ? input.types : [];
    const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : undefined;
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;
    const requestedVisibility = input.visibility ? normalizeVisibility(input.visibility) : null;
    const requestedAcl = input.acl;

    let artifact = null;
    if (input.artifactId) {
      artifact = await getMemoryItemById(input.artifactId, tenantId, principalId);
    } else if (input.docId) {
      artifact = await getArtifactByExternalId(tenantId, collection, input.docId, principalId);
    }

    if (!artifact) {
      await updateMemoryJob({ id: jobId, status: "failed", error: "Artifact not found" });
      return;
    }
    if (artifact.item_type !== "artifact") {
      await updateMemoryJob({ id: jobId, status: "failed", error: "Item is not an artifact" });
      return;
    }

    let text = await loadArtifactText(artifact.namespace_id);
    if (!text.trim()) {
      await updateMemoryJob({ id: jobId, status: "failed", error: "Artifact has no text chunks" });
      return;
    }

    if (text.length > MAX_REFLECT_CHARS) {
      text = text.slice(0, MAX_REFLECT_CHARS);
    }

    const reflection = await reflectMemories({
      text,
      types,
      maxItems
    });

    const ownerId = principalId || artifact.principal_id || null;
    const resolvedVisibility = requestedVisibility || artifact.visibility || "tenant";
    const aclList = resolvedVisibility === "acl"
      ? normalizeAclList(requestedAcl || artifact.acl_principals || [], ownerId)
      : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const created = [];
    const typeMap = {
      semantic: reflection.semantic || [],
      procedural: reflection.procedural || [],
      summary: reflection.summary || []
    };

    for (const [type, items] of Object.entries(typeMap)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] || {};
        const content = String(item.content || "").trim();
        if (!content) continue;

        const memoryId = crypto.randomUUID();
        const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);
        const externalId = `job:${jobId}:${type}:${i + 1}`;

        const memory = await upsertMemoryItem({
          tenantId,
          collection,
          itemType: type,
          externalId,
          namespaceId,
          itemId: memoryId,
          title: item.title || null,
          sourceType: "reflection",
          sourceUrl: null,
          metadata: {
            origin: "reflect",
            artifactId: artifact.id,
            jobId,
            type
          },
          principalId: ownerId,
          visibility: resolvedVisibility,
          acl: aclList
        });

        await indexMemoryText(memory.namespace_id, content);
        await createMemoryLink({
          tenantId,
          fromItemId: memory.id,
          toItemId: artifact.id,
          relation: "derived_from",
          metadata: { jobId, type }
        });

        created.push({
          id: memory.id,
          namespaceId: memory.namespace_id,
          type: memory.item_type,
          title: memory.title || null
        });
      }
    }

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        artifactId: artifact.id,
        createdCount: created.length,
        created
      }
    });
  } catch (err) {
    await updateMemoryJob({ id: jobId, status: "failed", error: String(err.message || err) });
  }
}

async function runTtlCleanupJob(jobId, tenantId) {
  try {
    await updateMemoryJob({ id: jobId, status: "running" });
    const job = await getMemoryJobById(jobId, tenantId);
    if (!job) return;

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const before = parseTimeInput(input.before || new Date().toISOString(), "before");
    const limit = parseInt(input.limit || "200", 10);
    const dryRun = Boolean(input.dryRun);
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("limit must be a positive number");
    }

    const items = await listExpiredMemoryItems({
      tenantId,
      collection,
      before,
      limit,
      principalId
    });

    let vectorsDeleted = 0;
    let itemsDeleted = 0;

    if (!dryRun) {
      for (const item of items) {
        vectorsDeleted += await deleteVectorsForDoc(item.namespace_id);
        await deleteMemoryItemById(item.id);
        itemsDeleted += 1;
      }
    }

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        collection,
        before,
        dryRun,
        matched: items.length,
        itemsDeleted,
        vectorsDeleted
      }
    });
  } catch (err) {
    await updateMemoryJob({ id: jobId, status: "failed", error: String(err.message || err) });
  }
}

async function runCompactionJob(jobId, tenantId) {
  try {
    await updateMemoryJob({ id: jobId, status: "running" });
    const job = await getMemoryJobById(jobId, tenantId);
    if (!job) return;

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const typeFilter = parseTypeFilter(input.types);
    const types = typeFilter.length ? typeFilter : ["semantic", "procedural", "summary", "memory"];
    const since = input.since ? parseTimeInput(input.since, "since") : null;
    const until = input.until ? parseTimeInput(input.until, "until") : null;
    const limit = parseInt(input.maxItems || "25", 10);
    const summaryType = normalizeItemType(input.summaryType || "summary");
    const deleteOriginals = Boolean(input.deleteOriginals);
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;
    const requestedVisibility = input.visibility ? normalizeVisibility(input.visibility) : null;
    const requestedAcl = input.acl;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("maxItems must be a positive number");
    }

    const items = await listMemoryItemsForCompaction({
      tenantId,
      collection,
      types,
      since,
      until,
      limit,
      principalId
    });

    if (!items.length) {
      await updateMemoryJob({
        id: jobId,
        status: "succeeded",
        output: { createdCount: 0, sourceCount: 0, collection }
      });
      return;
    }

    const parts = [];
    const included = [];
    let total = 0;
    for (const item of items) {
      const text = await loadArtifactText(item.namespace_id);
      if (!text.trim()) continue;
      const header = item.title ? `${item.title}` : `${item.item_type}:${item.id}`;
      const block = `# ${header}\n${text}`;
      if (total + block.length > MAX_COMPACT_CHARS) break;
      parts.push(block);
      included.push(item);
      total += block.length;
    }

    if (!parts.length) {
      await updateMemoryJob({
        id: jobId,
        status: "failed",
        error: "No memory text available for compaction"
      });
      return;
    }

    const combined = parts.join("\n\n---\n\n");
    const summary = await summarizeMemories({ text: combined });
    if (!summary.content) {
      await updateMemoryJob({
        id: jobId,
        status: "failed",
        error: "Compaction produced empty summary"
      });
      return;
    }

    const ownerId = principalId || (included[0]?.principal_id || null);
    let resolvedVisibility = requestedVisibility;
    let resolvedAcl = requestedAcl;
    if (!resolvedVisibility && included.length) {
      const baseVisibility = included[0].visibility || "tenant";
      const sameVisibility = included.every(item => (item.visibility || "tenant") === baseVisibility);
      if (sameVisibility) {
        resolvedVisibility = baseVisibility;
        if (baseVisibility === "acl") {
          const baseAcl = (included[0].acl_principals || []).slice().sort().join(",");
          const sameAcl = included.every(item => (item.acl_principals || []).slice().sort().join(",") === baseAcl);
          if (sameAcl) {
            resolvedAcl = included[0].acl_principals || [];
          } else {
            resolvedVisibility = "private";
            resolvedAcl = [];
          }
        }
      } else {
        resolvedVisibility = "private";
        resolvedAcl = [];
      }
    }

    resolvedVisibility = normalizeVisibility(resolvedVisibility);
    const aclList = resolvedVisibility === "acl" ? normalizeAclList(resolvedAcl || [], ownerId) : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const memoryId = crypto.randomUUID();
    const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);
    const externalId = `job:${jobId}:compaction`;

    const memory = await upsertMemoryItem({
      tenantId,
      collection,
      itemType: summaryType,
      externalId,
      namespaceId,
      itemId: memoryId,
      title: summary.title || "Compacted memory",
      sourceType: "compaction",
      sourceUrl: null,
      metadata: {
        origin: "compaction",
        jobId,
        sourceCount: included.length,
        types
      },
      principalId: ownerId,
      visibility: resolvedVisibility,
      acl: aclList
    });

    await indexMemoryText(memory.namespace_id, summary.content);

    for (const item of included) {
      await createMemoryLink({
        tenantId,
        fromItemId: memory.id,
        toItemId: item.id,
        relation: "compacted_from",
        metadata: { jobId }
      });
    }

    let vectorsDeleted = 0;
    let deletedCount = 0;
    if (deleteOriginals) {
      for (const item of included) {
        vectorsDeleted += await deleteVectorsForDoc(item.namespace_id);
        await deleteMemoryItemById(item.id);
        deletedCount += 1;
      }
    }

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        collection,
        summaryId: memory.id,
        createdCount: 1,
        sourceCount: included.length,
        deletedCount,
        vectorsDeleted
      }
    });
  } catch (err) {
    await updateMemoryJob({ id: jobId, status: "failed", error: String(err.message || err) });
  }
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
// OpenAPI (public)
// --------------------------
app.get("/openapi.json", (req, res) => {
  res.json(buildOpenApiDoc(req));
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
      localStorage.setItem("atlasragAuthToken", ${JSON.stringify(token)});
      localStorage.setItem("atlasragAuthType", "bearer");
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
// Service tokens (admin)
// --------------------------
app.get(["/admin/service-tokens", "/v1/admin/service-tokens"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const tokens = (await listServiceTokens(tenantId)).map(formatServiceToken);
    sendOk(res, { tokens }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to list service tokens", "SERVICE_TOKEN_LIST_FAILED", tenantId, null);
  }
});

app.post(["/admin/service-tokens", "/v1/admin/service-tokens"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return sendError(res, 400, "name is required", "INVALID_REQUEST", tenantId, null);
    }

    let principalId = req.body?.principalId || req.body?.principal_id || req.user?.sub || req.user?.principal_id;
    principalId = String(principalId || "").trim();
    if (!principalId || !PRINCIPAL_RE.test(principalId)) {
      return sendError(res, 400, "Invalid principalId", "INVALID_REQUEST", tenantId, null);
    }

    const roles = normalizeRoles(req.body?.roles);
    let expiresAt = req.body?.expiresAt || req.body?.expires_at || null;
    if (expiresAt) {
      const dt = new Date(expiresAt);
      if (Number.isNaN(dt.getTime())) {
        return sendError(res, 400, "expiresAt must be a valid date", "INVALID_REQUEST", tenantId, null);
      }
      expiresAt = dt.toISOString();
    }

    const rawToken = `atrg_${crypto.randomBytes(24).toString("base64url")}`;
    const keyHash = hashToken(rawToken);
    const record = await createServiceToken({
      tenantId,
      name,
      principalId,
      roles,
      keyHash,
      expiresAt
    });

    sendOk(res, {
      token: rawToken,
      tokenInfo: formatServiceToken(record),
      note: "Store this token now. It will not be shown again."
    }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to create service token", "SERVICE_TOKEN_CREATE_FAILED", tenantId, null);
  }
});

app.delete(["/admin/service-tokens/:id", "/v1/admin/service-tokens/:id"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return sendError(res, 400, "Invalid token id", "INVALID_REQUEST", tenantId, null);
    }
    const record = await revokeServiceToken(id, tenantId);
    if (!record) {
      return sendError(res, 404, "Token not found", "NOT_FOUND", tenantId, null);
    }
    sendOk(res, { token: formatServiceToken(record) }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to revoke service token", "SERVICE_TOKEN_REVOKE_FAILED", tenantId, null);
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
    latency: getLatencyStats(tenantId)
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
      latency: getLatencyStats(tenantId)
    };
    sendOk(res, { ...tcpStats, gateway: gatewayStats }, tenantId, collection);
  } catch (e) {
    sendError(res, 500, e, "STATS_FAILED", tenantId, collection);
  }
});

app.get(["/admin/usage", "/v1/admin/usage"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const reply = await sendCmd("STATS");
    const tcpStats = JSON.parse(reply);
    const gatewayStats = {
      latency: getLatencyStats(tenantId)
    };
    if (req.path.startsWith("/v1")) {
      return sendOk(res, { ...tcpStats, gateway: gatewayStats }, tenantId, collection);
    }
    return res.json({ ...tcpStats, gateway: gatewayStats, tenantId, collection });
  } catch (e) {
    if (req.path.startsWith("/v1")) {
      return sendError(res, 500, e, "USAGE_FAILED", tenantId, collection);
    }
    return res.status(500).json({ error: String(e), tenantId, collection });
  }
});

// =======================================================
// SEMANTIC / GENAI ENDPOINTS (protected)
// =======================================================

// GET /docs/list
// - list docs for the current tenant
app.get("/collections", requireJwt, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const principalId = hasTokenAdminAccess(req) ? null : resolvePrincipalId(req);
    const docs = await listDocsForTenant(tenantId, null, principalId);
    const collections = buildCollectionsFromDocs(docs);
    res.json({ collections, totalCollections: collections.length, tenantId, collection: null });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/collections", requireJwt, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = hasTokenAdminAccess(req) ? null : resolvePrincipalId(req);
    const docs = await listDocsForTenant(tenantId, null, principalId);
    const collections = buildCollectionsFromDocs(docs);
    sendOk(res, { collections, totalCollections: collections.length }, tenantId, null);
  } catch (e) {
    sendError(res, 400, e, "COLLECTIONS_LIST_FAILED", tenantId, null);
  }
});

app.delete("/collections/:collection", requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = normalizeCollection(req.params.collection);
    const docs = await listDocsForTenant(tenantId, collection, null);
    for (const doc of docs) {
      const namespaced = namespaceDocId(tenantId, collection, doc.docId);
      await deleteDoc(namespaced);
      if (collection === DEFAULT_COLLECTION) {
        const legacy = `${tenantId}::${doc.docId}`;
        if (legacy !== namespaced) {
          await deleteDoc(legacy);
        }
      }
    }
    const deletedMemoryItems = await deleteMemoryItemsByCollection(tenantId, collection);
    res.json({
      ok: true,
      collection,
      deletedDocs: docs.length,
      deletedMemoryItems,
      tenantId,
      note: "Deleted chunk text and memory items; vector deletion is a next improvement."
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
});

app.delete("/v1/collections/:collection", requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = normalizeCollection(req.params.collection);
    const docs = await listDocsForTenant(tenantId, collection, null);
    for (const doc of docs) {
      const namespaced = namespaceDocId(tenantId, collection, doc.docId);
      await deleteDoc(namespaced);
      if (collection === DEFAULT_COLLECTION) {
        const legacy = `${tenantId}::${doc.docId}`;
        if (legacy !== namespaced) {
          await deleteDoc(legacy);
        }
      }
    }
    const deletedMemoryItems = await deleteMemoryItemsByCollection(tenantId, collection);
    sendOk(res, {
      collection,
      deletedDocs: docs.length,
      deletedMemoryItems,
      note: "Deleted chunk text and memory items; vector deletion is a next improvement."
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "COLLECTION_DELETE_FAILED", tenantId, collection);
  }
});

app.get("/docs/list", requireJwt, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection, principalId);
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
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection, principalId);
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
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);
    const expiresAt = resolveExpiresAt(req.body);
    const { chunksIndexed, truncated } = await indexDocument(
      tenantId,
      collection,
      cleanDocId,
      text,
      { type: "text", expiresAt, principalId, visibility: req.body?.visibility, acl: req.body?.acl }
    );
    res.json({ ok: true, docId: cleanDocId, collection, tenantId, chunksIndexed, truncated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/docs", requireJwt, async (req, res) => {
  const { docId, text } = req.body || {};

  const cleanDocId = String(docId || "").trim();

  if (!cleanDocId || !text) {
    return res.status(400).json(buildErrorPayload("docId and text required", "INVALID_REQUEST", null, null));
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_REQUEST", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/docs",
    handler: async () => {
      try {
        const expiresAt = resolveExpiresAt(req.body);
        const { chunksIndexed, truncated } = await indexDocument(
          tenantId,
          collection,
          cleanDocId,
          text,
          { type: "text", expiresAt, principalId, visibility: req.body?.visibility, acl: req.body?.acl }
        );
        return {
          status: 200,
          payload: buildOkPayload({ docId: cleanDocId, chunksIndexed, truncated }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "INDEX_FAILED", tenantId, collection)
        };
      }
    }
  });
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
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);
    const expiresAt = resolveExpiresAt(req.body);
    const fetched = await fetchUrlText(cleanUrl);
    const { chunksIndexed, truncated } = await indexDocument(
      tenantId,
      collection,
      cleanDocId,
      fetched.text,
      { type: "url", url: cleanUrl, metadata: { contentType: fetched.contentType || null }, expiresAt, principalId, visibility: req.body?.visibility, acl: req.body?.acl }
    );

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
    return res.status(400).json(buildErrorPayload("docId and url required", "INVALID_REQUEST", null, null));
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_REQUEST", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/docs/url",
    handler: async () => {
      try {
        const expiresAt = resolveExpiresAt(req.body);
        const fetched = await fetchUrlText(cleanUrl);
        const { chunksIndexed, truncated } = await indexDocument(
          tenantId,
          collection,
          cleanDocId,
          fetched.text,
          { type: "url", url: cleanUrl, metadata: { contentType: fetched.contentType || null }, expiresAt, principalId, visibility: req.body?.visibility, acl: req.body?.acl }
        );

        return {
          status: 200,
          payload: buildOkPayload({
            docId: cleanDocId,
            url: cleanUrl,
            contentType: fetched.contentType || null,
            extractedChars: fetched.text.length,
            fetchTruncated: fetched.truncated,
            docTruncated: truncated,
            chunksIndexed
          }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "INDEX_URL_FAILED", tenantId, collection)
        };
      }
    }
  });
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

  try {
    const tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);

    const result = await answerQuestion({ tenantId, collection, question, k, docIds, principalId });
    const citationIds = result.citations.map(c => c.chunkId);

    res.json({
      question,
      answer: result.answer,
      citations: citationIds,
      sources: result.citations,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
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
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const result = await answerQuestion({ tenantId, collection, question, k, docIds, principalId });
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

  try {
    const tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);

    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds,
      principalId,
      enforceArtifactVisibility: true
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
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
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
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds,
      principalId,
      enforceArtifactVisibility: true
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

// --------------------------
// Memory APIs (protected)
// --------------------------
const memoryWriteLegacy = async (req, res) => {
  const { text } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "text is required", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    const result = await memoryWriteCore(req);
    tenantId = result.tenantId;
    collection = result.collection;

    res.json({
      ok: true,
      memory: {
        id: result.memory.id,
        namespaceId: result.memory.namespace_id,
        type: result.memory.item_type,
        externalId: result.memory.external_id || null,
        principalId: result.memory.principal_id || null,
        visibility: result.memory.visibility || "tenant",
        acl: result.memory.acl_principals || [],
        title: result.memory.title || null,
        sourceType: result.memory.source_type || null,
        sourceUrl: result.memory.source_url || null,
        metadata: result.memory.metadata || null,
        createdAt: result.memory.created_at,
        expiresAt: result.memory.expires_at || null
      },
      chunksIndexed: result.chunksIndexed,
      truncated: result.truncated,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryWriteV1 = async (req, res) => {
  const { text } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json(buildErrorPayload("text is required", "INVALID_REQUEST", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_REQUEST", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/memory/write",
    handler: async () => {
      try {
        const result = await memoryWriteCore(req);
        return {
          status: 200,
          payload: buildOkPayload({
            memory: {
              id: result.memory.id,
              namespaceId: result.memory.namespace_id,
            type: result.memory.item_type,
            externalId: result.memory.external_id || null,
            principalId: result.memory.principal_id || null,
            visibility: result.memory.visibility || "tenant",
            acl: result.memory.acl_principals || [],
            title: result.memory.title || null,
              sourceType: result.memory.source_type || null,
              sourceUrl: result.memory.source_url || null,
              metadata: result.memory.metadata || null,
              createdAt: result.memory.created_at,
              expiresAt: result.memory.expires_at || null
            },
            chunksIndexed: result.chunksIndexed,
            truncated: result.truncated
          }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "MEMORY_WRITE_FAILED", tenantId, collection)
        };
      }
    }
  });
};

app.post(["/memory", "/memory/write"], requireJwt, memoryWriteLegacy);
app.post(["/v1/memory", "/v1/memory/write"], requireJwt, memoryWriteV1);

app.post("/memory/recall", requireJwt, async (req, res) => {
  const { query, k, types, since, until } = req.body || {};
  const limit = parseInt(k || "5", 10);

  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: "query is required", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const typeFilter = parseTypeFilter(types);
    const sinceTime = parseTimeInput(since, "since");
    const untilTime = parseTimeInput(until, "until");

    const results = await searchChunks({
      tenantId,
      collection,
      query,
      k: limit,
      docIds: []
    });

    const namespaceIds = results.map(r => r._row.doc_id);
    const memoryMap = await getMemoryItemsByNamespaceIds({
      namespaceIds,
      types: typeFilter,
      since: sinceTime,
      until: untilTime,
      excludeExpired: true,
      principalId
    });

    const recalled = [];
    for (const r of results) {
      const mem = memoryMap.get(r._row.doc_id);
      if (!mem) continue;
      recalled.push({
        score: r.score,
        chunkId: r.chunkId,
        preview: r.preview,
        memory: {
          id: mem.id,
          namespaceId: mem.namespace_id,
          type: mem.item_type,
          externalId: mem.external_id || null,
          principalId: mem.principal_id || null,
          visibility: mem.visibility || "tenant",
          acl: mem.acl_principals || [],
          title: mem.title || null,
          sourceType: mem.source_type || null,
          sourceUrl: mem.source_url || null,
          metadata: mem.metadata || null,
          createdAt: mem.created_at,
          expiresAt: mem.expires_at || null
        }
      });
      if (recalled.length >= limit) break;
    }

    res.json({
      ok: true,
      query,
      results: recalled,
      k: limit,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
});

app.post("/v1/memory/recall", requireJwt, async (req, res) => {
  const { query, k, types, since, until } = req.body || {};
  const limit = parseInt(k || "5", 10);

  if (!query || !String(query).trim()) {
    return sendError(res, 400, "query is required", "INVALID_REQUEST", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const typeFilter = parseTypeFilter(types);
    const sinceTime = parseTimeInput(since, "since");
    const untilTime = parseTimeInput(until, "until");

    const results = await searchChunks({
      tenantId,
      collection,
      query,
      k: limit,
      docIds: []
    });

    const namespaceIds = results.map(r => r._row.doc_id);
    const memoryMap = await getMemoryItemsByNamespaceIds({
      namespaceIds,
      types: typeFilter,
      since: sinceTime,
      until: untilTime,
      excludeExpired: true,
      principalId
    });

    const recalled = [];
    for (const r of results) {
      const mem = memoryMap.get(r._row.doc_id);
      if (!mem) continue;
      recalled.push({
        score: r.score,
        chunkId: r.chunkId,
        preview: r.preview,
        memory: {
          id: mem.id,
          namespaceId: mem.namespace_id,
          type: mem.item_type,
          externalId: mem.external_id || null,
          principalId: mem.principal_id || null,
          visibility: mem.visibility || "tenant",
          acl: mem.acl_principals || [],
          title: mem.title || null,
          sourceType: mem.source_type || null,
          sourceUrl: mem.source_url || null,
          metadata: mem.metadata || null,
          createdAt: mem.created_at,
          expiresAt: mem.expires_at || null
        }
      });
      if (recalled.length >= limit) break;
    }

    sendOk(res, {
      query,
      results: recalled,
      k: limit
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_RECALL_FAILED", tenantId, collection);
  }
});

const memoryReflectLegacy = async (req, res) => {
  const { docId, artifactId, types, maxItems, visibility, acl } = req.body || {};

  if (!docId && !artifactId) {
    return res.status(400).json({ error: "docId or artifactId is required", tenantId: null, collection: null });
  }
  if (docId && !isValidDocId(docId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    const reflectTypes = normalizeReflectTypes(types);
    const limit = parseInt(maxItems || "5", 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("maxItems must be a positive number");
    }
    const resolvedVisibility = normalizeVisibility(visibility);
    const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const job = await createMemoryJob({
      tenantId,
      jobType: "reflect",
      status: "queued",
      input: {
        docId: docId || null,
        artifactId: artifactId || null,
        types: reflectTypes,
        maxItems: limit,
        collection,
        principalId,
        visibility: resolvedVisibility,
        acl: aclList
      }
    });

    setImmediate(() => {
      runReflectionJob(job.id, tenantId).catch(() => {});
    });

    res.json({
      ok: true,
      job: {
        id: job.id,
        status: job.status
      },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryReflectV1 = async (req, res) => {
  const { docId, artifactId, types, maxItems, visibility, acl } = req.body || {};

  if (!docId && !artifactId) {
    return res.status(400).json(buildErrorPayload("docId or artifactId is required", "INVALID_REQUEST", null, null));
  }
  if (docId && !isValidDocId(docId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_REQUEST", null, null));
  }

  const reflectTypes = normalizeReflectTypes(types);
  const limit = parseInt(maxItems || "5", 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return res.status(400).json(buildErrorPayload("maxItems must be a positive number", "INVALID_REQUEST", tenantId, collection));
  }
  const resolvedVisibility = normalizeVisibility(visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    return res.status(400).json(buildErrorPayload("acl list is required when visibility is acl", "INVALID_REQUEST", tenantId, collection));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/memory/reflect",
    payloadForHash: {
      docId: docId || null,
      artifactId: artifactId || null,
      types: reflectTypes,
      maxItems: limit,
      collection,
      tenantId,
      principalId,
      visibility: resolvedVisibility,
      acl: aclList
    },
    handler: async () => {
      try {
        const job = await createMemoryJob({
          tenantId,
          jobType: "reflect",
          status: "queued",
          input: {
            docId: docId || null,
            artifactId: artifactId || null,
            types: reflectTypes,
            maxItems: limit,
            collection,
            principalId,
            visibility: resolvedVisibility,
            acl: aclList
          }
        });

        setImmediate(() => {
          runReflectionJob(job.id, tenantId).catch(() => {});
        });

        return {
          status: 200,
          payload: buildOkPayload({
            job: {
              id: job.id,
              status: job.status
            }
          }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "MEMORY_REFLECT_FAILED", tenantId, collection)
        };
      }
    }
  });
};

app.post("/memory/reflect", requireJwt, memoryReflectLegacy);
app.post("/v1/memory/reflect", requireJwt, memoryReflectV1);

const memoryCleanupLegacy = async (req, res) => {
  const { before, limit, dryRun } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const cutoff = before ? parseTimeInput(before, "before") : new Date();
    const max = parseInt(limit || "200", 10);
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error("limit must be a positive number");
    }

    const job = await createMemoryJob({
      tenantId,
      jobType: "ttl_cleanup",
      status: "queued",
      input: {
        before: cutoff.toISOString(),
        limit: max,
        dryRun: Boolean(dryRun),
        collection,
        principalId
      }
    });

    setImmediate(() => {
      runTtlCleanupJob(job.id, tenantId).catch(() => {});
    });

    res.json({
      ok: true,
      job: { id: job.id, status: job.status },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryCleanupV1 = async (req, res) => {
  const { before, limit, dryRun } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const cutoff = before ? parseTimeInput(before, "before") : new Date();
    const max = parseInt(limit || "200", 10);
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error("limit must be a positive number");
    }

    const job = await createMemoryJob({
      tenantId,
      jobType: "ttl_cleanup",
      status: "queued",
      input: {
        before: cutoff.toISOString(),
        limit: max,
        dryRun: Boolean(dryRun),
        collection,
        principalId
      }
    });

    setImmediate(() => {
      runTtlCleanupJob(job.id, tenantId).catch(() => {});
    });

    sendOk(res, { job: { id: job.id, status: job.status } }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_CLEANUP_FAILED", tenantId, collection);
  }
};

const memoryCompactLegacy = async (req, res) => {
  const { types, since, until, maxItems, summaryType, deleteOriginals, visibility, acl } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);

    const job = await createMemoryJob({
      tenantId,
      jobType: "compaction",
      status: "queued",
      input: {
        types: types ?? null,
        since: since || null,
        until: until || null,
        maxItems: maxItems || null,
        summaryType: summaryType || null,
        deleteOriginals: Boolean(deleteOriginals),
        collection,
        principalId,
        visibility: visibility || null,
        acl: acl || null
      }
    });

    setImmediate(() => {
      runCompactionJob(job.id, tenantId).catch(() => {});
    });

    res.json({
      ok: true,
      job: { id: job.id, status: job.status },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryCompactV1 = async (req, res) => {
  const { types, since, until, maxItems, summaryType, deleteOriginals, visibility, acl } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);

    const job = await createMemoryJob({
      tenantId,
      jobType: "compaction",
      status: "queued",
      input: {
        types: types ?? null,
        since: since || null,
        until: until || null,
        maxItems: maxItems || null,
        summaryType: summaryType || null,
        deleteOriginals: Boolean(deleteOriginals),
        collection,
        principalId,
        visibility: visibility || null,
        acl: acl || null
      }
    });

    setImmediate(() => {
      runCompactionJob(job.id, tenantId).catch(() => {});
    });

    sendOk(res, { job: { id: job.id, status: job.status } }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_COMPACTION_FAILED", tenantId, collection);
  }
};

app.post("/memory/cleanup", requireJwt, memoryCleanupLegacy);
app.post("/v1/memory/cleanup", requireJwt, memoryCleanupV1);
app.post("/memory/compact", requireJwt, memoryCompactLegacy);
app.post("/v1/memory/compact", requireJwt, memoryCompactV1);

app.get("/jobs", requireJwt, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const limit = parseInt(req.query?.limit || "20", 10);
    const statusRaw = req.query?.status ? String(req.query.status).trim() : null;
    let status = statusRaw;
    if (statusRaw === "in_progress" || statusRaw === "active") {
      status = ["queued", "running"];
    }
    const jobType = req.query?.jobType ? String(req.query.jobType) : null;
    const rows = await listMemoryJobs({ tenantId, limit, status, jobType });
    const jobs = rows.map((job) => ({
      id: job.id,
      status: job.status,
      jobType: job.job_type,
      input: parseJsonPayload(job.input),
      output: parseJsonPayload(job.output),
      error: job.error || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    res.json({ ok: true, jobs, tenantId, collection: null });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection: null });
  }
});

app.get("/v1/jobs", requireJwt, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const limit = parseInt(req.query?.limit || "20", 10);
    const statusRaw = req.query?.status ? String(req.query.status).trim() : null;
    let status = statusRaw;
    if (statusRaw === "in_progress" || statusRaw === "active") {
      status = ["queued", "running"];
    }
    const jobType = req.query?.jobType ? String(req.query.jobType) : null;
    const rows = await listMemoryJobs({ tenantId, limit, status, jobType });
    const jobs = rows.map((job) => ({
      id: job.id,
      status: job.status,
      jobType: job.job_type,
      input: parseJsonPayload(job.input),
      output: parseJsonPayload(job.output),
      error: job.error || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    sendOk(res, { jobs }, tenantId, null);
  } catch (e) {
    sendError(res, 400, e, "JOBS_LIST_FAILED", tenantId, null);
  }
});

app.get("/jobs/:id", requireJwt, async (req, res) => {
  const id = parseInt(req.params.id || "0", 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid job id", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const job = await getMemoryJobById(id, tenantId);
    if (!job) {
      return res.status(404).json({ error: "job not found", tenantId, collection });
    }
    const input = parseJsonPayload(job.input);
    const output = parseJsonPayload(job.output);
    collection = input?.collection || null;

    res.json({
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        jobType: job.job_type,
        input,
        output,
        error: job.error || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
});

app.get("/v1/jobs/:id", requireJwt, async (req, res) => {
  const id = parseInt(req.params.id || "0", 10);
  if (!Number.isFinite(id) || id <= 0) {
    return sendError(res, 400, "invalid job id", "INVALID_REQUEST", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const job = await getMemoryJobById(id, tenantId);
    if (!job) {
      return sendError(res, 404, "job not found", "NOT_FOUND", tenantId, collection);
    }
    const input = parseJsonPayload(job.input);
    const output = parseJsonPayload(job.output);
    collection = input?.collection || null;

    sendOk(res, {
      job: {
        id: job.id,
        status: job.status,
        jobType: job.job_type,
        input,
        output,
        error: job.error || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      }
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "JOB_FETCH_FAILED", tenantId, collection);
  }
});

async function start() {
  try {
    await runMigrations();
    app.listen(3000, () => {
      console.log("HTTP gateway listening on http://localhost:3000");
      scheduleAutoReindex();
    });
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
}

start();

// index.js
const express = require("express");
const fs = require("fs");
const path = require("path");

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
  listExpiredMemoryItemsGlobal,
  listMemoryItemsForCompaction,
  listMemoryItemsByExternalPrefix,
  recordMemoryEvent,
  updateMemoryItemMetrics,
  listMemoryItemsForValueDecay,
  listMemoryItemsForRedundancy,
  listMemoryItemsForLifecycle,
  createAuditLog,
  createMemoryLink,
  createMemoryJob,
  claimMemoryJob,
  updateMemoryJob,
  getMemoryJobById,
  listDueMemoryJobs,
  listMemoryJobs,
  findActiveDeleteJob,
  deleteMemoryItemsByCollection,
  beginIdempotencyKey,
  touchIdempotencyKey,
  completeIdempotencyKey,
  recordTenantUsage,
  getTenantUsage,
  getTenantUsageWindow,
  getTenantStorageStats,
  getTenantItemStats,
  getMemoryStateSnapshot,
  getTenantById,
  setTenantSettings,
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
const { computeValueScore, estimateTokensFromText } = require("./memory_value");
const {
  isBelowMinAgeForLifecycle,
  createDeleteBudget,
  consumeDeleteBudget,
  canConsumeDeleteBudget
} = require("./lifecycle_policy");
const { verifyCredentials, issueToken, parseAuthMode, normalizeAuthMode, isSsoAllowed } = require("./auth");
const { recordLatency, getLatencyStats, getAllTenantLatencyStats } = require("./metrics");
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
const {
  createRequestId: createTelemetryRequestId,
  getTelemetryMeta,
  isTelemetryEnabled,
  logTelemetry
} = require("./telemetry");

const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");
const UI_TEMPLATE_PATH = path.join(PUBLIC_DIR, "index.html");
const UI_PARTIALS_DIR = path.join(PUBLIC_DIR, "partials");

function renderPublicUiTemplate() {
  const template = fs.readFileSync(UI_TEMPLATE_PATH, "utf8");
  return template.replace(/<!--\s*@@include:([a-z0-9._-]+)\s*-->/gi, (match, partialName) => {
    const clean = String(partialName || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(clean)) {
      throw new Error(`Invalid UI partial include: ${partialName}`);
    }
    const partialPath = path.join(UI_PARTIALS_DIR, `${clean}.html`);
    if (!fs.existsSync(partialPath)) {
      throw new Error(`Missing UI partial: ${clean}.html`);
    }
    return fs.readFileSync(partialPath, "utf8");
  });
}

app.use(express.json({ limit: "8mb" }));
app.use(cookieParser(process.env.COOKIE_SECRET || process.env.JWT_SECRET || "atlasrag-cookie-secret"));

app.use((req, res, next) => {
  const incoming = req.header("x-request-id");
  const requestId = incoming ? String(incoming).trim() : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

app.use((req, res, next) => {
  if (!isTelemetryEnabled()) {
    return next();
  }
  const path = req.path || "";
  const isStaticAsset = /\.[a-z0-9]+$/i.test(path);
  if (isStaticAsset) {
    return next();
  }

  const start = process.hrtime.bigint();
  logTelemetry("request_start", {
    requestId: req.requestId,
    tenantId: resolveTenantForMetrics(req)
  }, {
    method: req.method,
    path: req.originalUrl || req.path
  });

  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    logTelemetry("request_finish", {
      requestId: req.requestId,
      tenantId: resolveTenantForMetrics(req)
    }, {
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      latency_ms: Number(elapsedMs.toFixed(2)),
      collection: req.collection ?? null
    });
  });

  next();
});

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const path = req.path || "";
    const isStaticAsset = /\.[a-z0-9]+$/i.test(path);
    if (path === "/health" && res.statusCode < 400) return;
    if (isStaticAsset) return;

    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tenantId = resolveTenantForMetrics(req) || null;
    const collection = req.collection ?? null;
    const payload = {
      level: "info",
      event: "request",
      request_id: req.requestId || null,
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      duration_ms: Number(ms.toFixed(2)),
      tenant_id: tenantId,
      collection
    };
    console.log(JSON.stringify(payload));
  });
  next();
});

app.get(["/", "/index.html"], (req, res, next) => {
  try {
    const html = renderPublicUiTemplate();
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

// Static UI is public (safe)
app.use(express.static(PUBLIC_DIR));

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
const TTL_SWEEP_ENABLED = process.env.TTL_SWEEP_ENABLED !== "0";
const TTL_SWEEP_INTERVAL_MS = parseInt(process.env.TTL_SWEEP_INTERVAL_MS || "300000", 10);
const TTL_SWEEP_BATCH_SIZE = parseInt(process.env.TTL_SWEEP_BATCH_SIZE || "200", 10);
const JOB_MAX_ATTEMPTS = parseInt(process.env.JOB_MAX_ATTEMPTS || "3", 10);
const JOB_RETRY_BASE_MS = parseInt(process.env.JOB_RETRY_BASE_MS || "2000", 10);
const JOB_RETRY_MAX_MS = parseInt(process.env.JOB_RETRY_MAX_MS || "30000", 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.JOB_SWEEP_INTERVAL_MS || "5000", 10);
const JOB_SWEEP_BATCH_SIZE = parseInt(process.env.JOB_SWEEP_BATCH_SIZE || "20", 10);
const MEMORY_RECENCY_HALFLIFE_DAYS = parseFloat(process.env.MEMORY_RECENCY_HALFLIFE_DAYS || "30");
const MEMORY_COST_SCALE_TOKENS = parseFloat(process.env.MEMORY_COST_SCALE_TOKENS || "2000");
const MEMORY_UTILITY_ALPHA = parseFloat(process.env.MEMORY_UTILITY_ALPHA || "0.2");
const MEMORY_TRUST_STEP = parseFloat(process.env.MEMORY_TRUST_STEP || "0.05");
const MEMORY_VALUE_DECAY_INTERVAL_MS = parseInt(process.env.MEMORY_VALUE_DECAY_INTERVAL_MS || "3600000", 10);
const MEMORY_VALUE_BATCH_SIZE = parseInt(process.env.MEMORY_VALUE_BATCH_SIZE || "200", 10);
const MEMORY_VALUE_MAX_ITEMS = parseInt(process.env.MEMORY_VALUE_MAX_ITEMS || "0", 10);
const MEMORY_VALUE_TEXT_FALLBACK = process.env.MEMORY_VALUE_TEXT_FALLBACK !== "0";
const MEMORY_REDUNDANCY_INTERVAL_MS = parseInt(process.env.MEMORY_REDUNDANCY_INTERVAL_MS || "86400000", 10);
const MEMORY_REDUNDANCY_BATCH_SIZE = parseInt(process.env.MEMORY_REDUNDANCY_BATCH_SIZE || "100", 10);
const MEMORY_REDUNDANCY_TOP_K = parseInt(process.env.MEMORY_REDUNDANCY_TOP_K || "8", 10);
const MEMORY_REDUNDANCY_QUERY_CHARS = parseInt(process.env.MEMORY_REDUNDANCY_QUERY_CHARS || "800", 10);
const MEMORY_LIFECYCLE_INTERVAL_MS = parseInt(process.env.MEMORY_LIFECYCLE_INTERVAL_MS || "86400000", 10);
const MEMORY_LIFECYCLE_BATCH_SIZE = parseInt(process.env.MEMORY_LIFECYCLE_BATCH_SIZE || "50", 10);
const MEMORY_LIFECYCLE_MIN_AGE_HOURS = parseFloat(process.env.MEMORY_LIFECYCLE_MIN_AGE_HOURS || "24");
const MEMORY_LIFECYCLE_MAX_DELETES = parseInt(process.env.MEMORY_LIFECYCLE_MAX_DELETES || "0", 10);
const MEMORY_LIFECYCLE_DRY_RUN = process.env.MEMORY_LIFECYCLE_DRY_RUN === "1";
const MEMORY_LIFECYCLE_DELETE_THRESHOLD = parseFloat(process.env.MEMORY_LIFECYCLE_DELETE_THRESHOLD || "0.25");
const MEMORY_LIFECYCLE_SUMMARY_THRESHOLD = parseFloat(process.env.MEMORY_LIFECYCLE_SUMMARY_THRESHOLD || "0.45");
const MEMORY_LIFECYCLE_PROMOTE_THRESHOLD = parseFloat(process.env.MEMORY_LIFECYCLE_PROMOTE_THRESHOLD || "0.70");
const MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE = parseInt(process.env.MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE || "5", 10);
const MEMORY_LIFECYCLE_COMPACT_DELETE_ORIGINALS = process.env.MEMORY_LIFECYCLE_COMPACT_DELETE_ORIGINALS !== "0";
const MEMORY_PROMOTION_MAX_ITEMS = parseInt(process.env.MEMORY_PROMOTION_MAX_ITEMS || "3", 10);
const MEMORY_PROMOTION_COOLDOWN_HOURS = parseInt(process.env.MEMORY_PROMOTION_COOLDOWN_HOURS || "24", 10);
const MEMORY_COMPACT_COOLDOWN_HOURS = parseInt(process.env.MEMORY_COMPACT_COOLDOWN_HOURS || "24", 10);
const MEMORY_SNAPSHOT_INTERVAL_MS = parseInt(process.env.TELEMETRY_SNAPSHOT_INTERVAL_MS || "300000", 10);
let reindexStarted = false;
let ttlSweepRunning = false;
let jobSweepRunning = false;
let valueDecayRunning = false;
let redundancyRunning = false;
let lifecycleRunning = false;
let memorySnapshotRunning = false;
const redundancyPending = new Set();
const FETCH_USER_AGENT = process.env.FETCH_USER_AGENT
  || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const DOC_ID_RE = /^[a-zA-Z0-9._-]+$/;
const TENANT_RE = /^[a-zA-Z0-9._-]+$/;
const COLLECTION_RE = /^[a-zA-Z0-9._-]+$/;
const ITEM_TYPE_RE = /^[a-zA-Z0-9._-]+$/;
const PRINCIPAL_RE = /^[a-zA-Z0-9._:@-]+$/;
const TAG_RE = /^[a-zA-Z0-9._:@-]+$/;
const AGENT_RE = /^[a-zA-Z0-9._:@-]+$/;
const DEFAULT_COLLECTION = process.env.DEFAULT_COLLECTION || "default";
const TENANT_SEARCH_MULTIPLIER = parseInt(process.env.TENANT_SEARCH_MULTIPLIER || "5", 10);
const TENANT_SEARCH_CAP = parseInt(process.env.TENANT_SEARCH_CAP || "50", 10);
const SSO_PROVIDERS = ["google", "azure", "okta"];
const ROLE_DEFAULT = "reader";
const ROLE_ALIASES = new Map([
  ["admin", "admin"],
  ["owner", "admin"],
  ["indexer", "indexer"],
  ["writer", "indexer"],
  ["reader", "reader"]
]);
const MEMORY_TYPES = ["artifact", "semantic", "procedural", "episodic", "conversation", "summary"];
const LEGACY_TYPE_ALIASES = new Map([
  ["memory", "semantic"]
]);
const MEMORY_EVENT_DEFAULTS = {
  retrieved: 0.1,
  used_in_answer: 0.6,
  user_positive: 1.0,
  user_negative: -1.0,
  task_success: 0.8,
  task_fail: -0.8
};
const MEMORY_TASK_EVENT_TYPES = new Set(["task_success", "task_fail"]);
const OPENAPI_HIDDEN_TAGS = new Set(["Metrics"]);

function filterPublicOpenApiDoc(doc) {
  const inputTags = Array.isArray(doc?.tags) ? doc.tags : [];
  const inputPaths = doc?.paths && typeof doc.paths === "object" ? doc.paths : {};
  const paths = {};

  for (const [route, ops] of Object.entries(inputPaths)) {
    const cleanOps = {};
    for (const [method, op] of Object.entries(ops || {})) {
      const tags = Array.isArray(op?.tags) ? op.tags : [];
      const hiddenByTag = tags.some((tag) => OPENAPI_HIDDEN_TAGS.has(tag));
      if (op?.["x-internal"] === true || hiddenByTag) continue;
      cleanOps[method] = op;
    }
    if (Object.keys(cleanOps).length > 0) {
      paths[route] = cleanOps;
    }
  }

  return {
    ...doc,
    tags: inputTags.filter((tag) => !OPENAPI_HIDDEN_TAGS.has(tag.name)),
    paths
  };
}

function buildOpenApiDoc(req, options = {}) {
  const { publicView = false } = options;
  const envBase = process.env.OPENAPI_BASE_URL || process.env.PUBLIC_BASE_URL;
  const host = req.get("host");
  const baseUrl = envBase || (host ? `${req.protocol}://${host}` : "http://localhost:3000");
  const doc = {
    ...openApiSpec,
    servers: [{ url: baseUrl }]
  };
  return publicView ? filterPublicOpenApiDoc(doc) : doc;
}

function resolveTenantForMetrics(req) {
  const candidate = req.user?.tenant || req.user?.tid || req.user?.sub;
  const clean = String(candidate || "").trim();
  if (!clean || !TENANT_RE.test(clean)) return null;
  return clean;
}

function buildTelemetryContext({ requestId, tenantId, collection, source } = {}) {
  return {
    requestId: requestId || null,
    tenantId: tenantId || null,
    collection: collection || null,
    source: source || null
  };
}

function emitTelemetry(eventType, context = {}, payload = {}) {
  if (!isTelemetryEnabled()) return;
  logTelemetry(eventType, {
    requestId: context.requestId || null,
    tenantId: context.tenantId || null
  }, {
    ...(context.collection ? { collection: context.collection } : {}),
    ...(context.source ? { source: context.source } : {}),
    ...payload
  });
}

function emitLifecycleActionTelemetry(action, item, details = {}, context = {}) {
  if (!isTelemetryEnabled()) return;
  emitTelemetry("memory_lifecycle", {
    requestId: context.requestId || null,
    tenantId: item?.tenant_id || context.tenantId || null,
    collection: item?.collection || context.collection || null,
    source: context.source || "lifecycle"
  }, {
    action,
    memory_id: item?.id || null,
    namespace_id: item?.namespace_id || null,
    item_type: item?.item_type || null,
    ...details
  });
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

function normalizeTypeValue(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return null;
  if (!ITEM_TYPE_RE.test(clean)) return null;
  if (LEGACY_TYPE_ALIASES.has(clean)) {
    return LEGACY_TYPE_ALIASES.get(clean);
  }
  if (MEMORY_TYPES.includes(clean)) return clean;
  return null;
}

function normalizeItemType(value) {
  const clean = String(value || "").trim();
  if (!clean) return "semantic";
  const normalized = normalizeTypeValue(clean);
  if (!normalized) {
    throw new Error(`type must be one of: ${MEMORY_TYPES.join(", ")}`);
  }
  return normalized;
}

function normalizeVisibility(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return "tenant";
  if (!["tenant", "private", "acl"].includes(clean)) {
    throw new Error("visibility must be one of: tenant, private, acl");
  }
  return clean;
}

function normalizeAgentId(value) {
  const clean = String(value || "").trim();
  if (!clean) return null;
  if (!AGENT_RE.test(clean)) {
    throw new Error("agentId must use only letters, numbers, dot, dash, underscore, colon, or @");
  }
  return clean;
}

function parseTagsInput(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    if (!TAG_RE.test(clean)) {
      throw new Error("tags must use only letters, numbers, dot, dash, underscore, colon, or @");
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function normalizeSsoProvidersInput(raw) {
  if (raw === undefined) return { provided: false, value: null };
  if (raw === null) return { provided: true, value: null };
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    if (!SSO_PROVIDERS.includes(clean)) {
      throw new Error(`ssoProviders must be one of: ${SSO_PROVIDERS.join(", ")}`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return { provided: true, value: out };
}

function resolveSsoProviders(tenant) {
  if (!tenant || tenant.sso_providers == null) return Array.from(SSO_PROVIDERS);
  return Array.isArray(tenant.sso_providers) ? tenant.sso_providers : [];
}

function isSsoProviderAllowed(tenant, provider) {
  if (!tenant || tenant.sso_providers == null) return true;
  if (!Array.isArray(tenant.sso_providers)) return false;
  return tenant.sso_providers.includes(provider);
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
    const normalized = normalizeTypeValue(item);
    if (!normalized) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  if (seen.has("semantic") && !seen.has("memory")) {
    out.push("memory");
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
  if (provided) {
    const candidate = String(provided).trim();
    if (!PRINCIPAL_RE.test(candidate)) {
      throw new Error("Invalid principal in request");
    }
    const allowOverride = process.env.ALLOW_PRINCIPAL_OVERRIDE === "1"
      && req.user?.auth === "api_key"
      && hasRequiredRole(req, "admin");
    if (allowOverride) {
      return candidate;
    }
    if (candidate !== clean) {
      throw new Error("principalId mismatch");
    }
  }
  return clean;
}

function parsePrivilegesInput(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    if (!PRINCIPAL_RE.test(clean)) {
      throw new Error("Invalid privilege value");
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function hasAccessOverrideInput(req) {
  const provided = req.body?.principalId || req.body?.principal_id || req.query?.principalId || req.query?.principal_id;
  const privilegesRaw = req.body?.privileges ?? req.query?.privileges;
  const privileges = parsePrivilegesInput(privilegesRaw);
  return Boolean(provided) || privileges.length > 0;
}

function normalizeRole(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return null;
  return ROLE_ALIASES.get(clean) || null;
}

function isPrincipalTenantMatch(req) {
  const principal = req.user?.principal_id || req.user?.sub;
  const tenant = req.user?.tenant || req.user?.tid || req.user?.sub;
  if (!principal || !tenant) return false;
  return String(principal).trim() === String(tenant).trim();
}

function getEffectiveRoles(req) {
  const rawRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const out = new Set();
  for (const role of rawRoles) {
    const normalized = normalizeRole(role);
    if (normalized) out.add(normalized);
  }
  if (isPrincipalTenantMatch(req)) {
    out.add("admin");
  }
  if (out.size === 0) {
    const fallback = req.user?.auth === "api_key" ? "indexer" : ROLE_DEFAULT;
    out.add(fallback);
  }
  return out;
}

function hasRequiredRole(req, required) {
  const roles = getEffectiveRoles(req);
  if (roles.has("admin")) return true;
  if (required === "admin") return false;
  if (required === "indexer") return roles.has("indexer");
  if (required === "reader") return roles.has("reader") || roles.has("indexer");
  return false;
}

function allowAccessOverride(req) {
  return process.env.ALLOW_PRINCIPAL_OVERRIDE === "1"
    && req.user?.auth === "api_key"
    && hasRequiredRole(req, "admin");
}

function resolveAccessContext(req) {
  const provided = req.body?.principalId || req.body?.principal_id || req.query?.principalId || req.query?.principal_id;
  const privileges = parsePrivilegesInput(req.body?.privileges ?? req.query?.privileges);
  const hasOverride = Boolean(provided) || privileges.length > 0;

  if (!hasOverride) {
    return { principalId: resolvePrincipalId(req), privileges: [] };
  }
  if (!allowAccessOverride(req)) {
    throw new Error("principal override not allowed");
  }

  let principalId = null;
  if (provided) {
    principalId = resolvePrincipalId(req);
  }
  return { principalId, privileges };
}

function normalizeRoles(input) {
  const list = Array.isArray(input)
    ? input
    : (typeof input === "string" ? input.split(",") : []);
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const normalized = normalizeRole(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
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
  return hasRequiredRole(req, "admin");
}

function requireRole(required) {
  return (req, res, next) => {
    if (!hasRequiredRole(req, required)) {
      const message = required === "admin"
        ? "Admin role required"
        : (required === "indexer"
          ? "Indexer or admin role required"
          : "Reader, indexer, or admin role required");
      if (req.path.startsWith("/v1")) {
        return sendError(res, 403, message, "FORBIDDEN", null, null);
      }
      return res.status(403).json({ error: message });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  return requireRole("admin")(req, res, next);
}

function resolveCollection(req, options = {}) {
  const provided = req.body?.collection || req.query?.collection;
  const collection = normalizeCollection(provided);
  const track = options.track !== false;
  if (req && track) req.collection = collection;
  return collection;
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

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function withTokenEstimate(metadata, text) {
  const tokensEst = estimateTokensFromText(text);
  const hasMeta = metadata && typeof metadata === "object" && !Array.isArray(metadata);
  const base = hasMeta ? { ...metadata } : null;
  if (Number.isFinite(tokensEst) && tokensEst > 0) {
    const out = base || {};
    out._tokens_est = tokensEst;
    return out;
  }
  return base;
}

function getTokensEstimate(memory) {
  const tokens = memory?.metadata?._tokens_est ?? memory?.metadata?.tokens_est ?? memory?.tokens_est ?? memory?.tokensEst;
  const clean = Number(tokens);
  return Number.isFinite(clean) ? clean : null;
}

function computeValueScoreForMemory(memory, tokensEst, now = new Date()) {
  const merged = { ...memory };
  if (tokensEst !== undefined && tokensEst !== null) {
    merged.tokens_est = tokensEst;
  }
  return computeValueScore(merged, {
    now,
    recencyHalfLifeDays: MEMORY_RECENCY_HALFLIFE_DAYS,
    costScaleTokens: MEMORY_COST_SCALE_TOKENS
  });
}

function formatMemoryItem(memory) {
  if (!memory) return null;
  return {
    id: memory.id,
    namespaceId: memory.namespace_id,
    type: memory.item_type,
    externalId: memory.external_id || null,
    principalId: memory.principal_id || null,
    agentId: memory.agent_id || null,
    tags: memory.tags || [],
    visibility: memory.visibility || "tenant",
    acl: memory.acl_principals || [],
    title: memory.title || null,
    sourceType: memory.source_type || null,
    sourceUrl: memory.source_url || null,
    metadata: memory.metadata || null,
    createdAt: memory.created_at,
    expiresAt: memory.expires_at || null,
    valueScore: memory.value_score ?? null,
    reuseCount: memory.reuse_count ?? 0,
    lastUsedAt: memory.last_used_at || null,
    utilityEma: memory.utility_ema ?? 0,
    redundancyScore: memory.redundancy_score ?? 0,
    trustScore: memory.trust_score ?? 0.5,
    importanceHint: memory.importance_hint ?? null,
    pinned: Boolean(memory.pinned)
  };
}

function buildAuditActor(req) {
  const auth = req.user?.auth || "system";
  const actorId = req.user?.principal_id || req.user?.sub || null;
  let actorType = "system";
  if (auth === "api_key") actorType = "service";
  else if (auth === "jwt") actorType = "user";
  else if (auth) actorType = String(auth);
  const tokenId = req.user?.token_id || null;
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : null;
  return {
    actorId,
    actorType,
    auth,
    tokenId,
    roles
  };
}

function mergeAuditMetadata(base, actor) {
  const metadata = { ...(base || {}) };
  if (actor?.auth) metadata.auth = actor.auth;
  if (actor?.tokenId) metadata.tokenId = actor.tokenId;
  if (actor?.roles && actor.roles.length) metadata.roles = actor.roles;
  return metadata;
}

async function recordAudit(req, tenantId, { action, targetType, targetId, metadata }) {
  if (!tenantId || !action) return;
  const actor = buildAuditActor(req);
  const merged = mergeAuditMetadata(metadata, actor);
  const payload = {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action,
    targetType: targetType || null,
    targetId: targetId || null,
    metadata: Object.keys(merged).length ? merged : null,
    requestId: req.requestId || null,
    ip: req.ip || null
  };
  try {
    await createAuditLog(payload);
  } catch (err) {
    console.warn("[audit] Failed to record audit log:", err?.message || err);
  }
}

function normalizeEventValue(eventType, eventValue) {
  const fallback = MEMORY_EVENT_DEFAULTS[eventType] ?? 0;
  if (eventValue === undefined || eventValue === null || eventValue === "") {
    return clampNumber(fallback, -1, 1);
  }
  const value = Number(eventValue);
  if (!Number.isFinite(value)) {
    throw new Error("eventValue must be a number");
  }
  return clampNumber(value, -1, 1);
}

function shouldIncrementReuse(eventType) {
  return eventType === "retrieved" || eventType === "used_in_answer";
}

function shouldUpdateUtility(eventType) {
  return eventType in MEMORY_EVENT_DEFAULTS;
}

function updateUtilityEma(previous, eventValue) {
  const prev = Number(previous || 0);
  const alpha = Number.isFinite(MEMORY_UTILITY_ALPHA) ? MEMORY_UTILITY_ALPHA : 0.2;
  return clampNumber(prev * (1 - alpha) + eventValue * alpha, -1, 1);
}

function updateTrustScore(previous, eventType, eventValue) {
  if (!["user_positive", "user_negative", "task_success", "task_fail"].includes(eventType)) {
    return clampNumber(Number(previous ?? 0.5), 0, 1);
  }
  const prev = Number(previous ?? 0.5);
  const step = Number.isFinite(MEMORY_TRUST_STEP) ? MEMORY_TRUST_STEP : 0.05;
  return clampNumber(prev + step * eventValue, 0, 1);
}

async function recordMemoryEventForItem(memory, eventType, eventValue) {
  if (!memory || !memory.id || !memory.tenant_id) return null;
  const normalizedValue = normalizeEventValue(eventType, eventValue);
  const now = new Date();
  await recordMemoryEvent({
    memoryId: memory.id,
    tenantId: memory.tenant_id,
    eventType,
    eventValue: normalizedValue,
    createdAt: now
  });

  const reuseCount = shouldIncrementReuse(eventType)
    ? Number(memory.reuse_count || 0) + 1
    : Number(memory.reuse_count || 0);
  const utilityEma = shouldUpdateUtility(eventType)
    ? updateUtilityEma(memory.utility_ema, normalizedValue)
    : Number(memory.utility_ema || 0);
  const trustScore = updateTrustScore(memory.trust_score, eventType, normalizedValue);
  const lastUsedAt = now;

  const tokensEst = getTokensEstimate(memory);
  const valueScore = computeValueScoreForMemory({
    ...memory,
    reuse_count: reuseCount,
    utility_ema: utilityEma,
    trust_score: trustScore,
    last_used_at: lastUsedAt
  }, tokensEst, now);

  return updateMemoryItemMetrics({
    id: memory.id,
    tenantId: memory.tenant_id,
    reuseCount,
    lastUsedAt,
    utilityEma,
    trustScore,
    valueScore
  });
}

async function recordMemoryEventsForItems(memories, eventType, eventValue) {
  if (!Array.isArray(memories) || memories.length === 0) return;
  for (const memory of memories) {
    try {
      await recordMemoryEventForItem(memory, eventType, eventValue);
    } catch (err) {
      console.warn(`[memory_events] Failed to record ${eventType} for ${memory?.id}:`, err?.message || err);
    }
  }
}

function toPositiveInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function parseEmbeddingUsage(usage) {
  const total = toPositiveInt(usage?.total_tokens ?? usage?.prompt_tokens);
  const prompt = toPositiveInt(usage?.prompt_tokens);
  return { total, prompt };
}

function parseGenerationUsage(usage) {
  const input = toPositiveInt(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = toPositiveInt(usage?.output_tokens ?? usage?.completion_tokens);
  const total = toPositiveInt(usage?.total_tokens) || (input + output);
  return { input, output, total };
}

function safeUsageRecord(promise) {
  if (!promise || typeof promise.catch !== "function") return;
  promise.catch((err) => {
    console.warn("[usage] Failed to record usage:", err?.message || err);
  });
}

function recordEmbeddingUsage(tenantId, usage, telemetryContext) {
  if (!tenantId) return;
  const tokens = parseEmbeddingUsage(usage);
  if (!tokens.total) return;
  safeUsageRecord(recordTenantUsage({
    tenantId,
    embeddingTokens: tokens.total,
    embeddingRequests: 1
  }));
  emitTelemetry("token_usage", buildTelemetryContext({
    requestId: telemetryContext?.requestId,
    tenantId,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "embedding"
  }), {
    token_kind: "embedding",
    token_total: tokens.total,
    token_prompt: tokens.prompt
  });
}

function recordGenerationUsage(tenantId, usage, telemetryContext) {
  if (!tenantId) return;
  const tokens = parseGenerationUsage(usage);
  if (!tokens.total) return;
  safeUsageRecord(recordTenantUsage({
    tenantId,
    generationInputTokens: tokens.input,
    generationOutputTokens: tokens.output,
    generationTotalTokens: tokens.total,
    generationRequests: 1
  }));
  emitTelemetry("token_usage", buildTelemetryContext({
    requestId: telemetryContext?.requestId,
    tenantId,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "generation"
  }), {
    token_kind: "generation",
    token_input: tokens.input,
    token_output: tokens.output,
    token_total: tokens.total
  });
}

function sendOk(res, data, tenantId, collection) {
  res.json(buildOkPayload(data, tenantId, collection));
}

function sendError(res, status, message, code, tenantId, collection) {
  res.status(status).json(buildErrorPayload(message, code, tenantId, collection));
}

function escapePromLabel(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function formatPromLabels(labels) {
  const entries = Object.entries(labels || {}).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapePromLabel(v)}"`);
  return `{${parts.join(",")}}`;
}

function pushPromMetric(lines, name, labels, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  lines.push(`${name}${formatPromLabels(labels)} ${value}`);
}

function emitPromLatencySummary(lines, summary, labels) {
  if (!summary) return;
  const base = labels || {};
  const quantiles = [
    ["0.5", summary.p50_ms],
    ["0.9", summary.p90_ms],
    ["0.95", summary.p95_ms],
    ["0.99", summary.p99_ms]
  ];
  for (const [q, v] of quantiles) {
    pushPromMetric(lines, "atlasrag_request_latency_ms", { ...base, quantile: q }, v);
  }
  if (Number.isFinite(summary.avg_ms) && Number.isFinite(summary.count)) {
    const sum = summary.avg_ms * summary.count;
    pushPromMetric(lines, "atlasrag_request_latency_ms_sum", base, sum);
    pushPromMetric(lines, "atlasrag_request_latency_ms_count", base, summary.count);
  }
  if (Number.isFinite(summary.count)) {
    pushPromMetric(lines, "atlasrag_requests_total", base, summary.count);
  }
  if (Number.isFinite(summary.error_count)) {
    pushPromMetric(lines, "atlasrag_request_errors_total", base, summary.error_count);
  }
  if (Number.isFinite(summary.error_rate)) {
    pushPromMetric(lines, "atlasrag_request_error_rate", base, summary.error_rate);
  }
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
  const { vectors } = await embedTexts(texts);

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

async function runTtlSweepOnce() {
  if (ttlSweepRunning) return;
  ttlSweepRunning = true;
  const batchSize = Number.isFinite(TTL_SWEEP_BATCH_SIZE) && TTL_SWEEP_BATCH_SIZE > 0 ? TTL_SWEEP_BATCH_SIZE : 200;
  let totalDeleted = 0;
  let vectorsDeleted = 0;
  let vectorFailures = 0;
  let queuedDeletes = 0;
  const cutoff = new Date();
  try {
    while (true) {
      const items = await listExpiredMemoryItemsGlobal({ before: cutoff, limit: batchSize });
      if (!items.length) break;
      let batchDeleted = 0;
      for (const item of items) {
        const result = await deleteMemoryItemFully(item, { reason: "ttl_sweep" });
        if (result?.deleted) {
          vectorsDeleted += result.vectorsDeleted || 0;
          totalDeleted += 1;
          batchDeleted += 1;
        } else if (result?.failed) {
          vectorFailures += result.failed;
        }
        if (result?.queued) {
          queuedDeletes += 1;
        }
      }
      if (batchDeleted === 0) break;
      if (items.length < batchSize) break;
    }
    if (totalDeleted || vectorFailures || queuedDeletes) {
      console.log(`[ttl] sweep deleted=${totalDeleted} vectors=${vectorsDeleted} failures=${vectorFailures} queuedDeletes=${queuedDeletes}`);
    }
  } catch (err) {
    console.warn("[ttl] sweep failed:", err?.message || err);
  } finally {
    ttlSweepRunning = false;
  }
}

function scheduleTtlSweep() {
  if (!TTL_SWEEP_ENABLED) return;
  if (!Number.isFinite(TTL_SWEEP_INTERVAL_MS) || TTL_SWEEP_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runTtlSweepOnce().catch(() => {});
    setInterval(() => {
      runTtlSweepOnce().catch(() => {});
    }, TTL_SWEEP_INTERVAL_MS);
  }, 2000);
}

async function sweepDueMemoryJobs() {
  if (jobSweepRunning) return;
  jobSweepRunning = true;
  const batchSize = Number.isFinite(JOB_SWEEP_BATCH_SIZE) && JOB_SWEEP_BATCH_SIZE > 0 ? JOB_SWEEP_BATCH_SIZE : 20;
  try {
    const jobs = await listDueMemoryJobs({ limit: batchSize });
    for (const job of jobs) {
      await dispatchMemoryJob(job.id, job.tenant_id, job.job_type);
    }
  } catch (err) {
    console.warn("[jobs] sweep failed:", err?.message || err);
  } finally {
    jobSweepRunning = false;
  }
}

function scheduleJobSweep() {
  if (!Number.isFinite(JOB_SWEEP_INTERVAL_MS) || JOB_SWEEP_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    sweepDueMemoryJobs().catch(() => {});
    setInterval(() => {
      sweepDueMemoryJobs().catch(() => {});
    }, JOB_SWEEP_INTERVAL_MS);
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

  const res = await fetch(url.toString(), {
    redirect: "follow",
    headers: {
      "User-Agent": FETCH_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.8"
    }
  });
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

async function indexDocument(tenantId, collection, docId, text, source, options = {}) {
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
    agentId: source?.agentId || null,
    tags: source?.tags || null,
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
  const { vectors, usage } = await embedTexts(texts);
  recordEmbeddingUsage(tenantId, usage, buildTelemetryContext({
    requestId: options?.telemetry?.requestId,
    tenantId,
    collection,
    source: options?.telemetry?.source || "document_index"
  }));
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

async function listDocsForTenant(tenantId, collection, principalId, privileges) {
  const rows = await listDocsByTenant(tenantId, principalId, privileges);
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

async function searchChunks({ tenantId, collection, query, k, docIds, principalId, privileges, enforceArtifactVisibility, telemetry }) {
  const { vectors: [qvec], usage } = await embedTexts([query]);
  recordEmbeddingUsage(tenantId, usage, buildTelemetryContext({
    requestId: telemetry?.requestId,
    tenantId,
    collection,
    source: telemetry?.source || "search_query"
  }));

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

  if (enforceArtifactVisibility && (principalId || (privileges && privileges.length))) {
    const namespaceIds = results.map(r => r._row.doc_id);
    const artifactMap = await getMemoryItemsByNamespaceIds({
      namespaceIds,
      types: ["artifact"],
      excludeExpired: true,
      principalId,
      privileges
    });
    return results.filter(r => artifactMap.has(r._row.doc_id));
  }

  return results;
}

async function answerQuestion({ tenantId, collection, question, k, docIds, principalId, privileges, telemetry }) {
  const telemetryContext = buildTelemetryContext({
    requestId: telemetry?.requestId,
    tenantId,
    collection,
    source: telemetry?.source || "answer_question"
  });

  const results = await searchChunks({
    tenantId,
    collection,
    query: question,
    k,
    docIds,
    principalId,
    privileges,
    enforceArtifactVisibility: true,
    telemetry: buildTelemetryContext({
      requestId: telemetryContext.requestId,
      tenantId,
      collection,
      source: "answer_retrieval_query"
    })
  });

  let memoryMap = new Map();
  const namespaceIds = results.map(r => r._row.doc_id);
  if (namespaceIds.length) {
    try {
      memoryMap = await getMemoryItemsByNamespaceIds({
        namespaceIds,
        types: ["artifact"],
        excludeExpired: true,
        principalId,
        privileges
      });

      const retrieved = [];
      const usedItems = [];
      const seen = new Set();
      for (const result of results) {
        const mem = memoryMap.get(result._row.doc_id);
        if (!mem) continue;
        retrieved.push({
          memory_id: mem.id,
          namespace_id: mem.namespace_id,
          item_type: mem.item_type,
          chunk_id: result.chunkId,
          score: result.score,
          value_score: mem.value_score ?? null
        });
        if (seen.has(mem.id)) continue;
        seen.add(mem.id);
        usedItems.push(mem);
      }

      emitTelemetry("memory_retrieval", telemetryContext, {
        operation: "answer_question",
        query_chars: String(question || "").length,
        retrieved_count: retrieved.length,
        retrieved
      });

      await recordMemoryEventsForItems(usedItems, "used_in_answer");
      emitTelemetry("memory_used", telemetryContext, {
        operation: "answer_question",
        memory_count: usedItems.length,
        memory_ids: usedItems.map((mem) => mem.id)
      });
    } catch (err) {
      console.warn("[memory_events] Failed to record used_in_answer:", err?.message || err);
      emitTelemetry("memory_retrieval", telemetryContext, {
        operation: "answer_question",
        query_chars: String(question || "").length,
        retrieved_count: results.length,
        retrieved: results.map((result) => ({
          memory_id: null,
          namespace_id: result?._row?.doc_id || null,
          chunk_id: result?.chunkId || null,
          score: result?.score ?? null
        })),
        warning: "memory_lookup_failed"
      });
    }
  }

  const chunks = results.map((result) => {
    const memory = memoryMap.get(result._row.doc_id);
    return {
      ...result._row,
      _retrieval_score: result.score,
      memory_id: memory?.id || null,
      memory_type: memory?.item_type || null
    };
  }).filter(Boolean);

  const { answer, citations, usage } = await generateAnswer(question, chunks, {
    onPromptBuilt: (promptStats) => {
      const memoryIds = [];
      const seen = new Set();
      const chunkIds = [];
      for (const chunk of promptStats?.chunks || []) {
        if (chunk?.chunkId) {
          chunkIds.push(chunk.chunkId);
        }
        const memoryId = chunk?.memoryId;
        if (!memoryId || seen.has(memoryId)) continue;
        seen.add(memoryId);
        memoryIds.push(memoryId);
      }
      emitTelemetry("prompt_constructed", telemetryContext, {
        operation: "answer_question",
        question_chars: String(question || "").length,
        prompt_chars: Number(promptStats?.promptChars || 0),
        prompt_tokens_est: Number(promptStats?.promptTokensEst || 0),
        chunk_count: chunkIds.length,
        memory_count: memoryIds.length || Number(promptStats?.memoriesIncluded || 0),
        chunk_ids: chunkIds,
        memory_ids: memoryIds
      });
    }
  });

  recordGenerationUsage(tenantId, usage, buildTelemetryContext({
    requestId: telemetryContext.requestId,
    tenantId,
    collection,
    source: "answer_generation"
  }));

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

async function indexMemoryText(namespaceId, text, options = {}) {
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
  const { vectors, usage } = await embedTexts(texts);
  const parsed = parseNamespacedDocId(namespaceId);
  recordEmbeddingUsage(parsed?.tenantId, usage, buildTelemetryContext({
    requestId: options?.telemetry?.requestId,
    tenantId: parsed?.tenantId,
    collection: parsed?.collection || null,
    source: options?.telemetry?.source || "memory_index"
  }));

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

function scheduleRedundancyUpdate(item) {
  if (!item || !item.id) return;
  if (item.item_type === "artifact") return;
  if (redundancyPending.has(item.id)) return;
  redundancyPending.add(item.id);
  setImmediate(async () => {
    try {
      await computeRedundancyForItem(item);
    } catch (err) {
      console.warn("[redundancy] async update failed:", err?.message || err);
    } finally {
      redundancyPending.delete(item.id);
    }
  });
}

async function deleteVectorsForDoc(namespaceId, options = {}) {
  const strict = options.strict === true;
  const rows = await getChunksByDocId(namespaceId);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await sendCmd(buildVdel(row.chunk_id));
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  if (strict && failed > 0) {
    return { deleted, failed, removedDoc: false };
  }
  await deleteDoc(namespaceId);
  return { deleted, failed, removedDoc: true };
}

async function memoryWriteCore(req) {
  const { text, type, title, externalId, metadata, sourceType, sourceUrl, createdAt, visibility, acl } = req.body || {};
  const tenantId = resolveTenantId(req);
  const principalId = resolvePrincipalId(req);
  const collection = resolveCollection(req);
  const itemType = normalizeItemType(type);
  const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
  const tags = parseTagsInput(req.body?.tags);
  const createdTime = createdAt ? parseTimeInput(createdAt, "createdAt") : null;
  const expiresAt = resolveExpiresAt(req.body);
  const resolvedVisibility = normalizeVisibility(visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    throw new Error("acl list is required when visibility is acl");
  }
  const importanceRaw = req.body?.importanceHint ?? req.body?.importance_hint;
  const importanceHint = importanceRaw === undefined || importanceRaw === null || importanceRaw === ""
    ? undefined
    : Number(importanceRaw);
  if (importanceRaw !== undefined && importanceRaw !== null && importanceRaw !== "" && !Number.isFinite(importanceHint)) {
    throw new Error("importanceHint must be a number");
  }
  let pinned = req.body?.pinned;
  if (pinned !== undefined) {
    if (typeof pinned === "string") {
      const clean = pinned.trim().toLowerCase();
      if (clean === "true") pinned = true;
      else if (clean === "false") pinned = false;
    }
    if (pinned !== true && pinned !== false) {
      throw new Error("pinned must be a boolean");
    }
  }
  const memoryId = crypto.randomUUID();
  const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);

  const metadataWithTokens = withTokenEstimate(metadata, text);
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
    metadata: metadataWithTokens,
    createdAt: createdTime,
    expiresAt,
    principalId,
    agentId,
    tags,
    visibility: resolvedVisibility,
    acl: aclList,
    importanceHint,
    pinned
  });

  const { chunksIndexed, truncated } = await indexMemoryText(memory.namespace_id, text, {
    telemetry: buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "memory_write_index"
    })
  });
  scheduleRedundancyUpdate(memory);

  try {
    const tokensEst = getTokensEstimate(memory);
    const valueScore = computeValueScoreForMemory(memory, tokensEst);
    const updated = await updateMemoryItemMetrics({
      id: memory.id,
      tenantId,
      valueScore,
      lastUsedAt: memory.created_at
    });
    if (updated) {
      memory.value_score = updated.value_score;
      memory.last_used_at = updated.last_used_at;
    } else {
      memory.value_score = valueScore;
    }
  } catch (err) {
    console.warn("[memory] Failed to set initial value score:", err?.message || err);
  }

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

function computeJobBackoff(attempt) {
  const base = Number.isFinite(JOB_RETRY_BASE_MS) && JOB_RETRY_BASE_MS > 0 ? JOB_RETRY_BASE_MS : 2000;
  const max = Number.isFinite(JOB_RETRY_MAX_MS) && JOB_RETRY_MAX_MS > 0 ? JOB_RETRY_MAX_MS : 30000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(exp * (Math.random() * 0.2));
  return exp + jitter;
}

async function dispatchMemoryJob(jobId, tenantId, jobType) {
  const type = jobType || null;
  if (type === "reflect") {
    await runReflectionJob(jobId, tenantId);
    return;
  }
  if (type === "ttl_cleanup") {
    await runTtlCleanupJob(jobId, tenantId);
    return;
  }
  if (type === "compaction") {
    await runCompactionJob(jobId, tenantId);
    return;
  }
  if (type === "delete_reconcile") {
    await runDeleteReconcileJob(jobId, tenantId);
    return;
  }
  if (!type) {
    const job = await getMemoryJobById(jobId, tenantId);
    if (!job) return;
    await dispatchMemoryJob(jobId, tenantId, job.job_type);
    return;
  }
  console.warn(`[jobs] Unknown job type ${type} for job ${jobId}`);
}

async function finalizeJobFailure(job, err, options = {}) {
  const retryable = options.retryable !== false;
  const message = String(err?.message || err);
  const maxAttempts = Number.isFinite(job.max_attempts) && job.max_attempts > 0
    ? job.max_attempts
    : (Number.isFinite(JOB_MAX_ATTEMPTS) && JOB_MAX_ATTEMPTS > 0 ? JOB_MAX_ATTEMPTS : 3);
  const attempts = Number.isFinite(job.attempts) ? job.attempts + 1 : 1;

  if (!retryable || attempts >= maxAttempts) {
    await updateMemoryJob({ id: job.id, status: "failed", error: message, attempts });
    return { retried: false, attempts };
  }

  const delay = computeJobBackoff(attempts);
  const nextRunAt = new Date(Date.now() + delay);
  await updateMemoryJob({ id: job.id, status: "queued", error: message, attempts, nextRunAt });
  setTimeout(() => {
    dispatchMemoryJob(job.id, job.tenant_id, job.job_type).catch(() => {});
  }, delay);
  return { retried: true, attempts, nextRunAt };
}

async function cleanupJobDerivedItems({ jobId, tenantId, collection, expectedExternalIds }) {
  const items = await listMemoryItemsByExternalPrefix({
    tenantId,
    collection,
    prefix: `job:${jobId}:`
  });
  const expected = new Set(expectedExternalIds || []);
  for (const item of items) {
    if (expected.size > 0 && item.external_id && expected.has(item.external_id)) {
      continue;
    }
    const result = await deleteMemoryItemFully(item, { reason: "job_cleanup" });
    if (result?.queued) {
      console.warn(`[delete] queued reconcile for job cleanup item id=${item.id}`);
    }
  }
}

async function cleanupExternalItems({ tenantId, collection, prefix, expectedExternalIds }) {
  const items = await listMemoryItemsByExternalPrefix({
    tenantId,
    collection,
    prefix
  });
  const expected = new Set(expectedExternalIds || []);
  for (const item of items) {
    if (expected.size > 0 && item.external_id && expected.has(item.external_id)) {
      continue;
    }
    const result = await deleteMemoryItemFully(item, { reason: "external_cleanup" });
    if (result?.queued) {
      console.warn(`[delete] queued reconcile for external cleanup item id=${item.id}`);
    }
  }
}

async function enqueueDeleteReconcileJob(item, reason, failedCount) {
  if (!item?.tenant_id || !item?.id) return null;
  const existing = await findActiveDeleteJob({ tenantId: item.tenant_id, memoryId: item.id });
  if (existing) return existing;
  return createMemoryJob({
    tenantId: item.tenant_id,
    jobType: "delete_reconcile",
    status: "queued",
    input: {
      memoryId: item.id,
      namespaceId: item.namespace_id || null,
      collection: item.collection || null,
      reason: reason || "vdel_failed",
      failed: Number.isFinite(failedCount) ? failedCount : null
    },
    maxAttempts: JOB_MAX_ATTEMPTS
  });
}

async function loadArtifactText(namespaceId) {
  const rows = await getChunksByDocId(namespaceId);
  if (!rows.length) return "";
  return rows.map(r => r.text).join("\n\n");
}

async function runReflectionJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  try {

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const types = Array.isArray(input.types) ? input.types : [];
    const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : undefined;
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;
    const requestedVisibility = input.visibility ? normalizeVisibility(input.visibility) : null;
    const requestedAcl = input.acl;

    let sourceItem = null;
    let sourceType = null;
    if (input.conversationId) {
      sourceItem = await getMemoryItemById(input.conversationId, tenantId, principalId);
      sourceType = "conversation";
    } else if (input.artifactId) {
      sourceItem = await getMemoryItemById(input.artifactId, tenantId, principalId);
      sourceType = "artifact";
    } else if (input.docId) {
      sourceItem = await getArtifactByExternalId(tenantId, collection, input.docId, principalId);
      sourceType = "artifact";
    }

    if (!sourceItem) {
      const message = sourceType === "conversation" ? "Conversation not found" : "Artifact not found";
      await finalizeJobFailure(job, message, { retryable: false });
      return;
    }
    if (sourceType === "artifact" && sourceItem.item_type !== "artifact") {
      await finalizeJobFailure(job, "Item is not an artifact", { retryable: false });
      return;
    }
    if (sourceType === "conversation" && sourceItem.item_type !== "conversation") {
      await finalizeJobFailure(job, "Item is not a conversation", { retryable: false });
      return;
    }

    const derivedAgentId = sourceItem.agent_id || null;
    const derivedTags = Array.isArray(sourceItem.tags) && sourceItem.tags.length ? sourceItem.tags : null;

    let text = await loadArtifactText(sourceItem.namespace_id);
    if (!text.trim()) {
      const message = sourceType === "conversation"
        ? "Conversation has no text chunks"
        : "Artifact has no text chunks";
      await finalizeJobFailure(job, message, { retryable: false });
      return;
    }

    if (text.length > MAX_REFLECT_CHARS) {
      text = text.slice(0, MAX_REFLECT_CHARS);
    }

    const reflection = await reflectMemories({ text, types, maxItems });
    recordGenerationUsage(tenantId, reflection?.usage, buildTelemetryContext({
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      source: "job_reflection_generation"
    }));

    const expectedExternalIds = [];
    const typeMap = {
      semantic: reflection.semantic || [],
      procedural: reflection.procedural || [],
      summary: reflection.summary || []
    };
    for (const [type, items] of Object.entries(typeMap)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      for (let i = 0; i < items.length; i += 1) {
        expectedExternalIds.push(`job:${jobId}:${type}:${i + 1}`);
      }
    }
    await cleanupJobDerivedItems({ jobId, tenantId, collection, expectedExternalIds });

    const ownerId = principalId || sourceItem.principal_id || null;
    const resolvedVisibility = requestedVisibility || sourceItem.visibility || "tenant";
    const aclList = resolvedVisibility === "acl"
      ? normalizeAclList(requestedAcl || sourceItem.acl_principals || [], ownerId)
      : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const created = [];

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
          metadata: withTokenEstimate({
            origin: "reflect",
            artifactId: sourceType === "artifact" ? sourceItem.id : null,
            conversationId: sourceType === "conversation" ? sourceItem.id : null,
            jobId,
            type
          }, content),
          principalId: ownerId,
          agentId: derivedAgentId,
          tags: derivedTags,
          visibility: resolvedVisibility,
          acl: aclList
        });

        const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
        if (cleanup.failed > 0) {
          throw new Error(`Failed to delete vectors for memory ${memory.id}`);
        }

        await indexMemoryText(memory.namespace_id, content, {
          telemetry: buildTelemetryContext({
            requestId: `job:${jobId}`,
            tenantId,
            collection,
            source: "job_reflection_index"
          })
        });
        scheduleRedundancyUpdate(memory);
        await createMemoryLink({
          tenantId,
          fromItemId: memory.id,
          toItemId: sourceItem.id,
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
        artifactId: sourceType === "artifact" ? sourceItem.id : null,
        conversationId: sourceType === "conversation" ? sourceItem.id : null,
        createdCount: created.length,
        created
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

async function runTtlCleanupJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;

  try {
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
    let vectorFailures = 0;
    let queuedDeletes = 0;

    if (!dryRun) {
      for (const item of items) {
        const result = await deleteMemoryItemFully(item, { reason: "ttl_cleanup" });
        if (result?.deleted) {
          itemsDeleted += 1;
          vectorsDeleted += result.vectorsDeleted || 0;
        } else if (result?.failed) {
          vectorFailures += result.failed;
        }
        if (result?.queued) {
          queuedDeletes += 1;
        }
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
        vectorsDeleted,
        vectorFailures,
        queuedDeletes
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

async function runCompactionJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  try {

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const typeFilter = parseTypeFilter(input.types);
    const types = typeFilter.length
      ? typeFilter
      : ["semantic", "procedural", "summary", "episodic", "conversation", "memory"];
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
      await finalizeJobFailure(job, "No memory text available for compaction", { retryable: false });
      return;
    }

    const combined = parts.join("\n\n---\n\n");
    const summary = await summarizeMemories({ text: combined });
    recordGenerationUsage(tenantId, summary?.usage, buildTelemetryContext({
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      source: "job_compaction_generation"
    }));
    if (!summary.content) {
      await finalizeJobFailure(job, "Compaction produced empty summary", { retryable: false });
      return;
    }

    await cleanupJobDerivedItems({
      jobId,
      tenantId,
      collection,
      expectedExternalIds: [`job:${jobId}:compaction`]
    });

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
      metadata: withTokenEstimate({
        origin: "compaction",
        jobId,
        sourceCount: included.length,
        types
      }, summary.content),
      principalId: ownerId,
      visibility: resolvedVisibility,
      acl: aclList
    });

    const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
    if (cleanup.failed > 0) {
      throw new Error(`Failed to delete vectors for memory ${memory.id}`);
    }

    await indexMemoryText(memory.namespace_id, summary.content, {
      telemetry: buildTelemetryContext({
        requestId: `job:${jobId}`,
        tenantId,
        collection,
        source: "job_compaction_index"
      })
    });
    scheduleRedundancyUpdate(memory);

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
    let vectorFailures = 0;
    let queuedDeletes = 0;
    if (deleteOriginals) {
      for (const item of included) {
        const result = await deleteMemoryItemFully(item, {
          reason: "compaction_job",
          requestId: `job:${jobId}`,
          source: "job_compaction"
        });
        if (result?.deleted) {
          vectorsDeleted += result.vectorsDeleted || 0;
          deletedCount += 1;
        } else if (result?.failed) {
          vectorFailures += result.failed;
        }
        if (result?.queued) {
          queuedDeletes += 1;
        }
      }
    }

    emitLifecycleActionTelemetry("compact", memory, {
      status: "created",
      reason: "compaction_job",
      source_count: included.length,
      source_memory_ids: included.map((item) => item.id),
      deleted_originals: deletedCount,
      vector_failures: vectorFailures,
      queued_delete_reconciles: queuedDeletes
    }, {
      requestId: `job:${jobId}`,
      source: "job_compaction"
    });

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        collection,
        summaryId: memory.id,
        createdCount: 1,
        sourceCount: included.length,
        deletedCount,
        vectorsDeleted,
        vectorFailures,
        queuedDeletes
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

async function runDeleteReconcileJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  try {
    const input = parseJsonPayload(job.input) || {};
    const memoryId = input.memoryId || null;
    let namespaceId = input.namespaceId || null;

    let memory = null;
    if (!namespaceId && memoryId) {
      memory = await getMemoryItemById(memoryId, tenantId, null);
      namespaceId = memory?.namespace_id || null;
    }

    if (!namespaceId) {
      throw new Error("Missing namespaceId for delete reconcile");
    }

    const result = await deleteVectorsForDoc(namespaceId, { strict: true });
    if (result.failed > 0) {
      throw new Error(`Failed to delete vectors for memory ${memoryId || namespaceId}`);
    }

    let dbDeleted = 0;
    if (memoryId) {
      await deleteMemoryItemById(memoryId);
      dbDeleted = 1;
    }

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        memoryId,
        namespaceId,
        vectorsDeleted: result.deleted,
        dbDeleted
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

function isExpiredMemory(item, now = new Date()) {
  if (!item?.expires_at) return false;
  return new Date(item.expires_at) <= now;
}

function visibilitySignature(item) {
  const visibility = item?.visibility || "tenant";
  if (visibility === "tenant") return "tenant";
  const acl = Array.isArray(item?.acl_principals) ? item.acl_principals.slice().sort().join(",") : "";
  const principal = item?.principal_id || "";
  return `${visibility}|${principal}|${acl}`;
}

async function deleteMemoryItemFully(item, options = {}) {
  if (!item?.id || !item?.namespace_id) {
    return { deleted: false, queued: false, skipped: "missing" };
  }
  const result = await deleteVectorsForDoc(item.namespace_id, { strict: true });
  if (result.failed > 0) {
    const job = await enqueueDeleteReconcileJob(item, options.reason, result.failed);
    console.warn(`[delete] vdel failed memory=${item.id} failed=${result.failed} job=${job?.id || "none"}`);
    emitLifecycleActionTelemetry("delete", item, {
      status: "queued_reconcile",
      reason: options.reason || null,
      vectors_deleted: result.deleted || 0,
      vector_failures: result.failed || 0,
      reconcile_job_id: job?.id || null
    }, {
      requestId: options.requestId || null,
      source: options.source || "delete"
    });
    return {
      deleted: false,
      queued: Boolean(job),
      failed: result.failed,
      vectorsDeleted: result.deleted,
      jobId: job?.id || null
    };
  }
  await deleteMemoryItemById(item.id);
  emitLifecycleActionTelemetry("delete", item, {
    status: "deleted",
    reason: options.reason || null,
    vectors_deleted: result.deleted || 0
  }, {
    requestId: options.requestId || null,
    source: options.source || "delete"
  });
  return { deleted: true, queued: false, failed: 0, vectorsDeleted: result.deleted };
}

async function ensureValueScore(item) {
  if (!item) return null;
  if (Number.isFinite(item.value_score)) return item.value_score;
  const tokensEst = getTokensEstimate(item);
  const score = computeValueScoreForMemory(item, tokensEst);
  const updated = await updateMemoryItemMetrics({
    id: item.id,
    tenantId: item.tenant_id,
    valueScore: score
  });
  if (updated) {
    item.value_score = updated.value_score;
  } else {
    item.value_score = score;
  }
  return item.value_score;
}

async function loadMemoryTextSnippet(item, limit) {
  const text = await loadArtifactText(item.namespace_id);
  if (!text || !text.trim()) return "";
  const cap = Number.isFinite(limit) && limit > 0 ? limit : MAX_COMPACT_CHARS;
  return text.length > cap ? text.slice(0, cap) : text;
}

async function isRecentExternalPrefix({ tenantId, collection, prefix, cooldownHours }) {
  const items = await listMemoryItemsByExternalPrefix({ tenantId, collection, prefix });
  if (!items.length) return false;
  const maxAgeMs = Number.isFinite(cooldownHours) && cooldownHours > 0 ? cooldownHours * 3600000 : 0;
  if (!maxAgeMs) return false;
  const now = Date.now();
  return items.some(item => item.created_at && now - new Date(item.created_at).getTime() < maxAgeMs);
}

async function promoteMemoryItem(item, options = {}) {
  if (!item) return { created: 0 };
  const cooldownHit = await isRecentExternalPrefix({
    tenantId: item.tenant_id,
    collection: item.collection,
    prefix: `promote:${item.id}:`,
    cooldownHours: MEMORY_PROMOTION_COOLDOWN_HOURS
  });
  if (cooldownHit) return { created: 0, skipped: "cooldown" };

  let text = await loadMemoryTextSnippet(item, MAX_REFLECT_CHARS);
  if (!text.trim()) return { created: 0, skipped: "empty" };

  const reflection = await reflectMemories({
    text,
    types: ["semantic", "procedural"],
    maxItems: MEMORY_PROMOTION_MAX_ITEMS
  });
  recordGenerationUsage(item.tenant_id, reflection?.usage, buildTelemetryContext({
    requestId: options.requestId || null,
    tenantId: item.tenant_id,
    collection: item.collection,
    source: "promotion_generation"
  }));

  const expectedExternalIds = [];
  const typeMap = {
    semantic: reflection.semantic || [],
    procedural: reflection.procedural || []
  };
  for (const [type, items] of Object.entries(typeMap)) {
    for (let i = 0; i < items.length; i += 1) {
      expectedExternalIds.push(`promote:${item.id}:${type}:${i + 1}`);
    }
  }

  await cleanupExternalItems({
    tenantId: item.tenant_id,
    collection: item.collection,
    prefix: `promote:${item.id}:`,
    expectedExternalIds
  });

  const created = [];
  for (const [type, items] of Object.entries(typeMap)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i] || {};
      const content = String(entry.content || "").trim();
      if (!content) continue;

      const memoryId = crypto.randomUUID();
      const namespaceId = namespaceDocId(item.tenant_id, item.collection, `mem_${memoryId}`);
      const externalId = `promote:${item.id}:${type}:${i + 1}`;

      const memory = await upsertMemoryItem({
        tenantId: item.tenant_id,
        collection: item.collection,
        itemType: type,
        externalId,
        namespaceId,
        itemId: memoryId,
        title: entry.title || null,
        sourceType: "promotion",
        sourceUrl: null,
        metadata: withTokenEstimate({
          origin: "promotion",
          sourceId: item.id,
          type
        }, content),
        principalId: item.principal_id || null,
        agentId: item.agent_id || null,
        tags: Array.isArray(item.tags) ? item.tags : null,
        visibility: item.visibility || "tenant",
        acl: Array.isArray(item.acl_principals) ? item.acl_principals : []
      });

      const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
      if (cleanup.failed > 0) {
        throw new Error(`Failed to delete vectors for memory ${memory.id}`);
      }

      await indexMemoryText(memory.namespace_id, content, {
        telemetry: buildTelemetryContext({
          requestId: options.requestId || null,
          tenantId: item.tenant_id,
          collection: item.collection,
          source: "promotion_index"
        })
      });
      scheduleRedundancyUpdate(memory);
      await createMemoryLink({
        tenantId: item.tenant_id,
        fromItemId: memory.id,
        toItemId: item.id,
        relation: "promoted_from",
        metadata: { origin: "promotion" }
      });
      created.push(memory.id);
    }
  }

  if (created.length > 0) {
    emitLifecycleActionTelemetry("promote", item, {
      status: "created",
      reason: options.reason || "value_threshold",
      created_count: created.length,
      created_memory_ids: created
    }, {
      requestId: options.requestId || null,
      source: options.source || "promotion"
    });
  }

  return { created: created.length };
}

async function compactLowValueGroup(seed, options = {}) {
  if (!seed) return { created: 0 };
  const cooldownHit = await isRecentExternalPrefix({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    prefix: `compact:${seed.id}:`,
    cooldownHours: MEMORY_COMPACT_COOLDOWN_HOURS
  });
  if (cooldownHit) return { created: 0, skipped: "cooldown" };

  const seedText = await loadMemoryTextSnippet(seed, MEMORY_REDUNDANCY_QUERY_CHARS);
  if (!seedText.trim()) return { created: 0, skipped: "empty" };

  const results = await searchChunks({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    query: seedText,
    k: MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE,
    docIds: [],
    principalId: null,
    privileges: null,
    telemetry: buildTelemetryContext({
      requestId: options.requestId || null,
      tenantId: seed.tenant_id,
      collection: seed.collection,
      source: "lifecycle_compaction_search"
    })
  });

  const namespaceIds = results.map(r => r._row.doc_id);
  const memoryMap = await getMemoryItemsByNamespaceIds({
    namespaceIds,
    types: MEMORY_TYPES.filter(t => t !== "artifact"),
    excludeExpired: true
  });

  const signature = visibilitySignature(seed);
  const group = [];
  const seen = new Set();

  for (const r of results) {
    const mem = memoryMap.get(r._row.doc_id);
    if (!mem) continue;
    if (seen.has(mem.id)) continue;
    if (mem.pinned) continue;
    if (mem.value_score !== null && mem.value_score !== undefined) {
      const score = Number(mem.value_score);
      if (Number.isFinite(score) && score >= MEMORY_LIFECYCLE_SUMMARY_THRESHOLD) continue;
    }
    if (visibilitySignature(mem) !== signature) continue;
    seen.add(mem.id);
    group.push(mem);
    if (group.length >= MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE) break;
  }

  if (group.length === 0) {
    group.push(seed);
  }

  const parts = [];
  const included = [];
  let total = 0;
  for (const item of group) {
    const text = await loadArtifactText(item.namespace_id);
    if (!text.trim()) continue;
    const header = item.title ? `${item.title}` : `${item.item_type}:${item.id}`;
    const block = `# ${header}\n${text}`;
    if (total + block.length > MAX_COMPACT_CHARS) break;
    parts.push(block);
    included.push(item);
    total += block.length;
  }

  if (!parts.length) return { created: 0, skipped: "empty" };

  const combined = parts.join("\n\n---\n\n");
  const summary = await summarizeMemories({ text: combined });
  recordGenerationUsage(seed.tenant_id, summary?.usage, buildTelemetryContext({
    requestId: options.requestId || null,
    tenantId: seed.tenant_id,
    collection: seed.collection,
    source: "lifecycle_compaction_generation"
  }));
  if (!summary.content) return { created: 0, skipped: "empty" };

  await cleanupExternalItems({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    prefix: `compact:${seed.id}:`,
    expectedExternalIds: [`compact:${seed.id}:summary`]
  });

  const ownerId = seed.principal_id || null;
  const visibility = seed.visibility || "tenant";
  const aclList = visibility === "acl" ? (seed.acl_principals || []) : [];

  const memoryId = crypto.randomUUID();
  const namespaceId = namespaceDocId(seed.tenant_id, seed.collection, `mem_${memoryId}`);
  const externalId = `compact:${seed.id}:summary`;

  const memory = await upsertMemoryItem({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    itemType: "summary",
    externalId,
    namespaceId,
    itemId: memoryId,
    title: summary.title || "Compacted memory",
    sourceType: "lifecycle_compaction",
    sourceUrl: null,
    metadata: withTokenEstimate({
      origin: "lifecycle_compaction",
      sourceCount: included.length,
      seedId: seed.id
    }, summary.content),
    principalId: ownerId,
    visibility,
    acl: aclList
  });

  const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
  if (cleanup.failed > 0) {
    throw new Error(`Failed to delete vectors for memory ${memory.id}`);
  }

  await indexMemoryText(memory.namespace_id, summary.content, {
    telemetry: buildTelemetryContext({
      requestId: options.requestId || null,
      tenantId: seed.tenant_id,
      collection: seed.collection,
      source: "lifecycle_compaction_index"
    })
  });
  scheduleRedundancyUpdate(memory);

  for (const item of included) {
    await createMemoryLink({
      tenantId: seed.tenant_id,
      fromItemId: memory.id,
      toItemId: item.id,
      relation: "compacted_from",
      metadata: { origin: "lifecycle_compaction" }
    });
  }

  let deletedOriginals = 0;
  let queuedOriginalDeletes = 0;
  if (MEMORY_LIFECYCLE_COMPACT_DELETE_ORIGINALS) {
    const deleteBudget = options.deleteBudget || null;
    if (deleteBudget && !canConsumeDeleteBudget(deleteBudget, included.length)) {
      console.warn(`[lifecycle] delete cap reached; skipping delete of compacted originals count=${included.length}`);
    } else {
      if (deleteBudget) consumeDeleteBudget(deleteBudget, included.length);
      for (const item of included) {
        const result = await deleteMemoryItemFully(item, {
          reason: "compaction_original",
          requestId: options.requestId || null,
          source: "lifecycle_compaction"
        });
        if (result?.deleted) {
          deletedOriginals += 1;
        }
        if (result?.queued) {
          queuedOriginalDeletes += 1;
          console.warn(`[lifecycle] queued delete reconcile for compacted item id=${item.id}`);
        }
      }
    }
  }

  emitLifecycleActionTelemetry("compact", seed, {
    status: "created",
    reason: options.reason || "low_value",
    summary_memory_id: memory.id,
    source_count: included.length,
    source_memory_ids: included.map((item) => item.id),
    deleted_originals: deletedOriginals,
    queued_delete_reconciles: queuedOriginalDeletes
  }, {
    requestId: options.requestId || null,
    source: options.source || "lifecycle_compaction"
  });

  return { created: 1, sourceCount: included.length };
}

async function runValueDecayOnce() {
  if (valueDecayRunning) return;
  valueDecayRunning = true;
  const batchSize = Number.isFinite(MEMORY_VALUE_BATCH_SIZE) && MEMORY_VALUE_BATCH_SIZE > 0 ? MEMORY_VALUE_BATCH_SIZE : 200;
  const maxItems = Number.isFinite(MEMORY_VALUE_MAX_ITEMS) && MEMORY_VALUE_MAX_ITEMS > 0 ? MEMORY_VALUE_MAX_ITEMS : 0;
  let processed = 0;
  let afterId = null;
  let updated = 0;
  try {
    while (true) {
      const items = await listMemoryItemsForValueDecay({ limit: batchSize, afterId });
      if (!items.length) break;
      for (const item of items) {
        let tokensEst = getTokensEstimate(item);
        if (tokensEst === null && MEMORY_VALUE_TEXT_FALLBACK) {
          const text = await loadArtifactText(item.namespace_id);
          tokensEst = estimateTokensFromText(text);
        }
        const valueScore = computeValueScoreForMemory(item, tokensEst);
        await updateMemoryItemMetrics({
          id: item.id,
          tenantId: item.tenant_id,
          valueScore
        });
        updated += 1;
        processed += 1;
        if (maxItems && processed >= maxItems) break;
      }
      afterId = items[items.length - 1].id;
      if (items.length < batchSize) break;
      if (maxItems && processed >= maxItems) break;
    }
    if (updated) {
      console.log(`[value] decay updated=${updated}`);
    }
  } catch (err) {
    console.warn("[value] decay failed:", err?.message || err);
  } finally {
    valueDecayRunning = false;
  }
}

function scheduleValueDecay() {
  if (!Number.isFinite(MEMORY_VALUE_DECAY_INTERVAL_MS) || MEMORY_VALUE_DECAY_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runValueDecayOnce().catch(() => {});
    setInterval(() => {
      runValueDecayOnce().catch(() => {});
    }, MEMORY_VALUE_DECAY_INTERVAL_MS);
  }, 2500);
}

async function computeRedundancyForItem(item) {
  if (!item || !item.id) return { updated: false, skipped: "missing" };
  if (item.item_type === "artifact") return { updated: false, skipped: "artifact" };
  if (isExpiredMemory(item)) return { updated: false, skipped: "expired" };

  const queryText = await loadMemoryTextSnippet(item, MEMORY_REDUNDANCY_QUERY_CHARS);
  if (!queryText.trim()) return { updated: false, skipped: "empty" };

  const results = await searchChunks({
    tenantId: item.tenant_id,
    collection: item.collection,
    query: queryText,
    k: MEMORY_REDUNDANCY_TOP_K + 1,
    docIds: [],
    principalId: null,
    privileges: null
  });

  const namespaceIds = results.map(r => r._row.doc_id);
  const memoryMap = await getMemoryItemsByNamespaceIds({
    namespaceIds,
    types: MEMORY_TYPES.filter(t => t !== "artifact"),
    excludeExpired: true
  });

  const seen = new Set([item.id]);
  const scores = [];
  for (const r of results) {
    const mem = memoryMap.get(r._row.doc_id);
    if (!mem || seen.has(mem.id)) continue;
    seen.add(mem.id);
    scores.push(r.score);
    if (scores.length >= MEMORY_REDUNDANCY_TOP_K) break;
  }

  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const redundancyScore = clampNumber(avg, 0, 1);
  const updated = await updateMemoryItemMetrics({
    id: item.id,
    tenantId: item.tenant_id,
    redundancyScore
  });
  return { updated: Boolean(updated), redundancyScore };
}

async function runRedundancyOnce() {
  if (redundancyRunning) return;
  redundancyRunning = true;
  const batchSize = Number.isFinite(MEMORY_REDUNDANCY_BATCH_SIZE) && MEMORY_REDUNDANCY_BATCH_SIZE > 0 ? MEMORY_REDUNDANCY_BATCH_SIZE : 100;
  let afterId = null;
  let updated = 0;
  try {
    while (true) {
      const items = await listMemoryItemsForRedundancy({ limit: batchSize, afterId });
      if (!items.length) break;
      for (const item of items) {
        const result = await computeRedundancyForItem(item);
        if (result?.updated) updated += 1;
      }
      afterId = items[items.length - 1].id;
      if (items.length < batchSize) break;
    }
    if (updated) {
      console.log(`[redundancy] updated=${updated}`);
    }
  } catch (err) {
    console.warn("[redundancy] sweep failed:", err?.message || err);
  } finally {
    redundancyRunning = false;
  }
}

function scheduleRedundancySweep() {
  if (!Number.isFinite(MEMORY_REDUNDANCY_INTERVAL_MS) || MEMORY_REDUNDANCY_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runRedundancyOnce().catch(() => {});
    setInterval(() => {
      runRedundancyOnce().catch(() => {});
    }, MEMORY_REDUNDANCY_INTERVAL_MS);
  }, 3000);
}

async function runLifecycleOnce() {
  if (lifecycleRunning) return;
  lifecycleRunning = true;
  const lifecycleRequestId = isTelemetryEnabled() ? createTelemetryRequestId("lifecycle") : null;
  const batchSize = Number.isFinite(MEMORY_LIFECYCLE_BATCH_SIZE) && MEMORY_LIFECYCLE_BATCH_SIZE > 0 ? MEMORY_LIFECYCLE_BATCH_SIZE : 50;
  const now = new Date();
  const deleteBudget = createDeleteBudget(MEMORY_LIFECYCLE_MAX_DELETES);
  let afterId = null;
  let deleted = 0;
  let queuedDeletes = 0;
  let summarized = 0;
  let promoted = 0;
  try {
    while (true) {
      const items = await listMemoryItemsForLifecycle({ limit: batchSize, afterId });
      if (!items.length) break;
      for (const item of items) {
        if (isExpiredMemory(item, now)) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=delete id=${item.id} reason=expired`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "delete_expired"
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          if (!consumeDeleteBudget(deleteBudget, 1)) {
            console.warn(`[lifecycle] delete cap reached; skipping expired delete id=${item.id}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "delete_budget_exhausted",
              attempted_action: "delete_expired"
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          const result = await deleteMemoryItemFully(item, {
            reason: "expired",
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          if (result?.deleted) deleted += 1;
          if (result?.queued) queuedDeletes += 1;
          continue;
        }
        if (item.pinned) {
          emitLifecycleActionTelemetry("retain", item, {
            reason: "pinned"
          }, {
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          continue;
        }

        const valueScore = await ensureValueScore(item);
        if (valueScore > MEMORY_LIFECYCLE_PROMOTE_THRESHOLD) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=promote id=${item.id} value=${valueScore.toFixed(4)}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "promote",
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
          } else {
            const result = await promoteMemoryItem(item, {
              reason: "value_threshold",
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            if (result?.created) promoted += 1;
          }
          continue;
        }
        if (isBelowMinAgeForLifecycle(item, now, MEMORY_LIFECYCLE_MIN_AGE_HOURS)) {
          emitLifecycleActionTelemetry("retain", item, {
            reason: "below_min_age",
            value_score: Number.isFinite(valueScore) ? valueScore : null
          }, {
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          continue;
        }
        if (valueScore < MEMORY_LIFECYCLE_DELETE_THRESHOLD) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=delete id=${item.id} reason=value value=${valueScore.toFixed(4)}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "delete_low_value",
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          if (!consumeDeleteBudget(deleteBudget, 1)) {
            console.warn(`[lifecycle] delete cap reached; skipping low-value delete id=${item.id}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "delete_budget_exhausted",
              attempted_action: "delete_low_value",
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          const result = await deleteMemoryItemFully(item, {
            reason: "low_value",
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          if (result?.deleted) deleted += 1;
          if (result?.queued) queuedDeletes += 1;
          continue;
        }
        if (valueScore < MEMORY_LIFECYCLE_SUMMARY_THRESHOLD) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=compact id=${item.id} value=${valueScore.toFixed(4)}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "compact",
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
          } else {
            const result = await compactLowValueGroup(item, {
              deleteBudget,
              reason: "low_value_group",
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            if (result?.created) summarized += 1;
          }
          continue;
        }
        emitLifecycleActionTelemetry("retain", item, {
          reason: "value_band",
          value_score: valueScore
        }, {
          requestId: lifecycleRequestId,
          source: "lifecycle_sweep"
        });
      }
      afterId = items[items.length - 1].id;
      if (items.length < batchSize) break;
    }
    if (deleted || summarized || promoted || queuedDeletes) {
      console.log(`[lifecycle] deleted=${deleted} summarized=${summarized} promoted=${promoted} queuedDeletes=${queuedDeletes}`);
    }
  } catch (err) {
    console.warn("[lifecycle] sweep failed:", err?.message || err);
  } finally {
    lifecycleRunning = false;
  }
}

function scheduleLifecycleSweep() {
  if (!Number.isFinite(MEMORY_LIFECYCLE_INTERVAL_MS) || MEMORY_LIFECYCLE_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runLifecycleOnce().catch(() => {});
    setInterval(() => {
      runLifecycleOnce().catch(() => {});
    }, MEMORY_LIFECYCLE_INTERVAL_MS);
  }, 3500);
}

async function runMemorySnapshotOnce() {
  if (!isTelemetryEnabled()) return;
  if (memorySnapshotRunning) return;
  memorySnapshotRunning = true;
  try {
    const snapshot = await getMemoryStateSnapshot(null);
    emitTelemetry("memory_snapshot", buildTelemetryContext({
      requestId: createTelemetryRequestId("snapshot"),
      tenantId: "all",
      collection: null,
      source: "periodic_snapshot"
    }), {
      scope: "global",
      total_items: snapshot.total_items,
      approx_tokens: snapshot.approx_tokens,
      type_distribution: snapshot.type_distribution || {},
      value_distribution: snapshot.value_distribution || {}
    });
  } catch (err) {
    console.warn("[telemetry] memory snapshot failed:", err?.message || err);
  } finally {
    memorySnapshotRunning = false;
  }
}

function scheduleMemorySnapshots() {
  if (!isTelemetryEnabled()) return;
  if (!Number.isFinite(MEMORY_SNAPSHOT_INTERVAL_MS) || MEMORY_SNAPSHOT_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runMemorySnapshotOnce().catch(() => {});
    setInterval(() => {
      runMemorySnapshotOnce().catch(() => {});
    }, MEMORY_SNAPSHOT_INTERVAL_MS);
  }, 2000);
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

app.get("/openapi.public.json", (req, res) => {
  res.json(buildOpenApiDoc(req, { publicView: true }));
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
    return sendError(res, 400, "username and password required", "INVALID_INPUT", null, null);
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
    return sendError(res, 401, "Invalid credentials", "AUTH_INVALID", null, null);
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
    const tenantRecord = await getTenantById(tenant);
    const tenantAuthMode = normalizeAuthMode(tenantRecord?.auth_mode);
    if (!isSsoAllowed(tenantAuthMode)) {
      return res.status(403).json({ error: "Tenant requires password login." });
    }
    if (!isSsoProviderAllowed(tenantRecord, provider)) {
      return res.status(403).json({ error: "SSO provider not allowed for tenant." });
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
// Tenant settings (admin)
// --------------------------
app.get(["/admin/tenant", "/v1/admin/tenant"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const tenant = await getTenantById(tenantId);
    const authMode = normalizeAuthMode(tenant?.auth_mode);
    sendOk(res, {
      tenant: {
        id: tenantId,
        name: tenant?.name || null,
        authMode,
        ssoProviders: resolveSsoProviders(tenant)
      }
    }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to load tenant settings", "TENANT_SETTINGS_FAILED", tenantId, null);
  }
});

app.patch(["/admin/tenant", "/v1/admin/tenant"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const rawMode = req.body?.authMode ?? req.body?.auth_mode;
    const rawProviders = req.body?.ssoProviders ?? req.body?.sso_providers;
    const authMode = rawMode === undefined ? null : parseAuthMode(rawMode);
    if (rawMode !== undefined && !authMode) {
      return sendError(res, 400, "authMode must be one of: sso_only, sso_plus_password, password_only", "INVALID_INPUT", tenantId, null);
    }

    let providersInput;
    try {
      providersInput = normalizeSsoProvidersInput(rawProviders);
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    if (rawMode === undefined && !providersInput.provided) {
      return sendError(res, 400, "Provide authMode and/or ssoProviders", "INVALID_INPUT", tenantId, null);
    }

    const current = await getTenantById(tenantId);
    const prevAuthMode = normalizeAuthMode(current?.auth_mode);
    const prevProviders = Array.isArray(current?.sso_providers) ? current.sso_providers : null;
    const nextAuthMode = authMode || prevAuthMode;
    const nextProviders = providersInput.provided ? providersInput.value : current?.sso_providers ?? null;
    if (nextAuthMode === "sso_only" && Array.isArray(nextProviders) && nextProviders.length === 0) {
      return sendError(res, 400, "ssoProviders cannot be empty when authMode is sso_only", "INVALID_INPUT", tenantId, null);
    }

    const tenant = await setTenantSettings(tenantId, {
      authMode: rawMode === undefined ? undefined : authMode,
      ssoProviders: providersInput.provided ? providersInput.value : undefined
    });
    const updatedAuthMode = normalizeAuthMode(tenant?.auth_mode || authMode);
    const updatedProviders = Array.isArray(tenant?.sso_providers) ? tenant.sso_providers : null;
    await recordAudit(req, tenantId, {
      action: "tenant.auth_policy.update",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        before: { authMode: prevAuthMode, ssoProviders: prevProviders },
        after: { authMode: updatedAuthMode, ssoProviders: updatedProviders }
      }
    });
    sendOk(res, {
      tenant: {
        id: tenantId,
        name: tenant?.name || null,
        authMode: updatedAuthMode,
        ssoProviders: resolveSsoProviders(tenant)
      }
    }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to update tenant settings", "TENANT_SETTINGS_UPDATE_FAILED", tenantId, null);
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
      return sendError(res, 400, "name is required", "INVALID_INPUT", tenantId, null);
    }

    let principalId = req.body?.principalId || req.body?.principal_id || req.user?.sub || req.user?.principal_id;
    principalId = String(principalId || "").trim();
    if (!principalId || !PRINCIPAL_RE.test(principalId)) {
      return sendError(res, 400, "Invalid principalId", "INVALID_INPUT", tenantId, null);
    }

    const roles = normalizeRoles(req.body?.roles);
    let expiresAt = req.body?.expiresAt || req.body?.expires_at || null;
    if (expiresAt) {
      const dt = new Date(expiresAt);
      if (Number.isNaN(dt.getTime())) {
        return sendError(res, 400, "expiresAt must be a valid date", "INVALID_INPUT", tenantId, null);
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
      return sendError(res, 400, "Invalid token id", "INVALID_INPUT", tenantId, null);
    }
    const record = await revokeServiceToken(id, tenantId);
    if (!record) {
      return sendError(res, 404, "Token not found", "NOT_FOUND", tenantId, null);
    }
    await recordAudit(req, tenantId, {
      action: "service_token.revoked",
      targetType: "service_token",
      targetId: String(record.id),
      metadata: {
        name: record.name || null,
        principalId: record.principal_id || null,
        roles: record.roles || [],
        revokedAt: record.revoked_at || null
      }
    });
    sendOk(res, { token: formatServiceToken(record) }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to revoke service token", "SERVICE_TOKEN_REVOKE_FAILED", tenantId, null);
  }
});

// --------------------------
// Stats (protected)
// --------------------------
app.get("/stats", requireJwt, requireRole("reader"), async (req, res) => {
  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req, { track: false });
  const reply = await sendCmd("STATS");
  const tcpStats = JSON.parse(reply);
  const gatewayStats = {
    latency: getLatencyStats(tenantId)
  };
  res.json({ ...tcpStats, gateway: gatewayStats, tenantId, collection });
});

app.get("/v1/stats", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req, { track: false });
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

const metricsHandler = async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
  } catch (e) {
    return sendError(res, 400, e, "INVALID_INPUT", null, null);
  }

  const isAdmin = hasTokenAdminAccess(req);
  const lines = [
    "# HELP atlasrag_request_latency_ms Request latency in milliseconds (rolling window).",
    "# TYPE atlasrag_request_latency_ms summary",
    "# HELP atlasrag_requests_total Requests observed in rolling window.",
    "# TYPE atlasrag_requests_total gauge",
    "# HELP atlasrag_request_errors_total Error responses (>=500) observed in rolling window.",
    "# TYPE atlasrag_request_errors_total gauge",
    "# HELP atlasrag_request_error_rate Error rate observed in rolling window.",
    "# TYPE atlasrag_request_error_rate gauge"
  ];

  const emitGroup = (group, baseLabels) => {
    emitPromLatencySummary(lines, group.overall, { ...baseLabels, scope: "overall" });
    for (const [route, summary] of Object.entries(group.routes || {})) {
      emitPromLatencySummary(lines, summary, { ...baseLabels, scope: "route", route });
    }
  };

  if (isAdmin) {
    emitGroup(getLatencyStats(), { tenant_id: "__all__" });
  }

  const tenantStats = isAdmin ? getAllTenantLatencyStats() : { [tenantId]: getLatencyStats(tenantId) };
  for (const [tid, stats] of Object.entries(tenantStats)) {
    emitGroup(stats, { tenant_id: tid });
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(`${lines.join("\n")}\n`);
};

app.get(["/metrics", "/v1/metrics"], requireJwt, requireRole("reader"), metricsHandler);

app.get(["/admin/usage", "/v1/admin/usage"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req, { track: false });
    const reply = await sendCmd("STATS");
    const tcpStats = JSON.parse(reply);
    const gatewayStats = {
      latency: getLatencyStats(tenantId)
    };
    const [usageAll, usage24h, usage7d, storageRow, itemRow] = await Promise.all([
      getTenantUsage(tenantId),
      getTenantUsageWindow(tenantId, "24h"),
      getTenantUsageWindow(tenantId, "7d"),
      getTenantStorageStats(tenantId),
      getTenantItemStats(tenantId)
    ]);

    const buildUsageWindow = (row) => ({
      tokens: {
        embedding: {
          total: Number(row?.embedding_tokens || 0),
          requests: Number(row?.embedding_requests || 0)
        },
        generation: {
          input: Number(row?.generation_input_tokens || 0),
          output: Number(row?.generation_output_tokens || 0),
          total: Number(row?.generation_total_tokens || 0),
          requests: Number(row?.generation_requests || 0)
        },
        total: Number(row?.embedding_tokens || 0) + Number(row?.generation_total_tokens || 0)
      }
    });

    const usage = {
      windows: {
        all: buildUsageWindow(usageAll),
        "24h": buildUsageWindow(usage24h),
        "7d": buildUsageWindow(usage7d)
      },
      storage: {
        bytes: Number(storageRow.bytes || 0),
        chunks: Number(storageRow.chunks || 0),
        documents: Number(itemRow.documents || 0),
        memoryItems: Number(itemRow.memory_items || 0),
        collections: Number(itemRow.collections || 0)
      },
      updatedAt: usageAll?.updated_at || null
    };
    if (req.path.startsWith("/v1")) {
      return sendOk(res, { ...tcpStats, gateway: gatewayStats, usage }, tenantId, collection);
    }
    return res.json({ ...tcpStats, gateway: gatewayStats, usage, tenantId, collection });
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
app.get("/collections", requireJwt, requireRole("reader"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const overrideInput = hasAccessOverrideInput(req);
    const access = (hasTokenAdminAccess(req) && !overrideInput)
      ? { principalId: null, privileges: [] }
      : resolveAccessContext(req);
    const docs = await listDocsForTenant(tenantId, null, access.principalId, access.privileges);
    const collections = buildCollectionsFromDocs(docs);
    res.json({ collections, totalCollections: collections.length, tenantId, collection: null });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/collections", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const overrideInput = hasAccessOverrideInput(req);
    const access = (hasTokenAdminAccess(req) && !overrideInput)
      ? { principalId: null, privileges: [] }
      : resolveAccessContext(req);
    const docs = await listDocsForTenant(tenantId, null, access.principalId, access.privileges);
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
    req.collection = collection;
    const docs = await listDocsForTenant(tenantId, collection, null, []);
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
    await recordAudit(req, tenantId, {
      action: "collection.deleted",
      targetType: "collection",
      targetId: collection,
      metadata: {
        deletedDocs: docs.length,
        deletedMemoryItems
      }
    });
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
    req.collection = collection;
    const docs = await listDocsForTenant(tenantId, collection, null, []);
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
    await recordAudit(req, tenantId, {
      action: "collection.deleted",
      targetType: "collection",
      targetId: collection,
      metadata: {
        deletedDocs: docs.length,
        deletedMemoryItems
      }
    });
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

app.get("/docs/list", requireJwt, requireRole("reader"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection, access.principalId, access.privileges);
    res.json({ docs, totalDocs: docs.length, tenantId, collection });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/docs", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection, access.principalId, access.privileges);
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
app.post("/docs", requireJwt, requireRole("indexer"), async (req, res) => {
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
    const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    const tags = parseTagsInput(req.body?.tags);
    const expiresAt = resolveExpiresAt(req.body);
    const { chunksIndexed, truncated } = await indexDocument(
      tenantId,
      collection,
      cleanDocId,
      text,
      { type: "text", expiresAt, principalId, agentId, tags, visibility: req.body?.visibility, acl: req.body?.acl },
      { telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_index_legacy" }) }
    );
    res.json({ ok: true, docId: cleanDocId, collection, tenantId, chunksIndexed, truncated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/docs", requireJwt, requireRole("indexer"), async (req, res) => {
  const { docId, text } = req.body || {};

  const cleanDocId = String(docId || "").trim();

  if (!cleanDocId || !text) {
    return res.status(400).json(buildErrorPayload("docId and text required", "INVALID_INPUT", null, null));
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  let agentId = null;
  let tags = [];
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    tags = parseTagsInput(req.body?.tags);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
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
          { type: "text", expiresAt, principalId, agentId, tags, visibility: req.body?.visibility, acl: req.body?.acl },
          { telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_index_v1" }) }
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
app.post("/docs/url", requireJwt, requireRole("indexer"), async (req, res) => {
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
    const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    const tags = parseTagsInput(req.body?.tags);
    const expiresAt = resolveExpiresAt(req.body);
    const fetched = await fetchUrlText(cleanUrl);
    const { chunksIndexed, truncated } = await indexDocument(
      tenantId,
      collection,
      cleanDocId,
      fetched.text,
      { type: "url", url: cleanUrl, metadata: { contentType: fetched.contentType || null }, expiresAt, principalId, agentId, tags, visibility: req.body?.visibility, acl: req.body?.acl },
      { telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_url_index_legacy" }) }
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

app.post("/v1/docs/url", requireJwt, requireRole("indexer"), async (req, res) => {
  const { docId, url } = req.body || {};
  const cleanDocId = String(docId || "").trim();
  const cleanUrl = String(url || "").trim();

  if (!cleanDocId || !cleanUrl) {
    return res.status(400).json(buildErrorPayload("docId and url required", "INVALID_INPUT", null, null));
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  let agentId = null;
  let tags = [];
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    tags = parseTagsInput(req.body?.tags);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
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
          { type: "url", url: cleanUrl, metadata: { contentType: fetched.contentType || null }, expiresAt, principalId, agentId, tags, visibility: req.body?.visibility, acl: req.body?.acl },
          { telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_url_index_v1" }) }
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
app.post("/ask", requireJwt, requireRole("reader"), async (req, res) => {

  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "5", 10);
  const docIds = parseDocFilter(req.body?.docIds);

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollection(req);

    const result = await answerQuestion({
      tenantId,
      collection,
      question,
      k,
      docIds,
      principalId: access.principalId,
      privileges: access.privileges,
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "ask_legacy"
      })
    });
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

app.post("/v1/ask", requireJwt, requireRole("reader"), async (req, res) => {
  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "5", 10);
  const docIds = parseDocFilter(req.body?.docIds);

  if (!question || !question.trim()) {
    return sendError(res, 400, "question is required", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const result = await answerQuestion({
      tenantId,
      collection,
      question,
      k,
      docIds,
      principalId: access.principalId,
      privileges: access.privileges,
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "ask_v1"
      })
    });
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
app.delete("/docs/:docId", requireJwt, requireRole("indexer"), async (req, res) => {
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
  await recordAudit(req, tenantId, {
    action: "doc.deleted",
    targetType: "doc",
    targetId: docId,
    metadata: {
      collection,
      namespaceId: namespaced
    }
  });
  res.json({
    ok: true,
    docId,
    collection,
    tenantId,
    note: "Deleted chunk text; vector deletion is a next improvement."
  });
});

app.delete("/v1/docs/:docId", requireJwt, requireRole("indexer"), async (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return sendError(res, 400, "docId required", "INVALID_INPUT", null, null);
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
    await recordAudit(req, tenantId, {
      action: "doc.deleted",
      targetType: "doc",
      targetId: docId,
      metadata: {
        collection,
        namespaceId: namespaced
      }
    });
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
app.get("/search", requireJwt, requireRole("reader"), async (req, res) => {
  const q = req.query.q;
  const k = parseInt(req.query.k || "5", 10);
  const docIds = parseDocFilter(req.query.docIds || req.query.docs);

  if (!q) return res.status(400).json({ error: "q query param required" });

  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollection(req);

    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds,
      principalId: access.principalId,
      privileges: access.privileges,
      enforceArtifactVisibility: true,
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "search_legacy"
      })
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

app.get("/v1/search", requireJwt, requireRole("reader"), async (req, res) => {
  const q = req.query.q;
  const k = parseInt(req.query.k || "5", 10);
  const docIds = parseDocFilter(req.query.docIds || req.query.docs);

  if (!q) return sendError(res, 400, "q query param required", "INVALID_INPUT", null, null);

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds,
      principalId: access.principalId,
      privileges: access.privileges,
      enforceArtifactVisibility: true,
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "search_v1"
      })
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
      memory: formatMemoryItem(result.memory),
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
    return res.status(400).json(buildErrorPayload("text is required", "INVALID_INPUT", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
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
            memory: formatMemoryItem(result.memory),
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

app.post(["/memory", "/memory/write"], requireJwt, requireRole("indexer"), memoryWriteLegacy);
app.post(["/v1/memory", "/v1/memory/write"], requireJwt, requireRole("indexer"), memoryWriteV1);

app.post("/memory/recall", requireJwt, requireRole("reader"), async (req, res) => {
  const { query, k, types, since, until } = req.body || {};
  const limit = parseInt(k || "5", 10);

  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: "query is required", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const telemetryContext = buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "memory_recall_legacy"
    });
    const typeFilter = parseTypeFilter(types);
    const sinceTime = parseTimeInput(since, "since");
    const untilTime = parseTimeInput(until, "until");
    const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    const tags = parseTagsInput(req.body?.tags);

    const results = await searchChunks({
      tenantId,
      collection,
      query,
      k: limit,
      docIds: [],
      principalId: access.principalId,
      privileges: access.privileges,
      telemetry: telemetryContext
    });

    const namespaceIds = results.map(r => r._row.doc_id);
    const memoryMap = await getMemoryItemsByNamespaceIds({
      namespaceIds,
      types: typeFilter,
      since: sinceTime,
      until: untilTime,
      excludeExpired: true,
      principalId: access.principalId,
      privileges: access.privileges,
      agentId,
      tags
    });

    const recalled = [];
    const recalledItems = [];
    const seen = new Set();
    for (const r of results) {
      const mem = memoryMap.get(r._row.doc_id);
      if (!mem) continue;
      recalled.push({
        score: r.score,
        chunkId: r.chunkId,
        preview: r.preview,
        memory: formatMemoryItem(mem)
      });
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        recalledItems.push(mem);
      }
      if (recalled.length >= limit) break;
    }

    await recordMemoryEventsForItems(recalledItems, "retrieved");
    emitTelemetry("memory_retrieval", telemetryContext, {
      operation: "memory_recall",
      query_chars: String(query || "").length,
      retrieved_count: recalled.length,
      retrieved: recalled.map((entry) => ({
        memory_id: entry?.memory?.id || null,
        item_type: entry?.memory?.type || null,
        chunk_id: entry?.chunkId || null,
        score: entry?.score ?? null,
        value_score: entry?.memory?.valueScore ?? null
      }))
    });

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

app.post("/v1/memory/recall", requireJwt, requireRole("reader"), async (req, res) => {
  const { query, k, types, since, until } = req.body || {};
  const limit = parseInt(k || "5", 10);

  if (!query || !String(query).trim()) {
    return sendError(res, 400, "query is required", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const telemetryContext = buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "memory_recall_v1"
    });
    const typeFilter = parseTypeFilter(types);
    const sinceTime = parseTimeInput(since, "since");
    const untilTime = parseTimeInput(until, "until");
    const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    const tags = parseTagsInput(req.body?.tags);

    const results = await searchChunks({
      tenantId,
      collection,
      query,
      k: limit,
      docIds: [],
      principalId: access.principalId,
      privileges: access.privileges,
      telemetry: telemetryContext
    });

    const namespaceIds = results.map(r => r._row.doc_id);
    const memoryMap = await getMemoryItemsByNamespaceIds({
      namespaceIds,
      types: typeFilter,
      since: sinceTime,
      until: untilTime,
      excludeExpired: true,
      principalId: access.principalId,
      privileges: access.privileges,
      agentId,
      tags
    });

    const recalled = [];
    const recalledItems = [];
    const seen = new Set();
    for (const r of results) {
      const mem = memoryMap.get(r._row.doc_id);
      if (!mem) continue;
      recalled.push({
        score: r.score,
        chunkId: r.chunkId,
        preview: r.preview,
        memory: formatMemoryItem(mem)
      });
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        recalledItems.push(mem);
      }
      if (recalled.length >= limit) break;
    }

    await recordMemoryEventsForItems(recalledItems, "retrieved");
    emitTelemetry("memory_retrieval", telemetryContext, {
      operation: "memory_recall",
      query_chars: String(query || "").length,
      retrieved_count: recalled.length,
      retrieved: recalled.map((entry) => ({
        memory_id: entry?.memory?.id || null,
        item_type: entry?.memory?.type || null,
        chunk_id: entry?.chunkId || null,
        score: entry?.score ?? null,
        value_score: entry?.memory?.valueScore ?? null
      }))
    });

    sendOk(res, {
      query,
      results: recalled,
      k: limit
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_RECALL_FAILED", tenantId, collection);
  }
});

app.post("/v1/feedback", requireJwt, requireRole("reader"), async (req, res) => {
  const { memoryId, feedback, eventValue } = req.body || {};
  if (!memoryId || !String(memoryId).trim()) {
    return sendError(res, 400, "memoryId is required", "INVALID_INPUT", null, null);
  }

  const choice = String(feedback || "").trim().toLowerCase();
  if (!choice || (choice !== "positive" && choice !== "negative")) {
    return sendError(res, 400, "feedback must be positive or negative", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const memory = await getMemoryItemById(memoryId, tenantId, principalId);
    if (!memory) {
      return sendError(res, 404, "memory not found", "NOT_FOUND", tenantId, null);
    }
    collection = memory.collection || null;
    const eventType = choice === "positive" ? "user_positive" : "user_negative";
    const updated = await recordMemoryEventForItem(memory, eventType, eventValue);
    sendOk(res, {
      memoryId: memory.id,
      eventType,
      valueScore: updated?.value_score ?? memory.value_score ?? null
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "FEEDBACK_FAILED", tenantId, collection);
  }
});

app.post("/v1/memory/event", requireJwt, requireRole("reader"), async (req, res) => {
  const { memoryId, eventType, eventValue } = req.body || {};
  if (!memoryId || !String(memoryId).trim()) {
    return sendError(res, 400, "memoryId is required", "INVALID_INPUT", null, null);
  }

  const cleanType = String(eventType || "").trim();
  if (!MEMORY_TASK_EVENT_TYPES.has(cleanType)) {
    return sendError(res, 400, "eventType must be task_success or task_fail", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const memory = await getMemoryItemById(memoryId, tenantId, principalId);
    if (!memory) {
      return sendError(res, 404, "memory not found", "NOT_FOUND", tenantId, null);
    }
    collection = memory.collection || null;
    const normalizedValue = normalizeEventValue(cleanType, eventValue);
    const updated = await recordMemoryEventForItem(memory, cleanType, eventValue);
    sendOk(res, {
      memoryId: memory.id,
      eventType: cleanType,
      eventValue: normalizedValue,
      utilityEma: updated?.utility_ema ?? memory.utility_ema ?? 0,
      trustScore: updated?.trust_score ?? memory.trust_score ?? 0.5,
      valueScore: updated?.value_score ?? memory.value_score ?? null
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_EVENT_FAILED", tenantId, collection);
  }
});

const memoryReflectLegacy = async (req, res) => {
  const { docId, artifactId, conversationId, types, maxItems, visibility, acl } = req.body || {};

  if (!docId && !artifactId && !conversationId) {
    return res.status(400).json({ error: "docId, artifactId, or conversationId is required", tenantId: null, collection: null });
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
      maxAttempts: JOB_MAX_ATTEMPTS,
      input: {
        docId: docId || null,
        artifactId: artifactId || null,
        conversationId: conversationId || null,
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
  const { docId, artifactId, conversationId, types, maxItems, visibility, acl } = req.body || {};

  if (!docId && !artifactId && !conversationId) {
    return res.status(400).json(buildErrorPayload("docId, artifactId, or conversationId is required", "INVALID_INPUT", null, null));
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
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
  }

  const reflectTypes = normalizeReflectTypes(types);
  const limit = parseInt(maxItems || "5", 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return res.status(400).json(buildErrorPayload("maxItems must be a positive number", "INVALID_INPUT", tenantId, collection));
  }
  const resolvedVisibility = normalizeVisibility(visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    return res.status(400).json(buildErrorPayload("acl list is required when visibility is acl", "INVALID_INPUT", tenantId, collection));
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
      conversationId: conversationId || null,
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
          maxAttempts: JOB_MAX_ATTEMPTS,
          input: {
            docId: docId || null,
            artifactId: artifactId || null,
            conversationId: conversationId || null,
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

app.post("/memory/reflect", requireJwt, requireRole("indexer"), memoryReflectLegacy);
app.post("/v1/memory/reflect", requireJwt, requireRole("indexer"), memoryReflectV1);

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
      maxAttempts: JOB_MAX_ATTEMPTS,
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
      maxAttempts: JOB_MAX_ATTEMPTS,
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
      maxAttempts: JOB_MAX_ATTEMPTS,
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
      maxAttempts: JOB_MAX_ATTEMPTS,
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

app.post("/memory/cleanup", requireJwt, requireRole("admin"), memoryCleanupLegacy);
app.post("/v1/memory/cleanup", requireJwt, requireRole("admin"), memoryCleanupV1);
app.post("/memory/compact", requireJwt, requireRole("admin"), memoryCompactLegacy);
app.post("/v1/memory/compact", requireJwt, requireRole("admin"), memoryCompactV1);

app.get("/jobs", requireJwt, requireRole("reader"), async (req, res) => {
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
      attempts: job.attempts ?? 0,
      maxAttempts: job.max_attempts ?? null,
      nextRunAt: job.next_run_at || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    res.json({ ok: true, jobs, tenantId, collection: null });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection: null });
  }
});

app.get("/v1/jobs", requireJwt, requireRole("reader"), async (req, res) => {
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
      attempts: job.attempts ?? 0,
      maxAttempts: job.max_attempts ?? null,
      nextRunAt: job.next_run_at || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    sendOk(res, { jobs }, tenantId, null);
  } catch (e) {
    sendError(res, 400, e, "JOBS_LIST_FAILED", tenantId, null);
  }
});

app.get("/jobs/:id", requireJwt, requireRole("reader"), async (req, res) => {
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
        attempts: job.attempts ?? 0,
        maxAttempts: job.max_attempts ?? null,
        nextRunAt: job.next_run_at || null,
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

app.get("/v1/jobs/:id", requireJwt, requireRole("reader"), async (req, res) => {
  const id = parseInt(req.params.id || "0", 10);
  if (!Number.isFinite(id) || id <= 0) {
    return sendError(res, 400, "invalid job id", "INVALID_INPUT", null, null);
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
        attempts: job.attempts ?? 0,
        maxAttempts: job.max_attempts ?? null,
        nextRunAt: job.next_run_at || null,
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
      if (isTelemetryEnabled()) {
        const telemetryMeta = getTelemetryMeta();
        emitTelemetry("telemetry_session", buildTelemetryContext({
          requestId: createTelemetryRequestId("telemetry"),
          tenantId: "system",
          source: "startup"
        }), {
          file_path: telemetryMeta.filePath,
          run_id: telemetryMeta.runId,
          config_id: telemetryMeta.configId
        });
      }
      scheduleAutoReindex();
      scheduleTtlSweep();
      scheduleJobSweep();
      scheduleValueDecay();
      scheduleRedundancySweep();
      scheduleLifecycleSweep();
      scheduleMemorySnapshots();
    });
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
}

start();

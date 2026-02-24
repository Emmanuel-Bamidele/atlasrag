// telemetry.js
// Lightweight non-blocking NDJSON telemetry logger.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENABLED = process.env.TELEMETRY_ENABLED === "1";
const FILE_PATH = String(
  process.env.TELEMETRY_FILE || path.join(process.cwd(), "telemetry", "events.ndjson")
).trim();
const CONFIG_ID = String(process.env.TELEMETRY_CONFIG_ID || process.env.SYSTEM_CONFIG_ID || "default").trim() || "default";
const POLICY = String(process.env.TELEMETRY_POLICY || process.env.SYSTEM_POLICY || "unknown").trim() || "unknown";
const RUN_ID = String(
  process.env.TELEMETRY_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, "-")}-pid${process.pid}`
).trim();
const MAX_QUEUE = parseInt(process.env.TELEMETRY_MAX_QUEUE || "10000", 10);
const DROP_WARN_EVERY = parseInt(process.env.TELEMETRY_DROP_WARN_EVERY || "100", 10);

let stream = null;
let flushing = false;
let waitingDrain = false;
let flushScheduled = false;
let dropped = 0;
const queue = [];

function createRequestId(prefix = "system") {
  return `${prefix}:${crypto.randomUUID()}`;
}

function isTelemetryEnabled() {
  return ENABLED;
}

function getTelemetryMeta() {
  return {
    enabled: ENABLED,
    filePath: FILE_PATH,
    configId: CONFIG_ID,
    policy: POLICY,
    runId: RUN_ID
  };
}

function normalizeTenantId(tenantId) {
  if (tenantId === null || tenantId === undefined || tenantId === "") return "unknown";
  return String(tenantId);
}

function normalizeRequestId(requestId) {
  const clean = String(requestId || "").trim();
  return clean || createRequestId("system");
}

function ensureStream() {
  if (!ENABLED) return null;
  if (stream) return stream;

  try {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
    stream = fs.createWriteStream(FILE_PATH, {
      flags: "a",
      encoding: "utf8",
      highWaterMark: 1024 * 1024
    });
    stream.on("error", (err) => {
      console.warn("[telemetry] stream error:", err?.message || err);
    });
  } catch (err) {
    console.warn("[telemetry] failed to initialize stream:", err?.message || err);
    stream = null;
  }

  return stream;
}

function scheduleFlush() {
  if (flushScheduled || !ENABLED) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    flushQueue();
  });
}

function flushQueue() {
  if (!ENABLED || flushing || waitingDrain || queue.length === 0) return;
  const out = ensureStream();
  if (!out) return;

  flushing = true;
  const payload = queue.splice(0, queue.length).join("");
  const ok = out.write(payload, "utf8", () => {
    flushing = false;
    if (queue.length > 0) {
      scheduleFlush();
    }
  });

  if (!ok) {
    waitingDrain = true;
    out.once("drain", () => {
      waitingDrain = false;
      if (!flushing && queue.length > 0) {
        scheduleFlush();
      }
    });
  }
}

function logTelemetry(eventType, context = {}, fields = {}) {
  if (!ENABLED) return;

  if (queue.length >= (Number.isFinite(MAX_QUEUE) && MAX_QUEUE > 0 ? MAX_QUEUE : 10000)) {
    dropped += 1;
    if (dropped === 1 || dropped % (Number.isFinite(DROP_WARN_EVERY) && DROP_WARN_EVERY > 0 ? DROP_WARN_EVERY : 100) === 0) {
      console.warn(`[telemetry] dropped events=${dropped} queue_full=${queue.length}`);
    }
    return;
  }

  const nowMs = Date.now();
  const event = {
    timestamp: new Date(nowMs).toISOString(),
    timestamp_ms: nowMs,
    request_id: normalizeRequestId(context.requestId),
    tenant_id: normalizeTenantId(context.tenantId),
    config_id: CONFIG_ID,
    policy: POLICY,
    run_id: RUN_ID,
    event_type: String(eventType || "unknown"),
    ...fields
  };
  queue.push(`${JSON.stringify(event)}\n`);
  scheduleFlush();
}

function flushTelemetrySync() {
  if (!ENABLED || queue.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
    fs.appendFileSync(FILE_PATH, queue.join(""), "utf8");
    queue.length = 0;
  } catch (err) {
    console.warn("[telemetry] flush sync failed:", err?.message || err);
  }
}

process.on("beforeExit", flushTelemetrySync);

module.exports = {
  createRequestId,
  isTelemetryEnabled,
  getTelemetryMeta,
  logTelemetry,
  flushTelemetrySync
};

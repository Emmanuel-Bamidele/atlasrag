#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith("--")) {
      out[key] = "1";
      continue;
    }
    out[key] = String(next);
    i += 1;
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function createRng(seed) {
  let x = (Number(seed) >>> 0) || 1337;
  return function next() {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x >>>= 0;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

const TOPICS = [
  "pricing", "billing", "forecasting", "ops", "infra", "alerts", "latency", "capacity", "planning", "routing",
  "cache", "queue", "retry", "dedupe", "schema", "index", "vector", "embedding", "ranking", "relevance",
  "security", "auth", "policy", "compliance", "audit", "privacy", "retention", "ttl", "lifecycle", "memory",
  "analytics", "dashboard", "experiments", "abtest", "growth", "sales", "support", "oncall", "incident", "postmortem",
  "payments", "invoice", "refund", "shipping", "inventory", "procurement", "quality", "risk", "finance", "legal"
];

const WORD_BANK = [
  "adaptive", "baseline", "calibrated", "deterministic", "elastic", "federated", "granular", "harmonic", "iterative", "junction",
  "kernel", "layered", "modular", "normalized", "orchestrated", "predictive", "quantized", "resilient", "stochastic", "temporal",
  "uplink", "vectorized", "weighted", "crosscheck", "yielding", "zonal", "aggregate", "backlog", "cohort", "drift",
  "envelope", "feature", "gate", "heuristic", "ingest", "jitter", "knob", "ledger", "matrix", "namespace",
  "objective", "pipeline", "query", "rollup", "sampling", "throughput", "utility", "variance", "window", "xor",
  "anchor", "bridge", "cluster", "delta", "epoch", "fallback", "gradient", "hotpath", "isolation", "join",
  "keystone", "lineage", "median", "node", "offset", "partition", "quota", "replica", "segment", "throttle",
  "update", "validator", "workload", "xform", "yearly", "zone", "artifact", "context", "document", "event",
  "fact", "graph", "hint", "intent", "journal", "knowledge", "link", "memory", "note", "observation",
  "pattern", "quality", "reasoning", "signal", "trace", "uncertainty", "value", "warm", "cold", "hot"
];

const QUESTION_TEMPLATES = [
  "what trend stands out and why?",
  "which facts conflict and how would you resolve them?",
  "what actions should an operator take next?",
  "what risk is most likely in the next cycle?",
  "which metric should be watched first?",
  "what is the concise operating recommendation?",
  "what is the most cost-sensitive decision here?",
  "which factors most affect reliability?",
  "what is the likely bottleneck?",
  "what should be escalated immediately?"
];

function estimateTokens(text) {
  const chars = String(text || "").length;
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function buildFactText(i, topic, rng) {
  const len = 20 + Math.floor(rng() * 41);
  const parts = [];
  for (let j = 0; j < len; j += 1) {
    parts.push(pick(WORD_BANK, rng));
  }
  const sentence = parts.join(" ");
  return `fact_${i}: ${sentence} topic=${topic} tag=${topic}`;
}

function buildWorkload(seed, writeCount, minAsks, snapshotEvery) {
  const rng = createRng(seed);
  const operations = [];
  let reads = 0;
  let asks = 0;

  for (let i = 1; i <= writeCount; i += 1) {
    const writeTopic = pick(TOPICS, rng);
    operations.push({
      kind: "write",
      i,
      topic: writeTopic,
      text: buildFactText(i, writeTopic, rng)
    });

    if (i % 5 === 0) {
      const topic = pick(TOPICS, rng);
      operations.push({
        kind: "read",
        i,
        topic,
        query: `What do you remember about topic=${topic}?`
      });
      reads += 1;
    }

    if (i % 20 === 0) {
      const topic = pick(TOPICS, rng);
      operations.push({
        kind: "ask",
        i,
        topic,
        summary: false,
        question: `Given what you remember about topic=${topic}, answer: ${pick(QUESTION_TEMPLATES, rng)}`
      });
      asks += 1;
    }

    if (i % 200 === 0) {
      const topic = pick(TOPICS, rng);
      operations.push({
        kind: "ask",
        i,
        topic,
        summary: true,
        question: `Summarize everything you know about topic=${topic} in 5 bullet points.`
      });
      asks += 1;
    }

    if (snapshotEvery > 0 && i % snapshotEvery === 0) {
      operations.push({ kind: "snapshot", i });
    }
  }

  while (asks < minAsks) {
    const topic = pick(TOPICS, rng);
    operations.push({
      kind: "ask",
      i: writeCount,
      topic,
      summary: false,
      extra: true,
      question: `Given what you remember about topic=${topic}, answer: ${pick(QUESTION_TEMPLATES, rng)}`
    });
    asks += 1;
  }

  return {
    operations,
    planned: {
      writes: writeCount,
      reads,
      asks
    }
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGatewayError(status, json, text) {
  if (status !== 400) return false;
  const code = String(json?.error?.code || "").toUpperCase();
  const message = String(json?.error?.message || text || "").toLowerCase();
  const retryableCodes = new Set([
    "ASK_FAILED",
    "MEMORY_RECALL_FAILED",
    "MEMORY_WRITE_FAILED",
    "SEARCH_FAILED"
  ]);
  const transientMessage = /timeout|timed out|connect|socket|econn|temporary|try again|upstream|getaddrinfo|enotfound|dns/.test(message);
  return retryableCodes.has(code) && transientMessage;
}

function isRetryableControlPlaneError(status, json, text) {
  const code = String(json?.error?.code || "").toUpperCase();
  const message = String(json?.error?.message || text || "").toLowerCase();
  if (status === 409 && code === "IDEMPOTENCY_IN_PROGRESS") {
    return true;
  }
  if (status === 400 && code === "COLLECTION_DELETE_FAILED") {
    return /timeout|timed out|read timeout|temporary|try again|busy|getaddrinfo|enotfound|dns/.test(message);
  }
  return false;
}

async function requestJson(baseUrl, method, route, options = {}) {
  const url = new URL(route, baseUrl).toString();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 4;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = { ...(options.headers || {}) };
      const body = options.body;
      const startedAt = Date.now();
      const init = {
        method,
        headers,
        signal: controller.signal
      };
      if (body !== undefined) {
        headers["content-type"] = headers["content-type"] || "application/json";
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);
      const text = await response.text();
      clearTimeout(timer);

      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      const shouldRetry = response.status === 429
        || response.status >= 500
        || isTransientGatewayError(response.status, json, text)
        || isRetryableControlPlaneError(response.status, json, text);
      if (shouldRetry && attempt < maxRetries) {
        await sleep(200 * Math.pow(2, attempt));
        continue;
      }

      return {
        status: response.status,
        json,
        text,
        latencyMs: Date.now() - startedAt
      };
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= maxRetries) {
        throw err;
      }
      await sleep(200 * Math.pow(2, attempt));
    }
  }

  throw new Error(`request failed after retries: ${method} ${route}`);
}

function expectOkEnvelope(response, label) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed status=${response?.status} body=${response?.text || ""}`);
  }
  if (!response.json || typeof response.json !== "object" || response.json.ok !== true || !response.json.data) {
    throw new Error(`${label} expected v1 envelope, got=${response.text || ""}`);
  }
  return response.json.data;
}

function createTelemetryWriter(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  let writes = 0;

  return {
    append(event) {
      const line = `${JSON.stringify(event)}\n`;
      fs.writeSync(fd, line, null, "utf8");
      writes += 1;
      if (writes % 25 === 0) {
        fs.fsyncSync(fd);
      }
    },
    close() {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
  };
}

async function loginAdmin(baseUrl, username, password, requestIdPrefix) {
  const response = await requestJson(baseUrl, "POST", "/v1/login", {
    headers: { "x-request-id": `${requestIdPrefix}:login` },
    body: { username, password },
    timeoutMs: 30000,
    maxRetries: 5
  });
  const data = expectOkEnvelope(response, "login");
  if (!data.token) {
    throw new Error("login did not return token");
  }
  const user = data.user || null;
  return { token: data.token, tenantId: user?.tenantId || username };
}

async function createServiceToken(baseUrl, adminJwt, runId, requestIdPrefix) {
  const response = await requestJson(baseUrl, "POST", "/v1/admin/service-tokens", {
    headers: {
      authorization: `Bearer ${adminJwt}`,
      "x-request-id": `${requestIdPrefix}:svc-create`
    },
    body: {
      name: `eval-${runId}`,
      principalId: `eval:${runId}`,
      roles: ["admin", "indexer", "reader"]
    },
    timeoutMs: 30000,
    maxRetries: 3
  });
  const data = expectOkEnvelope(response, "create service token");
  return {
    token: data.token,
    id: data.tokenInfo?.id || null
  };
}

async function revokeServiceToken(baseUrl, adminJwt, tokenId, requestIdPrefix) {
  if (!tokenId) return;
  const response = await requestJson(baseUrl, "DELETE", `/v1/admin/service-tokens/${encodeURIComponent(String(tokenId))}`, {
    headers: {
      authorization: `Bearer ${adminJwt}`,
      "x-request-id": `${requestIdPrefix}:svc-revoke`
    },
    timeoutMs: 30000,
    maxRetries: 2
  });
  if (response.status >= 200 && response.status < 300) return;
  throw new Error(`revoke service token failed status=${response.status} body=${response.text}`);
}

async function clearCollection(baseUrl, apiKey, collection, requestIdPrefix) {
  const response = await requestJson(baseUrl, "DELETE", `/v1/collections/${encodeURIComponent(collection)}`, {
    headers: {
      "x-api-key": apiKey,
      "x-request-id": `${requestIdPrefix}:clear:${collection}`
    },
    timeoutMs: 60000,
    maxRetries: 8
  });

  if (response.status >= 200 && response.status < 300) {
    return;
  }

  throw new Error(`clear collection failed status=${response.status} body=${response.text}`);
}

async function snapshotMemory(baseUrl, apiKey, collection, runMeta, writer, snapshotIndex) {
  const requestId = `${runMeta.runId}:snapshot:${snapshotIndex}`;
  const usageResp = await requestJson(baseUrl, "GET", `/v1/admin/usage?collection=${encodeURIComponent(collection)}`, {
    headers: {
      "x-api-key": apiKey,
      "x-request-id": requestId
    },
    timeoutMs: 60000,
    maxRetries: 4
  });
  const data = expectOkEnvelope(usageResp, "usage snapshot");
  const totalItems = Number(data?.usage?.storage?.memoryItems || 0);
  const nowMs = Date.now();
  writer.append({
    timestamp: new Date(nowMs).toISOString(),
    timestamp_ms: nowMs,
    event_type: "memory_snapshot",
    request_id: requestId,
    tenant_id: runMeta.tenantId,
    config_id: runMeta.configId,
    run_id: runMeta.runId,
    source: "workload_snapshot",
    scope: "tenant_collection",
    collection,
    total_items: totalItems,
    tier_distribution: {},
    value_distribution: {}
  });
  return totalItems;
}

async function run() {
  const args = parseArgs(process.argv);
  const baseUrl = String(args["base-url"] || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const username = String(args.username || process.env.EVAL_USERNAME || process.env.E2E_USERNAME || "ci_admin");
  const password = String(args.password || process.env.EVAL_PASSWORD || process.env.E2E_PASSWORD || "ci_admin_password");
  const collection = String(args.collection || "eval_ttl_amvl");
  const seed = toInt(args.seed, 1337);
  const writes = toInt(args.writes, 50000);
  const minAsks = toInt(args["min-asks"], 10000);
  const recallK = toInt(args["recall-k"], 24);
  const askK = toInt(args["ask-k"], 48);
  const ttlSeconds = toInt(args["ttl-seconds"], 60 * 60 * 24 * 30);
  const snapshotEvery = toInt(args["snapshot-every"], 1000);
  const logEvery = toInt(args["log-every"], 250);
  const concurrency = Math.max(1, toInt(args.concurrency, 1));
  const timeoutMs = toInt(args["request-timeout-ms"], 120000);
  const maxRetries = toInt(args["max-retries"], 5);
  const telemetryFile = String(args["telemetry-file"] || "/app/telemetry/events_ttl_amvl_lru.ndjson");
  const configId = String(args["config-id"] || "default");
  const runId = String(args["run-id"] || `run-${Date.now()}`);

  if (!writes || writes < 1) {
    throw new Error("writes must be > 0");
  }
  if (!minAsks || minAsks < 1) {
    throw new Error("min-asks must be > 0");
  }

  const writer = createTelemetryWriter(telemetryFile);
  const requestIdPrefix = `workload:${runId}`;
  const { operations, planned } = buildWorkload(seed, writes, minAsks, snapshotEvery);

  console.log(`[workload] base_url=${baseUrl}`);
  console.log(`[workload] config_id=${configId} run_id=${runId}`);
  console.log(`[workload] planned writes=${planned.writes} reads=${planned.reads} asks=${planned.asks} ops=${operations.length}`);
  console.log(`[workload] concurrency=${concurrency}`);

  const startedAt = Date.now();
  const admin = await loginAdmin(baseUrl, username, password, requestIdPrefix);
  const tokenRecord = await createServiceToken(baseUrl, admin.token, runId, requestIdPrefix);
  let serviceTokenId = tokenRecord.id;

  const runMeta = {
    configId,
    runId,
    tenantId: admin.tenantId || username
  };

  const counters = {
    writes: 0,
    reads: 0,
    asks: 0,
    summaries: 0,
    snapshots: 0,
    errors: 0,
    maxMemoryItems: 0
  };

  writer.append({
    timestamp: new Date(startedAt).toISOString(),
    timestamp_ms: startedAt,
    event_type: "workload_phase",
    request_id: `${runId}:phase:start`,
    tenant_id: runMeta.tenantId,
    config_id: configId,
    run_id: runId,
    phase: "start",
    seed,
    collection,
    planned_writes: planned.writes,
    planned_reads: planned.reads,
    planned_asks: planned.asks,
    recall_k: recallK,
    ask_k: askK
  });

  try {
    await clearCollection(baseUrl, tokenRecord.token, collection, requestIdPrefix);

    let completed = 0;
    async function executeOp(op, seq) {
      const reqId = `${runId}:op:${seq}:${op.kind}`;

      if (op.kind === "write") {
        const response = await requestJson(baseUrl, "POST", "/v1/memory/write", {
          headers: {
            "x-api-key": tokenRecord.token,
            "x-request-id": reqId,
            "idempotency-key": `${runId}:write:${op.i}`
          },
          body: {
            collection,
            type: "artifact",
            externalId: `fact_${op.i}`,
            text: op.text,
            tags: [op.topic],
            metadata: {
              topic: op.topic,
              fact_id: op.i,
              seed
            },
            ttlSeconds
          },
          timeoutMs,
          maxRetries
        });
        expectOkEnvelope(response, `write#${op.i}`);
        counters.writes += 1;
      } else if (op.kind === "read") {
        const response = await requestJson(baseUrl, "POST", "/v1/memory/recall", {
          headers: {
            "x-api-key": tokenRecord.token,
            "x-request-id": reqId
          },
          body: {
            collection,
            query: op.query,
            k: recallK,
            types: ["artifact"]
          },
          timeoutMs,
          maxRetries
        });
        expectOkEnvelope(response, `recall#${op.i}`);
        counters.reads += 1;
      } else if (op.kind === "ask") {
        const response = await requestJson(baseUrl, "POST", "/v1/ask", {
          headers: {
            "x-api-key": tokenRecord.token,
            "x-request-id": reqId
          },
          body: {
            collection,
            question: op.question,
            k: askK
          },
          timeoutMs,
          maxRetries
        });
        expectOkEnvelope(response, `ask#${op.i}`);
        counters.asks += 1;
        if (op.summary) counters.summaries += 1;
      } else if (op.kind === "snapshot") {
        const totalItems = await snapshotMemory(baseUrl, tokenRecord.token, collection, runMeta, writer, op.i);
        counters.snapshots += 1;
        if (totalItems > counters.maxMemoryItems) {
          counters.maxMemoryItems = totalItems;
        }
      }

      completed += 1;
      if (logEvery > 0 && completed % logEvery === 0) {
        console.log(
          `[workload] run=${runId} progress=${completed}/${operations.length}`
          + ` writes=${counters.writes} reads=${counters.reads} asks=${counters.asks}`
        );
      }
    }

    if (concurrency === 1) {
      for (let idx = 0; idx < operations.length; idx += 1) {
        const op = operations[idx];
        const seq = idx + 1;
        await executeOp(op, seq);
      }
    } else {
      let cursor = 0;
      const workers = new Array(concurrency).fill(null).map(async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= operations.length) return;
          const op = operations[idx];
          const seq = idx + 1;
          await executeOp(op, seq);
        }
      });
      await Promise.all(workers);
    }

    const finalItems = await snapshotMemory(baseUrl, tokenRecord.token, collection, runMeta, writer, writes);
    counters.snapshots += 1;
    if (finalItems > counters.maxMemoryItems) {
      counters.maxMemoryItems = finalItems;
    }
  } catch (err) {
    counters.errors += 1;
    const nowMs = Date.now();
    writer.append({
      timestamp: new Date(nowMs).toISOString(),
      timestamp_ms: nowMs,
      event_type: "workload_error",
      request_id: `${runId}:phase:error`,
      tenant_id: runMeta.tenantId,
      config_id: configId,
      run_id: runId,
      message: String(err?.message || err)
    });
    throw err;
  } finally {
    const endedAt = Date.now();
    writer.append({
      timestamp: new Date(endedAt).toISOString(),
      timestamp_ms: endedAt,
      event_type: "workload_phase",
      request_id: `${runId}:phase:finish`,
      tenant_id: runMeta.tenantId,
      config_id: configId,
      run_id: runId,
      phase: "finish",
      duration_ms: endedAt - startedAt,
      writes: counters.writes,
      reads: counters.reads,
      asks: counters.asks,
      summaries: counters.summaries,
      snapshots: counters.snapshots,
      max_memory_items: counters.maxMemoryItems,
      errors: counters.errors
    });

    try {
      await revokeServiceToken(baseUrl, admin.token, serviceTokenId, requestIdPrefix);
      serviceTokenId = null;
    } catch (err) {
      const nowMs = Date.now();
      writer.append({
        timestamp: new Date(nowMs).toISOString(),
        timestamp_ms: nowMs,
        event_type: "workload_warning",
        request_id: `${runId}:svc-revoke-warning`,
        tenant_id: runMeta.tenantId,
        config_id: configId,
        run_id: runId,
        warning: String(err?.message || err)
      });
    }

    writer.close();
  }

  console.log(`[workload] completed run=${runId} writes=${planned.writes} reads=${planned.reads} asks=${planned.asks}`);
}

run().catch((err) => {
  console.error("[workload] failed");
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

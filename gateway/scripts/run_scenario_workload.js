#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

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

function buildFactText(prefix, index, topic, rng) {
  const len = 24 + Math.floor(rng() * 30);
  const parts = [];
  for (let j = 0; j < len; j += 1) {
    parts.push(pick(WORD_BANK, rng));
  }
  const sentence = parts.join(" ");
  return `${prefix}_fact_${index}: ${sentence} topic=${topic} tag=${topic}`;
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
  const transientMessage = /timeout|timed out|connect|socket|econn|temporary|try again|upstream/.test(message);
  return retryableCodes.has(code) && transientMessage;
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
        || isTransientGatewayError(response.status, json, text);
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
    maxRetries: 2
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
    maxRetries: 5
  });

  if (response.status >= 200 && response.status < 300) {
    return;
  }

  throw new Error(`clear collection failed status=${response.status} body=${response.text}`);
}

async function snapshotMemory(baseUrl, apiKey, collection, runMeta, writer, label) {
  const requestId = `${runMeta.runId}:snapshot:${label}`;
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
    policy: runMeta.policy,
    run_id: runMeta.runId,
    source: "scenario_snapshot",
    scope: "tenant_collection",
    collection,
    total_items: totalItems,
    tier_distribution: {},
    value_distribution: {}
  });
  return totalItems;
}

function buildMixedPhaseOperations({ phaseName, topic, writes, recalls, asks, rng, scenarioType, keyFacts }) {
  const ops = [];
  let readsAdded = 0;
  let asksAdded = 0;
  const safeWrites = Math.max(0, Number(writes || 0));
  const safeRecalls = Math.max(0, Number(recalls || 0));
  const safeAsks = Math.max(0, Number(asks || 0));
  const recallStride = safeRecalls > 0 ? Math.max(1, Math.floor(safeWrites / safeRecalls)) : 0;
  const askStride = safeAsks > 0 ? Math.max(1, Math.floor(safeWrites / safeAsks)) : 0;

  for (let i = 1; i <= safeWrites; i += 1) {
    const factTopic = topic || pick(TOPICS, rng);
    let text;
    if (scenarioType === "aged_recall_seed") {
      const key = `founding_key_${i}`;
      const detail = pick(WORD_BANK, rng);
      text = `founding_fact_${i}: key=${key} canonical_answer=${detail} topic=${factTopic}`;
      keyFacts.push({ key, canonical: detail, index: i });
    } else {
      text = buildFactText(phaseName, i, factTopic, rng);
    }

    ops.push({
      kind: "write",
      phase: phaseName,
      topic: factTopic,
      externalId: `${phaseName}_fact_${i}`,
      text
    });

    if (safeRecalls > 0 && (i % recallStride === 0) && readsAdded < safeRecalls) {
      readsAdded += 1;
      const recallTopic = scenarioType === "aged_recall_probe"
        ? "founding_facts"
        : factTopic;
      const probe = scenarioType === "aged_recall_probe" && keyFacts.length
        ? pick(keyFacts, rng)
        : null;
      const query = probe
        ? `Recall the founding fact for key=${probe.key}.`
        : `Recall details for topic=${recallTopic}.`;
      ops.push({
        kind: "read",
        phase: phaseName,
        topic: recallTopic,
        query
      });
    }

    if (safeAsks > 0 && (i % askStride === 0) && asksAdded < safeAsks) {
      asksAdded += 1;
      const askTopic = scenarioType === "aged_recall_probe"
        ? "founding_facts"
        : factTopic;
      const probe = scenarioType === "aged_recall_probe" && keyFacts.length
        ? pick(keyFacts, rng)
        : null;
      const question = probe
        ? `For key=${probe.key}, what is the canonical_answer and confidence?`
        : `Given what you remember about topic=${askTopic}, answer: ${pick(QUESTION_TEMPLATES, rng)}`;
      ops.push({
        kind: "ask",
        phase: phaseName,
        topic: askTopic,
        question
      });
    }
  }

  while (readsAdded < safeRecalls) {
    readsAdded += 1;
    const probe = scenarioType === "aged_recall_probe" && keyFacts.length
      ? pick(keyFacts, rng)
      : null;
    ops.push({
      kind: "read",
      phase: phaseName,
      topic: topic || "general",
      query: probe ? `Recall the founding fact for key=${probe.key}.` : `Recall details for topic=${topic || "general"}.`
    });
  }

  while (asksAdded < safeAsks) {
    asksAdded += 1;
    const probe = scenarioType === "aged_recall_probe" && keyFacts.length
      ? pick(keyFacts, rng)
      : null;
    ops.push({
      kind: "ask",
      phase: phaseName,
      topic: topic || "general",
      question: probe
        ? `For key=${probe.key}, what is the canonical_answer and confidence?`
        : `Given what you remember about topic=${topic || "general"}, answer: ${pick(QUESTION_TEMPLATES, rng)}`
    });
  }

  return ops;
}

function buildScenarioPlan(config, seed) {
  const type = String(config?.type || "").trim();
  const rng = createRng(seed);
  const keyFacts = [];
  const phases = [];

  if (type === "phase_shift" || type === "bursty_write") {
    const list = Array.isArray(config?.phases) ? config.phases : [];
    for (const phase of list) {
      phases.push({
        name: String(phase?.name || "phase"),
        operations: buildMixedPhaseOperations({
          phaseName: String(phase?.name || "phase"),
          topic: String(phase?.topic || pick(TOPICS, rng)),
          writes: toInt(phase?.writes, 0),
          recalls: toInt(phase?.recalls, 0),
          asks: toInt(phase?.asks, 0),
          rng,
          scenarioType: type,
          keyFacts
        })
      });
    }
  } else if (type === "aged_recall") {
    const early = config?.early_facts || {};
    phases.push({
      name: "early_facts",
      operations: buildMixedPhaseOperations({
        phaseName: "early_facts",
        topic: String(early?.topic || "founding_facts"),
        writes: toInt(early?.writes, 1000),
        recalls: 0,
        asks: 0,
        rng,
        scenarioType: "aged_recall_seed",
        keyFacts
      })
    });

    const background = config?.background || {};
    phases.push({
      name: "background_traffic",
      operations: buildMixedPhaseOperations({
        phaseName: "background",
        topic: String(background?.topic || "background"),
        writes: toInt(background?.writes, 20000),
        recalls: toInt(background?.recalls, 4000),
        asks: toInt(background?.asks, 4000),
        rng,
        scenarioType: "aged_recall_background",
        keyFacts
      })
    });

    const probes = config?.probes || {};
    phases.push({
      name: "aged_probes",
      operations: buildMixedPhaseOperations({
        phaseName: "aged_probe",
        topic: String(probes?.topic || "founding_facts"),
        writes: 0,
        recalls: toInt(probes?.recalls, 1000),
        asks: toInt(probes?.asks, 1000),
        rng,
        scenarioType: "aged_recall_probe",
        keyFacts
      })
    });
  } else {
    throw new Error(`unsupported scenario type: ${type}`);
  }

  const planned = {
    writes: 0,
    reads: 0,
    asks: 0,
    phases: phases.length
  };
  for (const phase of phases) {
    for (const op of phase.operations) {
      if (op.kind === "write") planned.writes += 1;
      else if (op.kind === "read") planned.reads += 1;
      else if (op.kind === "ask") planned.asks += 1;
    }
  }

  return {
    type,
    phases,
    planned
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const baseUrl = String(args["base-url"] || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const username = String(args.username || process.env.EVAL_USERNAME || process.env.E2E_USERNAME || "ci_admin");
  const password = String(args.password || process.env.EVAL_PASSWORD || process.env.E2E_PASSWORD || "ci_admin_password");
  const collection = String(args.collection || "eval_scenarios");
  const seed = toInt(args.seed, 1337);
  const scenarioConfigPath = String(args["scenario-config"] || "").trim();
  const scenarioJsonB64 = String(args["scenario-json-b64"] || "").trim();
  if (!scenarioConfigPath && !scenarioJsonB64) {
    throw new Error("--scenario-config or --scenario-json-b64 is required");
  }

  let config;
  if (scenarioJsonB64) {
    const jsonText = Buffer.from(scenarioJsonB64, "base64").toString("utf8");
    config = JSON.parse(jsonText);
  } else {
    config = JSON.parse(fs.readFileSync(scenarioConfigPath, "utf8"));
  }
  const workloadConfig = config?.workload || {};

  const recallK = toInt(args["recall-k"], toInt(workloadConfig.recall_k, 24));
  const askK = toInt(args["ask-k"], toInt(workloadConfig.ask_k, 48));
  const ttlSeconds = toInt(args["ttl-seconds"], toInt(workloadConfig.ttl_seconds, 60 * 60 * 24 * 30));
  const logEvery = toInt(args["log-every"], toInt(workloadConfig.log_every, 250));
  const concurrency = Math.max(1, toInt(args.concurrency, toInt(workloadConfig.concurrency, 1)));
  const timeoutMs = toInt(args["request-timeout-ms"], toInt(workloadConfig.request_timeout_ms, 120000));
  const maxRetries = toInt(args["max-retries"], toInt(workloadConfig.max_retries, 5));
  const telemetryFile = String(args["telemetry-file"] || "/app/telemetry/events_ttl_amvl_lru.ndjson");
  const configId = String(args["config-id"] || config?.id || "scenario-config");
  const runId = String(args["run-id"] || `run-${Date.now()}`);
  const policy = String(args.policy || process.env.TELEMETRY_POLICY || "unknown");

  const writer = createTelemetryWriter(telemetryFile);
  const requestIdPrefix = `scenario:${runId}`;
  const plan = buildScenarioPlan(config, seed);

  console.log(`[scenario] base_url=${baseUrl}`);
  console.log(`[scenario] config_id=${configId} run_id=${runId}`);
  console.log(`[scenario] type=${plan.type} phases=${plan.phases.length}`);
  console.log(`[scenario] planned writes=${plan.planned.writes} reads=${plan.planned.reads} asks=${plan.planned.asks}`);
  console.log(`[scenario] concurrency=${concurrency}`);

  const startedAt = Date.now();
  const admin = await loginAdmin(baseUrl, username, password, requestIdPrefix);
  const tokenRecord = await createServiceToken(baseUrl, admin.token, runId, requestIdPrefix);
  let serviceTokenId = tokenRecord.id;

  const runMeta = {
    configId,
    runId,
    tenantId: admin.tenantId || username,
    policy
  };

  const counters = {
    writes: 0,
    reads: 0,
    asks: 0,
    snapshots: 0,
    errors: 0,
    phasesCompleted: 0,
    maxMemoryItems: 0
  };

  writer.append({
    timestamp: new Date(startedAt).toISOString(),
    timestamp_ms: startedAt,
    event_type: "workload_phase",
    request_id: `${runId}:phase:start`,
    tenant_id: runMeta.tenantId,
    config_id: configId,
    policy,
    run_id: runId,
    phase: "start",
    scenario_type: plan.type,
    seed,
    collection,
    planned_writes: plan.planned.writes,
    planned_reads: plan.planned.reads,
    planned_asks: plan.planned.asks,
    recall_k: recallK,
    ask_k: askK
  });

  try {
    await clearCollection(baseUrl, tokenRecord.token, collection, requestIdPrefix);

    async function executeOp(op, seq) {
      const reqId = `${runId}:op:${seq}:${op.kind}`;
      if (op.kind === "write") {
        const response = await requestJson(baseUrl, "POST", "/v1/memory/write", {
          headers: {
            "x-api-key": tokenRecord.token,
            "x-request-id": reqId,
            "idempotency-key": `${runId}:write:${seq}`
          },
          body: {
            collection,
            type: "artifact",
            externalId: op.externalId || `fact_${seq}`,
            text: op.text,
            tags: [op.topic || "general"],
            metadata: {
              scenario_type: plan.type,
              scenario_phase: op.phase,
              topic: op.topic || "general",
              seed
            },
            ttlSeconds
          },
          timeoutMs,
          maxRetries
        });
        expectOkEnvelope(response, `write#${seq}`);
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
        expectOkEnvelope(response, `recall#${seq}`);
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
        expectOkEnvelope(response, `ask#${seq}`);
        counters.asks += 1;
      }
    }

    async function runPhase(phase, phaseIndex) {
      const phaseStart = Date.now();
      const phaseOps = Array.isArray(phase.operations) ? phase.operations : [];
      writer.append({
        timestamp: new Date(phaseStart).toISOString(),
        timestamp_ms: phaseStart,
        event_type: "workload_phase",
        request_id: `${runId}:phase:${phaseIndex}:start`,
        tenant_id: runMeta.tenantId,
        config_id: configId,
        policy,
        run_id: runId,
        phase: phase.name,
        phase_state: "start",
        operation_count: phaseOps.length
      });

      let cursor = 0;
      let completed = 0;
      const workers = new Array(concurrency).fill(null).map(async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= phaseOps.length) return;
          const seq = idx + 1;
          await executeOp(phaseOps[idx], `${phaseIndex}:${seq}`);
          completed += 1;
          if (logEvery > 0 && completed % logEvery === 0) {
            console.log(`[scenario] run=${runId} phase=${phase.name} progress=${completed}/${phaseOps.length}`);
          }
        }
      });
      await Promise.all(workers);

      const snapshotItems = await snapshotMemory(baseUrl, tokenRecord.token, collection, runMeta, writer, `phase-${phaseIndex}`);
      counters.snapshots += 1;
      counters.maxMemoryItems = Math.max(counters.maxMemoryItems, snapshotItems);
      counters.phasesCompleted += 1;

      const phaseEnd = Date.now();
      writer.append({
        timestamp: new Date(phaseEnd).toISOString(),
        timestamp_ms: phaseEnd,
        event_type: "workload_phase",
        request_id: `${runId}:phase:${phaseIndex}:finish`,
        tenant_id: runMeta.tenantId,
        config_id: configId,
        policy,
        run_id: runId,
        phase: phase.name,
        phase_state: "finish",
        duration_ms: phaseEnd - phaseStart,
        operation_count: phaseOps.length
      });
    }

    for (let i = 0; i < plan.phases.length; i += 1) {
      await runPhase(plan.phases[i], i + 1);
    }

    const finalItems = await snapshotMemory(baseUrl, tokenRecord.token, collection, runMeta, writer, "final");
    counters.snapshots += 1;
    counters.maxMemoryItems = Math.max(counters.maxMemoryItems, finalItems);
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
      policy,
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
      policy,
      run_id: runId,
      phase: "finish",
      duration_ms: endedAt - startedAt,
      writes: counters.writes,
      reads: counters.reads,
      asks: counters.asks,
      snapshots: counters.snapshots,
      phases_completed: counters.phasesCompleted,
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
        policy,
        run_id: runId,
        warning: String(err?.message || err)
      });
    }

    writer.close();
  }

  console.log(`[scenario] completed run=${runId} writes=${counters.writes} reads=${counters.reads} asks=${counters.asks}`);
}

run().catch((err) => {
  console.error("[scenario] failed");
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

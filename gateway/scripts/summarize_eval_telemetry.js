#!/usr/bin/env node
"use strict";

const fs = require("fs");
const readline = require("readline");

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

function cleanPath(pathValue) {
  return String(pathValue || "").split("?")[0] || "";
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function median(values) {
  return percentile(values, 50);
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

async function main() {
  const args = parseArgs(process.argv);
  const input = String(args.input || "").trim();
  if (!input) {
    throw new Error("Usage: node scripts/summarize_eval_telemetry.js --input /app/telemetry/events_ttl_amvl_lru.ndjson [--ttl-config baseline-ttl] [--amvl-config baseline-amvl] [--lru-config baseline-lru]");
  }

  const ttlConfig = String(args["ttl-config"] || "baseline-ttl");
  const amvlConfig = String(args["amvl-config"] || "baseline-amvl");
  const lruConfig = String(args["lru-config"] || "").trim();
  const requiredWrites = toInt(args["require-writes"], 50000);
  const requiredReads = toInt(args["require-reads"], 10000);
  const requiredAsks = toInt(args["require-asks"], 10000);

  const eventCount = new Map(); // key: config|event_type
  const perConfig = new Map();
  const requiredEventTypes = new Set([
    "request_start",
    "request_finish",
    "prompt_constructed",
    "memory_candidates",
    "token_usage",
    "memory_snapshot",
    "lifecycle_actions"
  ]);
  const seenRequired = new Set();

  let healthEvents = 0;

  function getStats(configId) {
    if (!perConfig.has(configId)) {
      perConfig.set(configId, {
        requestCounts: { writes: 0, reads: 0, asks: 0 },
        latencies: [],
        tokensPerRequest: [],
        memorySnapshotTotals: [],
        retrievalSetSizes: [],
        retrievalBounds: []
      });
    }
    return perConfig.get(configId);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(input, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) continue;

    let event;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON line in ${input}: ${err.message}`);
    }

    const configId = String(event.config_id || "unknown");
    const eventType = String(event.event_type || "unknown");
    const key = `${configId}|${eventType}`;
    eventCount.set(key, (eventCount.get(key) || 0) + 1);

    if (requiredEventTypes.has(eventType)) {
      seenRequired.add(eventType);
    }

    const stats = getStats(configId);

    if (eventType === "request_start" || eventType === "request_finish") {
      const path = cleanPath(event.path);
      if (path === "/health" || path === "/v1/health") {
        healthEvents += 1;
      }
    }

    if (eventType === "request_finish") {
      const status = Number(event.status || 0);
      const path = cleanPath(event.path);
      const latency = Number(event.latency_ms);

      if (Number.isFinite(latency) && latency >= 0 && path !== "/health" && path !== "/v1/health") {
        stats.latencies.push(latency);
      }

      if (status >= 200 && status < 300) {
        if (path === "/v1/memory/write" || path === "/memory/write" || path === "/v1/memory" || path === "/memory") {
          stats.requestCounts.writes += 1;
        } else if (path === "/v1/memory/recall" || path === "/memory/recall") {
          stats.requestCounts.reads += 1;
        } else if (path === "/v1/ask" || path === "/ask") {
          stats.requestCounts.asks += 1;
        }
      }
    }

    if (eventType === "prompt_constructed") {
      const total = Number(event.total_tokens_est ?? event.prompt_tokens_est ?? 0);
      if (Number.isFinite(total) && total > 0) {
        stats.tokensPerRequest.push(total);
      }
    }

    if (eventType === "memory_snapshot") {
      const totalItems = Number(event.total_items);
      if (Number.isFinite(totalItems) && totalItems >= 0) {
        stats.memorySnapshotTotals.push(totalItems);
      }
    }

    if (eventType === "memory_candidates") {
      const retrievalSize = Number(event.retrieval_set_size);
      const retrievalBound = Number(event.retrieval_bound);
      if (Number.isFinite(retrievalSize) && retrievalSize >= 0) {
        stats.retrievalSetSizes.push(retrievalSize);
      }
      if (Number.isFinite(retrievalBound) && retrievalBound >= 0) {
        stats.retrievalBounds.push(retrievalBound);
      }
    }

    if (eventType === "token_usage" && stats.tokensPerRequest.length === 0) {
      const tokenTotal = Number(event.token_total || 0);
      if (Number.isFinite(tokenTotal) && tokenTotal > 0) {
        stats.tokensPerRequest.push(tokenTotal);
      }
    }
  }

  const configs = [ttlConfig, amvlConfig];
  if (lruConfig && !configs.includes(lruConfig)) {
    configs.push(lruConfig);
  }

  console.log("\nEvent counts by config_id and event_type:");
  const rows = [];
  for (const [key, count] of eventCount.entries()) {
    const [configId, eventType] = key.split("|");
    if (!configs.includes(configId)) continue;
    rows.push({ config_id: configId, event_type: eventType, count });
  }
  rows.sort((a, b) => {
    if (a.config_id !== b.config_id) return a.config_id.localeCompare(b.config_id);
    if (a.event_type !== b.event_type) return a.event_type.localeCompare(b.event_type);
    return a.count - b.count;
  });
  for (const row of rows) {
    console.log(`${row.config_id}\t${row.event_type}\t${row.count}`);
  }

  console.log("\nPer-run request and latency summary:");
  for (const configId of configs) {
    const stats = getStats(configId);
    const latencyP50 = percentile(stats.latencies, 50);
    const latencyP95 = percentile(stats.latencies, 95);
    const latencyP99 = percentile(stats.latencies, 99);
    const tokenMean = mean(stats.tokensPerRequest);
    const tokenMedian = median(stats.tokensPerRequest);
    const maxMemoryItems = stats.memorySnapshotTotals.length ? Math.max(...stats.memorySnapshotTotals) : 0;

    console.log(`config_id=${configId}`);
    console.log(`  writes=${stats.requestCounts.writes} reads=${stats.requestCounts.reads} asks=${stats.requestCounts.asks}`);
    console.log(`  latency_ms p50=${latencyP50 ?? "n/a"} p95=${latencyP95 ?? "n/a"} p99=${latencyP99 ?? "n/a"}`);
    console.log(`  tokens/request mean=${tokenMean ? tokenMean.toFixed(2) : "n/a"} median=${tokenMedian ?? "n/a"}`);
    console.log(`  max_memory_items=${maxMemoryItems}`);
  }

  const assertions = [];

  for (const configId of configs) {
    const stats = getStats(configId);
    assertions.push({
      name: `${configId}: writes >= ${requiredWrites}`,
      pass: stats.requestCounts.writes >= requiredWrites
    });
    assertions.push({
      name: `${configId}: reads >= ${requiredReads}`,
      pass: stats.requestCounts.reads >= requiredReads
    });
    assertions.push({
      name: `${configId}: asks >= ${requiredAsks}`,
      pass: stats.requestCounts.asks >= requiredAsks
    });
  }

  const ttlStats = getStats(ttlConfig);
  const amvlStats = getStats(amvlConfig);
  const ttlMaxMemory = ttlStats.memorySnapshotTotals.length ? Math.max(...ttlStats.memorySnapshotTotals) : 0;
  assertions.push({
    name: `${ttlConfig}: memory grows large (max total_items >= 10000)`,
    pass: ttlMaxMemory >= 10000
  });

  const amvlRetrievalP95 = percentile(amvlStats.retrievalSetSizes, 95);
  const amvlBoundP95 = percentile(amvlStats.retrievalBounds, 95);
  assertions.push({
    name: `${amvlConfig}: p95 retrieval_set_size <= p95 retrieval_bound`,
    pass: Number.isFinite(amvlRetrievalP95) && Number.isFinite(amvlBoundP95) && amvlRetrievalP95 <= amvlBoundP95
  });

  for (const eventType of requiredEventTypes) {
    assertions.push({
      name: `required event_type present: ${eventType}`,
      pass: seenRequired.has(eventType)
    });
  }

  assertions.push({
    name: "health traffic excluded from output",
    pass: healthEvents === 0
  });

  let failed = 0;
  console.log("\nAssertions:");
  for (const assertion of assertions) {
    const status = assertion.pass ? "PASS" : "FAIL";
    if (!assertion.pass) failed += 1;
    console.log(`${status}\t${assertion.name}`);
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

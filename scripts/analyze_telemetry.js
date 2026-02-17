#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  "J": ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]
};

const COLORS = {
  white: [255, 255, 255],
  black: [18, 24, 31],
  gray: [173, 181, 189],
  lightGrid: [226, 232, 240],
  blue: [30, 120, 245],
  red: [219, 58, 52],
  green: [38, 166, 91],
  amber: [245, 158, 11],
  purple: [139, 92, 246],
  teal: [20, 184, 166],
  pink: [236, 72, 153],
  indigo: [79, 70, 229],
  orange: [249, 115, 22],
  slate: [100, 116, 139]
};

const PALETTE = [
  COLORS.blue,
  COLORS.red,
  COLORS.green,
  COLORS.amber,
  COLORS.purple,
  COLORS.teal,
  COLORS.pink,
  COLORS.indigo,
  COLORS.orange,
  COLORS.slate
];

class Canvas {
  constructor(width, height, bg = COLORS.white) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  setPixel(x, y, color) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const idx = (yi * this.width + xi) * 4;
    this.pixels[idx] = color[0];
    this.pixels[idx + 1] = color[1];
    this.pixels[idx + 2] = color[2];
    this.pixels[idx + 3] = 255;
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        this.setPixel(xx, yy, color);
      }
    }
  }

  drawLine(x0, y0, x1, y1, color, thickness = 1) {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const sx = ax < bx ? 1 : -1;
    const dy = -Math.abs(by - ay);
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;

    while (true) {
      this.fillRect(ax - Math.floor(thickness / 2), ay - Math.floor(thickness / 2), thickness, thickness, color);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  drawText(x, y, text, color = COLORS.black, scale = 1) {
    const clean = String(text || "").toUpperCase();
    let cursor = Math.round(x);
    const top = Math.round(y);
    for (const ch of clean) {
      const glyph = FONT[ch] || FONT["?"];
      for (let gy = 0; gy < glyph.length; gy += 1) {
        const row = glyph[gy];
        for (let gx = 0; gx < row.length; gx += 1) {
          if (row[gx] === "1") {
            this.fillRect(cursor + gx * scale, top + gy * scale, scale, scale, color);
          }
        }
      }
      cursor += (5 + 1) * scale;
    }
  }

  savePng(filePath) {
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      const rowStart = y * (this.width * 4 + 1);
      raw[rowStart] = 0;
      const srcStart = y * this.width * 4;
      this.pixels.copy(raw, rowStart + 1, srcStart, srcStart + this.width * 4);
    }

    const png = encodePng(this.width, this.height, raw);
    fs.writeFileSync(filePath, png);
  }
}

function encodePng(width, height, raw) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const chunks = [
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0))
  ];
  return Buffer.concat([signature, ...chunks]);
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseArgs(argv) {
  const out = {
    input: path.join("telemetry", "events.ndjson"),
    outDir: path.join("telemetry_analysis")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--input" || arg === "-i") && argv[i + 1]) {
      out.input = argv[i + 1];
      i += 1;
      continue;
    }
    if ((arg === "--out" || arg === "-o") && argv[i + 1]) {
      out.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log("Usage: node scripts/analyze_telemetry.js --input <events.ndjson> --out <output_dir>");
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function shortLabel(value, maxLen = 20) {
  const text = String(value || "");
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
}

function runKey(configId, runId) {
  return `${configId}::${runId}`;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function loadEvents(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Telemetry file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const events = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const ts = Date.parse(parsed.timestamp);
      if (!Number.isFinite(ts)) continue;
      events.push({
        ...parsed,
        timestamp_ms: ts,
        timestamp: new Date(ts).toISOString(),
        config_id: safeString(parsed.config_id, "unknown"),
        run_id: safeString(parsed.run_id, "unknown"),
        tenant_id: safeString(parsed.tenant_id, "unknown"),
        request_id: safeString(parsed.request_id, `unknown-${i + 1}`),
        event_type: safeString(parsed.event_type, "unknown")
      });
    } catch {
      // Ignore malformed lines.
    }
  }
  events.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return events;
}

function buildDatasets(events) {
  const tokenUsage = [];
  const memorySnapshots = [];
  const latencyRows = [];
  const lifecycleRows = [];
  const promptRows = [];
  const retrievalRows = [];
  const memoryUsedRows = [];
  const runMeta = new Map();

  for (const event of events) {
    const key = runKey(event.config_id, event.run_id);
    if (!runMeta.has(key)) {
      runMeta.set(key, {
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id
      });
    }

    if (event.event_type === "token_usage") {
      tokenUsage.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        request_id: event.request_id,
        token_kind: safeString(event.token_kind, "unknown"),
        token_input: toNumber(event.token_input, 0),
        token_output: toNumber(event.token_output, 0),
        token_prompt: toNumber(event.token_prompt, 0),
        token_total: toNumber(event.token_total, 0),
        source: safeString(event.source, "")
      });
      continue;
    }

    if (event.event_type === "memory_snapshot") {
      const typeDist = event.type_distribution && typeof event.type_distribution === "object"
        ? event.type_distribution
        : {};
      const valueDist = event.value_distribution && typeof event.value_distribution === "object"
        ? event.value_distribution
        : {};
      memorySnapshots.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        total_items: toNumber(event.total_items, 0),
        approx_tokens: toNumber(event.approx_tokens, 0),
        type_distribution: typeDist,
        value_distribution: valueDist
      });
      continue;
    }

    if (event.event_type === "request_finish") {
      latencyRows.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        request_id: event.request_id,
        method: safeString(event.method, ""),
        path: safeString(event.path, ""),
        status: toNumber(event.status, 0),
        latency_ms: toNumber(event.latency_ms, 0)
      });
      continue;
    }

    if (event.event_type === "memory_lifecycle") {
      lifecycleRows.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        request_id: event.request_id,
        action: safeString(event.action, "unknown"),
        reason: safeString(event.reason, ""),
        status: safeString(event.status, ""),
        memory_id: safeString(event.memory_id, ""),
        item_type: safeString(event.item_type, ""),
        source: safeString(event.source, "")
      });
      continue;
    }

    if (event.event_type === "prompt_constructed") {
      const memoryIds = Array.isArray(event.memory_ids) ? event.memory_ids : [];
      promptRows.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        request_id: event.request_id,
        prompt_chars: toNumber(event.prompt_chars, 0),
        prompt_tokens_est: toNumber(event.prompt_tokens_est, 0),
        chunk_count: toNumber(event.chunk_count, 0),
        memory_count: toNumber(event.memory_count, memoryIds.length),
        memory_ids: memoryIds
      });
      continue;
    }

    if (event.event_type === "memory_retrieval") {
      const retrieved = Array.isArray(event.retrieved) ? event.retrieved : [];
      retrievalRows.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        request_id: event.request_id,
        operation: safeString(event.operation, ""),
        retrieved_count: toNumber(event.retrieved_count, retrieved.length),
        retrieved
      });
      continue;
    }

    if (event.event_type === "memory_used") {
      const memoryIds = Array.isArray(event.memory_ids) ? event.memory_ids : [];
      memoryUsedRows.push({
        run_key: key,
        config_id: event.config_id,
        run_id: event.run_id,
        timestamp: event.timestamp,
        timestamp_ms: event.timestamp_ms,
        tenant_id: event.tenant_id,
        request_id: event.request_id,
        operation: safeString(event.operation, ""),
        memory_ids: memoryIds
      });
    }
  }

  tokenUsage.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  memorySnapshots.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  latencyRows.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  lifecycleRows.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  promptRows.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  retrievalRows.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  memoryUsedRows.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const tokenCumulative = [];
  const tokenByRun = new Map();
  for (const row of tokenUsage) {
    const current = tokenByRun.get(row.run_key) || 0;
    const next = current + row.token_total;
    tokenByRun.set(row.run_key, next);
    tokenCumulative.push({
      ...row,
      cumulative_token_total: next
    });
  }

  const valueRows = [];
  for (const snapshot of memorySnapshots) {
    for (const [bucket, count] of Object.entries(snapshot.value_distribution || {})) {
      valueRows.push({
        run_key: snapshot.run_key,
        config_id: snapshot.config_id,
        run_id: snapshot.run_id,
        timestamp: snapshot.timestamp,
        timestamp_ms: snapshot.timestamp_ms,
        tenant_id: snapshot.tenant_id,
        bucket,
        count: toNumber(count, 0)
      });
    }
  }

  const typeRows = [];
  for (const snapshot of memorySnapshots) {
    for (const [itemType, count] of Object.entries(snapshot.type_distribution || {})) {
      typeRows.push({
        run_key: snapshot.run_key,
        config_id: snapshot.config_id,
        run_id: snapshot.run_id,
        timestamp: snapshot.timestamp,
        timestamp_ms: snapshot.timestamp_ms,
        tenant_id: snapshot.tenant_id,
        item_type: itemType,
        count: toNumber(count, 0)
      });
    }
  }

  const proxyRows = buildRetrievalProxyRows(retrievalRows, promptRows, memoryUsedRows);
  const runSummary = buildRunSummary({
    runMeta,
    tokenUsage,
    tokenCumulative,
    memorySnapshots,
    latencyRows,
    lifecycleRows,
    promptRows,
    proxyRows
  });
  const configSummary = buildConfigSummary(runSummary, latencyRows);
  const latencyPercentiles = buildLatencyPercentiles(latencyRows);

  return {
    runMeta: Array.from(runMeta.values()).sort((a, b) => a.run_key.localeCompare(b.run_key)),
    tokenUsage,
    tokenCumulative,
    memorySnapshots,
    latencyRows,
    lifecycleRows,
    promptRows,
    retrievalRows,
    memoryUsedRows,
    proxyRows,
    valueRows,
    typeRows,
    runSummary,
    configSummary,
    latencyPercentiles
  };
}

function buildRetrievalProxyRows(retrievalRows, promptRows, memoryUsedRows) {
  const groups = new Map();
  const keyOf = (row) => `${row.run_key}::${row.request_id}`;

  function ensureGroup(row) {
    const key = keyOf(row);
    if (!groups.has(key)) {
      groups.set(key, {
        run_key: row.run_key,
        config_id: row.config_id,
        run_id: row.run_id,
        tenant_id: row.tenant_id,
        request_id: row.request_id,
        operation: row.operation || "",
        timestamp_ms: row.timestamp_ms,
        retrieved_ids: new Set(),
        used_ids: new Set()
      });
    }
    const group = groups.get(key);
    group.timestamp_ms = Math.min(group.timestamp_ms, row.timestamp_ms);
    if (row.operation && !group.operation) {
      group.operation = row.operation;
    }
    return group;
  }

  for (const row of retrievalRows) {
    const group = ensureGroup(row);
    for (const item of row.retrieved || []) {
      const memoryId = safeString(item?.memory_id, "");
      if (memoryId) group.retrieved_ids.add(memoryId);
    }
  }

  for (const row of promptRows) {
    const group = ensureGroup(row);
    for (const memoryId of row.memory_ids || []) {
      const clean = safeString(memoryId, "");
      if (clean) group.used_ids.add(clean);
    }
  }

  for (const row of memoryUsedRows) {
    const group = ensureGroup(row);
    for (const memoryId of row.memory_ids || []) {
      const clean = safeString(memoryId, "");
      if (clean) group.used_ids.add(clean);
    }
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.retrieved_ids.size === 0) continue;
    let usedCount = 0;
    for (const memoryId of group.retrieved_ids) {
      if (group.used_ids.has(memoryId)) usedCount += 1;
    }
    out.push({
      run_key: group.run_key,
      config_id: group.config_id,
      run_id: group.run_id,
      timestamp: new Date(group.timestamp_ms).toISOString(),
      timestamp_ms: group.timestamp_ms,
      tenant_id: group.tenant_id,
      request_id: group.request_id,
      operation: group.operation || "",
      retrieved_count: group.retrieved_ids.size,
      used_count: usedCount,
      used_ratio: group.retrieved_ids.size > 0 ? usedCount / group.retrieved_ids.size : 0
    });
  }
  out.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return out;
}

function buildRunSummary({
  runMeta,
  tokenUsage,
  memorySnapshots,
  latencyRows,
  lifecycleRows,
  promptRows,
  proxyRows
}) {
  const out = [];
  for (const meta of runMeta.values()) {
    const runTokenRows = tokenUsage.filter((row) => row.run_key === meta.run_key);
    const runLatencyRows = latencyRows.filter((row) => row.run_key === meta.run_key);
    const runLifecycle = lifecycleRows.filter((row) => row.run_key === meta.run_key);
    const runPrompts = promptRows.filter((row) => row.run_key === meta.run_key);
    const runProxy = proxyRows.filter((row) => row.run_key === meta.run_key);
    const runSnapshots = memorySnapshots.filter((row) => row.run_key === meta.run_key);
    const latestSnapshot = runSnapshots.length ? runSnapshots[runSnapshots.length - 1] : null;

    const latencies = runLatencyRows.map((row) => row.latency_ms).filter((n) => n > 0);
    const embeddingTokens = runTokenRows
      .filter((row) => row.token_kind === "embedding")
      .reduce((sum, row) => sum + row.token_total, 0);
    const generationTokens = runTokenRows
      .filter((row) => row.token_kind === "generation")
      .reduce((sum, row) => sum + row.token_total, 0);
    const totalTokens = runTokenRows.reduce((sum, row) => sum + row.token_total, 0);

    const lifecycleCounts = { delete: 0, compact: 0, promote: 0, retain: 0 };
    for (const row of runLifecycle) {
      if (row.action in lifecycleCounts) {
        lifecycleCounts[row.action] += 1;
      }
    }

    const retrievedTotal = runProxy.reduce((sum, row) => sum + row.retrieved_count, 0);
    const usedTotal = runProxy.reduce((sum, row) => sum + row.used_count, 0);
    const retrievalUsedRatio = retrievedTotal > 0 ? usedTotal / retrievedTotal : 0;

    out.push({
      run_key: meta.run_key,
      config_id: meta.config_id,
      run_id: meta.run_id,
      request_count: runLatencyRows.length,
      latency_avg_ms: mean(latencies),
      latency_p50_ms: percentile(latencies, 0.5),
      latency_p90_ms: percentile(latencies, 0.9),
      latency_p95_ms: percentile(latencies, 0.95),
      latency_p99_ms: percentile(latencies, 0.99),
      tokens_total: totalTokens,
      tokens_embedding: embeddingTokens,
      tokens_generation: generationTokens,
      prompts_count: runPrompts.length,
      prompt_tokens_est_avg: mean(runPrompts.map((row) => row.prompt_tokens_est)),
      lifecycle_delete: lifecycleCounts.delete,
      lifecycle_compact: lifecycleCounts.compact,
      lifecycle_promote: lifecycleCounts.promote,
      lifecycle_retain: lifecycleCounts.retain,
      retrieval_requests: runProxy.length,
      retrieved_total: retrievedTotal,
      used_total: usedTotal,
      retrieval_used_ratio: retrievalUsedRatio,
      final_memory_items: latestSnapshot ? latestSnapshot.total_items : 0,
      final_memory_tokens_est: latestSnapshot ? latestSnapshot.approx_tokens : 0
    });
  }
  return out.sort((a, b) => a.run_key.localeCompare(b.run_key));
}

function buildConfigSummary(runSummary, latencyRows) {
  const byConfig = new Map();
  for (const row of runSummary) {
    if (!byConfig.has(row.config_id)) {
      byConfig.set(row.config_id, []);
    }
    byConfig.get(row.config_id).push(row);
  }

  const out = [];
  for (const [configId, rows] of byConfig.entries()) {
    const allLatencies = latencyRows
      .filter((row) => row.config_id === configId)
      .map((row) => row.latency_ms)
      .filter((n) => n > 0);

    const requestCount = rows.reduce((sum, row) => sum + row.request_count, 0);
    const tokensTotal = rows.reduce((sum, row) => sum + row.tokens_total, 0);
    const tokensEmbedding = rows.reduce((sum, row) => sum + row.tokens_embedding, 0);
    const tokensGeneration = rows.reduce((sum, row) => sum + row.tokens_generation, 0);
    const deleteCount = rows.reduce((sum, row) => sum + row.lifecycle_delete, 0);
    const compactCount = rows.reduce((sum, row) => sum + row.lifecycle_compact, 0);
    const promoteCount = rows.reduce((sum, row) => sum + row.lifecycle_promote, 0);
    const retainCount = rows.reduce((sum, row) => sum + row.lifecycle_retain, 0);
    const retrievedTotal = rows.reduce((sum, row) => sum + row.retrieved_total, 0);
    const usedTotal = rows.reduce((sum, row) => sum + row.used_total, 0);
    const retrievalRatio = retrievedTotal > 0 ? usedTotal / retrievedTotal : 0;

    out.push({
      config_id: configId,
      run_count: rows.length,
      request_count: requestCount,
      latency_avg_ms: mean(allLatencies),
      latency_p50_ms: percentile(allLatencies, 0.5),
      latency_p90_ms: percentile(allLatencies, 0.9),
      latency_p95_ms: percentile(allLatencies, 0.95),
      latency_p99_ms: percentile(allLatencies, 0.99),
      tokens_total: tokensTotal,
      tokens_embedding: tokensEmbedding,
      tokens_generation: tokensGeneration,
      lifecycle_delete: deleteCount,
      lifecycle_compact: compactCount,
      lifecycle_promote: promoteCount,
      lifecycle_retain: retainCount,
      retrieved_total: retrievedTotal,
      used_total: usedTotal,
      retrieval_used_ratio: retrievalRatio,
      final_memory_items_avg: mean(rows.map((row) => row.final_memory_items)),
      final_memory_tokens_est_avg: mean(rows.map((row) => row.final_memory_tokens_est))
    });
  }

  return out.sort((a, b) => a.config_id.localeCompare(b.config_id));
}

function buildLatencyPercentiles(latencyRows) {
  const byRun = new Map();
  for (const row of latencyRows) {
    if (!byRun.has(row.run_key)) {
      byRun.set(row.run_key, {
        run_key: row.run_key,
        config_id: row.config_id,
        run_id: row.run_id,
        values: []
      });
    }
    byRun.get(row.run_key).values.push(row.latency_ms);
  }

  const out = [];
  for (const group of byRun.values()) {
    const values = group.values.filter((n) => n > 0);
    out.push({
      run_key: group.run_key,
      config_id: group.config_id,
      run_id: group.run_id,
      p50_ms: percentile(values, 0.5),
      p90_ms: percentile(values, 0.9),
      p95_ms: percentile(values, 0.95),
      p99_ms: percentile(values, 0.99),
      count: values.length
    });
  }

  return out.sort((a, b) => a.run_key.localeCompare(b.run_key));
}

function drawAxes(canvas, bounds, yMax, options = {}) {
  const { left, top, right, bottom } = bounds;
  const ticks = options.ticks || 5;
  canvas.drawLine(left, top, left, bottom, COLORS.black, 2);
  canvas.drawLine(left, bottom, right, bottom, COLORS.black, 2);
  for (let i = 0; i <= ticks; i += 1) {
    const ratio = i / ticks;
    const y = bottom - ratio * (bottom - top);
    canvas.drawLine(left, y, right, y, COLORS.lightGrid, 1);
    const label = formatNumber(yMax * ratio);
    canvas.drawText(8, y - 6, label, COLORS.black, 1);
  }
}

function drawLegend(canvas, labels, colors, x, y) {
  for (let i = 0; i < labels.length; i += 1) {
    const yy = y + i * 18;
    canvas.fillRect(x, yy + 2, 12, 12, colors[i], 0);
    canvas.drawText(x + 18, yy + 2, shortLabel(labels[i], 28), COLORS.black, 1);
  }
}

function drawLineChart(filePath, title, series, options = {}) {
  const canvas = new Canvas(1400, 900);
  const bounds = { left: 90, top: 80, right: 1320, bottom: 790 };

  canvas.drawText(90, 24, title, COLORS.black, 2);

  const points = [];
  for (const item of series) {
    for (const point of item.points) points.push(point);
  }
  if (!points.length) {
    canvas.drawText(560, 420, "NO DATA", COLORS.gray, 3);
    canvas.savePng(filePath);
    return;
  }

  let minX = Math.min(...points.map((p) => p.x));
  let maxX = Math.max(...points.map((p) => p.x));
  let minY = Math.min(...points.map((p) => p.y));
  let maxY = Math.max(...points.map((p) => p.y));
  if (options.minY !== undefined) minY = options.minY;
  if (options.maxY !== undefined) maxY = options.maxY;
  if (minX === maxX) maxX += 1;
  if (minY === maxY) maxY += 1;
  const ySpan = maxY - minY;
  const yTop = maxY + ySpan * 0.05;
  drawAxes(canvas, bounds, yTop, { ticks: 5 });

  const xToPixel = (x) => bounds.left + ((x - minX) / (maxX - minX)) * (bounds.right - bounds.left);
  const yToPixel = (y) => bounds.bottom - ((y - minY) / (yTop - minY)) * (bounds.bottom - bounds.top);

  for (let i = 0; i < series.length; i += 1) {
    const item = series[i];
    const color = item.color;
    const cleanPoints = item.points.slice().sort((a, b) => a.x - b.x);
    for (let j = 1; j < cleanPoints.length; j += 1) {
      canvas.drawLine(
        xToPixel(cleanPoints[j - 1].x),
        yToPixel(cleanPoints[j - 1].y),
        xToPixel(cleanPoints[j].x),
        yToPixel(cleanPoints[j].y),
        color,
        2
      );
    }
    for (const point of cleanPoints) {
      canvas.fillRect(xToPixel(point.x) - 2, yToPixel(point.y) - 2, 4, 4, color);
    }
  }

  const labels = series.map((item) => item.label);
  const colors = series.map((item) => item.color);
  drawLegend(canvas, labels, colors, 930, 100);

  canvas.drawText(90, 820, options.xLabel || "TIME", COLORS.black, 1);
  canvas.drawText(90, 50, options.yLabel || "VALUE", COLORS.black, 1);
  canvas.savePng(filePath);
}

function drawBarChart(filePath, title, categories, series, options = {}) {
  const canvas = new Canvas(1400, 900);
  const bounds = { left: 90, top: 80, right: 1320, bottom: 790 };

  canvas.drawText(90, 24, title, COLORS.black, 2);

  if (!categories.length || !series.length) {
    canvas.drawText(560, 420, "NO DATA", COLORS.gray, 3);
    canvas.savePng(filePath);
    return;
  }

  let yMax = 0;
  for (const item of series) {
    for (const value of item.values) {
      yMax = Math.max(yMax, toNumber(value, 0));
    }
  }
  if (options.stacked) {
    yMax = 0;
    for (let i = 0; i < categories.length; i += 1) {
      let stack = 0;
      for (const item of series) stack += toNumber(item.values[i], 0);
      yMax = Math.max(yMax, stack);
    }
  }
  yMax = yMax <= 0 ? 1 : yMax * 1.1;

  drawAxes(canvas, bounds, yMax, { ticks: 5 });

  const plotWidth = bounds.right - bounds.left;
  const groupWidth = plotWidth / categories.length;
  const yToPixel = (y) => bounds.bottom - (y / yMax) * (bounds.bottom - bounds.top);

  for (let i = 0; i < categories.length; i += 1) {
    const gx = bounds.left + i * groupWidth;
    const label = shortLabel(categories[i], 11).toUpperCase();
    canvas.drawText(gx + 4, bounds.bottom + 12, label, COLORS.black, 1);

    if (options.stacked) {
      let acc = 0;
      const bw = Math.max(8, groupWidth * 0.65);
      for (let s = 0; s < series.length; s += 1) {
        const value = toNumber(series[s].values[i], 0);
        const color = series[s].color;
        const y1 = yToPixel(acc);
        const y2 = yToPixel(acc + value);
        canvas.fillRect(gx + (groupWidth - bw) / 2, y2, bw, Math.max(1, y1 - y2), color);
        acc += value;
      }
    } else {
      const bw = Math.max(4, (groupWidth * 0.8) / series.length);
      for (let s = 0; s < series.length; s += 1) {
        const value = toNumber(series[s].values[i], 0);
        const color = series[s].color;
        const x = gx + groupWidth * 0.1 + s * bw;
        const y = yToPixel(value);
        canvas.fillRect(x, y, bw - 1, Math.max(1, bounds.bottom - y), color);
      }
    }
  }

  drawLegend(
    canvas,
    series.map((item) => item.label),
    series.map((item) => item.color),
    930,
    100
  );

  canvas.drawText(90, 820, options.xLabel || "CATEGORY", COLORS.black, 1);
  canvas.drawText(90, 50, options.yLabel || "VALUE", COLORS.black, 1);
  canvas.savePng(filePath);
}

function buildPlots(datasets, plotsDir) {
  const runKeys = datasets.runMeta.map((row) => row.run_key);
  const keyToColor = new Map();
  runKeys.forEach((key, index) => {
    keyToColor.set(key, PALETTE[index % PALETTE.length]);
  });

  const minTs = datasets.memorySnapshots.length
    ? datasets.memorySnapshots[0].timestamp_ms
    : (datasets.tokenCumulative[0]?.timestamp_ms || Date.now());

  const memorySeries = runKeys.map((key) => {
    const points = datasets.memorySnapshots
      .filter((row) => row.run_key === key)
      .map((row) => ({
        x: (row.timestamp_ms - minTs) / 3600000,
        y: row.total_items
      }));
    return { label: key, points, color: keyToColor.get(key) };
  });
  drawLineChart(
    path.join(plotsDir, "memory_size_over_time.png"),
    "MEMORY SIZE OVER TIME",
    memorySeries,
    { xLabel: "TIME (HOURS)", yLabel: "ITEM COUNT", minY: 0 }
  );

  const tokenSeries = runKeys.map((key) => {
    const points = datasets.tokenCumulative
      .filter((row) => row.run_key === key)
      .map((row) => ({
        x: (row.timestamp_ms - minTs) / 3600000,
        y: row.cumulative_token_total
      }));
    return { label: key, points, color: keyToColor.get(key) };
  });
  drawLineChart(
    path.join(plotsDir, "token_usage_over_time.png"),
    "TOKEN USAGE OVER TIME",
    tokenSeries,
    { xLabel: "TIME (HOURS)", yLabel: "CUMULATIVE TOKENS", minY: 0 }
  );

  const configIds = Array.from(new Set(datasets.runMeta.map((row) => row.config_id))).sort();
  const allLatencies = datasets.latencyRows.map((row) => row.latency_ms).filter((n) => n > 0);
  const bins = 16;
  const minLatency = allLatencies.length ? Math.min(...allLatencies) : 0;
  const maxLatency = allLatencies.length ? Math.max(...allLatencies) : 1;
  const span = maxLatency - minLatency || 1;
  const categories = [];
  for (let i = 0; i < bins; i += 1) {
    const start = minLatency + (i * span) / bins;
    const end = minLatency + ((i + 1) * span) / bins;
    categories.push(`${Math.round(start)}-${Math.round(end)}`);
  }
  const histogramSeries = configIds.map((configId, index) => {
    const values = new Array(bins).fill(0);
    const latencies = datasets.latencyRows
      .filter((row) => row.config_id === configId)
      .map((row) => row.latency_ms)
      .filter((n) => n > 0);
    for (const latency of latencies) {
      const ratio = (latency - minLatency) / span;
      let bin = Math.floor(ratio * bins);
      if (bin < 0) bin = 0;
      if (bin >= bins) bin = bins - 1;
      values[bin] += 1;
    }
    return {
      label: configId,
      values,
      color: PALETTE[index % PALETTE.length]
    };
  });
  drawBarChart(
    path.join(plotsDir, "latency_distribution.png"),
    "LATENCY DISTRIBUTION",
    categories,
    histogramSeries,
    { xLabel: "LATENCY BINS (MS)", yLabel: "REQUEST COUNT" }
  );

  const latencyPercentileCats = datasets.latencyPercentiles.map((row) => row.run_key);
  drawBarChart(
    path.join(plotsDir, "latency_percentiles.png"),
    "LATENCY PERCENTILES",
    latencyPercentileCats,
    [
      { label: "P50", values: datasets.latencyPercentiles.map((row) => row.p50_ms), color: COLORS.blue },
      { label: "P90", values: datasets.latencyPercentiles.map((row) => row.p90_ms), color: COLORS.amber },
      { label: "P95", values: datasets.latencyPercentiles.map((row) => row.p95_ms), color: COLORS.red }
    ],
    { xLabel: "RUN", yLabel: "LATENCY (MS)" }
  );

  const lifecycleCats = ["delete", "compact", "promote", "retain"];
  const lifecycleSeries = runKeys.map((key) => {
    const rows = datasets.lifecycleRows.filter((row) => row.run_key === key);
    const counts = new Map(lifecycleCats.map((cat) => [cat, 0]));
    for (const row of rows) {
      if (counts.has(row.action)) {
        counts.set(row.action, counts.get(row.action) + 1);
      }
    }
    return {
      label: key,
      values: lifecycleCats.map((cat) => counts.get(cat)),
      color: keyToColor.get(key)
    };
  });
  drawBarChart(
    path.join(plotsDir, "lifecycle_action_frequency.png"),
    "LIFECYCLE ACTION FREQUENCY",
    lifecycleCats,
    lifecycleSeries,
    { xLabel: "ACTION", yLabel: "EVENT COUNT" }
  );

  const valueBuckets = ["null", "lt_0", "0_0.25", "0.25_0.5", "0.5_0.75", "0.75_1", "gte_1"];
  const latestSnapshotByRun = new Map();
  for (const snapshot of datasets.memorySnapshots) {
    latestSnapshotByRun.set(snapshot.run_key, snapshot);
  }
  const memoryValueSeries = valueBuckets.map((bucket, idx) => ({
    label: bucket,
    values: runKeys.map((key) => {
      const snapshot = latestSnapshotByRun.get(key);
      return toNumber(snapshot?.value_distribution?.[bucket], 0);
    }),
    color: PALETTE[idx % PALETTE.length]
  }));
  drawBarChart(
    path.join(plotsDir, "memory_value_distribution.png"),
    "MEMORY VALUE DISTRIBUTION (LATEST SNAPSHOT)",
    runKeys,
    memoryValueSeries,
    { xLabel: "RUN", yLabel: "ITEM COUNT", stacked: true }
  );

  drawBarChart(
    path.join(plotsDir, "retrieval_usage_proxy.png"),
    "RETRIEVAL USAGE PROXY",
    datasets.runSummary.map((row) => row.run_key),
    [
      {
        label: "USED RATIO",
        values: datasets.runSummary.map((row) => row.retrieval_used_ratio),
        color: COLORS.teal
      }
    ],
    { xLabel: "RUN", yLabel: "USED / RETRIEVED" }
  );
}

function formatNumber(value, digits = 2) {
  const n = toNumber(value, 0);
  return Number.isFinite(n) ? n.toFixed(digits) : "0.00";
}

function writeSummaryMarkdown(filePath, inputPath, datasets, totalEvents) {
  const lines = [];
  lines.push("# Telemetry Analysis Summary");
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Source: \`${inputPath}\``);
  lines.push(`- Total events: ${toNumber(totalEvents, 0)}`);
  lines.push(`- Configurations: ${datasets.configSummary.length}`);
  lines.push(`- Runs: ${datasets.runMeta.length}`);
  lines.push("");

  lines.push("## Configuration Comparison");
  lines.push("");
  lines.push("| Config | Runs | Requests | p50 ms | p95 ms | Tokens | Retrieval Used Ratio |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const row of datasets.configSummary) {
    lines.push(
      `| ${row.config_id} | ${row.run_count} | ${row.request_count} | ${formatNumber(row.latency_p50_ms)} | ${formatNumber(row.latency_p95_ms)} | ${Math.round(row.tokens_total)} | ${formatNumber(row.retrieval_used_ratio)} |`
    );
  }
  lines.push("");

  lines.push("## Run Comparison");
  lines.push("");
  lines.push("| Run | Requests | p50 ms | p95 ms | Tokens | Memory Items (Last) | Retrieval Used Ratio |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const row of datasets.runSummary) {
    lines.push(
      `| ${row.run_key} | ${row.request_count} | ${formatNumber(row.latency_p50_ms)} | ${formatNumber(row.latency_p95_ms)} | ${Math.round(row.tokens_total)} | ${Math.round(row.final_memory_items)} | ${formatNumber(row.retrieval_used_ratio)} |`
    );
  }
  lines.push("");

  lines.push("## Output Artifacts");
  lines.push("");
  lines.push("- `csv/` contains clean plotting tables and summaries.");
  lines.push("- `plots/` contains PNG plots for trends/distributions.");
  lines.push("- This markdown file summarizes cross-configuration results.");
  lines.push("");

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outDir = path.resolve(args.outDir);
  const csvDir = path.join(outDir, "csv");
  const plotsDir = path.join(outDir, "plots");

  fs.mkdirSync(csvDir, { recursive: true });
  fs.mkdirSync(plotsDir, { recursive: true });

  const events = loadEvents(inputPath);
  const datasets = buildDatasets(events);

  writeCsv(path.join(csvDir, "memory_size_over_time.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "total_items",
    "approx_tokens"
  ], datasets.memorySnapshots);

  writeCsv(path.join(csvDir, "token_usage_over_time.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "request_id",
    "token_kind",
    "token_input",
    "token_output",
    "token_prompt",
    "token_total",
    "cumulative_token_total",
    "source"
  ], datasets.tokenCumulative);

  writeCsv(path.join(csvDir, "latency_requests.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "request_id",
    "method",
    "path",
    "status",
    "latency_ms"
  ], datasets.latencyRows);

  writeCsv(path.join(csvDir, "latency_percentiles.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "p50_ms",
    "p90_ms",
    "p95_ms",
    "p99_ms",
    "count"
  ], datasets.latencyPercentiles);

  writeCsv(path.join(csvDir, "lifecycle_actions.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "request_id",
    "action",
    "reason",
    "status",
    "memory_id",
    "item_type",
    "source"
  ], datasets.lifecycleRows);

  writeCsv(path.join(csvDir, "memory_values.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "bucket",
    "count"
  ], datasets.valueRows);

  writeCsv(path.join(csvDir, "memory_types.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "item_type",
    "count"
  ], datasets.typeRows);

  writeCsv(path.join(csvDir, "retrieval_usage_proxy.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "timestamp",
    "tenant_id",
    "request_id",
    "operation",
    "retrieved_count",
    "used_count",
    "used_ratio"
  ], datasets.proxyRows);

  writeCsv(path.join(csvDir, "summary_runs.csv"), [
    "run_key",
    "config_id",
    "run_id",
    "request_count",
    "latency_avg_ms",
    "latency_p50_ms",
    "latency_p90_ms",
    "latency_p95_ms",
    "latency_p99_ms",
    "tokens_total",
    "tokens_embedding",
    "tokens_generation",
    "prompts_count",
    "prompt_tokens_est_avg",
    "lifecycle_delete",
    "lifecycle_compact",
    "lifecycle_promote",
    "lifecycle_retain",
    "retrieval_requests",
    "retrieved_total",
    "used_total",
    "retrieval_used_ratio",
    "final_memory_items",
    "final_memory_tokens_est"
  ], datasets.runSummary);

  writeCsv(path.join(csvDir, "summary_configs.csv"), [
    "config_id",
    "run_count",
    "request_count",
    "latency_avg_ms",
    "latency_p50_ms",
    "latency_p90_ms",
    "latency_p95_ms",
    "latency_p99_ms",
    "tokens_total",
    "tokens_embedding",
    "tokens_generation",
    "lifecycle_delete",
    "lifecycle_compact",
    "lifecycle_promote",
    "lifecycle_retain",
    "retrieved_total",
    "used_total",
    "retrieval_used_ratio",
    "final_memory_items_avg",
    "final_memory_tokens_est_avg"
  ], datasets.configSummary);

  writeCsv(path.join(csvDir, "events_clean.csv"), [
    "timestamp",
    "config_id",
    "run_id",
    "tenant_id",
    "request_id",
    "event_type"
  ], events.map((event) => ({
    timestamp: event.timestamp,
    config_id: event.config_id,
    run_id: event.run_id,
    tenant_id: event.tenant_id,
    request_id: event.request_id,
    event_type: event.event_type
  })));

  buildPlots(datasets, plotsDir);
  writeSummaryMarkdown(path.join(outDir, "summary.md"), inputPath, datasets, events.length);

  console.log(`Telemetry analysis complete.
Input: ${inputPath}
Output: ${outDir}
CSV: ${csvDir}
Plots: ${plotsDir}`);
}

main();

#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
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

function cleanPath(pathValue) {
  return String(pathValue || "").split("?")[0] || "";
}

async function main() {
  const args = parseArgs(process.argv);
  const input = String(args.input || "").trim();
  if (!input) {
    throw new Error("Usage: node scripts/filter_health_events.js --input /app/telemetry/events_ttl_amvl_lru.ndjson");
  }

  const tmp = `${input}.tmp`;
  fs.mkdirSync(path.dirname(input), { recursive: true });

  const inStream = fs.createReadStream(input, { encoding: "utf8" });
  const outStream = fs.createWriteStream(tmp, { flags: "w", encoding: "utf8" });
  const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });

  let kept = 0;
  let dropped = 0;

  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) continue;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      // Keep malformed lines untouched; summary script will catch invalid JSON later.
      outStream.write(`${raw}\n`);
      kept += 1;
      continue;
    }

    const eventType = String(event.event_type || "");
    const p = cleanPath(event.path);
    const isHealthRequest = (eventType === "request_start" || eventType === "request_finish")
      && (p === "/health" || p === "/v1/health");

    if (isHealthRequest) {
      dropped += 1;
      continue;
    }

    outStream.write(`${JSON.stringify(event)}\n`);
    kept += 1;
  }

  await new Promise((resolve, reject) => {
    outStream.end((err) => (err ? reject(err) : resolve()));
  });

  fs.renameSync(tmp, input);
  console.log(`[filter] kept=${kept} dropped_health=${dropped} file=${input}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

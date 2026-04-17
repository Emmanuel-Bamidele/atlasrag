#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const {
  evaluateRetrievalCases
} = require("../retrieval_eval");

function resolveFixturePath(cliPath) {
  const candidates = [
    cliPath,
    path.join(__dirname, "..", "..", "experiments", "fixtures", "retrieval_correctness_cases.json"),
    path.join(__dirname, "..", "experiments", "fixtures", "retrieval_correctness_cases.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`retrieval evaluation fixture not found; tried: ${candidates.join(", ")}`);
}

function readFlag(name) {
  const argv = process.argv.slice(2);
  const index = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const arg = argv[index];
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  return argv[index + 1] || null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function main() {
  const fixturePath = resolveFixturePath(readFlag("--fixture"));
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const k = Number.parseInt(readFlag("--k") || String(fixture.defaultK || "5"), 10);
  const fusionMode = String(readFlag("--fusion-mode") || "rrf").trim().toLowerCase() || "rrf";
  const json = hasFlag("--json");

  const report = evaluateRetrievalCases(fixture.cases || [], {
    k,
    fusionMode
  });

  if (json) {
    console.log(JSON.stringify({
      fixturePath,
      fusionMode,
      ...report
    }, null, 2));
    return;
  }

  console.log("Retrieval correctness evaluation");
  console.log(`Fixture file: ${fixturePath}`);
  console.log(`Fusion mode: ${fusionMode}`);
  console.log("");
  console.log("Summary");
  console.log(`- recall@${k}: ${formatPercent(report.summary.recallAtK)}`);
  console.log(`- MRR: ${report.summary.mrr.toFixed(3)}`);
  console.log(`- nDCG@${k}: ${report.summary.ndcgAtK.toFixed(3)}`);
  console.log(`- evidence hit rate: ${formatPercent(report.summary.evidenceHitRate)}`);
  console.log(`- latency avg/p50/p95: ${report.summary.latencyMsAvg.toFixed(3)}ms / ${report.summary.latencyMsP50.toFixed(3)}ms / ${report.summary.latencyMsP95.toFixed(3)}ms`);
  console.log("");
  console.log("Per-case results");
  for (const testCase of report.cases) {
    console.log(`- ${testCase.name}: top=${testCase.topChunkIds[0] || "none"} rank=${testCase.relevantRank || "miss"} recall=${testCase.recallAtK.toFixed(2)} ndcg=${testCase.ndcgAtK.toFixed(3)} latency=${testCase.latencyMs.toFixed(3)}ms`);
  }
}

main();

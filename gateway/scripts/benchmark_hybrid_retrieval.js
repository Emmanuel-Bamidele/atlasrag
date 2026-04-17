#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "benchmark-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "benchmark-jwt-secret";

const __testHooks = require("../hybrid_retrieval");

function resolveFixturePath() {
  const candidates = [
    path.join(__dirname, "..", "..", "experiments", "fixtures", "hybrid_retrieval_cases.json"),
    path.join(__dirname, "..", "experiments", "fixtures", "hybrid_retrieval_cases.json")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`hybrid retrieval fixture not found; tried: ${candidates.join(", ")}`);
}

const fixturePath = resolveFixturePath();
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")).cases || [];

function buildCandidates(testCase) {
  const chunkMap = new Map();
  for (const chunk of testCase.chunks || []) {
    chunkMap.set(chunk.chunkId, {
      chunk_id: chunk.chunkId,
      doc_id: chunk.docId,
      idx: chunk.idx,
      text: chunk.text
    });
  }

  const candidates = new Map();
  function ensureCandidate(chunkId) {
    if (!candidates.has(chunkId)) {
      candidates.set(chunkId, {
        row: chunkMap.get(chunkId),
        memory: null,
        vectorScore: null,
        lexicalScore: null,
        vectorRank: null,
        lexicalRank: null
      });
    }
    return candidates.get(chunkId);
  }

  (testCase.vectorResults || []).forEach((match, index) => {
    const candidate = ensureCandidate(match.chunkId);
    candidate.vectorScore = Number(match.score);
    candidate.vectorRank = index + 1;
  });

  (testCase.lexicalResults || []).forEach((match, index) => {
    const candidate = ensureCandidate(match.chunkId);
    candidate.lexicalScore = Number(match.score);
    candidate.lexicalRank = index + 1;
  });

  return Array.from(candidates.values());
}

function rankCase(testCase, fusionMode) {
  return __testHooks.rankSearchCandidates(buildCandidates(testCase), {
    query: testCase.query,
    useHybrid: true,
    fusionMode,
    vectorWeight: 0.72,
    lexicalWeight: 0.28,
    rankConstant: 60,
    overlapBoostScale: 0.12,
    exactBoostScale: 0.08,
    recencyWeight: 0,
    recencyHalfLifeDays: 14
  });
}

function reciprocalRank(rank) {
  return Number.isFinite(rank) && rank >= 1 ? 1 / rank : 0;
}

function evaluateMode(fusionMode) {
  const rows = fixtures.map((testCase) => {
    const ranked = rankCase(testCase, fusionMode);
    const rank = ranked.findIndex((candidate) => candidate.row.chunk_id === testCase.relevantChunkId) + 1;
    return {
      name: testCase.name,
      query: testCase.query,
      topChunkId: ranked[0]?.row?.chunk_id || null,
      relevantChunkId: testCase.relevantChunkId,
      relevantRank: rank || null,
      mrr: reciprocalRank(rank)
    };
  });
  const top1 = rows.filter((row) => row.relevantRank === 1).length / rows.length;
  const mrr = rows.reduce((sum, row) => sum + row.mrr, 0) / rows.length;
  return {
    fusionMode,
    top1,
    mrr,
    rows
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function main() {
  const weighted = evaluateMode("weighted");
  const rrf = evaluateMode("rrf");

  console.log("Hybrid retrieval benchmark");
  console.log(`Fixture file: ${fixturePath}`);
  console.log("");
  console.log("Summary");
  console.log(`- weighted top1: ${formatPercent(weighted.top1)} | mrr: ${weighted.mrr.toFixed(3)}`);
  console.log(`- rrf top1: ${formatPercent(rrf.top1)} | mrr: ${rrf.mrr.toFixed(3)}`);
  console.log("");
  console.log("Per-case results");
  for (let index = 0; index < fixtures.length; index += 1) {
    const weightRow = weighted.rows[index];
    const rrfRow = rrf.rows[index];
    console.log(`- ${weightRow.name}: weighted top=${weightRow.topChunkId} rank=${weightRow.relevantRank}; rrf top=${rrfRow.topChunkId} rank=${rrfRow.relevantRank}`);
  }
}

main();

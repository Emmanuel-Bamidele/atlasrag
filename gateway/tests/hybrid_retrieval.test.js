const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const __testHooks = require("../hybrid_retrieval");

const FIXTURES = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "experiments", "fixtures", "hybrid_retrieval_cases.json"),
    "utf8"
  )
);

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
    const row = chunkMap.get(chunkId);
    if (!row) {
      throw new Error(`unknown chunk fixture id: ${chunkId}`);
    }
    if (!candidates.has(chunkId)) {
      candidates.set(chunkId, {
        row,
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

function rankFixture(testCase, options = {}) {
  return __testHooks.rankSearchCandidates(buildCandidates(testCase), {
    query: testCase.query,
    useHybrid: options.useHybrid !== undefined ? options.useHybrid : true,
    fusionMode: options.fusionMode || "rrf",
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
  return Number.isFinite(rank) ? (1 / rank) : 0;
}

function meanReciprocalRank(testCases, fusionMode) {
  const values = testCases.map((testCase) => {
    const ranked = rankFixture(testCase, { fusionMode });
    const index = ranked.findIndex((candidate) => candidate.row.chunk_id === testCase.relevantChunkId);
    return index === -1 ? 0 : reciprocalRank(index + 1);
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function testFusionModeAliasesResolveToExpectedValues() {
  assert.equal(__testHooks.resolveHybridFusionMode("rrf"), "rrf");
  assert.equal(__testHooks.resolveHybridFusionMode("weighted"), "weighted");
  assert.equal(__testHooks.resolveHybridFusionMode("normalized"), "weighted");
  assert.equal(__testHooks.resolveHybridFusionMode("unknown"), "rrf");
}

function testExactIdentifierFixturePromotesLexicalHit() {
  const testCase = FIXTURES.cases.find((item) => item.name === "exact_identifier_short");
  const ranked = rankFixture(testCase, { fusionMode: "rrf" });
  assert.equal(ranked[0].row.chunk_id, testCase.relevantChunkId);
}

function testSemanticOnlyFixtureKeepsDenseLeader() {
  const testCase = FIXTURES.cases.find((item) => item.name === "semantic_only_explanation");
  const ranked = rankFixture(testCase, { fusionMode: "rrf" });
  assert.equal(ranked[0].row.chunk_id, testCase.relevantChunkId);
}

function testMixedFixturePromotesCandidateSupportedByBothSignals() {
  const testCase = FIXTURES.cases.find((item) => item.name === "mixed_semantic_and_identifier");
  const ranked = rankFixture(testCase, { fusionMode: "rrf" });
  assert.equal(ranked[0].row.chunk_id, testCase.relevantChunkId);
}

function testHybridDisabledPreservesVectorOnlyOrdering() {
  const testCase = FIXTURES.cases.find((item) => item.name === "exact_identifier_short");
  const ranked = rankFixture(testCase, {
    useHybrid: false,
    fusionMode: "rrf"
  });
  assert.equal(ranked[0].row.chunk_id, "doc-ops#0");
  assert.equal(ranked[0].vectorNorm, 1);
  assert.equal(ranked[0].lexicalNorm, 0);
}

function testRrfImprovesFixtureMrrOverLegacyWeightedFusion() {
  const testCases = FIXTURES.cases;
  const weighted = meanReciprocalRank(testCases, "weighted");
  const rrf = meanReciprocalRank(testCases, "rrf");
  assert(rrf > weighted, `expected rrf MRR ${rrf} to exceed weighted MRR ${weighted}`);
  assert.equal(rrf, 1);
}

function main() {
  testFusionModeAliasesResolveToExpectedValues();
  testExactIdentifierFixturePromotesLexicalHit();
  testSemanticOnlyFixtureKeepsDenseLeader();
  testMixedFixturePromotesCandidateSupportedByBothSignals();
  testHybridDisabledPreservesVectorOnlyOrdering();
  testRrfImprovesFixtureMrrOverLegacyWeightedFusion();
  console.log("hybrid retrieval tests passed");
}

main();

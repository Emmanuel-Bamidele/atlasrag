const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const {
  buildFixtureCandidates,
  evaluateRetrievalCase,
  evaluateRetrievalCases
} = require("../retrieval_eval");
const {
  matchesRetrievalFilters
} = require("../retrieval_planner");

const fixturePath = path.join(__dirname, "..", "..", "experiments", "fixtures", "retrieval_correctness_cases.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function testTenantIsolationFixture() {
  const testCase = fixture.cases.find((item) => item.name === "tenant_isolation_exact_identifier");
  const report = evaluateRetrievalCase(testCase, { k: 3 });
  assert.equal(report.filteredCandidates, 1);
  assert.equal(report.topChunkIds[0], "alpha-ops-431#0");
  assert.equal(report.recallAtK, 1);
  assert.equal(report.mrr, 1);
}

function testFilterCorrectnessFixture() {
  const testCase = fixture.cases.find((item) => item.name === "filter_combo_release_window");
  const candidates = buildFixtureCandidates(testCase);
  const filtered = candidates.filter((candidate) => matchesRetrievalFilters(candidate, {
    ...testCase.filters,
    since: new Date(testCase.filters.since),
    until: new Date(testCase.filters.until)
  }));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].row.chunk_id, "release-2026-04#0");

  const report = evaluateRetrievalCase(testCase, { k: 3 });
  assert.equal(report.topChunkIds[0], "release-2026-04#0");
  assert.equal(report.filteredCandidates, 1);
}

function testRecentVsStaleRankingFixture() {
  const testCase = fixture.cases.find((item) => item.name === "recent_status_beats_stale_status");
  const report = evaluateRetrievalCase(testCase, { k: 2 });
  assert.equal(report.retrievalPlan.queryRecencySensitive, true);
  assert.equal(report.retrievalPlan.effectiveFavorRecency, true);
  assert.equal(report.topChunkIds[0], "incident-current#0");
  assert.equal(report.results[0].recencyMode, "all");
}

function testMalformedFreshnessMetadataDoesNotBreakEvaluation() {
  const testCase = {
    name: "malformed_freshness_metadata_is_ignored",
    query: "latest status",
    relevantChunkIds: ["freshness-valid#0"],
    favorRecency: true,
    filters: {
      tenantId: "tenant-a",
      collection: "ops",
      timeField: "freshness"
    },
    chunks: [
      {
        chunkId: "freshness-valid#0",
        docId: "freshness-valid",
        namespaceId: "tenant-a:ops:freshness-valid",
        tenantId: "tenant-a",
        collection: "ops",
        text: "Current status page reflects the latest incident update.",
        createdAt: "2026-04-01T00:00:00.000Z",
        metadata: {
          updatedAt: "2026-04-16T10:00:00.000Z"
        }
      },
      {
        chunkId: "freshness-invalid#0",
        docId: "freshness-invalid",
        namespaceId: "tenant-a:ops:freshness-invalid",
        tenantId: "tenant-a",
        collection: "ops",
        text: "Broken upstream metadata should not crash ranking.",
        createdAt: "2026-04-02T00:00:00.000Z",
        metadata: {
          updatedAt: "2026-99-99T00:00:00.000Z"
        }
      }
    ],
    vectorResults: [
      { chunkId: "freshness-valid#0", score: 0.72 },
      { chunkId: "freshness-invalid#0", score: 0.7 }
    ],
    lexicalResults: [
      { chunkId: "freshness-valid#0", score: 8 },
      { chunkId: "freshness-invalid#0", score: 7 }
    ]
  };
  const report = evaluateRetrievalCase(testCase, { k: 2 });
  assert.equal(report.topChunkIds[0], "freshness-valid#0");
}

function testSchemaUsesSafeFreshnessCastHelper() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  assert.match(schemaSql, /CREATE OR REPLACE FUNCTION sv_try_timestamptz/);
  assert.match(schemaSql, /memory_items_freshness_idx[\s\S]*sv_try_timestamptz/);
}

function testEvalHarnessExecution() {
  const report = evaluateRetrievalCases(fixture.cases, { k: fixture.defaultK, fusionMode: "rrf" });
  assert.equal(report.summary.cases, fixture.cases.length);
  assert.equal(report.summary.recallAtK, 1);
  assert.equal(report.summary.mrr, 1);
  assert.equal(report.summary.evidenceHitRate, 1);
  assert.ok(report.summary.ndcgAtK >= 0.99);
  assert.ok(report.summary.latencyMsAvg >= 0);
  assert.ok(report.summary.latencyMsP95 >= report.summary.latencyMsP50);

  const stdout = execFileSync(process.execPath, [
    "scripts/evaluate_retrieval.js",
    "--json"
  ], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
  const scriptReport = JSON.parse(stdout);
  assert.equal(scriptReport.summary.cases, fixture.cases.length);
  assert.equal(scriptReport.summary.recallAtK, 1);
  assert.equal(scriptReport.summary.mrr, 1);
}

function main() {
  testTenantIsolationFixture();
  testFilterCorrectnessFixture();
  testRecentVsStaleRankingFixture();
  testMalformedFreshnessMetadataDoesNotBreakEvaluation();
  testSchemaUsesSafeFreshnessCastHelper();
  testEvalHarnessExecution();
  console.log("retrieval correctness tests passed");
}

main();

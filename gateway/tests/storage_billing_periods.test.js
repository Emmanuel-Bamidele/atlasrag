const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const {
  BYTES_PER_GIB,
  splitRangeByUtcMonth,
  estimateVectorBytes,
  computeStoragePeriodSummary
} = require("../storage_billing");
const { __testHooks } = require("../index");

function assertApprox(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function testSplitRangeByUtcMonthAcrossBoundary() {
  const segments = splitRangeByUtcMonth("2026-03-31T23:30:00.000Z", "2026-04-01T01:00:00.000Z");
  assert.equal(segments.length, 2);
  assert.equal(segments[0].periodStart.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(segments[0].periodEnd.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(segments[0].elapsedSeconds, 1800);
  assert.equal(segments[1].periodStart.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(segments[1].periodEnd.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(segments[1].elapsedSeconds, 3600);
}

function testEstimateVectorBytesUsesChunkCountAndDimension() {
  assert.equal(estimateVectorBytes({ chunkCount: 3, vectorDim: 1536 }), 18432);
}

function testComputeStoragePeriodSummaryProjectsMonthlyGbMonthCharge() {
  const periodStart = new Date("2026-03-01T00:00:00.000Z");
  const periodEnd = new Date("2026-04-01T00:00:00.000Z");
  const now = new Date("2026-03-16T00:00:00.000Z");
  const elapsedSeconds = (now.getTime() - periodStart.getTime()) / 1000;
  const summary = computeStoragePeriodSummary({
    periodStart,
    periodEnd,
    byteSeconds: 2 * BYTES_PER_GIB * elapsedSeconds,
    currentBytes: 2 * BYTES_PER_GIB,
    lastAccruedAt: now,
    now,
    storagePricePerGBMonth: 0.1,
    includedGBMonth: 1.5
  });

  assertApprox(summary.averageGiBToDate, 2);
  assertApprox(summary.projectedAverageGiB, 2);
  assertApprox(summary.billableGiBMonthToDate, 0.5);
  assertApprox(summary.chargeToDate, 0.05);
  assertApprox(summary.projectedCharge, 0.05);
}

function testBuildStorageBillingSummarySeparatesCurrentAndClosedPeriods() {
  const currentNow = new Date("2026-03-16T00:00:00.000Z");
  const currentStart = new Date("2026-03-01T00:00:00.000Z");
  const currentEnd = new Date("2026-04-01T00:00:00.000Z");
  const currentElapsedSeconds = (currentNow.getTime() - currentStart.getTime()) / 1000;
  const previousStart = new Date("2026-02-01T00:00:00.000Z");
  const previousEnd = new Date("2026-03-01T00:00:00.000Z");
  const previousSeconds = (previousEnd.getTime() - previousStart.getTime()) / 1000;
  const billing = __testHooks.buildStorageBillingSummary({
    state: {
      current_bytes: 2 * BYTES_PER_GIB,
      last_accrued_at: currentNow.toISOString(),
      formula_version: "storage_v1"
    },
    currentPeriod: {
      period_start: currentStart.toISOString(),
      period_end: currentEnd.toISOString(),
      storage_byte_seconds: 2 * BYTES_PER_GIB * currentElapsedSeconds,
      closing_bytes: 2 * BYTES_PER_GIB,
      closing_chunk_text_bytes: 1024,
      closing_metadata_bytes: 2048,
      closing_vector_bytes: 4096,
      closing_vector_dim: 1536,
      formula_version: "storage_v1",
      last_event_at: currentNow.toISOString(),
      closed_at: null
    },
    recentPeriods: [
      {
        period_start: currentStart.toISOString(),
        period_end: currentEnd.toISOString(),
        storage_byte_seconds: 2 * BYTES_PER_GIB * currentElapsedSeconds,
        closing_bytes: 2 * BYTES_PER_GIB,
        closing_chunk_text_bytes: 1024,
        closing_metadata_bytes: 2048,
        closing_vector_bytes: 4096,
        closing_vector_dim: 1536,
        formula_version: "storage_v1",
        last_event_at: currentNow.toISOString(),
        closed_at: null
      },
      {
        period_start: previousStart.toISOString(),
        period_end: previousEnd.toISOString(),
        storage_byte_seconds: 1.25 * BYTES_PER_GIB * previousSeconds,
        closing_bytes: Math.round(1.25 * BYTES_PER_GIB),
        closing_chunk_text_bytes: 512,
        closing_metadata_bytes: 1024,
        closing_vector_bytes: 2048,
        closing_vector_dim: 1536,
        formula_version: "storage_v1",
        last_event_at: previousEnd.toISOString(),
        closed_at: previousEnd.toISOString()
      }
    ],
    now: currentNow,
    storagePricePerGBMonth: 0.1,
    includedGBMonth: 1
  });

  assert.equal(billing.model, "gb_month_average");
  assert.equal(billing.current.closed, false);
  assertApprox(billing.current.projectedCharge, 0.1);
  assert.equal(billing.current.components.vectorDim, 1536);
  assert.equal(billing.recentPeriods.length, 1);
  assert.equal(billing.recentPeriods[0].closed, true);
  assertApprox(billing.recentPeriods[0].charge, 0.025);
}

function main() {
  testSplitRangeByUtcMonthAcrossBoundary();
  testEstimateVectorBytesUsesChunkCountAndDimension();
  testComputeStoragePeriodSummaryProjectsMonthlyGbMonthCharge();
  testBuildStorageBillingSummarySeparatesCurrentAndClosedPeriods();
  console.log("storage billing period tests passed");
}

main();

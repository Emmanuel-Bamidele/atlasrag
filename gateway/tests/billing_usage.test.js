const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

function testComputeUsageCostsBillsOnlyBillableGenerationTokens() {
  const costs = __testHooks.computeUsageCosts({
    storageBytes: 2 * 1024 * 1024 * 1024,
    storagePricePerGB: 0.1,
    totalAiTokens: 4000,
    billableAiTokens: 1500,
    aiTokenPricePer1K: 0.002
  });

  assert.equal(costs.storageCharge, 0.2);
  assert.equal(costs.aiTokens, 4000);
  assert.equal(costs.billableAiTokens, 1500);
  assert.equal(costs.aiTokensCharge, 0.003);
}

function testGenerationHistoryEntrySkipsChargeWhenNotBillable() {
  const entry = __testHooks.buildUsageHistoryEntry({
    id: 7,
    event_kind: "generation",
    request_id: "req_123",
    billable: false,
    generation_total_tokens: 900,
    created_at: "2026-03-25T00:00:00.000Z"
  }, {
    aiTokensPer1K: 0.002
  });

  assert.equal(entry.eventKind, "generation");
  assert.equal(entry.billable, false);
  assert.equal(entry.usage.generationTotalTokens, 900);
  assert.equal(entry.charges.aiTokensCharge, 0);
}

function testStorageHistoryEntryUsesCurrentStorageTotalForCharge() {
  const entry = __testHooks.buildUsageHistoryEntry({
    id: 9,
    event_kind: "storage",
    storage_bytes_delta: 128,
    storage_bytes_total: 1024 * 1024 * 1024,
    storage_chunks_total: 12,
    storage_documents_total: 3,
    storage_memory_items_total: 7,
    storage_collections_total: 2,
    created_at: "2026-03-25T00:00:00.000Z"
  }, {
    storagePerGB: 0.1
  });

  assert.equal(entry.eventKind, "storage");
  assert.equal(entry.usage.storageBytesDelta, 128);
  assert.equal(entry.usage.storageBytesTotal, 1024 * 1024 * 1024);
  assert.equal(entry.charges.storageCharge, 0.1);
  assert.equal(entry.charges.aiTokensCharge, 0);
}

function main() {
  testComputeUsageCostsBillsOnlyBillableGenerationTokens();
  testGenerationHistoryEntrySkipsChargeWhenNotBillable();
  testStorageHistoryEntryUsesCurrentStorageTotalForCharge();
  console.log("billing usage tests passed");
}

main();

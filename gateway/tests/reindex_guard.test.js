const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

function testSkipsWhenVectorStoreMatchesCurrentChunksAndDims() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 17,
    vectorDims: 3072,
    expectedVectorDim: 3072
  });

  assert.equal(decision.shouldReindex, false);
  assert.equal(decision.clearFirst, false);
  assert.equal(decision.reason, "up_to_date");
}

function testReindexesOnDimensionMismatch() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 17,
    vectorDims: 1536,
    expectedVectorDim: 3072
  });

  assert.equal(decision.shouldReindex, true);
  assert.equal(decision.clearFirst, true);
  assert.equal(decision.reason, "dimension_mismatch");
}

function testReindexesOnPartialVectorStore() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 11,
    vectorDims: 1536,
    expectedVectorDim: 1536
  });

  assert.equal(decision.shouldReindex, true);
  assert.equal(decision.clearFirst, true);
  assert.equal(decision.reason, "count_mismatch");
}

function testReindexesWhenStaleVectorsExistWithoutChunks() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 0,
    vectorCount: 12,
    vectorDims: 1536,
    expectedVectorDim: 1536
  });

  assert.equal(decision.shouldReindex, true);
  assert.equal(decision.clearFirst, true);
  assert.equal(decision.reason, "count_mismatch");
}

function main() {
  testSkipsWhenVectorStoreMatchesCurrentChunksAndDims();
  testReindexesOnDimensionMismatch();
  testReindexesOnPartialVectorStore();
  testReindexesWhenStaleVectorsExistWithoutChunks();
  console.log("reindex guard tests passed");
}

main();

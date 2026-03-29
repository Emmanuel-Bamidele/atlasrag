const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testSplitIntoBatches() {
  const batches = __testHooks.splitIntoBatches([1, 2, 3, 4, 5], 2);
  assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
}

function testVectorReplyClassification() {
  assert.equal(__testHooks.isVectorCommandReplyOk("OK updated"), true);
  assert.equal(__testHooks.isVectorCommandReplyOk("1"), true);
  assert.equal(__testHooks.isVectorCommandReplyOk("ERR bad command"), false);
  assert.equal(__testHooks.isVectorCommandReplyOk(""), false);
}

async function testRunBatchedCommandSetPreservesOrder() {
  let active = 0;
  let maxActive = 0;

  const results = await __testHooks.runBatchedCommandSet(
    ["a", "b", "c", "d", "e"],
    {
      batchSize: 2,
      concurrency: 2,
      runBatch: async (batch) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(batch[0] === "a" ? 15 : 5);
        active -= 1;
        return batch.map((item) => `ok:${item}`);
      }
    }
  );

  assert.deepEqual(
    results.map((item) => ({ ok: item.ok, reply: item.reply })),
    [
      { ok: true, reply: "ok:a" },
      { ok: true, reply: "ok:b" },
      { ok: true, reply: "ok:c" },
      { ok: true, reply: "ok:d" },
      { ok: true, reply: "ok:e" }
    ]
  );
  assert.ok(maxActive <= 2, `expected concurrency <= 2, got ${maxActive}`);
}

async function testRunBatchedCommandSetMarksBatchFailures() {
  const results = await __testHooks.runBatchedCommandSet(
    ["a", "b", "c", "d"],
    {
      batchSize: 2,
      concurrency: 1,
      runBatch: async (batch) => {
        if (batch.includes("c")) {
          throw new Error("boom");
        }
        return batch.map((item) => `ok:${item}`);
      }
    }
  );

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, false);
  assert.equal(results[3].ok, false);
  assert.match(String(results[2].error?.message || ""), /boom/);
}

async function testRunBatchedCommandSetMarksErrRepliesAsFailures() {
  const results = await __testHooks.runBatchedCommandSet(
    ["a", "b", "c"],
    {
      batchSize: 3,
      concurrency: 1,
      runBatch: async () => ["OK updated", "ERR bad command", "1"]
    }
  );

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(String(results[1].reply || ""), /ERR bad command/);
  assert.equal(results[2].ok, true);
}

async function main() {
  testSplitIntoBatches();
  testVectorReplyClassification();
  await testRunBatchedCommandSetPreservesOrder();
  await testRunBatchedCommandSetMarksBatchFailures();
  await testRunBatchedCommandSetMarksErrRepliesAsFailures();
  console.log("vector batching tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

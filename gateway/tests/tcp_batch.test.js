const assert = require("assert/strict");

const { __testHooks } = require("../tcp");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testExtractReplyLinesWithRemainder() {
  const parsed = __testHooks.extractReplyLines("OK new\r\n1\npartial");
  assert.deepEqual(parsed.lines, ["OK new", "1"]);
  assert.equal(parsed.remainder, "partial");
}

function testExtractReplyLinesHandlesMultipleChunks() {
  const first = __testHooks.extractReplyLines("OK updated\nERR bad");
  assert.deepEqual(first.lines, ["OK updated"]);
  assert.equal(first.remainder, "ERR bad");

  const second = __testHooks.extractReplyLines(first.remainder + "\n0\n");
  assert.deepEqual(second.lines, ["ERR bad", "0"]);
  assert.equal(second.remainder, "");
}

async function testInactivityTimerExtendsDeadlineOnProgress() {
  let fired = 0;
  const timer = __testHooks.createInactivityTimer(25, () => {
    fired += 1;
  });

  timer.start();
  await sleep(15);
  timer.bump();
  await sleep(15);
  assert.equal(fired, 0);
  await sleep(20);
  assert.equal(fired, 1);
  timer.clear();
}

async function main() {
  testExtractReplyLinesWithRemainder();
  testExtractReplyLinesHandlesMultipleChunks();
  await testInactivityTimerExtendsDeadlineOnProgress();
  console.log("tcp batch tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

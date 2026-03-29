const assert = require("assert/strict");

const { __testHooks } = require("../tcp");

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

function main() {
  testExtractReplyLinesWithRemainder();
  testExtractReplyLinesHandlesMultipleChunks();
  console.log("tcp batch tests passed");
}

main();

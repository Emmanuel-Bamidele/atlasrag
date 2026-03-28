const assert = require("assert");
const { chunkText } = require("../chunk");

function toTokens(text) {
  return String(text || "").split(/\s+/).filter(Boolean);
}

(() => {
  const chunks = chunkText("doc-empty", "   ", { strategy: "token", maxTokens: 8, overlapTokens: 2 });
  assert.deepStrictEqual(chunks, [], "empty text should produce no chunks");
})();

(() => {
  const input = [
    "Paragraph one has enough text to chunk cleanly when max chars are small.",
    "Paragraph two continues the same topic so boundary handling can be verified."
  ].join("\n\n");
  const chunks = chunkText("doc-char", input, { strategy: "char", maxChars: 60 });

  assert.ok(chunks.length >= 2, "char strategy should split long content");
  for (const item of chunks) {
    assert.ok(item.chunkId.startsWith("doc-char#"), "chunk id must include doc prefix");
    assert.ok(item.text.length <= 60, "char chunks must respect maxChars");
  }
})();

(() => {
  const words = Array.from({ length: 30 }, (_, i) => `w${i + 1}`);
  const text = words.join(" ");
  const chunks = chunkText("doc-token", text, {
    strategy: "token",
    maxTokens: 10,
    overlapTokens: 3
  });

  assert.strictEqual(chunks.length, 4, "token strategy should produce expected sliding windows");
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = toTokens(chunks[i - 1].text);
    const next = toTokens(chunks[i].text);
    const tail = prev.slice(prev.length - 3).join(" ");
    const head = next.slice(0, 3).join(" ");
    assert.strictEqual(head, tail, "adjacent token chunks should overlap by configured token count");
  }
})();

(() => {
  const text = Array.from({ length: 12 }, (_, i) => `t${i + 1}`).join(" ");
  const chunks = chunkText("doc-clamp", text, {
    strategy: "token",
    maxTokens: 6,
    overlapTokens: 99
  });
  assert.ok(chunks.length > 1, "overlap clamping should still make progress and produce multiple chunks");
})();

(() => {
  const code = [
    "function alpha() {",
    "  const first = 1;",
    "  return first;",
    "}",
    "",
    "function beta() {",
    "  const second = 2;",
    "  return second;",
    "}",
    "",
    "class Gamma {",
    "  value() {",
    "    return 3;",
    "  }",
    "}"
  ].join("\n");

  const chunks = chunkText("doc-code", code, {
    strategy: "code",
    maxTokens: 8,
    overlapTokens: 0
  });

  assert.ok(chunks.length >= 2, "code strategy should split multi-symbol source");
  assert.ok(chunks.some((item) => item.text.includes("function alpha")), "expected alpha chunk");
  assert.ok(chunks.some((item) => item.text.includes("function beta")), "expected beta chunk");
  assert.ok(chunks.some((item) => item.text.includes("class Gamma")), "expected class chunk");
})();

console.log("chunking_strategy tests passed");

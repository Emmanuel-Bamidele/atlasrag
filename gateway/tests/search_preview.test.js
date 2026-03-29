const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

function testBuildSearchPreviewCentersExactMatch() {
  const text = [
    "Long-form diagnostic file for retrieval validation.",
    "Background section one adds setup details.",
    "Background section two adds more filler content.",
    "Critical final note: The release freeze codename is Copper Lantern."
  ].join(" ");

  const preview = __testHooks.buildSearchPreview(text, "Copper Lantern", 120);
  assert.match(preview, /Copper Lantern/);
  assert.match(preview, /^…/);
}

function testBuildSearchPreviewFallsBackToLeadingSnippet() {
  const text = "SupaVector stores memory for agents and retrieves grounded evidence from indexed chunks.";
  const preview = __testHooks.buildSearchPreview(text, "missing query", 60);
  assert.match(preview, /^SupaVector stores memory for agents and retrieves grounded/);
  assert.match(preview, /…$/);
}

function main() {
  testBuildSearchPreviewCentersExactMatch();
  testBuildSearchPreviewFallsBackToLeadingSnippet();
  console.log("search preview tests passed");
}

main();

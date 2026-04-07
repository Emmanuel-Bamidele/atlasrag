const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

function testNormalizesWikiPages() {
  assert.deepEqual(
    __testHooks.normalizeConversationWikiPagesInput(["facts", "open_loops", "facts"]),
    ["facts", "open_loops"]
  );
}

function testBuildsConversationWikiPageText() {
  const built = __testHooks.buildConversationWikiPageText("facts", {
    confirmed: ["Ada prefers monthly billing."],
    uncertain: ["Migration timing is unclear."],
    open: ["Confirm the billing contact."]
  }, 400);
  assert.match(built.text, /Conversation Facts/);
  assert.equal(built.itemCount, 3);
}

function testParsesConversationWikiResponse() {
  const parsed = __testHooks.parseConversationWikiResponse(JSON.stringify({
    facts: {
      confirmed: ["Ada prefers monthly billing."],
      uncertain: [],
      open: []
    }
  }));
  assert.deepEqual(parsed.facts.confirmed, ["Ada prefers monthly billing."]);
  assert.deepEqual(parsed.preferences.confirmed, []);
}

function testFormatsConversationWikiAuditFields() {
  const formatted = __testHooks.formatConversationWikiItem({
    metadata: {
      page: "facts",
      revision: 3,
      checkpointTurnExternalId: "turn-42",
      itemCount: 2,
      updatedAt: "2026-04-06T12:00:00.000Z",
      updatedBySource: "conversation_wiki_manual",
      sections: {
        confirmed: ["Ada prefers monthly billing."],
        uncertain: [],
        open: ["Confirm billing contact email."]
      }
    },
    created_at: "2026-04-05T12:00:00.000Z",
    source_type: "conversation_wiki"
  }, "Conversation Facts\n\n## Confirmed\n- Ada prefers monthly billing.");
  assert.equal(formatted.updatedAt, "2026-04-06T12:00:00.000Z");
  assert.equal(formatted.updatedBySource, "conversation_wiki_manual");
  assert.equal(__testHooks.getConversationWikiLastUpdatedAt([formatted]), "2026-04-06T12:00:00.000Z");
}

function main() {
  testNormalizesWikiPages();
  testBuildsConversationWikiPageText();
  testParsesConversationWikiResponse();
  testFormatsConversationWikiAuditFields();
  console.log("conversation wiki tests passed");
}

main();

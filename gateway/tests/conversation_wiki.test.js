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

async function testConversationWikiJobRetryableFailureRequeues() {
  const updates = [];
  const scheduled = [];
  const result = await __testHooks.finalizeJobFailureWithDeps({
    updateMemoryJob: async (payload) => {
      updates.push(payload);
      return payload;
    },
    computeJobBackoff: () => 250,
    scheduleRetry: (fn, delay) => {
      scheduled.push({ fn, delay });
    },
    dispatchMemoryJob: async () => {}
  }, {
    id: "job-1",
    tenant_id: "tenant-1",
    job_type: "conversation_wiki_update",
    attempts: 0,
    max_attempts: 3
  }, new Error("temporary wiki failure"));

  assert.equal(result.retried, true);
  assert.equal(result.attempts, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "queued");
  assert.equal(updates[0].attempts, 1);
  assert.ok(updates[0].nextRunAt instanceof Date);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 250);
}

async function testConversationWikiEnqueueDedupesConcurrentRequests() {
  let createCalls = 0;
  const active = { id: "job-active", status: "queued" };
  const first = await __testHooks.enqueueConversationWikiUpdateJobWithDeps({
    findActiveConversationWikiJob: async () => active,
    createMemoryJob: async () => {
      createCalls += 1;
      return { id: "job-created", status: "queued" };
    }
  }, {
    tenantId: "tenant-1",
    collection: "__brain_conv_test",
    conversationId: "conv-1",
    pages: ["facts", "preferences"]
  });
  assert.equal(first, active);
  assert.equal(createCalls, 0);

  const second = await __testHooks.enqueueConversationWikiUpdateJobWithDeps({
    findActiveConversationWikiJob: async () => null,
    createMemoryJob: async (payload) => {
      createCalls += 1;
      return {
        id: "job-created",
        status: payload.status,
        input: payload.input
      };
    }
  }, {
    tenantId: "tenant-1",
    collection: "__brain_conv_test",
    conversationId: "conv-1",
    pages: ["facts", "preferences"],
    keepRecentTurns: 6,
    updateEveryTurns: 4,
    baseTags: ["conversation:conv-1"]
  });

  assert.equal(second.id, "job-created");
  assert.equal(second.status, "queued");
  assert.deepEqual(second.input.pages, ["facts", "preferences"]);
  assert.equal(second.input.keepRecentTurns, 6);
  assert.equal(second.input.updateEveryTurns, 4);
  assert.deepEqual(second.input.baseTags, ["conversation:conv-1"]);
  assert.equal(createCalls, 1);
}

async function testPrunesConversationTailAndCountsQueuedDeletes() {
  const deletedIds = [];
  const result = await __testHooks.pruneConversationTurnsForWikiWithDeps({
    getMemoryItemByExternalId: async () => ({ created_at: "2026-04-06T10:00:00.000Z" }),
    listConversationTurnItemsForPrune: async ({ beforeCreatedAt, keepRecentTurns }) => {
      assert.equal(beforeCreatedAt, "2026-04-06T10:00:00.000Z");
      assert.equal(keepRecentTurns, 2);
      return [
        { id: "turn-1" },
        { id: "turn-2" },
        { id: "turn-3" }
      ];
    },
    deleteMemoryItemFully: async (item, options) => {
      deletedIds.push({ id: item.id, reason: options.reason });
      if (item.id === "turn-2") return { deleted: false, queued: true };
      return { deleted: true, queued: false };
    }
  }, {
    tenantId: "tenant-1",
    collection: "__brain_conv_test",
    conversationId: "conv-1",
    checkpointTurnExternalId: "turn-checkpoint",
    keepRecentTurns: 2,
    requestId: "job:conversation-wiki"
  });

  assert.deepEqual(deletedIds, [
    { id: "turn-1", reason: "conversation_wiki_prune" },
    { id: "turn-2", reason: "conversation_wiki_prune" },
    { id: "turn-3", reason: "conversation_wiki_prune" }
  ]);
  assert.deepEqual(result, { pruned: 2, queued: 1 });
}

async function main() {
  testNormalizesWikiPages();
  testBuildsConversationWikiPageText();
  testParsesConversationWikiResponse();
  testFormatsConversationWikiAuditFields();
  await testConversationWikiJobRetryableFailureRequeues();
  await testConversationWikiEnqueueDedupesConcurrentRequests();
  await testPrunesConversationTailAndCountsQueuedDeletes();
  console.log("conversation wiki tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).then(() => {
  process.exit(0);
});

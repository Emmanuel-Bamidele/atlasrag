const assert = require("assert/strict");
const Module = require("module");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./plugins" && parent?.filename?.endsWith("/gateway/index.js")) {
    return { mount() {} };
  }
  return originalLoad.apply(this, arguments);
};

const { __testHooks } = require("../index");

function testNormalizesWikiPages() {
  assert.deepEqual(
    __testHooks.normalizeConversationWikiPagesInput(["questions answered", "Questions Answered", "how understanding evolved"]),
    ["questions answered", "how understanding evolved"]
  );
}

function testBuildsConversationWikiPageText() {
  const built = __testHooks.buildConversationWikiPageText("article", {
    title: "Conversation wiki",
    note: "Merged from the previous wiki version.",
    paragraphs: [
      "The user asked how to demonstrate consistency in their work, and the answer emphasized repeatable follow-through, clear communication, and reliable outcomes over time.",
      "They also asked when to draw the line between performance and compensation, and the answer explained that the line appears when ownership and outcomes consistently exceed what compensation still reflects."
    ]
  }, 1200);
  assert.match(built.text, /Conversation wiki/);
  assert.match(built.text, /Note: Merged from the previous wiki version\./);
  assert.equal(built.itemCount, 2);
}

function testParsesConversationWikiResponse() {
  const parsed = __testHooks.parseConversationWikiResponse(JSON.stringify({
    article: {
      id: "article",
      title: "Questions answered over time",
      note: "Updated from the latest turn set.",
      paragraphs: [
        "The first exchange focused on demonstrating consistency at work and framed consistency as repeatable execution plus visible follow-through.",
        "The next exchange focused on compensation and clarified that compensation should eventually catch up with the level of ownership and outcomes being carried."
      ]
    }
  }));
  assert.equal(parsed.id, "article");
  assert.equal(parsed.title, "Questions answered over time");
  assert.equal(parsed.note, "Updated from the latest turn set.");
  assert.equal(parsed.paragraphs.length, 2);
}

function testParsesLegacyConversationWikiResponse() {
  const parsed = __testHooks.parseConversationWikiResponse(JSON.stringify({
    facts: {
      confirmed: ["Ada prefers monthly billing."],
      uncertain: [],
      open: ["Explain when billing changes take effect after a plan update."]
    }
  }));
  assert.equal(parsed.id, "article");
  assert.deepEqual(parsed.paragraphs, [
    "Ada prefers monthly billing.",
    "Additional knowledge base coverage could help answer this unresolved point: Explain when billing changes take effect after a plan update."
  ]);
}

function testFormatsConversationWikiAuditFields() {
  const formatted = __testHooks.formatConversationWikiItem({
    metadata: {
      page: "article",
      title: "Conversation wiki",
      note: "Updated from the newest exchange.",
      paragraphs: [
        "The user asked how to recover from a weak presentation and the answer focused on diagnosing what failed, tightening the narrative, and rehearsing a stronger version."
      ],
      revision: 3,
      checkpointTurnExternalId: "turn-42",
      itemCount: 1,
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
  }, "Conversation wiki\n\nNote: Updated from the newest exchange.\n\nThe user asked how to recover from a weak presentation and the answer focused on diagnosing what failed, tightening the narrative, and rehearsing a stronger version.");
  assert.equal(formatted.updatedAt, "2026-04-06T12:00:00.000Z");
  assert.equal(formatted.updatedBySource, "conversation_wiki_manual");
  assert.equal(formatted.title, "Conversation wiki");
  assert.equal(formatted.note, "Updated from the newest exchange.");
  assert.equal(formatted.paragraphs.length, 1);
  assert.equal(__testHooks.getConversationWikiLastUpdatedAt([formatted]), "2026-04-06T12:00:00.000Z");
}

function testBuildsTurnExchangesAndPrompt() {
  const exchanges = __testHooks.buildConversationWikiTurnExchanges([
    {
      role: "user",
      createdAt: "2026-04-07T01:00:00.000Z",
      externalId: "turn-user-1",
      text: "Message:\nHow can I demonstrate consistency in my work?"
    },
    {
      role: "assistant",
      createdAt: "2026-04-07T01:01:00.000Z",
      externalId: "turn-assistant-1",
      text: "Message:\nShow a repeatable pattern of follow-through, clear communication, and reliable outcomes."
    },
    {
      role: "user",
      createdAt: "2026-04-07T01:02:00.000Z",
      externalId: "turn-user-2",
      text: "Message:\nWhen should I draw the line between performance and compensation?"
    },
    {
      role: "assistant",
      createdAt: "2026-04-07T01:03:00.000Z",
      externalId: "turn-assistant-2",
      text: "Message:\nDraw the line when your compensation no longer reflects the level of ownership and outcomes you consistently carry."
    }
  ]);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].responseCount, 1);
  assert.match(exchanges[1].responses[0].text, /compensation no longer reflects/);

  const prompt = __testHooks.buildConversationWikiUpdatePrompt({
    conversationId: "conv-1",
    pages: ["questions answered", "how understanding evolved"],
    existingWikiState: {
      previousWiki: {
        title: "Conversation wiki",
        note: null,
        paragraphs: ["Earlier draft paragraph."]
      },
      previousWikiSourceExchanges: [
        {
          question: "What mattered before?",
          responses: [
            {
              role: "assistant",
              text: "The earlier answer explained the prior context."
            }
          ]
        }
      ]
    },
    recentTurns: [
      {
        role: "user",
        createdAt: "2026-04-07T01:00:00.000Z",
        externalId: "turn-user-1",
        text: "Message:\nHow can I demonstrate consistency in my work?"
      },
      {
        role: "assistant",
        createdAt: "2026-04-07T01:01:00.000Z",
        externalId: "turn-assistant-1",
        text: "Message:\nShow a repeatable pattern of follow-through, clear communication, and reliable outcomes."
      }
    ]
  });
  assert.match(prompt.system, /Treat answered questions as answered\./);
  assert.match(prompt.system, /cover each exchange with its own substantial paragraph/);
  assert.match(prompt.system, /Do not mention a user question without also carrying forward the substance of the assistant answer/);
  assert.match(prompt.system, /Only add a knowledge-base gap paragraph when the assistant response explicitly lacked enough information/);
  assert.match(prompt.user, /Previous wiki article text:/);
  assert.match(prompt.user, /Earlier draft paragraph\./);
  assert.match(prompt.user, /Previous wiki source exchanges JSON:/);
  assert.match(prompt.user, /The earlier answer explained the prior context\./);
  assert.match(prompt.user, /Question and answer digest:/);
  assert.match(prompt.user, /Question: How can I demonstrate consistency in my work\?/);
  assert.match(prompt.user, /Answer 1 \(assistant @ 2026-04-07T01:01:00.000Z\): Show a repeatable pattern of follow-through, clear communication, and reliable outcomes\./);
  assert.match(prompt.user, /Question and response exchanges JSON:/);
}

{
  assert.equal(__testHooks.resolveConversationWikiSourceCheckpoint([
    { checkpointTurnExternalId: "turn-42" }
  ], { force: false }), "turn-42");
  assert.equal(__testHooks.resolveConversationWikiSourceCheckpoint([
    { checkpointTurnExternalId: "turn-42" }
  ], { force: true }), null);
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
    pages: ["questions answered", "how understanding evolved"]
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
    pages: ["questions answered", "how understanding evolved"],
    keepRecentTurns: 6,
    updateEveryTurns: 4,
    baseTags: ["conversation:conv-1"]
  });

  assert.equal(second.id, "job-created");
  assert.equal(second.status, "queued");
  assert.deepEqual(second.input.pages, ["questions answered", "how understanding evolved"]);
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

async function testClearsConversationMemoryCollection() {
  const steps = [];
  const result = await __testHooks.clearConversationMemoryCollectionWithDeps({
    listMemoryItemsByCollection: async () => ([
      {
        id: "memory-1",
        namespace_id: "ns-1",
        tenant_id: "tenant-1",
        collection: "__brain_conv_test",
        metadata: { conversationId: "conv-1" }
      },
      {
        id: "memory-2",
        namespace_id: "ns-2",
        tenant_id: "tenant-1",
        collection: "__brain_conv_test",
        metadata: { conversationId: "conv-2" }
      }
    ]),
    listMemoryJobsByCollection: async () => ([
      {
        id: "job-1",
        job_type: "conversation_wiki_update",
        input: JSON.stringify({
          collection: "__brain_conv_test",
          conversationId: "conv-2"
        })
      },
      {
        id: "job-2",
        job_type: "delete_reconcile",
        input: JSON.stringify({
          collection: "__brain_conv_test"
        })
      }
    ]),
    acquireConversationWikiLock: async ({ conversationId }) => {
      steps.push(`lock:${conversationId}`);
      return { conversationId };
    },
    releaseConversationWikiLock: async (lock) => {
      steps.push(`unlock:${lock.conversationId}`);
    },
    deleteMemoryJobsByCollection: async ({ jobTypes }) => {
      steps.push(`deleteJobs:${jobTypes.join(",")}`);
      return 2;
    },
    deleteMemoryItemFully: async (item, options) => {
      steps.push(`deleteItem:${item.id}:${options.reason}`);
      if (item.id === "memory-2") {
        return { deleted: false, queued: true, vectorsDeleted: 1 };
      }
      return { deleted: true, queued: false, vectorsDeleted: 3 };
    }
  }, {
    tenantId: "tenant-1",
    collection: "__brain_conv_test",
    requestId: "req-1",
    source: "conversation_wiki_api"
  });

  assert.deepEqual(steps, [
    "lock:conv-1",
    "lock:conv-2",
    "deleteJobs:conversation_wiki_update,delete_reconcile",
    "deleteItem:memory-1:conversation_memory_clear_all",
    "deleteItem:memory-2:conversation_memory_clear_all",
    "unlock:conv-2",
    "unlock:conv-1"
  ]);
  assert.equal(result.collection, "__brain_conv_test");
  assert.equal(result.conversationCount, 2);
  assert.deepEqual(result.conversationIds, ["conv-1", "conv-2"]);
  assert.equal(result.memoryItemCount, 2);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.queuedCount, 1);
  assert.equal(result.deletedJobCount, 2);
  assert.equal(result.deletedVectors, 4);
}

async function main() {
  testNormalizesWikiPages();
  testBuildsConversationWikiPageText();
  testParsesConversationWikiResponse();
  testParsesLegacyConversationWikiResponse();
  testFormatsConversationWikiAuditFields();
  testBuildsTurnExchangesAndPrompt();
  if (__testHooks.finalizeJobFailureWithDeps) {
    await testConversationWikiJobRetryableFailureRequeues();
  }
  await testConversationWikiEnqueueDedupesConcurrentRequests();
  await testPrunesConversationTailAndCountsQueuedDeletes();
  await testClearsConversationMemoryCollection();
  console.log("conversation wiki tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).then(() => {
  process.exit(0);
});

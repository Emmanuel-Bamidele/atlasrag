const assert = require("assert/strict");
const Module = require("module");
const path = require("path");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const originalLoad = Module._load;
let providerClientsLoadedByIndex = false;
function isGatewayIndexModule(parent) {
  const fileName = String(parent?.filename || "");
  if (!fileName) return false;
  const normalized = fileName.replace(/\\/g, "/");
  if (normalized.endsWith("/gateway/index.js")) return true;
  return path.basename(normalized) === "index.js" && path.basename(path.dirname(normalized)) === "app";
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./plugins" && isGatewayIndexModule(parent)) {
    return { mount() {} };
  }
  if (request === "./provider_clients" && isGatewayIndexModule(parent)) {
    providerClientsLoadedByIndex = true;
    return originalLoad.apply(this, arguments);
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

function testGatewayIndexLoadsConversationWikiGeneratorDependency() {
  assert.equal(providerClientsLoadedByIndex, true);
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

function testPreservesLongConversationWikiParagraphs() {
  const longParagraph = Array.from({ length: 40 }, (_, index) => (
    `Sentence ${index + 1} explains the presentation advice in a complete thought that should stay readable when the wiki article is stored.`
  )).join(" ");
  const built = __testHooks.buildConversationWikiPageText("article", {
    title: "Conversation wiki",
    paragraphs: [`${longParagraph} Final sentence keeps the ending intact.`]
  }, 9000);
  assert.equal(built.paragraphs.length, 1);
  assert.match(built.paragraphs[0], /Final sentence keeps the ending intact\./);
  assert.ok(built.paragraphs[0].length > 1800);
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

function testRepairsConversationWikiResponseWhenModelUnderfills() {
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
  const repairedFromEmpty = __testHooks.repairConversationWikiArticleDraft(
    __testHooks.parseConversationWikiResponse(""),
    {
      sourceExchanges: exchanges,
      minAnsweredExchanges: 2,
      fallbackTitle: "Conversation wiki"
    }
  );
  assert.equal(repairedFromEmpty.id, "article");
  assert.equal(repairedFromEmpty.paragraphs.length, 2);
  assert.match(repairedFromEmpty.note || "", /generator returned no readable article/i);
  assert.match(repairedFromEmpty.paragraphs[0], /The user asked:/);
  assert.match(repairedFromEmpty.paragraphs[0], /The assistant answered:/);

  const repairedFromUnderfilled = __testHooks.repairConversationWikiArticleDraft({
    article: {
      title: "Conversation wiki",
      paragraphs: ["One short paragraph that drops the rest."]
    }
  }, {
    sourceExchanges: exchanges,
    minAnsweredExchanges: 2,
    fallbackTitle: "Conversation wiki"
  });
  assert.equal(repairedFromUnderfilled.paragraphs.length, 2);
  assert.match(repairedFromUnderfilled.note || "", /did not preserve every recent answered interaction/i);
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
  const promptTurns = __testHooks.mergeConversationWikiPromptTurns([
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
  ], [
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
    }
  ], 2);
  assert.deepEqual(promptTurns.map((turn) => turn.externalId), [
    "turn-user-1",
    "turn-assistant-1",
    "turn-user-2",
    "turn-assistant-2"
  ]);
  assert.equal(__testHooks.countConversationWikiTurnExchanges(promptTurns), 2);

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
  assert.match(prompt.system, /Do not silently drop an answered exchange from the digest or source exchanges\./);
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

async function testLoadConversationTurnsForWikiUpdateKeepsConfiguredOverlap() {
  const allTurns = [
    {
      id: "turn-user-1",
      externalId: "turn-user-1",
      role: "user",
      createdAt: "2026-04-07T01:00:00.000Z",
      text: "Message:\nHow can I demonstrate consistency in my work?"
    },
    {
      id: "turn-assistant-1",
      externalId: "turn-assistant-1",
      role: "assistant",
      createdAt: "2026-04-07T01:01:00.000Z",
      text: "Message:\nShow a repeatable pattern of follow-through, clear communication, and reliable outcomes."
    },
    {
      id: "turn-user-2",
      externalId: "turn-user-2",
      role: "user",
      createdAt: "2026-04-07T01:02:00.000Z",
      text: "Message:\nWhen should I draw the line between performance and compensation?"
    },
    {
      id: "turn-assistant-2",
      externalId: "turn-assistant-2",
      role: "assistant",
      createdAt: "2026-04-07T01:03:00.000Z",
      text: "Message:\nDraw the line when your compensation no longer reflects the level of ownership and outcomes you consistently carry."
    },
    {
      id: "turn-user-3",
      externalId: "turn-user-3",
      role: "user",
      createdAt: "2026-04-07T01:04:00.000Z",
      text: "Message:\nHow should I frame that conversation?"
    },
    {
      id: "turn-assistant-3",
      externalId: "turn-assistant-3",
      role: "assistant",
      createdAt: "2026-04-07T01:05:00.000Z",
      text: "Message:\nFrame it around sustained scope, outcomes, and what needs to change."
    },
    {
      id: "turn-user-4",
      externalId: "turn-user-4",
      role: "user",
      createdAt: "2026-04-07T01:06:00.000Z",
      text: "Message:\nWhat if they still delay?"
    },
    {
      id: "turn-assistant-4",
      externalId: "turn-assistant-4",
      role: "assistant",
      createdAt: "2026-04-07T01:07:00.000Z",
      text: "Message:\nSet a clear timeline and decide what you will do if nothing changes."
    }
  ];
  const byId = new Map(allTurns.map((turn) => [turn.externalId, turn]));
  const toItem = (turn) => ({
    id: turn.id,
    external_id: turn.externalId,
    created_at: turn.createdAt,
    metadata: { role: turn.role },
    namespace_id: `${turn.id}-ns`
  });

  const result = await __testHooks.loadConversationTurnsForWikiUpdate({
    tenantId: "tenant-1",
    collection: "__brain_conv_test",
    conversationId: "conv-1",
    principalId: null,
    checkpointTurnExternalId: "turn-assistant-2",
    keepRecentTurns: 4
  }, {
    getMemoryItemByExternalId: async ({ externalId }) => ({ created_at: byId.get(externalId)?.createdAt || null }),
    listConversationTurnItems: async () => allTurns.slice(4).map(toItem),
    listRecentConversationTurnItems: async ({ limit }) => allTurns.slice(-limit).map(toItem),
    loadConversationTurnTexts: async (items = []) => items.map((item) => byId.get(item.external_id)).filter(Boolean)
  });

  assert.deepEqual(result.newTurns.map((turn) => turn.externalId), [
    "turn-user-3",
    "turn-assistant-3",
    "turn-user-4",
    "turn-assistant-4"
  ]);
  assert.deepEqual(result.promptTurns.map((turn) => turn.externalId), [
    "turn-user-1",
    "turn-assistant-1",
    "turn-user-2",
    "turn-assistant-2",
    "turn-user-3",
    "turn-assistant-3",
    "turn-user-4",
    "turn-assistant-4"
  ]);
  assert.equal(__testHooks.countConversationWikiTurnExchanges(result.promptTurns), 4);
}

function testConversationWikiMetricsHelpers() {
  const snapshot = __testHooks.recordConversationWikiMetrics("tenant-1", {
    succeeded: 1,
    pagesUpdated: 2,
    queuedDeletes: 1,
    lastPageCount: 4,
    lastUpdatedAt: "2026-04-07T12:00:00.000Z"
  });
  assert.equal(snapshot.succeeded, 1);
  assert.equal(snapshot.pagesUpdated, 2);
  assert.equal(snapshot.queuedDeletes, 1);
  assert.equal(snapshot.lastPageCount, 4);
  assert.equal(snapshot.lastUpdatedAt, "2026-04-07T12:00:00.000Z");
  assert.doesNotThrow(() => {
    __testHooks.emitConversationWikiTelemetry("succeeded", {
      tenantId: "tenant-1",
      collection: "__brain_conv_test",
      source: "conversation_wiki_job"
    }, {
      page_count: 4
    });
  });
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
      assert.equal(keepRecentTurns, 4);
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

async function testEnqueuesConversationMemoryClearJob() {
  let createCalls = 0;
  const activeJob = { id: "job-clear-active", status: "running" };
  const first = await __testHooks.enqueueConversationMemoryClearJobWithDeps({
    listMemoryJobsByCollection: async ({ jobTypes, statuses }) => {
      assert.deepEqual(jobTypes, ["conversation_wiki_clear_collection"]);
      assert.deepEqual(statuses, ["queued", "running"]);
      return [activeJob];
    },
    createMemoryJob: async () => {
      createCalls += 1;
      return { id: "job-created", status: "queued" };
    }
  }, {
    tenantId: "tenant-1",
    collection: "__brain_conv_test"
  });
  assert.equal(first, activeJob);
  assert.equal(createCalls, 0);

  const second = await __testHooks.enqueueConversationMemoryClearJobWithDeps({
    listMemoryJobsByCollection: async () => [],
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
    requestId: "req-1",
    source: "conversation_wiki_api"
  });
  assert.equal(second.id, "job-created");
  assert.equal(second.status, "queued");
  assert.equal(second.input.collection, "__brain_conv_test");
  assert.equal(second.input.requestId, "req-1");
  assert.equal(second.input.source, "conversation_wiki_api");
  assert.equal(createCalls, 1);
}

async function testRunsConversationMemoryClearJob() {
  const updates = [];
  const audits = [];
  const finalizations = [];
  await __testHooks.runConversationMemoryClearJobWithDeps({
    claimMemoryJob: async ({ id, tenantId }) => ({
      id,
      tenant_id: tenantId,
      input: JSON.stringify({
        collection: "__brain_conv_test",
        requestId: "req-clear",
        source: "conversation_wiki_api"
      })
    }),
    clearConversationMemoryCollection: async ({ tenantId, collection, requestId, source }) => {
      assert.equal(tenantId, "tenant-1");
      assert.equal(collection, "__brain_conv_test");
      assert.equal(requestId, "req-clear");
      assert.equal(source, "conversation_wiki_api");
      return {
        collection,
        conversationCount: 3,
        memoryItemCount: 10,
        deletedCount: 8,
        queuedCount: 2,
        deletedJobCount: 4,
        deletedVectors: 22
      };
    },
    updateMemoryJob: async (payload) => {
      updates.push(payload);
      return payload;
    },
    createAuditLog: async (payload) => {
      audits.push(payload);
      return payload;
    },
    finalizeJobFailure: async (...args) => {
      finalizations.push(args);
    }
  }, "job-clear", "tenant-1");

  assert.equal(finalizations.length, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "succeeded");
  assert.equal(updates[0].output.deletedCount, 8);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "conversation_wiki.cleared");
  assert.equal(audits[0].metadata.deletedVectors, 22);
}

async function testDispatchMemoryJobRoutesConversationWikiUpdates() {
  const calls = [];
  await __testHooks.dispatchMemoryJobWithDeps({
    runConversationWikiUpdateJob: async (jobId, tenantId) => {
      calls.push({ jobId, tenantId });
    }
  }, "job-wiki-1", "tenant-1", "conversation_wiki_update");
  assert.deepEqual(calls, [{ jobId: "job-wiki-1", tenantId: "tenant-1" }]);
  assert.equal(
    __testHooks.resolveMemoryJobRunner("conversation_wiki_update", {
      runConversationWikiUpdateJob: () => "ok"
    })(),
    "ok"
  );
}

async function main() {
  testGatewayIndexLoadsConversationWikiGeneratorDependency();
  testNormalizesWikiPages();
  testBuildsConversationWikiPageText();
  testPreservesLongConversationWikiParagraphs();
  testParsesConversationWikiResponse();
  testParsesLegacyConversationWikiResponse();
  testRepairsConversationWikiResponseWhenModelUnderfills();
  testFormatsConversationWikiAuditFields();
  testBuildsTurnExchangesAndPrompt();
  await testLoadConversationTurnsForWikiUpdateKeepsConfiguredOverlap();
  testConversationWikiMetricsHelpers();
  if (__testHooks.finalizeJobFailureWithDeps) {
    await testConversationWikiJobRetryableFailureRequeues();
  }
  await testConversationWikiEnqueueDedupesConcurrentRequests();
  await testPrunesConversationTailAndCountsQueuedDeletes();
  await testClearsConversationMemoryCollection();
  await testEnqueuesConversationMemoryClearJob();
  await testRunsConversationMemoryClearJob();
  await testDispatchMemoryJobRoutesConversationWikiUpdates();
  console.log("conversation wiki tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).then(() => {
  process.exit(0);
});

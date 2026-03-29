const assert = require("assert/strict");

const { embedTexts, __testHooks } = require("../ai");

async function withFetchStub(handler, fn) {
  const previous = global.fetch;
  global.fetch = handler;
  try {
    await fn();
  } finally {
    global.fetch = previous;
  }
}

function makeJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

async function testCachesRepeatedRetrievalQueryEmbeddings() {
  __testHooks.clearQueryEmbeddingCache();
  let fetchCalls = 0;

  await withFetchStub(async (url, options) => {
    fetchCalls += 1;
    assert.match(String(url), /embedContent/);
    const body = JSON.parse(options.body);
    assert.equal(body.taskType, "RETRIEVAL_QUERY");
    return makeJsonResponse({
      embedding: {
        values: [0.1, 0.2, 0.3]
      },
      usageMetadata: {
        promptTokenCount: 3,
        totalTokenCount: 3
      }
    });
  }, async () => {
    const first = await embedTexts(["hello\n   world"], {
      embedProvider: "gemini",
      embedModel: "gemini-embedding-001",
      apiKey: "gemini-key",
      taskType: "RETRIEVAL_QUERY"
    });
    const second = await embedTexts(["hello world"], {
      embedProvider: "gemini",
      embedModel: "gemini-embedding-001",
      apiKey: "gemini-key",
      taskType: "RETRIEVAL_QUERY"
    });

    assert.deepEqual(first.vectors, [[0.1, 0.2, 0.3]]);
    assert.deepEqual(second.vectors, [[0.1, 0.2, 0.3]]);
    assert.equal(first.usage.total_tokens, 3);
    assert.equal(second.usage.total_tokens, 0);
    assert.equal(second.usage.cached, true);
  });

  assert.equal(fetchCalls, 1);
}

async function testDoesNotCacheDocumentEmbeddings() {
  __testHooks.clearQueryEmbeddingCache();
  let fetchCalls = 0;

  await withFetchStub(async () => {
    fetchCalls += 1;
    return makeJsonResponse({
      embedding: {
        values: [0.4, 0.5, 0.6]
      },
      usageMetadata: {
        promptTokenCount: 4,
        totalTokenCount: 4
      }
    });
  }, async () => {
    await embedTexts(["same text"], {
      embedProvider: "gemini",
      embedModel: "gemini-embedding-001",
      apiKey: "gemini-key",
      taskType: "RETRIEVAL_DOCUMENT"
    });
    await embedTexts(["same text"], {
      embedProvider: "gemini",
      embedModel: "gemini-embedding-001",
      apiKey: "gemini-key",
      taskType: "RETRIEVAL_DOCUMENT"
    });
  });

  assert.equal(fetchCalls, 2);
}

async function testSeparatesCacheByApiKeyScope() {
  __testHooks.clearQueryEmbeddingCache();
  let fetchCalls = 0;

  await withFetchStub(async () => {
    fetchCalls += 1;
    return makeJsonResponse({
      embedding: {
        values: [0.7, 0.8, 0.9]
      },
      usageMetadata: {
        promptTokenCount: 5,
        totalTokenCount: 5
      }
    });
  }, async () => {
    await embedTexts(["shared prompt"], {
      embedProvider: "gemini",
      embedModel: "gemini-embedding-001",
      apiKey: "key-a",
      taskType: "RETRIEVAL_QUERY"
    });
    await embedTexts(["shared prompt"], {
      embedProvider: "gemini",
      embedModel: "gemini-embedding-001",
      apiKey: "key-b",
      taskType: "RETRIEVAL_QUERY"
    });
  });

  assert.equal(fetchCalls, 2);
}

async function main() {
  await testCachesRepeatedRetrievalQueryEmbeddings();
  await testDoesNotCacheDocumentEmbeddings();
  await testSeparatesCacheByApiKeyScope();
  console.log("query embed cache tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const assert = require("assert/strict");

const {
  generateProviderText,
  embedProviderTexts,
  resolveProviderApiKey,
  __testHooks
} = require("../provider_clients");

function withEnv(updates, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(updates || {})) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

function testResolveProviderApiKeyAliases() {
  withEnv({ GEMINI_API: "test-gemini-key", GEMINI_API_KEY: undefined }, () => {
    assert.equal(resolveProviderApiKey("gemini"), "test-gemini-key");
  });
}

async function testGeminiGeneration() {
  await withFetchStub(async (url, options) => {
    assert.match(String(url), /generateContent/);
    assert.equal(options.headers["x-goog-api-key"], "gemini-key");
    return makeJsonResponse({
      candidates: [{
        content: {
          parts: [{ text: "Gemini answer\nCitations: SOURCE-1" }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14
      }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "gemini",
      model: "gemini-2.5-flash",
      input: "hello",
      apiKey: "gemini-key"
    });
    assert.equal(result.text, "Gemini answer\nCitations: SOURCE-1");
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 4);
  });
}

async function testAnthropicGeneration() {
  await withFetchStub(async (url, options) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    assert.equal(options.headers["x-api-key"], "anthropic-key");
    return makeJsonResponse({
      content: [{ type: "text", text: "Anthropic answer\nCitations: SOURCE-2" }],
      usage: { input_tokens: 9, output_tokens: 5 }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      input: "hello",
      apiKey: "anthropic-key"
    });
    assert.equal(result.text, "Anthropic answer\nCitations: SOURCE-2");
    assert.equal(result.usage.total_tokens, 14);
  });
}

async function testGeminiEmbeddings() {
  await withFetchStub(async (url, options) => {
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
    const result = await embedProviderTexts({
      provider: "gemini",
      texts: ["hello"],
      model: "gemini-embedding-001",
      apiKey: "gemini-key",
      taskType: "RETRIEVAL_QUERY"
    });
    assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]]);
    assert.equal(result.usage.prompt_tokens, 3);
  });
}

function testProviderClientHooks() {
  assert.equal(__testHooks.normalizeGeminiModelPath("models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(__testHooks.extractGeminiText({
    candidates: [{ content: { parts: [{ text: "hello" }, { text: "world" }] } }]
  }), "hello\nworld");
  assert.equal(__testHooks.extractAnthropicText({
    content: [{ type: "text", text: "hi" }, { type: "tool_result", text: "ignored" }]
  }), "hi");
}

async function main() {
  testResolveProviderApiKeyAliases();
  testProviderClientHooks();
  await testGeminiGeneration();
  await testAnthropicGeneration();
  await testGeminiEmbeddings();
  console.log("provider client tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

const assert = require("assert");
const {
  requestJson,
  assertStatus,
  assertOkEnvelope,
  randomId,
  bearer,
  apiKey,
  getBaseUrl
} = require("./_http");

const USERNAME = process.env.E2E_USERNAME || "ci_admin";
const PASSWORD = process.env.E2E_PASSWORD || "ci_admin_password";

async function login() {
  const response = await requestJson("POST", "/v1/login", {
    body: { username: USERNAME, password: PASSWORD }
  });
  assertStatus(response, 200, "/v1/login");
  const data = assertOkEnvelope(response, "/v1/login");
  assert(data.token, "login response must include token");
  return data.token;
}

async function createServiceToken(adminJwt) {
  const response = await requestJson("POST", "/v1/admin/service-tokens", {
    headers: bearer(adminJwt),
    body: {
      name: randomId("ci-e2e-token"),
      principalId: randomId("ci-e2e-principal"),
      roles: ["reader", "indexer"]
    }
  });
  assertStatus(response, 200, "/v1/admin/service-tokens");
  const data = assertOkEnvelope(response, "/v1/admin/service-tokens");
  assert(data.token, "service token create must return token");
  assert(data.tokenInfo?.id, "service token create must return tokenInfo.id");
  return { token: data.token, id: data.tokenInfo.id };
}

async function revokeServiceToken(adminJwt, tokenId) {
  const response = await requestJson("DELETE", `/v1/admin/service-tokens/${tokenId}`, {
    headers: bearer(adminJwt)
  });
  assertStatus(response, 200, "revoke service token");
  assertOkEnvelope(response, "revoke service token");
}

async function deleteDocWithAdmin(adminJwt, docId) {
  const response = await requestJson("DELETE", `/v1/docs/${encodeURIComponent(docId)}`, {
    headers: bearer(adminJwt)
  });
  if (response.status === 200) return;
  if (response.status === 400 || response.status === 404) return;
  throw new Error(`failed to delete doc ${docId}: status=${response.status} body=${response.text}`);
}

(async () => {
  const unique = randomId("ci-e2e");
  const marker = `atlasrag_${unique}_marker`;
  const docId = `${unique}_doc`;

  let adminJwt = null;
  let svcToken = null;
  let svcTokenId = null;
  let memoryId = null;

  try {
    adminJwt = await login();
    const serviceToken = await createServiceToken(adminJwt);
    svcToken = serviceToken.token;
    svcTokenId = serviceToken.id;

    const indexed = await requestJson("POST", "/v1/docs", {
      headers: {
        ...apiKey(svcToken),
        "Idempotency-Key": randomId("idem-doc")
      },
      body: {
        docId,
        text: [
          "AtlasRAG e2e ingestion test document.",
          `Unique marker: ${marker}.`,
          "This verifies indexing, retrieval, and memory lifecycle endpoints."
        ].join(" ")
      }
    });
    assertStatus(indexed, 200, "/v1/docs");
    const indexedData = assertOkEnvelope(indexed, "/v1/docs");
    assert.strictEqual(indexedData.docId, docId, "indexed doc id mismatch");
    assert(indexedData.chunksIndexed >= 1, "expected at least one indexed chunk");

    const searched = await requestJson("GET", "/v1/search", {
      headers: apiKey(svcToken),
      query: { q: marker, k: 5, docIds: docId }
    });
    assertStatus(searched, 200, "/v1/search");
    const searchedData = assertOkEnvelope(searched, "/v1/search");
    assert(Array.isArray(searchedData.results), "search should return results array");
    assert(
      searchedData.results.some((row) => row.docId === docId),
      `search results should include doc ${docId}`
    );

    const asked = await requestJson("POST", "/v1/ask", {
      headers: apiKey(svcToken),
      body: {
        question: "What is the unique marker in the indexed e2e document?",
        k: 4,
        docIds: [docId]
      }
    });
    assertStatus(asked, 200, "/v1/ask");
    const askedData = assertOkEnvelope(asked, "/v1/ask");
    assert(typeof askedData.answer === "string" && askedData.answer.length > 0, "ask should return answer text");
    assert(Array.isArray(askedData.citations), "ask should return citations");

    const memoryWrite = await requestJson("POST", "/v1/memory/write", {
      headers: {
        ...apiKey(svcToken),
        "Idempotency-Key": randomId("idem-memory")
      },
      body: {
        text: `Remember ${marker} as the escalation code for CI workflows.`,
        type: "semantic",
        tags: ["ci", "e2e"]
      }
    });
    assertStatus(memoryWrite, 200, "/v1/memory/write");
    const memoryData = assertOkEnvelope(memoryWrite, "/v1/memory/write");
    assert(memoryData.memory?.id, "memory write should return memory id");
    memoryId = memoryData.memory.id;

    const recalled = await requestJson("POST", "/v1/memory/recall", {
      headers: apiKey(svcToken),
      body: {
        query: marker,
        k: 5
      }
    });
    assertStatus(recalled, 200, "/v1/memory/recall");
    const recalledData = assertOkEnvelope(recalled, "/v1/memory/recall");
    assert(Array.isArray(recalledData.results), "memory recall should return results array");
    assert(
      recalledData.results.some((item) => item.memory?.id === memoryId),
      "memory recall should include newly written memory"
    );

    const feedback = await requestJson("POST", "/v1/feedback", {
      headers: apiKey(svcToken),
      body: {
        memoryId,
        feedback: "positive"
      }
    });
    assertStatus(feedback, 200, "/v1/feedback");
    const feedbackData = assertOkEnvelope(feedback, "/v1/feedback");
    assert.strictEqual(feedbackData.memoryId, memoryId, "feedback response memory id mismatch");
    assert.strictEqual(feedbackData.eventType, "user_positive", "feedback should map to user_positive");

    const event = await requestJson("POST", "/v1/memory/event", {
      headers: apiKey(svcToken),
      body: {
        memoryId,
        eventType: "task_success"
      }
    });
    assertStatus(event, 200, "/v1/memory/event");
    const eventData = assertOkEnvelope(event, "/v1/memory/event");
    assert.strictEqual(eventData.memoryId, memoryId, "memory event response memory id mismatch");
    assert.strictEqual(eventData.eventType, "task_success", "memory event type mismatch");

    const deleted = await requestJson("DELETE", `/v1/docs/${encodeURIComponent(docId)}`, {
      headers: apiKey(svcToken)
    });
    assertStatus(deleted, 200, "/v1/docs/:docId delete");
    assertOkEnvelope(deleted, "/v1/docs/:docId delete");

    await revokeServiceToken(adminJwt, svcTokenId);
    svcTokenId = null;

    console.log(`api_e2e tests passed against ${getBaseUrl()}`);
  } finally {
    if (svcTokenId && adminJwt) {
      try {
        await revokeServiceToken(adminJwt, svcTokenId);
      } catch (err) {
        console.warn(`cleanup warning: failed to revoke service token ${svcTokenId}: ${err.message}`);
      }
    }
    if (docId && adminJwt) {
      try {
        await deleteDocWithAdmin(adminJwt, docId);
      } catch (err) {
        console.warn(`cleanup warning: failed to delete doc ${docId}: ${err.message}`);
      }
    }
  }
})().catch((err) => {
  console.error("api_e2e tests failed");
  console.error(err);
  process.exit(1);
});

const assert = require("assert/strict");

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
const RETRY_ATTEMPTS = Number.parseInt(process.env.E2E_DIAGNOSTIC_RETRY_ATTEMPTS || "6", 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.E2E_DIAGNOSTIC_RETRY_DELAY_MS || "1200", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function excerpt(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function isCanonicalUnknownAnswer(answer) {
  const normalized = String(answer || "")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized === "i don't know based on the provided sources."
    || normalized === "i dont know based on the provided sources.";
}

function printDiagnostics(report, stream = console.log) {
  stream("---- diagnostic e2e report ----");
  stream(JSON.stringify(report, null, 2));
}

function recordFailure(report, stage, err, extra = {}) {
  const failure = {
    stage,
    message: err?.message || String(err),
    ...(err?.stack ? { stack: err.stack } : {}),
    ...extra
  };
  if (!Array.isArray(report.failures)) {
    report.failures = [];
  }
  report.failures.push(failure);
  return failure;
}

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
      name: randomId("diag-e2e-token"),
      principalId: randomId("diag-e2e-principal"),
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

async function deleteDocWithAdmin(adminJwt, docId, collection) {
  const response = await requestJson("DELETE", `/v1/docs/${encodeURIComponent(docId)}`, {
    headers: bearer(adminJwt),
    query: { collection }
  });
  if (response.status === 200 || response.status === 400 || response.status === 404) return;
  throw new Error(`failed to delete doc ${docId}: status=${response.status} body=${response.text}`);
}

async function deleteCollectionWithAdmin(adminJwt, collection) {
  const response = await requestJson("DELETE", `/v1/collections/${encodeURIComponent(collection)}`, {
    headers: bearer(adminJwt)
  });
  if (response.status === 200 || response.status === 400 || response.status === 404) return response;
  throw new Error(`failed to delete collection ${collection}: status=${response.status} body=${response.text}`);
}

async function eventually(label, fn, { attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      await sleep(delayMs);
    }
  }
  const wrapped = new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
  wrapped.cause = lastErr;
  throw wrapped;
}

function buildUploadLikeText({ header, ownerName, codename, marker, sectionCount = 18, finalSection = "" }) {
  const lines = [
    `${header}.`,
    `Document control marker: ${marker}.`,
    `Primary owner: ${ownerName}.`,
    `Escalation codename: ${codename}.`
  ];
  for (let index = 1; index <= sectionCount; index += 1) {
    lines.push(
      `Section ${index}: This diagnostic upload section confirms that retrieval should preserve factual details across chunk boundaries without collapsing distinct names, codes, and approvals.`
    );
  }
  if (finalSection) {
    lines.push(finalSection);
  }
  return lines.join("\n\n");
}

function buildLongTailText({ marker, finalFact, repeatedSections = 42 }) {
  const sections = [
    "Long-form diagnostic file for retrieval validation.",
    `Root marker: ${marker}.`
  ];
  for (let index = 1; index <= repeatedSections; index += 1) {
    sections.push(
      `Background ${index}: Teams reviewed architecture notes, support runbooks, roadmap summaries, and rollout checklists. This paragraph exists to push the decisive fact well beyond the first chunk while still preserving semantic context.`
    );
  }
  sections.push(`Critical final note: ${finalFact}.`);
  sections.push("End of diagnostic file.");
  return sections.join("\n\n");
}

async function indexSingleDocument({ svcToken, collection, docId, text, title, metadata, report }) {
  const response = await requestJson("POST", "/v1/docs", {
    headers: {
      ...apiKey(svcToken),
      "Idempotency-Key": randomId("diag-single")
    },
    body: {
      collection,
      docId,
      title,
      metadata,
      text
    }
  });
  assertStatus(response, 200, `/v1/docs ${docId}`);
  const data = assertOkEnvelope(response, `/v1/docs ${docId}`);
  report.index.single = {
    docId: data.docId,
    collection: data.collection,
    chunksIndexed: data.chunksIndexed,
    truncated: data.truncated
  };
  return data;
}

async function indexBulkDocuments({ svcToken, collection, documents, report }) {
  const response = await requestJson("POST", "/v1/docs/bulk", {
    headers: {
      ...apiKey(svcToken),
      "Idempotency-Key": randomId("diag-bulk")
    },
    body: {
      collection,
      documents
    }
  });
  assertStatus(response, 200, "/v1/docs/bulk");
  const data = assertOkEnvelope(response, "/v1/docs/bulk");
  report.index.bulk = data.summary;
  report.index.bulkResults = data.results.map((result) => ({
    index: result.index,
    ok: result.ok,
    docId: result.docId || null,
    chunksIndexed: result.chunksIndexed || 0,
    truncated: Boolean(result.truncated),
    error: result.error?.message || null
  }));
  return data;
}

async function diagnoseDocument({ label, svcToken, collection, docId, searchQuery, question, booleanQuestion, expectedSnippet, report }) {
  const entry = {
    label,
    docId,
    searchQuery,
    question,
    booleanQuestion,
    expectedSnippet
  };
  report.documents.push(entry);

  const localFailures = [];

  try {
    await eventually(`${label} search`, async () => {
      const response = await requestJson("GET", "/v1/search", {
        headers: apiKey(svcToken),
        query: {
          q: searchQuery,
          k: 6,
          collection,
          docIds: docId
        }
      });
      assertStatus(response, 200, `${label} /v1/search`);
      const data = assertOkEnvelope(response, `${label} /v1/search`);
      const matching = data.results.filter((row) => row.docId === docId);
      entry.search = {
        totalResults: data.results.length,
        matchingResults: matching.length,
        previews: data.results.slice(0, 3).map((row) => ({
          docId: row.docId,
          score: row.score,
          preview: excerpt(row.preview, 140)
        }))
      };
      if (!matching.length) {
        throw new Error(`search returned no results for doc ${docId}`);
      }
      if (!matching.some((row) => String(row.preview || "").includes(expectedSnippet))) {
        throw new Error(`search previews did not contain expected snippet "${expectedSnippet}"`);
      }
      return data;
    });
  } catch (err) {
    entry.searchFailure = err.message;
    localFailures.push(`search: ${err.message}`);
  }

  try {
    await eventually(`${label} ask`, async () => {
      const response = await requestJson("POST", "/v1/ask", {
        headers: apiKey(svcToken),
        body: {
          collection,
          question,
          k: 6,
          answerLength: "medium",
          docIds: [docId]
        }
      });
      assertStatus(response, 200, `${label} /v1/ask`);
      const data = assertOkEnvelope(response, `${label} /v1/ask`);
      entry.ask = {
        answer: excerpt(data.answer, 220),
        citations: Array.isArray(data.citations) ? data.citations.length : 0,
        chunksUsed: data.chunksUsed || 0,
        supportingChunks: (data.supportingChunks || []).slice(0, 3).map((chunk) => ({
          chunkId: chunk.chunkId,
          docId: chunk.docId,
          score: chunk.score,
          text: excerpt(chunk.text, 140)
        }))
      };
      if (!Array.isArray(data.supportingChunks) || data.supportingChunks.length === 0) {
        throw new Error("ask returned no supportingChunks");
      }
      if (!data.supportingChunks.some((chunk) => String(chunk.text || "").includes(expectedSnippet))) {
        throw new Error(`ask supportingChunks did not contain expected snippet "${expectedSnippet}"`);
      }
      if (isCanonicalUnknownAnswer(data.answer)) {
        throw new Error("ask returned canonical unknown answer even though supporting chunks were present");
      }
      if (!String(data.answer || "").includes(expectedSnippet)) {
        throw new Error(`ask answer did not include expected snippet "${expectedSnippet}"`);
      }
      return data;
    });
  } catch (err) {
    entry.askFailure = err.message;
    localFailures.push(`ask: ${err.message}`);
  }

  try {
    await eventually(`${label} boolean ask`, async () => {
      const response = await requestJson("POST", "/v1/boolean_ask", {
        headers: apiKey(svcToken),
        body: {
          collection,
          question: booleanQuestion,
          k: 6,
          docIds: [docId]
        }
      });
      assertStatus(response, 200, `${label} /v1/boolean_ask`);
      const data = assertOkEnvelope(response, `${label} /v1/boolean_ask`);
      entry.booleanAsk = {
        answer: data.answer,
        citations: Array.isArray(data.citations) ? data.citations.length : 0,
        supportingChunks: Array.isArray(data.supportingChunks) ? data.supportingChunks.length : 0
      };
      if (data.answer !== "true") {
        throw new Error(`boolean_ask returned ${data.answer}`);
      }
      return data;
    });
  } catch (err) {
    entry.booleanAskFailure = err.message;
    localFailures.push(`boolean_ask: ${err.message}`);
  }

  if (localFailures.length > 0) {
    throw new Error(localFailures.join("; "));
  }
}

async function verifyCollectionState({ adminJwt, collection, expectedDocs, report }) {
  const response = await requestJson("GET", "/v1/collections", {
    headers: bearer(adminJwt)
  });
  assertStatus(response, 200, "/v1/collections");
  const data = assertOkEnvelope(response, "/v1/collections");
  const entry = (data.collections || []).find((item) => item.collection === collection);
  report.collections.beforeDelete = {
    totalCollections: data.totalCollections,
    entry: entry || null
  };
  assert(entry, `expected collection ${collection} to exist`);
  assert.equal(entry.totalDocs, expectedDocs, `expected ${expectedDocs} docs in collection ${collection}`);
}

async function verifyDocumentDelete({ svcToken, collection, docId, searchQuery, report }) {
  const deleted = await requestJson("DELETE", `/v1/docs/${encodeURIComponent(docId)}`, {
    headers: apiKey(svcToken),
    query: { collection }
  });
  assertStatus(deleted, 200, `/v1/docs/${docId} delete`);
  const deletedData = assertOkEnvelope(deleted, `/v1/docs/${docId} delete`);
  report.delete.doc = deletedData;

  const searched = await eventually(`search after deleting ${docId}`, async () => {
    const response = await requestJson("GET", "/v1/search", {
      headers: apiKey(svcToken),
      query: {
        q: searchQuery,
        k: 6,
        collection
      }
    });
    assertStatus(response, 200, `search after deleting ${docId}`);
    const data = assertOkEnvelope(response, `search after deleting ${docId}`);
    if (data.results.some((row) => row.docId === docId)) {
      throw new Error(`deleted doc ${docId} still appears in search results`);
    }
    return data;
  });
  report.delete.docSearchAfter = {
    query: searchQuery,
    remainingResults: searched.results.slice(0, 3).map((row) => ({
      docId: row.docId,
      score: row.score,
      preview: excerpt(row.preview, 120)
    }))
  };
}

async function verifyCollectionDelete({ adminJwt, collection, report }) {
  const deleted = await requestJson("DELETE", `/v1/collections/${encodeURIComponent(collection)}`, {
    headers: bearer(adminJwt)
  });
  assertStatus(deleted, 200, `/v1/collections/${collection} delete`);
  const payload = deleted.json && deleted.json.ok ? deleted.json.data : deleted.json;
  report.delete.collection = payload;

  const listed = await eventually(`collections after deleting ${collection}`, async () => {
    const response = await requestJson("GET", "/v1/collections", {
      headers: bearer(adminJwt)
    });
    assertStatus(response, 200, "/v1/collections after delete");
    const data = assertOkEnvelope(response, "/v1/collections after delete");
    if ((data.collections || []).some((item) => item.collection === collection)) {
      throw new Error(`collection ${collection} still appears after delete`);
    }
    return data;
  });
  report.collections.afterDelete = {
    totalCollections: listed.totalCollections
  };
}

async function maybeDiagnoseUrlDocument({ svcToken, collection, report }) {
  const url = String(process.env.E2E_URL_DOC_URL || "").trim();
  const expectedSnippet = String(process.env.E2E_URL_EXPECTED_SNIPPET || "").trim();
  const question = String(process.env.E2E_URL_QUESTION || "").trim();
  if (!url || !expectedSnippet || !question) {
    report.urlDocument = {
      skipped: true,
      reason: "Set E2E_URL_DOC_URL, E2E_URL_EXPECTED_SNIPPET, and E2E_URL_QUESTION to exercise /v1/docs/url against a public page."
    };
    return;
  }

  const docId = randomId("diag-url-doc");
  const indexed = await requestJson("POST", "/v1/docs/url", {
    headers: {
      ...apiKey(svcToken),
      "Idempotency-Key": randomId("diag-url")
    },
    body: {
      collection,
      docId,
      url
    }
  });
  assertStatus(indexed, 200, "/v1/docs/url");
  const data = assertOkEnvelope(indexed, "/v1/docs/url");
  report.urlDocument = {
    skipped: false,
    index: data
  };
  await diagnoseDocument({
    label: "url-document",
    svcToken,
    collection,
    docId,
    searchQuery: expectedSnippet,
    question,
    expectedSnippet,
    report
  });
}

(async () => {
  const unique = randomId("diag-e2e");
  const collection = `diag_${unique.replace(/-/g, "_")}`;
  const directDocId = `${unique}_direct_doc`;
  const uploadDocId = `${unique}_upload_doc`;
  const longDocId = `${unique}_long_doc`;
  const report = {
    baseUrl: getBaseUrl(),
    startedAt: new Date().toISOString(),
    collection,
    index: {},
    documents: [],
    collections: {},
    delete: {},
    urlDocument: null,
    failures: []
  };

  const directFact = "Maris Quill";
  const uploadFact = "Miri Talbot";
  const longFact = "Copper Lantern";
  const directMarker = `direct-marker-${unique}`;
  const uploadMarker = `upload-marker-${unique}`;
  const longMarker = `long-marker-${unique}`;

  const directText = [
    "Direct API diagnostic document.",
    `Marker: ${directMarker}.`,
    `Renewal contact: ${directFact}.`,
    "This document exists to verify single-document indexing, retrieval, and ask behavior."
  ].join(" ");

  const uploadLikeText = buildUploadLikeText({
    header: "Uploaded diagnostic file snapshot",
    ownerName: uploadFact,
    codename: "River Glass",
    marker: uploadMarker,
    finalSection: "Finance approval routing confirms that the named approver remains Miri Talbot throughout the workflow."
  });

  const longTailText = buildLongTailText({
    marker: longMarker,
    finalFact: `The release freeze codename is ${longFact}`
  });

  let adminJwt = null;
  let svcToken = null;
  let svcTokenId = null;

  try {
    adminJwt = await login();
    const serviceToken = await createServiceToken(adminJwt);
    svcToken = serviceToken.token;
    svcTokenId = serviceToken.id;

    const singleIndexed = await indexSingleDocument({
      svcToken,
      collection,
      docId: directDocId,
      text: directText,
      title: "direct-diagnostic.txt",
      metadata: {
        source: "diagnostic_single",
        kind: "text"
      },
      report
    });
    assert(singleIndexed.chunksIndexed >= 1, "direct document should index at least one chunk");

    const bulkIndexed = await indexBulkDocuments({
      svcToken,
      collection,
      documents: [
        {
          docId: uploadDocId,
          title: "uploaded-diagnostic-notes.pdf",
          metadata: {
            source: "browser_file_upload",
            fileName: "uploaded-diagnostic-notes.pdf",
            mimeType: "application/pdf"
          },
          text: uploadLikeText
        },
        {
          docId: longDocId,
          title: "long-diagnostic-file.txt",
          metadata: {
            source: "bulk_long_form",
            fileName: "long-diagnostic-file.txt",
            mimeType: "text/plain"
          },
          text: longTailText
        }
      ],
      report
    });
    assert.equal(bulkIndexed.summary.failed, 0, "bulk indexing should succeed");
    assert(bulkIndexed.results.every((result) => result.ok === true), "all bulk results should be ok");
    const uploadBulk = bulkIndexed.results.find((result) => result.docId === uploadDocId);
    const longBulk = bulkIndexed.results.find((result) => result.docId === longDocId);
    assert(uploadBulk && uploadBulk.chunksIndexed >= 2, "upload-style document should produce multiple chunks");
    assert(longBulk && longBulk.chunksIndexed >= 3, "long-form document should produce multiple chunks");

    await verifyCollectionState({
      adminJwt,
      collection,
      expectedDocs: 3,
      report
    });

    const diagnosticSteps = [
      {
        stage: "direct-document",
        run: () => diagnoseDocument({
          label: "direct-document",
          svcToken,
          collection,
          docId: directDocId,
          searchQuery: directFact,
          question: "Who is the renewal contact in the direct diagnostic document?",
          booleanQuestion: "Does the direct diagnostic document state that the renewal contact is Maris Quill?",
          expectedSnippet: directFact,
          report
        })
      },
      {
        stage: "upload-style-document",
        run: () => diagnoseDocument({
          label: "upload-style-document",
          svcToken,
          collection,
          docId: uploadDocId,
          searchQuery: uploadFact,
          question: "Who is the finance approver in the uploaded diagnostic file?",
          booleanQuestion: "Does the uploaded diagnostic file say the finance approver is Miri Talbot?",
          expectedSnippet: uploadFact,
          report
        })
      },
      {
        stage: "long-tail-document",
        run: () => diagnoseDocument({
          label: "long-tail-document",
          svcToken,
          collection,
          docId: longDocId,
          searchQuery: longFact,
          question: "What is the release freeze codename in the long diagnostic file?",
          booleanQuestion: "Does the long diagnostic file say the release freeze codename is Copper Lantern?",
          expectedSnippet: longFact,
          report
        })
      },
      {
        stage: "url-document",
        run: () => maybeDiagnoseUrlDocument({
          svcToken,
          collection,
          report
        })
      },
      {
        stage: "delete-document",
        run: () => verifyDocumentDelete({
          svcToken,
          collection,
          docId: directDocId,
          searchQuery: directFact,
          report
        })
      },
      {
        stage: "delete-collection",
        run: () => verifyCollectionDelete({
          adminJwt,
          collection,
          report
        })
      }
    ];

    for (const step of diagnosticSteps) {
      try {
        await step.run();
      } catch (err) {
        recordFailure(report, step.stage, err);
      }
    }

    if (report.failures.length > 0) {
      throw new Error(`${report.failures.length} diagnostic stage(s) failed`);
    }

    if (svcTokenId) {
      await revokeServiceToken(adminJwt, svcTokenId);
      svcTokenId = null;
    }

    report.finishedAt = new Date().toISOString();
    printDiagnostics(report, console.log);
    console.log(`diagnostic_e2e tests passed against ${getBaseUrl()}`);
  } catch (err) {
    report.failedAt = new Date().toISOString();
    report.failure = {
      message: err.message,
      stack: err.stack
    };
    printDiagnostics(report, console.error);
    console.error("diagnostic_e2e tests failed");
    console.error(err);
    process.exit(1);
  } finally {
    if (svcTokenId && adminJwt) {
      try {
        await revokeServiceToken(adminJwt, svcTokenId);
      } catch (err) {
        console.warn(`cleanup warning: failed to revoke service token ${svcTokenId}: ${err.message}`);
      }
    }
    if (adminJwt) {
      try {
        await deleteCollectionWithAdmin(adminJwt, collection);
      } catch (err) {
        console.warn(`cleanup warning: failed to delete collection ${collection}: ${err.message}`);
      }
      try {
        await deleteDocWithAdmin(adminJwt, directDocId, collection);
      } catch (err) {
        console.warn(`cleanup warning: failed to delete doc ${directDocId}: ${err.message}`);
      }
      try {
        await deleteDocWithAdmin(adminJwt, uploadDocId, collection);
      } catch (err) {
        console.warn(`cleanup warning: failed to delete doc ${uploadDocId}: ${err.message}`);
      }
      try {
        await deleteDocWithAdmin(adminJwt, longDocId, collection);
      } catch (err) {
        console.warn(`cleanup warning: failed to delete doc ${longDocId}: ${err.message}`);
      }
    }
  }
})();

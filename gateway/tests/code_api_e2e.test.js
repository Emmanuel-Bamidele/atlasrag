const assert = require("assert");
const {
  requestJson,
  assertStatus,
  assertOkEnvelope,
  randomId,
  bearer,
  apiKey
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
      name: randomId("code-e2e-token"),
      principalId: randomId("code-e2e-principal"),
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

async function deleteDoc(adminJwt, docId) {
  const response = await requestJson("DELETE", `/v1/docs/${encodeURIComponent(docId)}`, {
    headers: bearer(adminJwt)
  });
  if (response.status === 200 || response.status === 400 || response.status === 404) return;
  throw new Error(`failed to delete doc ${docId}: status=${response.status} body=${response.text}`);
}

(async () => {
  const unique = randomId("code-e2e");
  const sessionDocId = `${unique}_session_doc`;
  const serverDocId = `${unique}_server_doc`;

  let adminJwt = null;
  let svcToken = null;
  let svcTokenId = null;

  try {
    adminJwt = await login();
    const serviceToken = await createServiceToken(adminJwt);
    svcToken = serviceToken.token;
    svcTokenId = serviceToken.id;

    const sessionIndexed = await requestJson("POST", "/v1/docs", {
      headers: {
        ...apiKey(svcToken),
        "Idempotency-Key": randomId("idem-code-session")
      },
      body: {
        docId: sessionDocId,
        sourceType: "code",
        title: "src/auth/session.ts",
        metadata: {
          repo: "ci/code-e2e",
          branch: "main",
          path: "src/auth/session.ts",
          language: "typescript"
        },
        text: [
          "export function validateSession(token: string) {",
          "  if (!token) throw new Error('missing token');",
          "  return token.startsWith('sess_');",
          "}"
        ].join("\n")
      }
    });
    assertStatus(sessionIndexed, 200, "/v1/docs session");

    const serverIndexed = await requestJson("POST", "/v1/docs", {
      headers: {
        ...apiKey(svcToken),
        "Idempotency-Key": randomId("idem-code-server")
      },
      body: {
        docId: serverDocId,
        sourceType: "code",
        title: "src/server.ts",
        metadata: {
          repo: "ci/code-e2e",
          branch: "main",
          path: "src/server.ts",
          language: "typescript"
        },
        text: [
          "import { validateSession } from './auth/session';",
          "const router = createRouter();",
          "",
          "export function startServer(token: string) {",
          "  return validateSession(token);",
          "}",
          "",
          "router.get('/health', healthHandler);"
        ].join("\n")
      }
    });
    assertStatus(serverIndexed, 200, "/v1/docs server");

    const coded = await requestJson("POST", "/v1/code", {
      headers: apiKey(svcToken),
      body: {
        question: "What connects src/server.ts to validateSession, and where is the route exposed?",
        task: "structure",
        language: "typescript",
        paths: ["src/server.ts", "src/auth/session.ts"],
        k: 6,
        docIds: [sessionDocId, serverDocId]
      }
    });
    assertStatus(coded, 200, "/v1/code");
    const codedData = assertOkEnvelope(coded, "/v1/code");
    assert(typeof codedData.answer === "string" && codedData.answer.length > 0, "code should return answer text");
    assert(Array.isArray(codedData.citations), "code should return citations");
    assert(Array.isArray(codedData.files), "code should return files");
    assert(Array.isArray(codedData.supportingChunks), "code should return supporting chunks");
    assert(Array.isArray(codedData.relationshipSummary?.connections), "code should return relationship summary");
    assert(codedData.files.some((file) => file.path === "src/server.ts"), "code should include src/server.ts");
    assert(codedData.files.some((file) => file.path === "src/auth/session.ts"), "code should include src/auth/session.ts");
    assert(
      codedData.relationshipSummary.connections.some((line) => /src\/server\.ts imports src\/auth\/session\.ts/.test(line))
      || codedData.relationshipSummary.connections.some((line) => /src\/server\.ts calls validateSession from src\/auth\/session\.ts/.test(line)),
      "relationship summary should describe the server/session connection"
    );
    assert(
      /validateSession|src\/auth\/session\.ts|GET \/health|healthHandler/i.test(codedData.answer),
      "code answer should mention the retrieved connection evidence"
    );

    console.log("code_api_e2e tests passed");
  } catch (err) {
    console.error("code_api_e2e tests failed");
    console.error(err);
    process.exitCode = 1;
  } finally {
    if (adminJwt) {
      await deleteDoc(adminJwt, sessionDocId).catch(() => {});
      await deleteDoc(adminJwt, serverDocId).catch(() => {});
    }
    if (adminJwt && svcTokenId) {
      await revokeServiceToken(adminJwt, svcTokenId).catch(() => {});
    }
  }
})();

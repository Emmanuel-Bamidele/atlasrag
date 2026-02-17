const assert = require("assert");
const crypto = require("crypto");

function getBaseUrl() {
  return String(process.env.E2E_BASE_URL || process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

function makeUrl(path, query) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getBaseUrl());
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function requestJson(method, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const body = options.body;
  const init = {
    method,
    headers
  };
  if (body !== undefined) {
    headers["content-type"] = headers["content-type"] || "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(makeUrl(path, options.query), init);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json
  };
}

function assertStatus(response, expectedStatus, message) {
  const prefix = message ? `${message}: ` : "";
  assert.strictEqual(
    response.status,
    expectedStatus,
    `${prefix}expected status ${expectedStatus}, got ${response.status}. Response: ${response.text}`
  );
}

function assertOkEnvelope(response, message) {
  assert(response.json && typeof response.json === "object", `${message || "response"} must be JSON`);
  assert.strictEqual(
    response.json.ok,
    true,
    `${message || "response"} should have ok=true. Response: ${response.text}`
  );
  assert(response.json.data && typeof response.json.data === "object", `${message || "response"} missing data envelope`);
  return response.json.data;
}

function randomId(prefix) {
  const cleanPrefix = String(prefix || "ci").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "ci";
  return `${cleanPrefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function apiKey(token) {
  return { "x-api-key": token };
}

module.exports = {
  requestJson,
  assertStatus,
  assertOkEnvelope,
  randomId,
  bearer,
  apiKey,
  getBaseUrl
};

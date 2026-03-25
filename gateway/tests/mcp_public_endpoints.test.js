const assert = require("assert");
const {
  requestJson,
  assertStatus,
  getBaseUrl
} = require("./_http");

async function callRpc(id, method, params) {
  const response = await requestJson("POST", "/mcp", {
    body: { jsonrpc: "2.0", id, method, params }
  });
  assertStatus(response, 200, `JSON-RPC ${method}`);
  assert(response.json && response.json.jsonrpc === "2.0", `invalid JSON-RPC payload for ${method}`);
  assert(!response.json.error, `${method} returned error: ${JSON.stringify(response.json.error)}`);
  return response.json.result;
}

(async () => {
  const health = await requestJson("GET", "/health");
  assertStatus(health, 200, "GET /health");
  assert.strictEqual(health.json?.ok, true, "/health should return ok=true");

  const llms = await requestJson("GET", "/llms.txt");
  assertStatus(llms, 200, "GET /llms.txt");
  assert(llms.text.includes("SupaVector"), "llms.txt should describe SupaVector");
  assert(llms.text.includes("/mcp"), "llms.txt should include MCP endpoint");

  const mcpInfo = await requestJson("GET", "/mcp");
  assertStatus(mcpInfo, 200, "GET /mcp");
  assert.strictEqual(mcpInfo.json?.ok, true, "/mcp should return ok=true");
  assert.strictEqual(mcpInfo.json?.transport, "http-jsonrpc", "unexpected MCP transport");

  const init = await callRpc(1, "initialize", { protocolVersion: "2024-11-05" });
  assert(init.serverInfo && init.serverInfo.name, "initialize should return serverInfo");

  const toolsList = await callRpc(2, "tools/list", {});
  assert(Array.isArray(toolsList.tools), "tools/list should return tools");
  assert(toolsList.tools.some((t) => t.name === "search_docs"), "search_docs tool should exist");

  const toolCall = await callRpc(3, "tools/call", {
    name: "search_docs",
    arguments: { query: "SupaVector API documentation", top_k: 3 }
  });
  assert(Array.isArray(toolCall.content), "tools/call should return content");
  assert(toolCall.content.length > 0, "tools/call content should not be empty");

  const resourcesList = await callRpc(4, "resources/list", {});
  assert(Array.isArray(resourcesList.resources), "resources/list should return resources array");
  assert(resourcesList.resources.length > 0, "resources/list should expose at least one page");

  const firstUri = resourcesList.resources[0].uri;
  const readResource = await callRpc(5, "resources/read", { uri: firstUri });
  assert(Array.isArray(readResource.contents), "resources/read should return contents");
  assert(readResource.contents[0]?.text?.length > 0, "resources/read should include content text");

  console.log(`mcp_public_endpoints tests passed against ${getBaseUrl()}`);
})().catch((err) => {
  console.error("mcp_public_endpoints tests failed");
  console.error(err);
  process.exit(1);
});

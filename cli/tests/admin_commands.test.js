const assert = require("assert/strict");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join("bin", "supavector.js"), ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...env
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || "")
        });
      }
    );
  });
}

async function withMockServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        const parsedBody = body ? JSON.parse(body) : null;
        requests.push({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: req.headers,
          body: parsedBody
        });
        const response = await handler({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: req.headers,
          body: parsedBody
        });
        res.statusCode = response.status || 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response.body || { ok: true, data: {}, meta: {} }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: { message: String(err.message || err) }
        }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ baseUrl, requests });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function testTenantTokenCreateCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/admin/service-tokens");
    assert.equal(req.headers["x-api-key"], "supav_test_token");
    assert.deepEqual(req.body, {
      name: "worker-prod",
      principalId: "worker-prod",
      expiresAt: "2030-01-01T00:00:00.000Z",
      roles: ["reader", "indexer"]
    });
    return {
      body: {
        ok: true,
        data: {
          token: "supav_created_token",
          tokenInfo: {
            id: 7,
            tenantId: "default",
            name: "worker-prod",
            principalId: "worker-prod",
            roles: ["reader", "indexer"],
            expiresAt: "2030-01-01T00:00:00.000Z"
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "tokens",
      "create",
      "--name",
      "worker-prod",
      "--principal-id",
      "worker-prod",
      "--roles",
      "reader,indexer",
      "--expires-at",
      "2030-01-01T00:00:00.000Z",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.token, "supav_created_token");
    assert.equal(payload.data.tokenInfo.id, 7);
  });
}

async function testTenantUpdateCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "PATCH");
    assert.equal(req.path, "/v1/admin/tenant");
    assert.deepEqual(req.body, {
      authMode: "sso_only",
      ssoProviders: ["google", "okta"],
      ssoConfig: {
        google: {
          clientId: "google-client",
          tenantClaim: "tid"
        }
      },
      answerProvider: "openai",
      answerModel: "gpt-4o"
    });
    return {
      body: {
        ok: true,
        data: {
          tenant: {
            id: "default",
            authMode: "sso_only",
            ssoProviders: ["google", "okta"],
            ssoConfig: {
              google: {
                clientId: "google-client",
                tenantClaim: "tid"
              }
            },
            models: {
              effective: {
                answerProvider: "openai",
                answerModel: "gpt-4o"
              }
            }
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "tenant",
      "update",
      "--auth-mode",
      "sso_only",
      "--sso-providers",
      "google,okta",
      "--sso-config-json",
      "{\"google\":{\"clientId\":\"google-client\",\"tenantClaim\":\"tid\"}}",
      "--answer-provider",
      "openai",
      "--answer-model",
      "gpt-4o",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.tenant.authMode, "sso_only");
    assert.equal(payload.data.tenant.models.effective.answerModel, "gpt-4o");
  });
}

async function testEnterpriseTenantCreateCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/admin/tenants");
    assert.deepEqual(req.body, {
      tenantId: "acme-prod",
      name: "Acme Prod",
      externalId: "acct_123",
      metadata: {
        plan: "enterprise",
        region: "us"
      },
      bootstrapAdmin: {
        username: "acme-admin",
        password: "SupaVectorPass123!",
        roles: ["admin", "indexer", "reader"],
        email: "admin@acme.example",
        fullName: "Acme Admin"
      },
      bootstrapServiceToken: {
        name: "acme-runtime",
        roles: ["reader", "indexer"]
      }
    });
    return {
      body: {
        ok: true,
        data: {
          tenant: {
            id: "acme-prod",
            name: "Acme Prod",
            externalId: "acct_123",
            metadata: {
              plan: "enterprise",
              region: "us"
            }
          },
          bootstrapAdmin: {
            user: {
              id: 21,
              username: "acme-admin"
            }
          },
          bootstrapServiceToken: {
            token: "supav_bootstrap_token",
            tokenInfo: {
              id: 31,
              name: "acme-runtime"
            }
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "tenants",
      "create",
      "--tenant",
      "acme-prod",
      "--name",
      "Acme Prod",
      "--external-id",
      "acct_123",
      "--metadata-json",
      "{\"plan\":\"enterprise\",\"region\":\"us\"}",
      "--bootstrap-admin",
      "acme-admin",
      "--bootstrap-admin-password",
      "SupaVectorPass123!",
      "--bootstrap-admin-roles",
      "admin,indexer,reader",
      "--bootstrap-admin-email",
      "admin@acme.example",
      "--bootstrap-admin-full-name",
      "Acme Admin",
      "--bootstrap-token-name",
      "acme-runtime",
      "--bootstrap-token-roles",
      "reader,indexer",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_TOKEN: "jwt_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.tenant.id, "acme-prod");
    assert.equal(payload.data.bootstrapServiceToken.token, "supav_bootstrap_token");
  });
}

async function testAuditListCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/v1/admin/tenants/acme-prod/audit");
    assert.deepEqual(req.query, {
      limit: "25",
      action: "tenant.settings.update"
    });
    return {
      body: {
        ok: true,
        data: {
          logs: [
            {
              id: 1,
              tenantId: "acme-prod",
              action: "tenant.settings.update"
            }
          ]
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "audit",
      "list",
      "--tenant",
      "acme-prod",
      "--limit",
      "25",
      "--action",
      "tenant.settings.update",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.logs.length, 1);
    assert.equal(payload.data.logs[0].tenantId, "acme-prod");
  });
}

async function main() {
  await testTenantTokenCreateCommand();
  await testTenantUpdateCommand();
  await testEnterpriseTenantCreateCommand();
  await testAuditListCommand();
  console.log("admin_commands.test.js passed");
}

main().catch((err) => {
  console.error(err.stack || String(err.message || err));
  process.exit(1);
});

const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const {
  __testHooks: {
    normalizeRuntimeRoleList,
    normalizeTenantIdentifier,
    parseTenantMetadataInput,
    formatTenantRecord,
    buildPublicRegistrationProjectName,
    slugifyPublicRegistrationProjectBase,
    buildPublicRegistrationTenantId,
    buildPublicRegistrationInstructions
  }
} = require("../index");
const {
  __testHooks: {
    parseRoles
  }
} = require("../scripts/bootstrap_instance");

function testNormalizeRuntimeRoleListAllowsInstanceAdminAliases() {
  const roles = normalizeRuntimeRoleList(["platform_admin", "reader"], {
    allowInstanceAdmin: true,
    allowEmpty: false
  });
  assert.deepEqual(roles, ["instance_admin", "reader"]);
}

function testNormalizeRuntimeRoleListRejectsInstanceAdminByDefault() {
  assert.throws(
    () => normalizeRuntimeRoleList(["instance_admin"], { allowEmpty: false }),
    /roles must be one of: admin, indexer, reader/
  );
  assert.throws(
    () => normalizeRuntimeRoleList(undefined, { allowEmpty: false }),
    /roles must include at least one of: admin, indexer, reader/
  );
}

function testNormalizeTenantIdentifierRejectsInvalidValues() {
  assert.equal(normalizeTenantIdentifier("acme-prod"), "acme-prod");
  assert.throws(
    () => normalizeTenantIdentifier("bad tenant"),
    /tenantId must use only letters, numbers, dot, dash, or underscore/
  );
}

function testParseTenantMetadataInputRequiresObject() {
  assert.deepEqual(parseTenantMetadataInput({ plan: "enterprise" }), { plan: "enterprise" });
  assert.throws(
    () => parseTenantMetadataInput(["not", "allowed"]),
    /metadata must be an object/
  );
}

function testFormatTenantRecordIncludesExternalFieldsAndSummary() {
  const payload = formatTenantRecord({
    tenant_id: "acme-prod",
    name: "Acme Production",
    external_id: "crm-123",
    metadata: { region: "us" },
    auth_mode: "sso_only",
    sso_providers: ["okta"],
    sso_config: {},
    answer_provider: null,
    answer_model: null,
    boolean_ask_provider: null,
    boolean_ask_model: null,
    reflect_provider: null,
    reflect_model: null,
    compact_provider: null,
    compact_model: null,
    created_at: "2026-03-26T00:00:00.000Z",
    user_count: 7,
    service_token_count: 3
  }, {
    summary: {
      storageBytes: 4096
    }
  });

  assert.equal(payload.id, "acme-prod");
  assert.equal(payload.externalId, "crm-123");
  assert.deepEqual(payload.metadata, { region: "us" });
  assert.deepEqual(payload.summary, {
    userCount: 7,
    serviceTokenCount: 3,
    storageBytes: 4096
  });
}

function testBootstrapParseRolesSupportsInstanceAdmin() {
  assert.deepEqual(
    parseRoles("instance_admin,admin,indexer,reader", ""),
    ["instance_admin", "admin", "indexer", "reader"]
  );
}

function testBuildPublicRegistrationProjectNameFallsBackCleanly() {
  assert.equal(
    buildPublicRegistrationProjectName({ projectName: "Customer Support", fullName: "Ignored User", username: "ignored" }),
    "Customer Support"
  );
  assert.equal(
    buildPublicRegistrationProjectName({ fullName: "Ava Quinn", username: "ava" }),
    "Ava Quinn's Project"
  );
  assert.equal(
    buildPublicRegistrationProjectName({ username: "ava" }),
    "ava Project"
  );
}

function testPublicRegistrationTenantSlugHelpers() {
  assert.equal(
    slugifyPublicRegistrationProjectBase("Northwind Customer Support"),
    "northwind-customer-support"
  );
  assert.equal(
    buildPublicRegistrationTenantId({ projectName: "Northwind Customer Support", suffix: "abc123" }),
    "northwind-customer-support-abc123"
  );
}

function testBuildPublicRegistrationInstructionsIncludesSdkUsage() {
  const payload = buildPublicRegistrationInstructions("https://api.supavector.test");
  assert.equal(payload.baseUrl, "https://api.supavector.test");
  assert.equal(payload.installCommand, "pip install supavector");
  assert(payload.env.includes("SUPAVECTOR_API_KEY=<paste-the-copied-service-token>"));
  assert(payload.python.some((line) => line.includes("Client")));
  assert(payload.python.some((line) => line.includes('collection="default"')));
}

function main() {
  testNormalizeRuntimeRoleListAllowsInstanceAdminAliases();
  testNormalizeRuntimeRoleListRejectsInstanceAdminByDefault();
  testNormalizeTenantIdentifierRejectsInvalidValues();
  testParseTenantMetadataInputRequiresObject();
  testFormatTenantRecordIncludesExternalFieldsAndSummary();
  testBootstrapParseRolesSupportsInstanceAdmin();
  testBuildPublicRegistrationProjectNameFallsBackCleanly();
  testPublicRegistrationTenantSlugHelpers();
  testBuildPublicRegistrationInstructionsIncludesSdkUsage();
  console.log("enterprise control plane tests passed");
}

main();

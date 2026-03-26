const assert = require("assert/strict");

const {
  buildTenantSsoConfigPublic,
  deriveSsoRoles,
  isEmailAllowedForProvider,
  normalizeControlPlaneRoleList,
  normalizeTenantSsoConfigInput,
  resolveSsoProviderConfig
} = require("../enterprise_auth");

function testResolveSsoProviderConfigPrefersTenantOverride() {
  const tenant = {
    sso_config: {
      google: {
        enabled: true,
        issuer: "https://accounts.google.com",
        clientId: "tenant-google-client",
        clientSecret: "tenant-secret",
        scopes: "openid email profile",
        tenantClaim: "hd",
        roleClaim: "groups",
        allowedDomains: ["acme.com"],
        defaultRoles: ["reader"],
        roleMappings: {}
      }
    }
  };

  const cfg = resolveSsoProviderConfig({
    tenant,
    provider: "google",
    env: {
      OIDC_GOOGLE_CLIENT_ID: "env-google-client",
      OIDC_GOOGLE_CLIENT_SECRET: "env-secret",
      OIDC_GOOGLE_ISSUER: "https://env.example.com"
    }
  });

  assert.equal(cfg.source, "tenant");
  assert.equal(cfg.clientId, "tenant-google-client");
  assert.deepEqual(cfg.allowedDomains, ["acme.com"]);
}

function testResolveSsoProviderConfigFallsBackToEnv() {
  const cfg = resolveSsoProviderConfig({
    tenant: { sso_config: {} },
    provider: "azure",
    env: {
      OIDC_AZURE_CLIENT_ID: "env-azure-client",
      OIDC_AZURE_CLIENT_SECRET: "env-azure-secret",
      OIDC_AZURE_ISSUER: "https://login.microsoftonline.com/common/v2.0",
      OIDC_AZURE_ALLOWED_DOMAINS: "acme.com,ops.acme.com",
      OIDC_AZURE_DEFAULT_ROLES: "reader,indexer"
    }
  });

  assert.equal(cfg.source, "instance");
  assert.equal(cfg.clientId, "env-azure-client");
  assert.deepEqual(cfg.allowedDomains, ["acme.com", "ops.acme.com"]);
  assert.deepEqual(cfg.defaultRoles, ["reader", "indexer"]);
}

function testNormalizeTenantSsoConfigKeepsAndClearsClientSecret() {
  const previous = {
    google: {
      enabled: true,
      issuer: "https://accounts.google.com",
      clientId: "prev-client",
      clientSecret: "prev-secret",
      scopes: "openid email profile",
      tenantClaim: "hd",
      roleClaim: "groups",
      allowedDomains: [],
      defaultRoles: ["reader"],
      roleMappings: {}
    }
  };

  const preserved = normalizeTenantSsoConfigInput({
    google: {
      enabled: true,
      clientId: "next-client",
      issuer: "https://accounts.google.com"
    }
  }, previous);
  assert.equal(preserved.google.clientSecret, "prev-secret");
  assert.equal(preserved.google.clientId, "next-client");

  const cleared = normalizeTenantSsoConfigInput({
    google: {
      clearClientSecret: true
    }
  }, previous);
  assert.equal(cleared.google.clientSecret, "");
}

function testBuildTenantSsoConfigPublicMasksSecrets() {
  const result = buildTenantSsoConfigPublic({
    okta: {
      enabled: true,
      issuer: "https://acme.okta.com/oauth2/default",
      clientId: "okta-client",
      clientSecret: "super-secret",
      scopes: "openid email profile",
      tenantClaim: "iss",
      roleClaim: "groups",
      allowedDomains: ["acme.com"],
      defaultRoles: ["reader"],
      roleMappings: { Admins: ["admin"] }
    }
  });

  assert.equal(result.okta.hasClientSecret, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.okta, "clientSecret"), false);
  assert.deepEqual(result.okta.roleMappings, { Admins: ["admin"] });
}

function testDeriveSsoRolesMergesExistingDefaultsAndMappings() {
  const roles = deriveSsoRoles({
    claims: { groups: ["SupaVector-Admins", "ignored"] },
    providerConfig: {
      roleClaim: "groups",
      defaultRoles: ["indexer"],
      roleMappings: {
        "SupaVector-Admins": ["admin", "reader"]
      }
    },
    existingRoles: ["reader"]
  }).sort();

  assert.deepEqual(roles, ["admin", "indexer", "reader"]);
}

function testIsEmailAllowedForProviderHonorsDomainAllowlist() {
  assert.equal(isEmailAllowedForProvider("admin@acme.com", ["acme.com"]), true);
  assert.equal(isEmailAllowedForProvider("admin@other.com", ["acme.com"]), false);
  assert.equal(isEmailAllowedForProvider("missing-domain", ["acme.com"]), false);
  assert.equal(isEmailAllowedForProvider("admin@acme.com", []), true);
}

function testNormalizeControlPlaneRoleListSupportsInstanceAdmin() {
  assert.deepEqual(
    normalizeControlPlaneRoleList(["instance_admin", "admin"], { allowEmpty: false }),
    ["instance_admin", "admin"]
  );
  assert.throws(
    () => normalizeControlPlaneRoleList(undefined, { allowEmpty: false }),
    /roles must include at least one of: instance_admin, admin, indexer, reader/
  );
  assert.throws(
    () => normalizeControlPlaneRoleList(["instance_admin"], { allowEmpty: false, allowInstanceAdmin: false }),
    /roles must be one of: admin, indexer, reader/
  );
}

function main() {
  testResolveSsoProviderConfigPrefersTenantOverride();
  testResolveSsoProviderConfigFallsBackToEnv();
  testNormalizeTenantSsoConfigKeepsAndClearsClientSecret();
  testBuildTenantSsoConfigPublicMasksSecrets();
  testDeriveSsoRolesMergesExistingDefaultsAndMappings();
  testIsEmailAllowedForProviderHonorsDomainAllowlist();
  testNormalizeControlPlaneRoleListSupportsInstanceAdmin();
  console.log("enterprise auth tests passed");
}

main();

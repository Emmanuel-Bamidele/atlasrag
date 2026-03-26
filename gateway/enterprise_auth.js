const { normalizeProviderId } = require("./model_config");

const INSTANCE_ADMIN_ROLE = "instance_admin";
const ENTERPRISE_SSO_PROVIDERS = ["google", "azure", "okta"];
const ENTERPRISE_ROLE_VALUES = ["admin", "indexer", "reader"];
const ENTERPRISE_CONTROL_ROLE_VALUES = [INSTANCE_ADMIN_ROLE, ...ENTERPRISE_ROLE_VALUES];

function normalizeString(value) {
  const clean = String(value || "").trim();
  return clean || "";
}

function normalizeRoleEntries(raw, allowedRoles, { allowEmpty = true } = {}) {
  if (raw === undefined || raw === null) {
    if (!allowEmpty) {
      throw new Error(`roles must include at least one of: ${allowedRoles.join(", ")}`);
    }
    return [];
  }
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    if (!allowedRoles.includes(clean)) {
      throw new Error(`roles must be one of: ${allowedRoles.join(", ")}`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  if (!allowEmpty && out.length === 0) {
    throw new Error(`roles must include at least one of: ${allowedRoles.join(", ")}`);
  }
  return out;
}

function normalizeRoleList(raw, { allowEmpty = true } = {}) {
  return normalizeRoleEntries(raw, ENTERPRISE_ROLE_VALUES, { allowEmpty });
}

function normalizeControlPlaneRoleList(raw, { allowEmpty = true, allowInstanceAdmin = true } = {}) {
  const allowed = allowInstanceAdmin ? ENTERPRISE_CONTROL_ROLE_VALUES : ENTERPRISE_ROLE_VALUES;
  return normalizeRoleEntries(raw, allowed, { allowEmpty });
}

function normalizeDomainList(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    const domain = clean.replace(/^@+/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      throw new Error("allowedDomains must be valid email domains");
    }
    if (!seen.has(domain)) {
      seen.add(domain);
      out.push(domain);
    }
  }
  return out;
}

function normalizeRoleMappingsInput(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("roleMappings must be an object whose keys are claim values and values are role arrays");
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const cleanKey = normalizeString(key);
    if (!cleanKey) continue;
    out[cleanKey] = normalizeRoleList(value, { allowEmpty: true }) || [];
  }
  return out;
}

function buildEnvProviderConfig(provider, env = process.env) {
  const cleanProvider = normalizeProviderId(provider);
  if (cleanProvider === "google") {
    return {
      provider: "google",
      issuer: normalizeString(env.OIDC_GOOGLE_ISSUER) || "https://accounts.google.com",
      clientId: normalizeString(env.OIDC_GOOGLE_CLIENT_ID),
      clientSecret: normalizeString(env.OIDC_GOOGLE_CLIENT_SECRET),
      scopes: normalizeString(env.OIDC_GOOGLE_SCOPES) || "openid email profile",
      tenantClaim: normalizeString(env.OIDC_GOOGLE_TENANT_CLAIM) || "hd",
      roleClaim: normalizeString(env.OIDC_GOOGLE_ROLE_CLAIM) || "groups",
      allowedDomains: normalizeDomainList(env.OIDC_GOOGLE_ALLOWED_DOMAINS) || [],
      defaultRoles: normalizeRoleList(env.OIDC_GOOGLE_DEFAULT_ROLES, { allowEmpty: true }) || [],
      roleMappings: {}
    };
  }
  if (cleanProvider === "azure") {
    return {
      provider: "azure",
      issuer: normalizeString(env.OIDC_AZURE_ISSUER),
      clientId: normalizeString(env.OIDC_AZURE_CLIENT_ID),
      clientSecret: normalizeString(env.OIDC_AZURE_CLIENT_SECRET),
      scopes: normalizeString(env.OIDC_AZURE_SCOPES) || "openid email profile",
      tenantClaim: normalizeString(env.OIDC_AZURE_TENANT_CLAIM) || "tid",
      roleClaim: normalizeString(env.OIDC_AZURE_ROLE_CLAIM) || "groups",
      allowedDomains: normalizeDomainList(env.OIDC_AZURE_ALLOWED_DOMAINS) || [],
      defaultRoles: normalizeRoleList(env.OIDC_AZURE_DEFAULT_ROLES, { allowEmpty: true }) || [],
      roleMappings: {}
    };
  }
  if (cleanProvider === "okta") {
    return {
      provider: "okta",
      issuer: normalizeString(env.OIDC_OKTA_ISSUER),
      clientId: normalizeString(env.OIDC_OKTA_CLIENT_ID),
      clientSecret: normalizeString(env.OIDC_OKTA_CLIENT_SECRET),
      scopes: normalizeString(env.OIDC_OKTA_SCOPES) || "openid email profile",
      tenantClaim: normalizeString(env.OIDC_OKTA_TENANT_CLAIM) || "iss",
      roleClaim: normalizeString(env.OIDC_OKTA_ROLE_CLAIM) || "groups",
      allowedDomains: normalizeDomainList(env.OIDC_OKTA_ALLOWED_DOMAINS) || [],
      defaultRoles: normalizeRoleList(env.OIDC_OKTA_DEFAULT_ROLES, { allowEmpty: true }) || [],
      roleMappings: {}
    };
  }
  return null;
}

function normalizeTenantProviderConfig(provider, input = {}, previous = null) {
  const cleanProvider = normalizeProviderId(provider);
  if (!ENTERPRISE_SSO_PROVIDERS.includes(cleanProvider)) {
    throw new Error(`provider must be one of: ${ENTERPRISE_SSO_PROVIDERS.join(", ")}`);
  }
  const current = previous && typeof previous === "object" ? previous : {};
  const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled);
  const issuer = input.issuer === undefined ? normalizeString(current.issuer) : normalizeString(input.issuer);
  const clientId = input.clientId === undefined ? normalizeString(current.clientId) : normalizeString(input.clientId);
  const rawClientSecret = input.clientSecret;
  const keepExistingSecret = rawClientSecret === undefined || rawClientSecret === null || rawClientSecret === "";
  const clearClientSecret = input.clearClientSecret === true;
  const clientSecret = clearClientSecret
    ? ""
    : (keepExistingSecret ? normalizeString(current.clientSecret) : normalizeString(rawClientSecret));
  const scopes = input.scopes === undefined
    ? normalizeString(current.scopes) || "openid email profile"
    : normalizeString(input.scopes) || "openid email profile";
  const tenantClaim = input.tenantClaim === undefined
    ? normalizeString(current.tenantClaim)
    : normalizeString(input.tenantClaim);
  const roleClaim = input.roleClaim === undefined
    ? normalizeString(current.roleClaim) || "groups"
    : normalizeString(input.roleClaim) || "groups";
  const allowedDomains = input.allowedDomains === undefined
    ? (Array.isArray(current.allowedDomains) ? normalizeDomainList(current.allowedDomains) : [])
    : normalizeDomainList(input.allowedDomains);
  const defaultRoles = input.defaultRoles === undefined
    ? (Array.isArray(current.defaultRoles) ? normalizeRoleList(current.defaultRoles, { allowEmpty: true }) : [])
    : (normalizeRoleList(input.defaultRoles, { allowEmpty: true }) || []);
  const roleMappings = input.roleMappings === undefined
    ? normalizeRoleMappingsInput(current.roleMappings || {}) || {}
    : (normalizeRoleMappingsInput(input.roleMappings) || {});
  return {
    enabled,
    issuer,
    clientId,
    clientSecret,
    scopes,
    tenantClaim,
    roleClaim,
    allowedDomains,
    defaultRoles,
    roleMappings
  };
}

function normalizeTenantSsoConfigInput(raw, previous = {}) {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ssoConfig must be an object keyed by provider");
  }
  const out = {};
  for (const provider of ENTERPRISE_SSO_PROVIDERS) {
    const nextInput = raw[provider];
    const prevInput = previous && typeof previous === "object" ? previous[provider] : null;
    if (nextInput === undefined) {
      if (prevInput && typeof prevInput === "object") out[provider] = normalizeTenantProviderConfig(provider, prevInput, prevInput);
      continue;
    }
    out[provider] = normalizeTenantProviderConfig(provider, nextInput, prevInput);
  }
  return out;
}

function buildTenantSsoConfigPublic(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const provider of ENTERPRISE_SSO_PROVIDERS) {
    const item = source[provider];
    if (!item || typeof item !== "object") continue;
    out[provider] = {
      enabled: Boolean(item.enabled),
      issuer: normalizeString(item.issuer) || "",
      clientId: normalizeString(item.clientId) || "",
      hasClientSecret: Boolean(normalizeString(item.clientSecret)),
      scopes: normalizeString(item.scopes) || "",
      tenantClaim: normalizeString(item.tenantClaim) || "",
      roleClaim: normalizeString(item.roleClaim) || "",
      allowedDomains: Array.isArray(item.allowedDomains) ? normalizeDomainList(item.allowedDomains) || [] : [],
      defaultRoles: Array.isArray(item.defaultRoles) ? normalizeRoleList(item.defaultRoles, { allowEmpty: true }) || [] : [],
      roleMappings: normalizeRoleMappingsInput(item.roleMappings || {}) || {}
    };
  }
  return out;
}

function resolveTenantProviderConfig(tenant, provider) {
  const cleanProvider = normalizeProviderId(provider);
  const rawConfig = tenant?.sso_config && typeof tenant.sso_config === "object" ? tenant.sso_config : {};
  const item = rawConfig?.[cleanProvider];
  if (!item || typeof item !== "object") return null;
  return normalizeTenantProviderConfig(cleanProvider, item, item);
}

function resolveSsoProviderConfig({ tenant, provider, env = process.env } = {}) {
  const cleanProvider = normalizeProviderId(provider);
  if (!ENTERPRISE_SSO_PROVIDERS.includes(cleanProvider)) return null;
  const tenantConfig = resolveTenantProviderConfig(tenant, cleanProvider);
  if (tenantConfig && tenantConfig.enabled && tenantConfig.issuer && tenantConfig.clientId && tenantConfig.clientSecret) {
    return { ...tenantConfig, provider: cleanProvider, source: "tenant" };
  }
  const envConfig = buildEnvProviderConfig(cleanProvider, env);
  if (envConfig && envConfig.issuer && envConfig.clientId && envConfig.clientSecret) {
    return { ...envConfig, source: "instance" };
  }
  return null;
}

function getClaimValues(claims, claimName) {
  const cleanName = normalizeString(claimName);
  if (!cleanName) return [];
  const value = claims?.[cleanName];
  if (value === undefined || value === null) return [];
  const rawValues = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const clean = normalizeString(raw);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function getEmailDomain(email) {
  const clean = normalizeString(email).toLowerCase();
  const idx = clean.lastIndexOf("@");
  if (idx === -1) return "";
  return clean.slice(idx + 1);
}

function isEmailAllowedForProvider(email, allowedDomains) {
  const normalized = Array.isArray(allowedDomains) ? normalizeDomainList(allowedDomains) || [] : [];
  if (!normalized.length) return true;
  const domain = getEmailDomain(email);
  if (!domain) return false;
  return normalized.includes(domain);
}

function deriveSsoRoles({ claims = {}, providerConfig = {}, existingRoles = [] } = {}) {
  const currentRoles = normalizeRoleList(existingRoles, { allowEmpty: true }) || [];
  const defaultRoles = normalizeRoleList(providerConfig.defaultRoles, { allowEmpty: true }) || [];
  const roleMappings = normalizeRoleMappingsInput(providerConfig.roleMappings || {}) || {};
  const claimValues = getClaimValues(claims, providerConfig.roleClaim || "groups");
  const merged = new Set([...currentRoles, ...defaultRoles]);
  for (const value of claimValues) {
    const mapped = roleMappings[value] || [];
    for (const role of mapped) {
      if (ENTERPRISE_ROLE_VALUES.includes(role)) merged.add(role);
    }
  }
  return Array.from(merged);
}

module.exports = {
  INSTANCE_ADMIN_ROLE,
  ENTERPRISE_SSO_PROVIDERS,
  ENTERPRISE_ROLE_VALUES,
  ENTERPRISE_CONTROL_ROLE_VALUES,
  normalizeRoleList,
  normalizeControlPlaneRoleList,
  normalizeDomainList,
  normalizeRoleMappingsInput,
  normalizeTenantProviderConfig,
  normalizeTenantSsoConfigInput,
  buildTenantSsoConfigPublic,
  buildEnvProviderConfig,
  resolveTenantProviderConfig,
  resolveSsoProviderConfig,
  getClaimValues,
  isEmailAllowedForProvider,
  deriveSsoRoles
};

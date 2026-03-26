// sso.js
// OIDC helpers for Google, Azure AD (Entra), and Okta.

const { Issuer, generators } = require("openid-client");
const {
  buildEnvProviderConfig,
  deriveSsoRoles,
  isEmailAllowedForProvider,
  resolveSsoProviderConfig
} = require("./enterprise_auth");

const clientCache = new Map();

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

function requireProviderConfig(provider, cfg) {
  if (!cfg || !cfg.issuer || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(`OIDC config missing for ${provider}`);
  }
}

function getRedirectUri(provider) {
  return `${getPublicBaseUrl()}/auth/${provider}/callback`;
}

async function getClient(provider, cfgOverride = null) {
  const cfg = cfgOverride || buildEnvProviderConfig(provider, process.env);
  requireProviderConfig(provider, cfg);

  const cacheKey = `${provider}:${cfg.issuer}:${cfg.clientId}`;
  const cached = clientCache.get(cacheKey);
  if (cached && cached.issuer === cfg.issuer && cached.clientId === cfg.clientId) {
    return cached;
  }

  const issuer = await Issuer.discover(cfg.issuer);
  const client = new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [getRedirectUri(provider)],
    response_types: ["code"]
  });

  const entry = { client, cfg, issuer: cfg.issuer, clientId: cfg.clientId };
  clientCache.set(cacheKey, entry);
  return entry;
}

function buildStateCookie(provider, data) {
  return `oidc_${provider}`;
}

function resolveTenant(claims, cfg) {
  const keys = [cfg.tenantClaim, "tenant", "tid", "hd", "iss", "sub"];
  for (const key of keys) {
    if (key && claims[key]) {
      const raw = String(claims[key]);
      if (raw.includes("://")) {
        try {
          const url = new URL(raw);
          return url.hostname;
        } catch {
          return raw;
        }
      }
      return raw;
    }
  }
  return "";
}

function getUserProfile(claims) {
  const email = claims.email || claims.preferred_username || "";
  const name = claims.name || claims.given_name || "";
  return { email: String(email), name: String(name) };
}

module.exports = {
  generators,
  buildEnvProviderConfig,
  deriveSsoRoles,
  getClient,
  getRedirectUri,
  buildStateCookie,
  isEmailAllowedForProvider,
  resolveSsoProviderConfig,
  resolveTenant,
  getUserProfile
};

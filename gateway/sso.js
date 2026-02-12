// sso.js
// OIDC helpers for Google, Azure AD (Entra), and Okta.

const { Issuer, generators } = require("openid-client");

const clientCache = new Map();

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

function getProviderConfig(provider) {
  switch (provider) {
    case "google":
      return {
        issuer: process.env.OIDC_GOOGLE_ISSUER || "https://accounts.google.com",
        clientId: process.env.OIDC_GOOGLE_CLIENT_ID,
        clientSecret: process.env.OIDC_GOOGLE_CLIENT_SECRET,
        scopes: "openid email profile",
        tenantClaim: process.env.OIDC_GOOGLE_TENANT_CLAIM || "hd"
      };
    case "azure":
      return {
        issuer: process.env.OIDC_AZURE_ISSUER,
        clientId: process.env.OIDC_AZURE_CLIENT_ID,
        clientSecret: process.env.OIDC_AZURE_CLIENT_SECRET,
        scopes: "openid email profile",
        tenantClaim: process.env.OIDC_AZURE_TENANT_CLAIM || "tid"
      };
    case "okta":
      return {
        issuer: process.env.OIDC_OKTA_ISSUER,
        clientId: process.env.OIDC_OKTA_CLIENT_ID,
        clientSecret: process.env.OIDC_OKTA_CLIENT_SECRET,
        scopes: "openid email profile",
        tenantClaim: process.env.OIDC_OKTA_TENANT_CLAIM || "iss"
      };
    default:
      return null;
  }
}

function requireProviderConfig(provider, cfg) {
  if (!cfg || !cfg.issuer || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(`OIDC config missing for ${provider}`);
  }
}

function getRedirectUri(provider) {
  return `${getPublicBaseUrl()}/auth/${provider}/callback`;
}

async function getClient(provider) {
  const cfg = getProviderConfig(provider);
  requireProviderConfig(provider, cfg);

  const cached = clientCache.get(provider);
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
  clientCache.set(provider, entry);
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
  getClient,
  getRedirectUri,
  buildStateCookie,
  resolveTenant,
  getUserProfile
};

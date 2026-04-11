const assert = require("assert");
const fs = require("fs");
const path = require("path");

const studioPluginPath = path.join(__dirname, "..", "plugins", "studio.js");

if (!fs.existsSync(studioPluginPath)) {
  console.log("public chat seo tests skipped: hosted portal plugin not available");
  process.exit(0);
}

const studio = require("../plugins/studio");
const hooks = studio.__testHooks;

function makeRequest(pathname = "/sitemap.xml") {
  return {
    path: pathname,
    protocol: "https",
    get(name) {
      const key = String(name || "").toLowerCase();
      if (key === "host") return "supavector.com";
      if (key === "x-forwarded-proto") return "https";
      if (key === "x-forwarded-host") return "supavector.com";
      return "";
    }
  };
}

function makeBrain({
  name = "Acme Support",
  description = "Answers questions grounded in the published Memory.",
  shareId = "public-acme",
  mode = "open",
  discoverable = true
} = {}) {
  return {
    name,
    description,
    portalProjectName: "Acme",
    publicAccess: {
      enabled: true,
      shareId,
      path: `/agents/${shareId}`,
      mode,
      about: description,
      discovery: {
        discoverable
      },
      references: [
        { label: "Docs", url: "https://example.com/docs" }
      ]
    },
    verification: {
      status: "verified",
      verified: true,
      badgeLabel: "Verified"
    }
  };
}

async function run() {
  const missing = await hooks.resolvePublicAgentShell("/agents/missing-share", "https://supavector.com", {
    getPublicBrainRowByShareId: async () => null,
    formatBrainRecord: () => null
  });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.html, /Public chat not found/i);
  assert.match(missing.html, /noindex,nofollow/i);

  const openBrain = makeBrain({ shareId: "open-public", mode: "open", discoverable: true });
  const openResult = await hooks.resolvePublicAgentShell("/agents/open-public", "https://supavector.com", {
    getPublicBrainRowByShareId: async () => ({ public_access_config: { mode: "open", discovery: { discoverable: true } } }),
    formatBrainRecord: () => openBrain
  });
  assert.equal(openResult.statusCode, 200);
  assert.match(openResult.html, /index,follow,max-image-preview:large/i);
  assert.match(openResult.html, /Acme Support/);
  assert.match(openResult.html, /Reference links/);

  const lockedBrain = makeBrain({ shareId: "locked-public", mode: "password", discoverable: true });
  const lockedResult = await hooks.resolvePublicAgentShell("/agents/locked-public", "https://supavector.com", {
    getPublicBrainRowByShareId: async () => ({ public_access_config: { mode: "password", discovery: { discoverable: true } } }),
    formatBrainRecord: () => lockedBrain
  });
  assert.equal(lockedResult.statusCode, 200);
  assert.match(lockedResult.html, /noindex,nofollow/i);

  const sitemapXml = await hooks.buildHostedSitemapXml(makeRequest(), {
    listPublicBrainsForSitemap: async () => ([
      {
        public_enabled: true,
        public_share_id: "open-public",
        public_access_config: { mode: "open", discovery: { discoverable: true } },
        updated_at: "2026-04-11T00:00:00.000Z",
        created_at: "2026-04-10T00:00:00.000Z"
      },
      {
        public_enabled: true,
        public_share_id: "hidden-public",
        public_access_config: { mode: "open", discovery: { discoverable: false } },
        updated_at: "2026-04-11T00:00:00.000Z",
        created_at: "2026-04-10T00:00:00.000Z"
      },
      {
        public_enabled: true,
        public_share_id: "locked-public",
        public_access_config: { mode: "password", discovery: { discoverable: true } },
        updated_at: "2026-04-11T00:00:00.000Z",
        created_at: "2026-04-10T00:00:00.000Z"
      }
    ])
  });

  assert.match(sitemapXml, /\/agents\/open-public/);
  assert.doesNotMatch(sitemapXml, /\/agents\/hidden-public/);
  assert.doesNotMatch(sitemapXml, /\/agents\/locked-public/);

  console.log("public chat seo tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

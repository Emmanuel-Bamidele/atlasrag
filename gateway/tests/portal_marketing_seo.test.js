const assert = require("assert");
const fs = require("fs");
const path = require("path");

const studioPluginPath = path.join(__dirname, "..", "plugins", "studio.js");

if (!fs.existsSync(studioPluginPath)) {
  console.log("portal marketing seo tests skipped: hosted portal plugin not available");
  process.exit(0);
}

const studio = require("../plugins/studio");
const hooks = studio.__testHooks;

function run() {
  const homeMeta = hooks.buildStudioSeo("/", "https://supavector.com");
  assert.match(homeMeta.title, /AI Memory And Agent Memory Platform/i);
  assert.match(homeMeta.description, /LangChain/i);

  const docsMeta = hooks.buildStudioSeo("/docs", "https://supavector.com");
  assert.match(docsMeta.title, /AI Memory API And Vector Retrieval Docs/i);
  assert.match(docsMeta.description, /vector-backed retrieval/i);
  assert.match(docsMeta.keywords, /langchain memory/i);

  const pricingMeta = hooks.buildStudioSeo("/pricing", "https://supavector.com");
  assert.match(pricingMeta.description, /Pinecone, Supabase/i);
  assert.match(pricingMeta.keywords, /pinecone pricing alternative/i);

  const homeHtml = hooks.renderStudioShell("/", "https://supavector.com");
  assert.match(homeHtml, /How do you make AI remember in production\?/i);
  assert.match(homeHtml, /Pinecone, Supabase pgvector/i);

  const docsHtml = hooks.renderStudioShell("/docs", "https://supavector.com");
  assert.match(docsHtml, /Can Supavector work with LangChain\?/i);
  assert.match(docsHtml, /AI memory workflows/i);

  const apiMeta = hooks.buildStudioSeo("/products/hosted-api", "https://supavector.com");
  assert.match(apiMeta.description, /LangChain/i);
  assert.match(apiMeta.keywords, /ai memory api/i);

  console.log("portal marketing seo tests passed");
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exit(1);
}

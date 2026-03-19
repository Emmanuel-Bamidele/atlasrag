const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOnboardConfig,
  defaultCollectionFromFolder,
  detectProjectRoot,
  isIngestibleTextPath,
  isProbablyTextBuffer,
  mergeEnvText,
  normalizeTcpPort,
  parseCliArgs,
  resolveBaseUrl,
  safeDocIdFromPath
} = require("../lib");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlasrag-cli-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testParseCliArgs() {
  const parsed = parseCliArgs([
    "write",
    "--doc-id",
    "welcome",
    "--text=hello world",
    "--json",
    "ignored-positional"
  ]);

  assert.equal(parsed.command, "write");
  assert.equal(parsed.flags["doc-id"], "welcome");
  assert.equal(parsed.flags.text, "hello world");
  assert.equal(parsed.flags.json, true);
  assert.deepEqual(parsed.positionals, ["write", "ignored-positional"]);
}

function testMergeEnvText() {
  const template = "OPENAI_API_KEY=\nJWT_SECRET=change_me\n# comment\n";
  const merged = mergeEnvText(template, {
    OPENAI_API_KEY: "sk-test",
    COOKIE_SECRET: "cookie value"
  });

  assert.match(merged, /^OPENAI_API_KEY=sk-test/m);
  assert.match(merged, /^JWT_SECRET=change_me/m);
  assert.match(merged, /^COOKIE_SECRET="cookie value"$/m);
}

function testDetectProjectRoot() {
  withTempDir((dir) => {
    const root = path.join(dir, "atlasrag");
    const nested = path.join(root, "gateway", "public");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services:\n", "utf8");
    fs.writeFileSync(path.join(root, ".env.example"), "OPENAI_API_KEY=\n", "utf8");

    const detected = detectProjectRoot(nested);
    assert.equal(detected, root);
  });
}

function testCreateOnboardConfig() {
  const config = createOnboardConfig({
    projectRoot: "/tmp/atlasrag",
    mode: "bundled-postgres",
    envFile: ".env",
    composeFile: "docker-compose.yml",
    baseUrl: resolveBaseUrl("4100"),
    tenantId: "default",
    adminUsername: "admin",
    apiKey: "atrg_secret",
    openAiApiKey: "sk-test"
  });

  assert.equal(config.projectRoot, "/tmp/atlasrag");
  assert.equal(config.baseUrl, "http://localhost:4100");
  assert.equal(config.tenantId, "default");
  assert.equal(config.adminUsername, "admin");
  assert.equal(config.apiKey, "atrg_secret");
  assert.equal(config.openAiApiKey, "sk-test");
  assert.ok(config.updatedAt);
}

function testFolderHelpers() {
  assert.equal(defaultCollectionFromFolder("/tmp/customer-support"), "customer-support");
  assert.equal(isIngestibleTextPath("/tmp/notes.md"), true);
  assert.equal(isIngestibleTextPath("/tmp/manual.pdf"), false);
  assert.equal(safeDocIdFromPath("guides/intro file.md"), "guides__intro-file.md");
  assert.equal(isProbablyTextBuffer(Buffer.from("hello world", "utf8")), true);
  assert.equal(isProbablyTextBuffer(Buffer.from([0, 1, 2, 3])), false);
}

function testNormalizeTcpPort() {
  assert.equal(normalizeTcpPort("3000"), "3000");
  assert.equal(normalizeTcpPort(" 5432 ", "Gateway port"), "5432");
  assert.throws(() => normalizeTcpPort("atlasrag status", "Gateway port"), /Gateway port must be a number between 1 and 65535/);
  assert.throws(() => normalizeTcpPort("70000"), /Port must be a number between 1 and 65535/);
}

function main() {
  testParseCliArgs();
  testMergeEnvText();
  testDetectProjectRoot();
  testCreateOnboardConfig();
  testFolderHelpers();
  testNormalizeTcpPort();
  console.log("cli helper tests passed");
}

main();

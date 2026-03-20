const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildBaseUrlCandidates,
  buildInstallBinDir,
  buildInstallRepoDir,
  buildShellPathLine,
  createOnboardConfig,
  detectIngestibleFileType,
  defaultCollectionFromFolder,
  detectProjectRoot,
  extractDocumentText,
  isIngestibleTextPath,
  isProbablyTextBuffer,
  mergeEnvText,
  removePathEntry,
  normalizeTcpPort,
  parseCliArgs,
  preferredBaseUrl,
  resolveInstallHome,
  resolveBaseUrl,
  safeDocIdFromPath,
  stripManagedShellPath
} = require("../lib");

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlasrag-cli-"));
  try {
    await fn(dir);
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
    "--replace",
    "--sync",
    "--yes",
    "ignored-positional"
  ]);

  assert.equal(parsed.command, "write");
  assert.equal(parsed.flags["doc-id"], "welcome");
  assert.equal(parsed.flags.text, "hello world");
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.replace, true);
  assert.equal(parsed.flags.sync, true);
  assert.equal(parsed.flags.yes, true);
  assert.deepEqual(parsed.positionals, ["write", "ignored-positional"]);

  const updateParsed = parseCliArgs([
    "update",
    "--project-root",
    "/tmp/atlasrag"
  ]);
  assert.equal(updateParsed.command, "update");
  assert.equal(updateParsed.flags["project-root"], "/tmp/atlasrag");

  const uninstallParsed = parseCliArgs([
    "uninstall",
    "--yes",
    "--json"
  ]);
  assert.equal(uninstallParsed.command, "uninstall");
  assert.equal(uninstallParsed.flags.yes, true);
  assert.equal(uninstallParsed.flags.json, true);

  const booleanAskParsed = parseCliArgs([
    "boolean_ask",
    "--question",
    "Does AtlasRAG store memory?",
    "--json"
  ]);
  assert.equal(booleanAskParsed.command, "boolean_ask");
  assert.equal(booleanAskParsed.flags.question, "Does AtlasRAG store memory?");
  assert.equal(booleanAskParsed.flags.json, true);
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
  return withTempDir(async (dir) => {
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
  assert.equal(detectIngestibleFileType("/tmp/manual.pdf"), "pdf");
  assert.equal(detectIngestibleFileType("/tmp/report.docx"), "docx");
  assert.equal(detectIngestibleFileType("/tmp/notes.md"), "text");
  assert.equal(safeDocIdFromPath("guides/intro file.md"), "guides__intro-file.md");
  assert.equal(isProbablyTextBuffer(Buffer.from("hello world", "utf8")), true);
  assert.equal(isProbablyTextBuffer(Buffer.from([0, 1, 2, 3])), false);
}

async function testDocumentExtraction() {
  await withTempDir(async (dir) => {
    const textPath = path.join(dir, "notes.md");
    const pdfPath = path.join(dir, "manual.pdf");
    const docxPath = path.join(dir, "resume.docx");

    fs.writeFileSync(textPath, "Hello from AtlasRAG.\n", "utf8");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-test", "utf8"));
    fs.writeFileSync(docxPath, Buffer.from("PK-test", "utf8"));

    assert.equal(await extractDocumentText(textPath), "Hello from AtlasRAG.\n");

    const pdfText = await extractDocumentText(pdfPath, {
      extractPdfText: async () => "PDF content\n\nwith spacing"
    });
    assert.equal(pdfText, "PDF content\n\nwith spacing");

    const docxText = await extractDocumentText(docxPath, {
      extractDocxText: async () => "DOCX content\r\n\r\nwith spacing"
    });
    assert.equal(docxText, "DOCX content\n\nwith spacing");
  });
}

function testNormalizeTcpPort() {
  assert.equal(normalizeTcpPort("3000"), "3000");
  assert.equal(normalizeTcpPort(" 5432 ", "Gateway port"), "5432");
  assert.throws(() => normalizeTcpPort("atlasrag status", "Gateway port"), /Gateway port must be a number between 1 and 65535/);
  assert.throws(() => normalizeTcpPort("70000"), /Port must be a number between 1 and 65535/);
}

function testBaseUrlHelpers() {
  assert.deepEqual(buildBaseUrlCandidates("http://localhost:3000"), [
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);
  assert.deepEqual(buildBaseUrlCandidates("https://atlasrag.com"), [
    "https://atlasrag.com"
  ]);
  assert.equal(preferredBaseUrl("http://localhost:3000"), "http://127.0.0.1:3000");
  assert.equal(preferredBaseUrl("https://atlasrag.com"), "https://atlasrag.com");
}

function testInstallHelpers() {
  const installHome = resolveInstallHome({ ATLASRAG_HOME: "/tmp/custom-atlasrag" }, "/Users/tester");
  assert.equal(installHome, path.resolve("/tmp/custom-atlasrag"));
  assert.equal(buildInstallBinDir(installHome), path.join(path.resolve("/tmp/custom-atlasrag"), "bin"));
  assert.equal(buildInstallRepoDir(installHome), path.join(path.resolve("/tmp/custom-atlasrag"), "src", "atlasrag"));

  const shellPathLine = buildShellPathLine("/tmp/custom-atlasrag/bin");
  assert.equal(shellPathLine, `export PATH="${path.resolve("/tmp/custom-atlasrag/bin")}:$PATH"`);

  const rcText = [
    "export PATH=\"/usr/local/bin:$PATH\"",
    "# >>> atlasrag >>>",
    shellPathLine,
    "# <<< atlasrag <<<",
    "alias ll='ls -la'"
  ].join("\n");
  assert.equal(stripManagedShellPath(rcText, "/tmp/custom-atlasrag/bin"), [
    "export PATH=\"/usr/local/bin:$PATH\"",
    "alias ll='ls -la'"
  ].join("\n"));

  const legacyRcText = [
    shellPathLine,
    "export PATH=\"/usr/local/bin:$PATH\""
  ].join("\n");
  assert.equal(stripManagedShellPath(legacyRcText, "/tmp/custom-atlasrag/bin"), "export PATH=\"/usr/local/bin:$PATH\"");

  assert.equal(
    removePathEntry("/usr/local/bin:/tmp/custom-atlasrag/bin:/bin", "/tmp/custom-atlasrag/bin", "linux"),
    "/usr/local/bin:/bin"
  );
  assert.equal(
    removePathEntry("C:\\Windows;C:\\Users\\Test\\.atlasrag\\bin;C:\\Tools", "c:\\users\\test\\.atlasrag\\bin\\", "win32"),
    "C:\\Windows;C:\\Tools"
  );
}

async function main() {
  testParseCliArgs();
  testMergeEnvText();
  await testDetectProjectRoot();
  testCreateOnboardConfig();
  testFolderHelpers();
  await testDocumentExtraction();
  testNormalizeTcpPort();
  testBaseUrlHelpers();
  testInstallHelpers();
  console.log("cli helper tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

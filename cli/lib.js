const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  GENERATION_PROVIDER_PRESETS,
  EMBEDDING_PROVIDER_PRESETS,
  GENERATION_MODEL_PRESETS,
  listEmbeddingModelPresets,
  listGenerationModelPresets,
  EMBEDDING_MODEL_PRESETS,
  defaultProviderSelection,
  normalizeProviderSelection,
  defaultGenerationModelSelectionForProvider,
  normalizeGenerationModelSelectionForProvider,
  defaultEmbeddingModelSelectionForProvider,
  normalizeEmbeddingModelSelectionForProvider,
  defaultGenerationModelSelection,
  normalizeGenerationModelSelection
} = require("../gateway/model_catalog");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(os.homedir(), ".supavector");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_INSTALL_HOME = path.join(os.homedir(), ".supavector");
const ONBOARD_ANSWER_MODEL_OPTIONS = GENERATION_MODEL_PRESETS;
const SHELL_PATH_BLOCK_START = "# >>> supavector >>>";
const SHELL_PATH_BLOCK_END = "# <<< supavector <<<";
const INGESTIBLE_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".toml",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh"
]);
const INGESTIBLE_BINARY_EXTENSIONS = new Set([
  ".pdf",
  ".docx"
]);
const BOOLEAN_FLAGS = new Set([
  "build",
  "down",
  "external-postgres",
  "force",
  "json",
  "non-interactive",
  "replace",
  "restart",
  "show-secrets",
  "sync",
  "yes"
]);

function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positionals = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (!body) continue;

    const eqIndex = body.indexOf("=");
    if (eqIndex >= 0) {
      const key = body.slice(0, eqIndex);
      const value = body.slice(eqIndex + 1);
      flags[key] = value;
      continue;
    }

    const next = args[i + 1];
    if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !String(next).startsWith("--")) {
      flags[body] = String(next);
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return {
    command: positionals[0] || "help",
    subcommand: positionals[1] || "",
    positionals,
    flags
  };
}

function hasProjectMarkers(dir) {
  return fs.existsSync(path.join(dir, "docker-compose.yml"))
    && fs.existsSync(path.join(dir, ".env.example"))
    && fs.existsSync(path.join(dir, "gateway"));
}

function detectProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (hasProjectMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return PACKAGE_ROOT;
}

function resolveProjectRoot(config = {}, explicitRoot = "") {
  const candidate = explicitRoot
    ? path.resolve(explicitRoot)
    : (config.projectRoot ? path.resolve(config.projectRoot) : detectProjectRoot());
  return hasProjectMarkers(candidate) ? candidate : PACKAGE_ROOT;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseEnvAssignments(text) {
  const assignments = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/i.exec(rawLine);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    assignments[key] = value;
  }
  return assignments;
}

function readEnvAssignments(filePath) {
  try {
    return parseEnvAssignments(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function readConfig() {
  return readJson(CONFIG_FILE, {}) || {};
}

function resolveInstallHome(env = process.env, homeDir = os.homedir()) {
  const raw = env && typeof env.SUPAVECTOR_HOME === "string" ? env.SUPAVECTOR_HOME : "";
  return path.resolve(raw || path.join(homeDir, ".supavector"));
}

function buildInstallBinDir(installHome = DEFAULT_INSTALL_HOME) {
  return path.join(path.resolve(String(installHome || DEFAULT_INSTALL_HOME)), "bin");
}

function buildInstallRepoDir(installHome = DEFAULT_INSTALL_HOME) {
  return path.join(path.resolve(String(installHome || DEFAULT_INSTALL_HOME)), "src", "supavector");
}

function buildShellPathLine(binDir) {
  return `export PATH="${path.resolve(String(binDir || ""))}:$PATH"`;
}

function stripManagedShellPath(text, binDir) {
  const targetLine = buildShellPathLine(binDir);
  const inputLines = String(text || "").split(/\r?\n/);
  const output = [];
  let insideManagedBlock = false;

  for (const line of inputLines) {
    if (line === SHELL_PATH_BLOCK_START) {
      insideManagedBlock = true;
      continue;
    }
    if (line === SHELL_PATH_BLOCK_END) {
      insideManagedBlock = false;
      continue;
    }
    if (insideManagedBlock) continue;
    if (line === targetLine) continue;
    output.push(line);
  }

  while (output.length > 1 && output[output.length - 1] === "" && output[output.length - 2] === "") {
    output.pop();
  }

  return output.join("\n");
}

function normalizePathForCompare(value, platform = process.platform) {
  const trimmed = String(value || "")
    .trim()
    .replace(/[\\/]+$/g, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function removePathEntry(pathValue, targetPath, platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":";
  const target = normalizePathForCompare(targetPath, platform);
  return String(pathValue || "")
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => normalizePathForCompare(part, platform) !== target)
    .join(separator);
}

function normalizeConfiguredModel(value, fallback = "") {
  const clean = String(value || "").trim();
  if (!clean) return String(fallback || "").trim();
  return clean;
}

function defaultOnboardAnswerModelSelection(value, fallback = DEFAULT_ANSWER_MODEL) {
  return defaultGenerationModelSelection(normalizeConfiguredModel(value, fallback), fallback);
}

function normalizeOnboardAnswerModelSelection(value, fallback = DEFAULT_ANSWER_MODEL) {
  return normalizeGenerationModelSelection(normalizeConfiguredModel(value, fallback), fallback);
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function writeConfig(config) {
  ensureConfigDir();
  const tempPath = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Best effort only.
  }
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 2)}...`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  if (!/[\s#"\\]/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function mergeEnvText(templateText, updates) {
  const lines = String(templateText || "").split(/\r?\n/);
  const remaining = new Map(Object.entries(updates || {}));
  const output = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=.*$/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const next = `${key}=${formatEnvValue(remaining.get(key))}`;
    remaining.delete(key);
    return next;
  });
  if (remaining.size > 0) {
    output.push("");
    for (const [key, value] of remaining.entries()) {
      output.push(`${key}=${formatEnvValue(value)}`);
    }
  }
  return `${output.join("\n").replace(/\s+$/u, "")}\n`;
}

function backupFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function randomPassword(length = 24) {
  const raw = crypto.randomBytes(length).toString("base64url");
  return raw.slice(0, length);
}

function resolveBaseUrl(port) {
  return `http://localhost:${String(port || "3000").trim() || "3000"}`;
}

function buildBaseUrlCandidates(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return [];
  try {
    const primary = new URL(raw);
    const candidates = [primary.toString().replace(/\/+$/u, "")];
    if (primary.hostname === "localhost") {
      const ipv4 = new URL(primary.toString());
      ipv4.hostname = "127.0.0.1";
      candidates.push(ipv4.toString().replace(/\/+$/u, ""));
    }
    return [...new Set(candidates)];
  } catch {
    return [raw.replace(/\/+$/u, "")];
  }
}

function preferredBaseUrl(baseUrl) {
  const candidates = buildBaseUrlCandidates(baseUrl);
  return candidates.find((value) => {
    try {
      return new URL(value).hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }) || candidates[0] || String(baseUrl || "").trim();
}

function normalizeTcpPort(value, label = "Port") {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new Error(`${label} must be a number between 1 and 65535.`);
  }
  const port = Number.parseInt(text, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`${label} must be a number between 1 and 65535.`);
  }
  return String(port);
}

function defaultCollectionFromFolder(folderPath) {
  return path.basename(path.resolve(String(folderPath || "").trim()));
}

function isIngestibleTextPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return INGESTIBLE_TEXT_EXTENSIONS.has(ext);
}

function detectIngestibleFileType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (INGESTIBLE_TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  return "unsupported";
}

function isProbablyTextBuffer(buffer) {
  if (!buffer || !buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let weird = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) weird += 1;
  }
  return weird / sample.length < 0.15;
}

function normalizeExtractedText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function requireCliDependency(name) {
  try {
    return require(name);
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      throw new Error(`Missing dependency "${name}". Run \`npm install\` in the SupaVector project root.`);
    }
    throw error;
  }
}

async function extractPdfText(rawBuffer, filePath, options = {}) {
  const extractPdf = options.extractPdfText || (async (buffer) => {
    const pdfParse = requireCliDependency("pdf-parse");
    const result = await pdfParse(buffer);
    return result?.text || "";
  });

  try {
    return normalizeExtractedText(await extractPdf(rawBuffer, { filePath }));
  } catch (error) {
    throw new Error(`Failed to extract PDF text from ${path.basename(filePath)}: ${error.message}`);
  }
}

async function extractDocxText(rawBuffer, filePath, options = {}) {
  const extractDocx = options.extractDocxText || (async (buffer) => {
    const mammoth = requireCliDependency("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result?.value || "";
  });

  try {
    return normalizeExtractedText(await extractDocx(rawBuffer, { filePath }));
  } catch (error) {
    throw new Error(`Failed to extract DOCX text from ${path.basename(filePath)}: ${error.message}`);
  }
}

async function extractDocumentText(filePath, options = {}) {
  const absPath = path.resolve(String(filePath || "").trim());
  const fileType = detectIngestibleFileType(absPath);
  if (fileType === "unsupported") {
    throw new Error(`Unsupported file type: ${path.extname(absPath) || "(no extension)"}`);
  }

  const raw = fs.readFileSync(absPath);
  if (fileType === "text") {
    if (!isProbablyTextBuffer(raw)) {
      throw new Error(`Binary or non-text content is not supported for ${path.basename(absPath)}`);
    }
    return raw.toString("utf8");
  }
  if (fileType === "pdf") {
    return extractPdfText(raw, absPath, options);
  }
  return extractDocxText(raw, absPath, options);
}

function safeDocIdFromPath(relativePath) {
  const text = String(relativePath || "").trim();
  const normalized = text
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("__")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return normalized || `doc-${randomSecret(6)}`;
}

function boolFromFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true) return true;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function normalizeCommandName(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function buildComposeContext(projectRoot, config = {}) {
  const composeFile = config.composeFile
    ? path.resolve(projectRoot, config.composeFile)
    : path.resolve(projectRoot, "docker-compose.yml");
  const envFile = config.envFile
    ? path.resolve(projectRoot, config.envFile)
    : path.resolve(projectRoot, ".env");
  return { projectRoot, composeFile, envFile };
}

function createOnboardConfig({
  projectRoot,
  mode,
  envFile,
  composeFile,
  baseUrl,
  tenantId,
  adminUsername,
  apiKey,
  openAiApiKey,
  geminiApiKey,
  anthropicApiKey,
  onboardingPending = false
}) {
  return {
    version: 1,
    projectRoot,
    mode,
    envFile,
    composeFile,
    baseUrl,
    tenantId,
    adminUsername,
    apiKey,
    openAiApiKey: openAiApiKey || "",
    geminiApiKey: geminiApiKey || "",
    anthropicApiKey: anthropicApiKey || "",
    onboardingPending: Boolean(onboardingPending),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  DEFAULT_INSTALL_HOME,
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  GENERATION_PROVIDER_PRESETS,
  EMBEDDING_PROVIDER_PRESETS,
  EMBEDDING_MODEL_PRESETS,
  GENERATION_MODEL_PRESETS,
  listEmbeddingModelPresets,
  listGenerationModelPresets,
  PACKAGE_ROOT,
  CONFIG_DIR,
  CONFIG_FILE,
  ONBOARD_ANSWER_MODEL_OPTIONS,
  SHELL_PATH_BLOCK_END,
  SHELL_PATH_BLOCK_START,
  backupFileIfExists,
  buildInstallBinDir,
  buildInstallRepoDir,
  buildShellPathLine,
  boolFromFlag,
  buildBaseUrlCandidates,
  buildComposeContext,
  createOnboardConfig,
  defaultProviderSelection,
  defaultCollectionFromFolder,
  detectIngestibleFileType,
  detectProjectRoot,
  defaultEmbeddingModelSelectionForProvider,
  defaultGenerationModelSelectionForProvider,
  defaultOnboardAnswerModelSelection,
  extractDocumentText,
  formatEnvValue,
  INGESTIBLE_BINARY_EXTENSIONS,
  INGESTIBLE_TEXT_EXTENSIONS,
  isIngestibleTextPath,
  isProbablyTextBuffer,
  maskSecret,
  mergeEnvText,
  normalizeExtractedText,
  normalizeCommandName,
  normalizeConfiguredModel,
  normalizeEmbeddingModelSelectionForProvider,
  normalizeGenerationModelSelectionForProvider,
  normalizeOnboardAnswerModelSelection,
  normalizeProviderSelection,
  normalizePathForCompare,
  normalizeTcpPort,
  parseCliArgs,
  parseEnvAssignments,
  preferredBaseUrl,
  randomPassword,
  randomSecret,
  readConfig,
  readEnvAssignments,
  readJson,
  removePathEntry,
  resolveBaseUrl,
  resolveInstallHome,
  resolveProjectRoot,
  safeDocIdFromPath,
  stripManagedShellPath,
  writeConfig
};

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const { AtlasRAGClient } = require("../sdk/node/src/client");
const {
  CONFIG_FILE,
  backupFileIfExists,
  boolFromFlag,
  buildComposeContext,
  createOnboardConfig,
  defaultCollectionFromFolder,
  isIngestibleTextPath,
  isProbablyTextBuffer,
  maskSecret,
  mergeEnvText,
  parseCliArgs,
  randomPassword,
  randomSecret,
  readConfig,
  resolveBaseUrl,
  resolveProjectRoot,
  safeDocIdFromPath,
  writeConfig
} = require("../cli/lib");

function printHelp() {
  console.log(`AtlasRAG CLI

Usage:
  atlasrag onboard [--external-postgres] [--project-root PATH] [--force]
  atlasrag start [--build]
  atlasrag stop [--down]
  atlasrag status [--json]
  atlasrag logs [--service gateway] [--tail 200]
  atlasrag doctor [--json]
  atlasrag bootstrap [--username USER] [--password PASS] [--tenant TENANT]
  atlasrag write (--doc-id ID [--text TEXT | --file PATH | --url URL] | --folder PATH) [--collection NAME] [--json]
  atlasrag search --q QUERY [--k 5] [--collection NAME] [--json]
  atlasrag ask --question TEXT [--k 5] [--collection NAME] [--policy amvl|ttl|lru] [--answer-length auto|short|medium|long] [--json]
  atlasrag config show [--show-secrets]
  atlasrag help

Common flags:
  --project-root PATH          Use a specific AtlasRAG checkout
  --base-url URL               Override saved base URL
  --api-key KEY                Override saved service token
  --openai-key KEY             Send request-scoped X-OpenAI-API-Key
  --tenant TENANT              Override tenant scope
  --collection NAME            Override collection scope; folder writes use folder name if omitted
  --json                       Print JSON output where supported

Onboarding flags:
  --admin-user USER
  --admin-password PASS
  --tenant TENANT
  --gateway-port PORT
  --external-postgres
  --pg-host HOST
  --pg-port PORT
  --pg-database NAME
  --pg-user USER
  --pg-password PASS
  --non-interactive            Fail instead of prompting for missing values
  --force                      Overwrite env file after creating a backup
`);
}

const EXECUTABLE_CANDIDATES = {
  docker: [
    process.env.ATLASRAG_DOCKER_BIN,
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "docker"
  ].filter(Boolean)
};

function resolveExecutable(name, args = ["--version"]) {
  const candidates = EXECUTABLE_CANDIDATES[name] || [name];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, args, { encoding: "utf8" });
    if (result.status === 0) return candidate;
    if (result.error && result.error.code === "ENOENT") continue;
  }
  return null;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("No output returned.");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Bootstrap output was not valid JSON.");
  }
}

function getFlag(parsed, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(parsed.flags, name)) return parsed.flags[name];
  }
  return undefined;
}

function ensureNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node 18+ is required. Current version: ${process.version}`);
  }
}

function ensureDockerAvailable() {
  if (!resolveExecutable("docker", ["--version"])) {
    throw new Error("Docker is required but was not found on PATH.");
  }
  if (!resolveExecutable("docker", ["compose", "version"])) {
    throw new Error("Docker Compose plugin is required. `docker compose version` failed.");
  }
}

function runCommand(command, args, options = {}) {
  const capture = options.capture !== false;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    let stderr = "";

    if (capture && child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
    }
    if (capture && child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const message = capture
        ? String(stderr || stdout || `${command} exited with code ${code}`).trim()
        : `${command} exited with code ${code}`;
      const err = new Error(message);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function buildComposeArgs(ctx) {
  return ["compose", "-f", ctx.composeFile, "--env-file", ctx.envFile];
}

async function runCompose(ctx, extraArgs, options = {}) {
  const dockerBin = resolveExecutable("docker", ["--version"]);
  if (!dockerBin) {
    throw new Error("Docker is required but was not found on PATH.");
  }
  return runCommand(dockerBin, [...buildComposeArgs(ctx), ...extraArgs], {
    cwd: ctx.projectRoot,
    capture: options.capture,
    env: options.env
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(payload?.error?.message || payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

async function waitForHealth(baseUrl, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Gateway did not become healthy.";
  while (Date.now() < deadline) {
    try {
      const payload = await fetchJson(new URL("/health", baseUrl).toString());
      if (payload?.ok === true) return payload;
      lastError = "Gateway responded without ok=true.";
    } catch (err) {
      lastError = String(err.message || err);
    }
    await sleep(2500);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health: ${lastError}`);
}

function askVisible(prompt, defaultValue = "") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close();
      const value = String(answer || "").trim();
      resolve(value || defaultValue || "");
    });
  });
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(`Cannot prompt for ${prompt} without a TTY. Pass the flag explicitly.`));
      return;
    }

    const stdin = process.stdin;
    const stderr = process.stderr;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore.
      }
      stdin.pause();
    };

    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        stderr.write("\n");
        reject(new Error("Cancelled."));
        return;
      }
      if (text === "\r" || text === "\n") {
        cleanup();
        stderr.write("\n");
        resolve(value.trim());
        return;
      }
      if (text === "\u007f" || text === "\b" || text === "\x08") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stderr.write("\b \b");
        }
        return;
      }
      value += text;
      stderr.write("*");
    };

    stderr.write(`${prompt}: `);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

async function confirm(question, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = await askVisible(`${question}${suffix}`);
  if (!answer) return defaultYes;
  const text = answer.trim().toLowerCase();
  if (["y", "yes"].includes(text)) return true;
  if (["n", "no"].includes(text)) return false;
  return defaultYes;
}

async function resolvePromptValue({
  parsed,
  flags,
  names,
  prompt,
  defaultValue = "",
  secret = false,
  required = false,
  allowEmpty = false
}) {
  for (const name of names) {
    const value = getFlag(parsed, name);
    if (value !== undefined && value !== true) {
      const text = String(value);
      if (text || allowEmpty) return text;
    }
  }

  if (flags.nonInteractive) {
    if (required && !defaultValue && !allowEmpty) {
      throw new Error(`Missing required flag: --${names[0]}`);
    }
    return defaultValue;
  }

  const answer = secret
    ? await askHidden(prompt)
    : await askVisible(prompt, defaultValue);
  if (!answer && required && !allowEmpty) {
    throw new Error(`${prompt} is required.`);
  }
  return answer;
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function readTemplate(projectRoot, externalPostgres) {
  const fileName = externalPostgres ? ".env.external-postgres.example" : ".env.example";
  const filePath = path.join(projectRoot, fileName);
  ensureFileExists(filePath, "Env template");
  return fs.readFileSync(filePath, "utf8");
}

async function writeEnvFile({ projectRoot, externalPostgres, updates, force }) {
  const template = readTemplate(projectRoot, externalPostgres);
  const outputName = externalPostgres ? ".env.external-postgres" : ".env";
  const outputPath = path.join(projectRoot, outputName);

  let backupPath = null;
  if (fs.existsSync(outputPath)) {
    if (!force) {
      const okay = await confirm(`${outputName} already exists. Overwrite it after creating a backup?`, false);
      if (!okay) {
        throw new Error("Aborted without changing the env file.");
      }
    }
    backupPath = backupFileIfExists(outputPath);
  }

  const content = mergeEnvText(template, updates);
  fs.writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(outputPath, 0o600);
  } catch {
    // Best effort only.
  }
  return { outputPath, backupPath };
}

function printSummary(title, rows) {
  console.log(title);
  for (const row of rows) {
    console.log(`- ${row}`);
  }
}

function resolveClientConfig(parsed) {
  const saved = readConfig();
  const baseUrl = String(
    getFlag(parsed, "base-url")
    || process.env.ATLASRAG_BASE_URL
    || process.env.ATLASRAG_URL
    || saved.baseUrl
    || "http://localhost:3000"
  ).trim();
  const apiKey = String(
    getFlag(parsed, "api-key")
    || process.env.ATLASRAG_API_KEY
    || saved.apiKey
    || ""
  ).trim();
  const token = String(
    getFlag(parsed, "token")
    || process.env.ATLASRAG_TOKEN
    || saved.token
    || ""
  ).trim();
  const openAiApiKey = String(
    getFlag(parsed, "openai-key")
    || process.env.ATLASRAG_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY
    || saved.openAiApiKey
    || ""
  ).trim();
  const tenantId = String(
    getFlag(parsed, "tenant")
    || process.env.ATLASRAG_TENANT_ID
    || saved.tenantId
    || ""
  ).trim();
  const collection = String(
    getFlag(parsed, "collection")
    || process.env.ATLASRAG_COLLECTION
    || saved.collection
    || ""
  ).trim();
  return { baseUrl, apiKey, token, openAiApiKey, tenantId, collection };
}

function buildClient(parsed) {
  const cfg = resolveClientConfig(parsed);
  if (!cfg.apiKey && !cfg.token) {
    throw new Error(`No AtlasRAG credential is configured. Run \`atlasrag onboard\` first or set ${"`ATLASRAG_API_KEY`"} / ${"`ATLASRAG_TOKEN`"}.`);
  }
  return new AtlasRAGClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey || null,
    token: cfg.apiKey ? null : cfg.token,
    openAiApiKey: cfg.openAiApiKey || null,
    tenantId: cfg.tenantId || null,
    collection: cfg.collection || null
  });
}

async function handleOnboard(parsed) {
  ensureNodeVersion();
  ensureDockerAvailable();

  const saved = readConfig();
  const nonInteractive = boolFromFlag(getFlag(parsed, "non-interactive"), false);
  const externalPostgres = boolFromFlag(getFlag(parsed, "external-postgres"), false);
  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  const gatewayPort = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["gateway-port"],
    prompt: "Gateway port",
    defaultValue: "3000",
    required: true
  });
  const adminUsername = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["admin-user", "username"],
    prompt: "Admin username",
    defaultValue: saved.adminUsername || "admin",
    required: true
  });
  const adminPassword = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["admin-password", "password"],
    prompt: "Admin password",
    defaultValue: "",
    secret: true,
    required: true
  });
  const tenantId = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["tenant"],
    prompt: "Tenant id",
    defaultValue: saved.tenantId || "default",
    required: true
  });
  const openAiApiKey = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["openai-key"],
    prompt: "OpenAI API key",
    defaultValue: process.env.OPENAI_API_KEY || saved.openAiApiKey || "",
    secret: true,
    required: true
  });

  const jwtSecret = randomSecret(32);
  const cookieSecret = randomSecret(32);
  const baseUrl = resolveBaseUrl(gatewayPort);
  let envUpdates = {
    OPENAI_API_KEY: openAiApiKey,
    JWT_SECRET: jwtSecret,
    COOKIE_SECRET: cookieSecret,
    PUBLIC_BASE_URL: baseUrl,
    OPENAPI_BASE_URL: baseUrl,
    GATEWAY_HOST_PORT: gatewayPort
  };
  let composeFile = "docker-compose.yml";
  let envFile = ".env";

  if (externalPostgres) {
    composeFile = "docker-compose.external-postgres.yml";
    envFile = ".env.external-postgres";
    const pgHost = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-host"],
      prompt: "Postgres host",
      defaultValue: "127.0.0.1",
      required: true
    });
    const pgPort = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-port"],
      prompt: "Postgres port",
      defaultValue: "5432",
      required: true
    });
    const pgDatabase = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-database"],
      prompt: "Postgres database",
      defaultValue: "atlasrag",
      required: true
    });
    const pgUser = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-user"],
      prompt: "Postgres user",
      defaultValue: "atlasrag",
      required: true
    });
    const pgPassword = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-password"],
      prompt: "Postgres password",
      defaultValue: "",
      secret: true,
      required: true
    });

    envUpdates = {
      ...envUpdates,
      PGHOST: pgHost,
      PGPORT: pgPort,
      PGDATABASE: pgDatabase,
      PGUSER: pgUser,
      PGPASSWORD: pgPassword
    };
  } else {
    envUpdates = {
      ...envUpdates,
      POSTGRES_PASSWORD: randomPassword(24)
    };
  }

  const { outputPath, backupPath } = await writeEnvFile({
    projectRoot,
    externalPostgres,
    updates: envUpdates,
    force: boolFromFlag(getFlag(parsed, "force"), false)
  });

  const composeCtx = buildComposeContext(projectRoot, { composeFile, envFile });
  console.log(`Using project root: ${projectRoot}`);
  console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
  if (backupPath) {
    console.log(`Backup created: ${path.relative(projectRoot, backupPath)}`);
  }

  console.log("Starting AtlasRAG services...");
  await runCompose(composeCtx, ["up", "-d", "--build"], { capture: false });

  console.log(`Waiting for ${baseUrl}/health ...`);
  await waitForHealth(baseUrl);

  console.log("Bootstrapping the first admin and service token...");
  const bootstrap = await runCompose(composeCtx, [
    "exec",
    "-T",
    "gateway",
    "node",
    "scripts/bootstrap_instance.js",
    "--username",
    adminUsername,
    "--password",
    adminPassword,
    "--tenant",
    tenantId,
    "--service-token-name",
    `${tenantId}-bootstrap`,
    "--json"
  ]);
  const payload = parseJsonFromStdout(bootstrap.stdout);
  const serviceToken = String(payload?.serviceToken?.token || "").trim();
  if (!serviceToken) {
    throw new Error("Bootstrap finished without returning a service token.");
  }

  writeConfig(createOnboardConfig({
    projectRoot,
    mode: externalPostgres ? "external-postgres" : "bundled-postgres",
    envFile,
    composeFile,
    baseUrl,
    tenantId,
    adminUsername,
    apiKey: serviceToken,
    openAiApiKey
  }));

  console.log("");
  printSummary("AtlasRAG is ready.", [
    `App URL: ${baseUrl}`,
    `Docs URL: ${baseUrl}/docs`,
    `Admin username: ${adminUsername}`,
    `Tenant: ${tenantId}`,
    `Service token: ${maskSecret(serviceToken)}`,
    `CLI config: ${CONFIG_FILE}`,
    "Next: atlasrag status",
    "Try: atlasrag write --doc-id welcome --text \"AtlasRAG stores memory for agents.\"",
    "Then: atlasrag ask --question \"What does AtlasRAG store?\""
  ]);
}

function resolveComposeFromSaved(parsed) {
  const saved = readConfig();
  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  const composeFile = saved.composeFile || "docker-compose.yml";
  const envFile = saved.envFile || ".env";
  const ctx = buildComposeContext(projectRoot, { composeFile, envFile });
  ensureFileExists(ctx.composeFile, "Compose file");
  ensureFileExists(ctx.envFile, "Env file");
  return { saved, ctx };
}

async function handleStart(parsed) {
  ensureDockerAvailable();
  const { ctx } = resolveComposeFromSaved(parsed);
  const args = ["up", "-d"];
  if (boolFromFlag(getFlag(parsed, "build"), false)) args.push("--build");
  await runCompose(ctx, args, { capture: false });
  const saved = readConfig();
  const baseUrl = saved.baseUrl || resolveBaseUrl("3000");
  try {
    await waitForHealth(baseUrl, 120000);
  } catch {
    // Leave status to the user if startup is still settling.
  }
  console.log("AtlasRAG services started.");
}

async function handleStop(parsed) {
  ensureDockerAvailable();
  const { ctx } = resolveComposeFromSaved(parsed);
  if (boolFromFlag(getFlag(parsed, "down"), false)) {
    await runCompose(ctx, ["down"], { capture: false });
    console.log("AtlasRAG stack stopped and containers removed.");
    return;
  }
  await runCompose(ctx, ["stop"], { capture: false });
  console.log("AtlasRAG services stopped.");
}

async function handleStatus(parsed) {
  ensureDockerAvailable();
  const { saved, ctx } = resolveComposeFromSaved(parsed);
  const ps = await runCompose(ctx, ["ps"]);
  let health = null;
  let healthError = "";
  if (saved.baseUrl) {
    try {
      health = await fetchJson(new URL("/health", saved.baseUrl).toString());
    } catch (err) {
      healthError = String(err.message || err);
    }
  }

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify({
      projectRoot: ctx.projectRoot,
      composeFile: ctx.composeFile,
      envFile: ctx.envFile,
      baseUrl: saved.baseUrl || null,
      health,
      healthError: healthError || null,
      composePs: ps.stdout
    }, null, 2));
    return;
  }

  console.log(`Project root: ${ctx.projectRoot}`);
  console.log(`Base URL: ${saved.baseUrl || "(not saved)"}`);
  if (health?.ok === true) {
    console.log(`Health: healthy (${health.tcp || "gateway to TCP OK"})`);
  } else if (healthError) {
    console.log(`Health: unavailable (${healthError})`);
  } else {
    console.log("Health: unknown");
  }
  console.log("");
  process.stdout.write(ps.stdout);
}

async function handleLogs(parsed) {
  ensureDockerAvailable();
  const { ctx } = resolveComposeFromSaved(parsed);
  const service = String(getFlag(parsed, "service") || "gateway").trim();
  const tail = String(getFlag(parsed, "tail") || "200").trim();
  await runCompose(ctx, ["logs", "-f", "--tail", tail, service], { capture: false });
}

async function handleBootstrap(parsed) {
  ensureDockerAvailable();
  const { saved, ctx } = resolveComposeFromSaved(parsed);
  const nonInteractive = boolFromFlag(getFlag(parsed, "non-interactive"), false);
  const username = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["username", "admin-user"],
    prompt: "Admin username",
    defaultValue: saved.adminUsername || "admin",
    required: true
  });
  const password = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["password", "admin-password"],
    prompt: "Admin password",
    defaultValue: "",
    secret: true,
    required: true
  });
  const tenant = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["tenant"],
    prompt: "Tenant id",
    defaultValue: saved.tenantId || "default",
    required: true
  });

  const result = await runCompose(ctx, [
    "exec",
    "-T",
    "gateway",
    "node",
    "scripts/bootstrap_instance.js",
    "--username",
    username,
    "--password",
    password,
    "--tenant",
    tenant,
    "--service-token-name",
    `${tenant}-bootstrap`,
    "--json"
  ]);

  const payload = parseJsonFromStdout(result.stdout);
  const nextConfig = {
    ...saved,
    adminUsername: username,
    tenantId: payload?.tenant || tenant,
    baseUrl: payload?.baseUrl || saved.baseUrl || resolveBaseUrl("3000"),
    apiKey: payload?.serviceToken?.token || saved.apiKey || "",
    updatedAt: new Date().toISOString()
  };
  writeConfig(nextConfig);

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printSummary("Bootstrap complete.", [
    `Base URL: ${nextConfig.baseUrl}`,
    `Tenant: ${nextConfig.tenantId}`,
    `Admin username: ${username}`,
    `Service token: ${maskSecret(nextConfig.apiKey)}`
  ]);
}

async function handleDoctor(parsed) {
  const saved = readConfig();
  const results = [];

  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
  };

  try {
    ensureNodeVersion();
  record("Node.js", true, process.version);
  } catch (err) {
    record("Node.js", false, String(err.message || err));
  }

  const dockerBin = resolveExecutable("docker", ["--version"]);
  const dockerComposeOk = Boolean(resolveExecutable("docker", ["compose", "version"]));
  record("Docker", Boolean(dockerBin), dockerBin || "missing");
  record("Docker Compose", dockerComposeOk, dockerComposeOk ? "available" : "missing");

  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  record("Project root", fs.existsSync(projectRoot), projectRoot);

  const composeFile = path.join(projectRoot, saved.composeFile || "docker-compose.yml");
  const envFile = path.join(projectRoot, saved.envFile || ".env");
  record("Compose file", fs.existsSync(composeFile), composeFile);
  record("Env file", fs.existsSync(envFile), envFile);
  record("CLI config", fs.existsSync(CONFIG_FILE), CONFIG_FILE);
  record("Saved base URL", Boolean(saved.baseUrl), saved.baseUrl || "not configured");
  record("Saved API key", Boolean(saved.apiKey), saved.apiKey ? maskSecret(saved.apiKey) : "not configured");

  if (saved.baseUrl) {
    try {
      const health = await fetchJson(new URL("/health", saved.baseUrl).toString());
      record("Gateway health", health?.ok === true, health?.tcp || "ok");
    } catch (err) {
      record("Gateway health", false, String(err.message || err));
    }
  }

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify({ ok: results.every((r) => r.ok), checks: results }, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  for (const item of results) {
    console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}`);
  }

  if (!results.every((r) => r.ok)) {
    process.exit(1);
  }
}

function getTextInput(parsed) {
  const direct = getFlag(parsed, "text");
  if (direct && direct !== true) return String(direct);
  const filePath = getFlag(parsed, "file");
  if (filePath && filePath !== true) {
    return fs.readFileSync(path.resolve(String(filePath)), "utf8");
  }
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8");
  }
  return "";
}

function parseListFlag(value) {
  if (value === undefined || value === null || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveEffectiveCollection(client, payload) {
  return payload?.meta?.collection || client.collection || "default";
}

function walkFiles(rootDir) {
  const out = [];

  function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      if (entry.isFile()) out.push(absPath);
    }
  }

  visit(rootDir);
  return out;
}

function collectFolderDocuments(folderPath) {
  const rootDir = path.resolve(String(folderPath || "").trim());
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Folder not found: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Not a folder: ${rootDir}`);
  }

  const files = walkFiles(rootDir);
  const usedDocIds = new Map();
  const accepted = [];
  const skipped = [];

  for (const absPath of files) {
    const relPath = path.relative(rootDir, absPath);
    if (!isIngestibleTextPath(absPath)) {
      skipped.push({ path: relPath, reason: "unsupported extension" });
      continue;
    }

    const raw = fs.readFileSync(absPath);
    if (!isProbablyTextBuffer(raw)) {
      skipped.push({ path: relPath, reason: "binary or non-text content" });
      continue;
    }

    const baseDocId = safeDocIdFromPath(relPath);
    const nextCount = (usedDocIds.get(baseDocId) || 0) + 1;
    usedDocIds.set(baseDocId, nextCount);
    const docId = nextCount === 1 ? baseDocId : `${baseDocId}-${nextCount}`;

    accepted.push({
      absPath,
      relPath,
      docId,
      text: raw.toString("utf8")
    });
  }

  return { rootDir, accepted, skipped };
}

async function handleWrite(parsed) {
  const client = buildClient(parsed);
  const folder = String(getFlag(parsed, "folder") || "").trim();
  if (folder) {
    const docId = String(getFlag(parsed, "doc-id") || getFlag(parsed, "docId") || "").trim();
    const url = String(getFlag(parsed, "url") || "").trim();
    const directText = getFlag(parsed, "text");
    const filePath = getFlag(parsed, "file");
    if (docId || url || (directText && directText !== true) || (filePath && filePath !== true) || !process.stdin.isTTY) {
      throw new Error("write --folder cannot be combined with --doc-id, --text, --file, --url, or piped stdin.");
    }

    const { rootDir, accepted, skipped } = collectFolderDocuments(folder);
    if (!accepted.length) {
      throw new Error("No acceptable text files were found in the folder.");
    }

    const collection = String(getFlag(parsed, "collection") || defaultCollectionFromFolder(rootDir)).trim();
    const commonParams = {
      collection,
      tenantId: getFlag(parsed, "tenant"),
      policy: getFlag(parsed, "policy"),
      expiresAt: getFlag(parsed, "expires-at"),
      visibility: getFlag(parsed, "visibility"),
      acl: parseListFlag(getFlag(parsed, "acl")),
      agentId: getFlag(parsed, "agent-id"),
      tags: parseListFlag(getFlag(parsed, "tags"))
    };

    const indexed = [];
    for (const item of accepted) {
      const payload = await client.indexText(item.docId, item.text, {
        ...commonParams,
        idempotencyKey: `atlasrag-cli-${Date.now()}-${randomSecret(6)}`
      });
      const data = payload?.data || payload;
      indexed.push({
        path: item.relPath,
        docId: data.docId || item.docId,
        chunksIndexed: data.chunksIndexed ?? null
      });
    }

    if (boolFromFlag(getFlag(parsed, "json"), false)) {
      console.log(JSON.stringify({
        ok: true,
        folder: rootDir,
        collection,
        indexed,
        skipped
      }, null, 2));
      return;
    }

    printSummary("Folder ingest complete.", [
      `folder: ${rootDir}`,
      `collection: ${collection}`,
      `indexed: ${indexed.length}`,
      `skipped: ${skipped.length}`
    ]);
    if (skipped.length) {
      console.log("");
      console.log("Skipped:");
      skipped.slice(0, 10).forEach((item) => {
        console.log(`- ${item.path} (${item.reason})`);
      });
      if (skipped.length > 10) {
        console.log(`- ... and ${skipped.length - 10} more`);
      }
    }
    return;
  }

  const docId = String(getFlag(parsed, "doc-id") || getFlag(parsed, "docId") || "").trim();
  if (!docId) {
    throw new Error("write requires --doc-id, or use --folder PATH.");
  }
  const url = String(getFlag(parsed, "url") || "").trim();
  const text = getTextInput(parsed).trim();
  if (url && text) {
    throw new Error("write accepts either --url or text input, not both.");
  }
  if (!url && !text) {
    throw new Error("write requires --text, --file, --url, or piped stdin.");
  }

  const params = {
    collection: getFlag(parsed, "collection"),
    tenantId: getFlag(parsed, "tenant"),
    policy: getFlag(parsed, "policy"),
    expiresAt: getFlag(parsed, "expires-at"),
    visibility: getFlag(parsed, "visibility"),
    acl: parseListFlag(getFlag(parsed, "acl")),
    agentId: getFlag(parsed, "agent-id"),
    tags: parseListFlag(getFlag(parsed, "tags")),
    idempotencyKey: `atlasrag-cli-${Date.now()}-${randomSecret(6)}`
  };

  const payload = url
    ? await client.indexUrl(docId, url, params)
    : await client.indexText(docId, text, params);

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  printSummary("Write complete.", [
    `docId: ${data.docId || docId}`,
    `chunksIndexed: ${data.chunksIndexed ?? "unknown"}`,
    `collection: ${resolveEffectiveCollection(client, payload)}`
  ]);
}

async function handleSearch(parsed) {
  const client = buildClient(parsed);
  const query = String(getFlag(parsed, "q") || parsed.positionals.slice(1).join(" ") || "").trim();
  if (!query) {
    throw new Error("search requires --q QUERY or a positional query.");
  }
  const k = parseInt(String(getFlag(parsed, "k") || "5"), 10);
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("search requires --k to be a positive integer.");
  }
  const policy = getFlag(parsed, "policy");
  const docIds = parseListFlag(getFlag(parsed, "doc-ids") || getFlag(parsed, "docIds"));
  const payload = await client.search(query, { k, policy, docIds });

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  const results = Array.isArray(data.results) ? data.results : [];
  console.log(`Query: ${query}`);
  console.log(`Collection: ${resolveEffectiveCollection(client, payload)}`);
  if (!results.length) {
    console.log("No results.");
    return;
  }
  console.log("");
  results.forEach((item, index) => {
    const score = Number.isFinite(item.score) ? item.score.toFixed(4) : String(item.score || "");
    console.log(`${index + 1}. ${item.docId || "(no docId)"}  score=${score}`);
    if (item.preview) console.log(`   ${item.preview}`);
  });
}

async function handleAsk(parsed) {
  const client = buildClient(parsed);
  const question = String(getFlag(parsed, "question") || parsed.positionals.slice(1).join(" ") || "").trim();
  if (!question) {
    throw new Error("ask requires --question TEXT or a positional question.");
  }
  const k = parseInt(String(getFlag(parsed, "k") || "5"), 10);
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("ask requires --k to be a positive integer.");
  }
  const policy = getFlag(parsed, "policy");
  const answerLength = String(getFlag(parsed, "answer-length") || getFlag(parsed, "answerLength") || "auto");
  const docIds = parseListFlag(getFlag(parsed, "doc-ids") || getFlag(parsed, "docIds"));
  const payload = await client.ask(question, { k, policy, answerLength, docIds });

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  console.log(`Question: ${question}`);
  console.log(`Collection: ${resolveEffectiveCollection(client, payload)}`);
  console.log("");
  console.log(data.answer || "(no answer)");
  const citations = Array.isArray(data.citations) ? data.citations : [];
  if (citations.length) {
    console.log("");
    console.log("Sources:");
    citations.forEach((item, index) => {
      if (typeof item === "string") {
        console.log(`${index + 1}. ${item}`);
        return;
      }
      console.log(`${index + 1}. ${item.docId || item.chunkId || "source"}`);
    });
  }
}

function handleConfig(parsed) {
  const sub = parsed.subcommand || "show";
  if (sub !== "show") {
    throw new Error(`Unknown config subcommand: ${sub}`);
  }
  const saved = readConfig();
  const showSecrets = boolFromFlag(getFlag(parsed, "show-secrets"), false);
  const output = {
    ...saved,
    apiKey: showSecrets ? (saved.apiKey || "") : maskSecret(saved.apiKey || ""),
    openAiApiKey: showSecrets ? (saved.openAiApiKey || "") : maskSecret(saved.openAiApiKey || "")
  };
  console.log(JSON.stringify(output, null, 2));
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const command = parsed.command;

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "onboard":
      await handleOnboard(parsed);
      return;
    case "start":
      await handleStart(parsed);
      return;
    case "stop":
      await handleStop(parsed);
      return;
    case "status":
      await handleStatus(parsed);
      return;
    case "logs":
      await handleLogs(parsed);
      return;
    case "doctor":
      await handleDoctor(parsed);
      return;
    case "bootstrap":
      await handleBootstrap(parsed);
      return;
    case "write":
      await handleWrite(parsed);
      return;
    case "search":
      await handleSearch(parsed);
      return;
    case "ask":
      await handleAsk(parsed);
      return;
    case "config":
      handleConfig(parsed);
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run \`atlasrag help\`.`);
  }
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});

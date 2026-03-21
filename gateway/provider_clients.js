const OpenAI = require("openai");
const {
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  buildResponsesCreateParams,
  normalizeModelId,
  normalizeProviderId
} = require("./model_catalog");

const OPENAI_CLIENTS = new Map();
const PROVIDER_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
const ANTHROPIC_VERSION = "2023-06-01";

function providerEnvKey(provider) {
  const clean = normalizeProviderId(provider);
  if (clean === "gemini") return "GEMINI_API_KEY";
  if (clean === "anthropic") return "ANTHROPIC_API_KEY";
  return "OPENAI_API_KEY";
}

function providerEnvAliases(provider) {
  const clean = normalizeProviderId(provider);
  if (clean === "gemini") return ["GEMINI_API_KEY", "GEMINI_API"];
  if (clean === "anthropic") return ["ANTHROPIC_API_KEY"];
  return ["OPENAI_API_KEY"];
}

function resolveProviderApiKey(provider, overrideKey = "") {
  const direct = String(overrideKey || "").trim();
  if (direct) return direct;
  for (const key of providerEnvAliases(provider)) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  throw new Error(`${providerEnvKey(provider)} not set on server`);
}

function createAbortSignal(timeoutMs = PROVIDER_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal: undefined, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

function createOpenAIClient(apiKey) {
  const cleanKey = resolveProviderApiKey("openai", apiKey);
  const options = { apiKey: cleanKey };
  if (Number.isFinite(PROVIDER_TIMEOUT_MS) && PROVIDER_TIMEOUT_MS > 0) {
    options.timeout = PROVIDER_TIMEOUT_MS;
  }
  return new OpenAI(options);
}

function getOpenAIClient(apiKey = "") {
  const cleanKey = String(apiKey || "").trim();
  if (cleanKey) return createOpenAIClient(cleanKey);
  const serverKey = resolveProviderApiKey("openai");
  if (OPENAI_CLIENTS.has(serverKey)) return OPENAI_CLIENTS.get(serverKey);
  const client = createOpenAIClient(serverKey);
  OPENAI_CLIENTS.set(serverKey, client);
  return client;
}

function normalizeGeminiModelPath(model) {
  return String(normalizeModelId(model) || "").replace(/^models\//i, "");
}

function extractAnthropicText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return blocks
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function extractGeminiText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const parts = candidates[0]?.content?.parts;
  const list = Array.isArray(parts) ? parts : [];
  return list
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiUsage(payload) {
  const usage = payload?.usageMetadata || {};
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || (inputTokens + outputTokens));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

function extractAnthropicUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

function extractOpenAiUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || (inputTokens + outputTokens));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

async function fetchJson(url, options = {}) {
  const { signal, dispose } = createAbortSignal();
  try {
    const res = await fetch(url, { ...options, signal });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const message = payload?.error?.message
        || payload?.error
        || payload?.message
        || res.statusText
        || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    dispose();
  }
}

async function generateTextWithOpenAI({ model, input, apiKey, temperature, jsonMode = false }) {
  const client = getOpenAIClient(apiKey);
  const resp = await client.responses.create(buildResponsesCreateParams({
    provider: "openai",
    model,
    input,
    temperature,
    ...(jsonMode ? { text: { format: { type: "json_object" } } } : {})
  }));
  return {
    text: String(resp?.output_text || "").trim(),
    usage: extractOpenAiUsage(resp?.usage)
  };
}

async function generateTextWithGemini({ model, input, apiKey, temperature, jsonMode = false }) {
  const key = resolveProviderApiKey("gemini", apiKey);
  const generationConfig = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (jsonMode) generationConfig.responseMimeType = "application/json";
  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizeGeminiModelPath(model))}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: String(input || "") }]
        }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {})
      })
    }
  );
  return {
    text: extractGeminiText(payload),
    usage: extractGeminiUsage(payload)
  };
}

async function generateTextWithAnthropic({ model, input, apiKey, temperature, maxTokens = 1024 }) {
  const key = resolveProviderApiKey("anthropic", apiKey);
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: String(input || "")
      }],
      ...(temperature !== undefined ? { temperature } : {})
    })
  });
  return {
    text: extractAnthropicText(payload),
    usage: extractAnthropicUsage(payload)
  };
}

async function generateProviderText({
  provider = DEFAULT_ANSWER_PROVIDER,
  model,
  input,
  apiKey,
  temperature,
  jsonMode = false,
  maxTokens
}) {
  const cleanProvider = normalizeProviderId(provider) || DEFAULT_ANSWER_PROVIDER;
  if (cleanProvider === "gemini") {
    return generateTextWithGemini({ model, input, apiKey, temperature, jsonMode });
  }
  if (cleanProvider === "anthropic") {
    return generateTextWithAnthropic({ model, input, apiKey, temperature, maxTokens });
  }
  return generateTextWithOpenAI({ model, input, apiKey, temperature, jsonMode });
}

function extractOpenAiEmbeddingUsage(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0)
  };
}

async function embedTextsWithOpenAI({ texts, model, apiKey }) {
  const client = getOpenAIClient(apiKey);
  const resp = await client.embeddings.create({
    model,
    input: texts
  });
  return {
    vectors: resp.data.map((item) => item.embedding),
    usage: extractOpenAiEmbeddingUsage(resp.usage)
  };
}

async function embedSingleTextWithGemini({ model, text, apiKey, taskType }) {
  const key = resolveProviderApiKey("gemini", apiKey);
  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizeGeminiModelPath(model))}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        content: {
          parts: [{ text: String(text || "") }]
        },
        ...(taskType ? { taskType } : {})
      })
    }
  );
  const values = payload?.embedding?.values || payload?.embeddings?.[0]?.values;
  if (!Array.isArray(values)) {
    throw new Error("Gemini embedding response did not include vector values.");
  }
  return {
    vector: values,
    usage: {
      prompt_tokens: Number(payload?.usageMetadata?.promptTokenCount || 0),
      total_tokens: Number(payload?.usageMetadata?.totalTokenCount || payload?.usageMetadata?.promptTokenCount || 0)
    }
  };
}

async function embedTextsWithGemini({ texts, model, apiKey, taskType }) {
  const vectors = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  for (const text of texts) {
    const item = await embedSingleTextWithGemini({ model, text, apiKey, taskType });
    vectors.push(item.vector);
    usage.prompt_tokens += Number(item?.usage?.prompt_tokens || 0);
    usage.total_tokens += Number(item?.usage?.total_tokens || 0);
  }
  return { vectors, usage };
}

async function embedProviderTexts({
  provider = DEFAULT_EMBED_PROVIDER,
  texts,
  model,
  apiKey,
  taskType
}) {
  const cleanProvider = normalizeProviderId(provider) || DEFAULT_EMBED_PROVIDER;
  if (cleanProvider === "gemini") {
    return embedTextsWithGemini({ texts, model, apiKey, taskType });
  }
  if (cleanProvider !== "openai") {
    throw new Error(`Embedding provider "${cleanProvider}" is not supported. Use openai or gemini.`);
  }
  return embedTextsWithOpenAI({ texts, model, apiKey });
}

module.exports = {
  providerEnvKey,
  providerEnvAliases,
  resolveProviderApiKey,
  generateProviderText,
  embedProviderTexts,
  __testHooks: {
    normalizeGeminiModelPath,
    extractGeminiText,
    extractAnthropicText,
    extractGeminiUsage,
    extractAnthropicUsage,
    extractOpenAiUsage
  }
};

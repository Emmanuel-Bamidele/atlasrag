// memory_reflect.js
// Generate semantic/procedural/summary memories from artifact text.

const {
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_REFLECT_MODEL,
  normalizeModelId,
  normalizeProviderId,
  resolveRequestedGenerationConfig
} = require("./model_config");
const { generateProviderText } = require("./provider_clients");

const DEFAULT_MAX_ITEMS = parseInt(process.env.REFLECT_MAX_ITEMS || "5", 10);
let reflectFallbackWarned = false;
let compactFallbackWarned = false;

function resolveReflectProvider(options = {}) {
  return normalizeProviderId(options?.provider ?? options?.reflectProvider)
    || normalizeProviderId(process.env.REFLECT_PROVIDER)
    || DEFAULT_REFLECT_PROVIDER;
}

function resolveReflectModel(options = {}) {
  return resolveRequestedGenerationConfig({
    provider: resolveReflectProvider(options),
    model: options?.model ?? options?.reflectModel ?? process.env.REFLECT_MODEL,
    fallbackProvider: resolveReflectProvider(options),
    fallbackModel: DEFAULT_REFLECT_MODEL
  }).model;
}

function resolveCompactProvider(options = {}) {
  return normalizeProviderId(options?.provider ?? options?.compactProvider ?? options?.reflectProvider)
    || normalizeProviderId(process.env.COMPACT_PROVIDER)
    || resolveReflectProvider(options);
}

function resolveCompactModel(options = {}) {
  return resolveRequestedGenerationConfig({
    provider: resolveCompactProvider(options),
    model: options?.model ?? options?.compactModel ?? options?.reflectModel ?? process.env.COMPACT_MODEL,
    fallbackProvider: resolveCompactProvider(options),
    fallbackModel: resolveReflectModel(options)
  }).model;
}

function normalizeTypes(types) {
  const allowed = new Set(["semantic", "procedural", "summary"]);
  const list = Array.isArray(types) ? types : [];
  const out = list.filter((t) => allowed.has(t));
  return out.length ? out : ["semantic", "procedural", "summary"];
}

function buildPrompt(text, types, maxItems) {
  const typeList = types.join(", ");
  return `You are converting an artifact into memories for an AI agent.
Return a JSON object with keys: semantic, procedural, summary.
Each key maps to an array of items. Each item has:
- title: short title
- content: concise factual memory
Rules:
- Only use information present in the artifact text.
- Avoid speculation.
- Max items per type: ${maxItems}.
- If a type has no items, return an empty array.
Requested types: ${typeList}

Artifact text:
${text}`;
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeTitle(prefix, sentence, idx) {
  const words = String(sentence || "")
    .replace(/[^a-zA-Z0-9._:@ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  return words ? `${prefix}: ${words}` : `${prefix} ${idx + 1}`;
}

function buildFallbackReflection({ text, types, maxItems }) {
  const selected = normalizeTypes(types);
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS;
  const sentences = splitSentences(text);
  const makeItems = (prefix, list) =>
    list.slice(0, limit).map((sentence, idx) => ({
      title: makeTitle(prefix, sentence, idx),
      content: sentence
    }));

  const semantic = selected.includes("semantic")
    ? makeItems("Semantic", sentences)
    : [];
  const proceduralSource = sentences.filter((s) =>
    /\b(should|must|use|ensure|avoid|step|first|then|finally)\b/i.test(s)
  );
  const procedural = selected.includes("procedural")
    ? makeItems("Procedure", proceduralSource.length ? proceduralSource : sentences)
    : [];
  const summarySource = sentences.length
    ? [sentences.slice(0, Math.min(2, sentences.length)).join(" ")]
    : [];
  const summary = selected.includes("summary")
    ? makeItems("Summary", summarySource)
    : [];

  return { semantic, procedural, summary, usage: null };
}

async function reflectMemories({ text, types, maxItems, apiKey, provider, reflectProvider, reflectModel }) {
  const selected = normalizeTypes(types);
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS;
  const input = buildPrompt(text, selected, limit);
  const resolved = resolveRequestedGenerationConfig({
    provider: provider ?? reflectProvider,
    model: reflectModel,
    fallbackProvider: resolveReflectProvider({ provider, reflectProvider }),
    fallbackModel: resolveReflectModel({ provider, reflectProvider, reflectModel })
  });

  let resp = null;
  try {
    resp = await generateProviderText({
      provider: resolved.provider,
      model: resolved.model,
      input,
      apiKey,
      temperature: 0.2,
      jsonMode: true,
      maxTokens: 1024
    });
  } catch (err) {
    if (!reflectFallbackWarned) {
      reflectFallbackWarned = true;
      console.warn(`[reflect] ${resolved.provider} generation unavailable, using extractive fallback (${String(err?.message || err)})`);
    }
    return buildFallbackReflection({ text, types: selected, maxItems: limit });
  }

  const raw = String(resp?.text || "").trim();
  const usage = resp?.usage || null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return buildFallbackReflection({ text, types: selected, maxItems: limit });
  }

  return {
    semantic: Array.isArray(payload.semantic) ? payload.semantic : [],
    procedural: Array.isArray(payload.procedural) ? payload.procedural : [],
    summary: Array.isArray(payload.summary) ? payload.summary : [],
    usage
  };
}

function buildCompactPrompt(text) {
  return `Summarize the memories below into one concise memory.\nReturn a JSON object with keys: title, content.\n- title: short descriptive title\n- content: concise factual memory\nOnly use the provided text. Avoid speculation.\n\nMemories:\n${text}`;
}

function buildFallbackCompaction(text) {
  const sentences = splitSentences(text);
  const summary = sentences.length
    ? sentences.slice(0, Math.min(2, sentences.length)).join(" ")
    : String(text || "").trim();
  const content = summary || "No memory content available.";
  return {
    title: makeTitle("Compaction", content, 0),
    content,
    usage: null
  };
}

async function summarizeMemories({ text, apiKey, provider, compactProvider, compactModel, reflectProvider, reflectModel }) {
  const input = buildCompactPrompt(text);
  const resolved = resolveRequestedGenerationConfig({
    provider: provider ?? compactProvider ?? reflectProvider,
    model: compactModel ?? reflectModel,
    fallbackProvider: resolveCompactProvider({ provider, compactProvider, reflectProvider }),
    fallbackModel: resolveCompactModel({ provider, compactProvider, compactModel, reflectProvider, reflectModel })
  });

  let resp = null;
  try {
    resp = await generateProviderText({
      provider: resolved.provider,
      model: resolved.model,
      input,
      apiKey,
      temperature: 0.2,
      jsonMode: true,
      maxTokens: 512
    });
  } catch (err) {
    if (!compactFallbackWarned) {
      compactFallbackWarned = true;
      console.warn(`[compact] ${resolved.provider} generation unavailable, using extractive fallback (${String(err?.message || err)})`);
    }
    return buildFallbackCompaction(text);
  }

  const raw = String(resp?.text || "").trim();
  const usage = resp?.usage || null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return buildFallbackCompaction(text);
  }

  return {
    title: String(payload.title || "").trim() || makeTitle("Compaction", payload?.content || text, 0),
    content: String(payload.content || "").trim() || String(text || "").trim(),
    usage
  };
}

module.exports = {
  reflectMemories,
  summarizeMemories,
  __testHooks: {
    resolveReflectProvider,
    resolveReflectModel,
    resolveCompactProvider,
    resolveCompactModel
  }
};

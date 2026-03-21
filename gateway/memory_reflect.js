// memory_reflect.js
// Generate semantic/procedural/summary memories from artifact text.

const OpenAI = require("openai");
const {
  DEFAULT_REFLECT_MODEL,
  buildResponsesCreateParams,
  normalizeModelId
} = require("./model_config");

let defaultClient = null;
function createClient(key) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) {
    throw new Error("OPENAI_API_KEY not set on server");
  }
  const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
  const options = { apiKey: cleanKey };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    options.timeout = timeoutMs;
  }
  return new OpenAI(options);
}

function getClient(apiKey = "") {
  const overrideKey = String(apiKey || "").trim();
  if (overrideKey) {
    return createClient(overrideKey);
  }
  if (defaultClient) return defaultClient;
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY not set on server");
  }
  defaultClient = createClient(key);
  return defaultClient;
}

const DEFAULT_MAX_ITEMS = parseInt(process.env.REFLECT_MAX_ITEMS || "5", 10);
let reflectFallbackWarned = false;
let compactFallbackWarned = false;

function resolveReflectModel(options = {}) {
  return normalizeModelId(options?.model ?? options?.reflectModel)
    || normalizeModelId(process.env.REFLECT_MODEL)
    || DEFAULT_REFLECT_MODEL;
}

function resolveCompactModel(options = {}) {
  return normalizeModelId(options?.model ?? options?.compactModel ?? options?.reflectModel)
    || normalizeModelId(process.env.COMPACT_MODEL)
    || resolveReflectModel(options);
}

function normalizeTypes(types) {
  const allowed = new Set(["semantic", "procedural", "summary"]);
  const list = Array.isArray(types) ? types : [];
  const out = list.filter(t => allowed.has(t));
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

async function reflectMemories({ text, types, maxItems, apiKey, reflectModel }) {
  const selected = normalizeTypes(types);
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS;
  const input = buildPrompt(text, selected, limit);

  let resp = null;
  try {
    resp = await getClient(apiKey).responses.create(buildResponsesCreateParams({
      model: resolveReflectModel({ reflectModel }),
      input,
      temperature: 0.2,
      text: { format: { type: "json_object" } }
    }));
  } catch (err) {
    if (!reflectFallbackWarned) {
      reflectFallbackWarned = true;
      console.warn(`[reflect] OpenAI unavailable, using extractive fallback (${String(err?.message || err)})`);
    }
    return buildFallbackReflection({ text, types: selected, maxItems: limit });
  }

  const raw = (resp.output_text || "").trim();
  const usage = resp.usage || null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
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

async function summarizeMemories({ text, apiKey, compactModel, reflectModel }) {
  const input = buildCompactPrompt(text);
  let resp = null;
  try {
    resp = await getClient(apiKey).responses.create(buildResponsesCreateParams({
      model: resolveCompactModel({ compactModel, reflectModel }),
      input,
      temperature: 0.2,
      text: { format: { type: "json_object" } }
    }));
  } catch (err) {
    if (!compactFallbackWarned) {
      compactFallbackWarned = true;
      console.warn(`[compact] OpenAI unavailable, using extractive fallback (${String(err?.message || err)})`);
    }
    return buildFallbackCompaction(text);
  }

  const raw = (resp.output_text || "").trim();
  const usage = resp.usage || null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
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
    resolveReflectModel,
    resolveCompactModel
  }
};

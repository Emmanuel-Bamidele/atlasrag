// memory_reflect.js
// Generate semantic/procedural/summary memories from artifact text.

const OpenAI = require("openai");

let defaultClient = null;
function getClient() {
  if (defaultClient) return defaultClient;
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY not set on server");
  }
  const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
  const options = { apiKey: key };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    options.timeout = timeoutMs;
  }
  defaultClient = new OpenAI(options);
  return defaultClient;
}

const DEFAULT_MODEL = process.env.REFLECT_MODEL || "gpt-4o-mini";
const DEFAULT_MAX_ITEMS = parseInt(process.env.REFLECT_MAX_ITEMS || "5", 10);
const COMPACT_MODEL = process.env.COMPACT_MODEL || DEFAULT_MODEL;

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

async function reflectMemories({ text, types, maxItems }) {
  const selected = normalizeTypes(types);
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS;
  const input = buildPrompt(text, selected, limit);

  const resp = await getClient().responses.create({
    model: DEFAULT_MODEL,
    input,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  const raw = (resp.output_text || "").trim();
  const usage = resp.usage || null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse reflection output");
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

async function summarizeMemories({ text }) {
  const input = buildCompactPrompt(text);
  const resp = await getClient().responses.create({
    model: COMPACT_MODEL,
    input,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  const raw = (resp.output_text || "").trim();
  const usage = resp.usage || null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse compaction output");
  }

  return {
    title: String(payload.title || "").trim(),
    content: String(payload.content || "").trim(),
    usage
  };
}

module.exports = { reflectMemories, summarizeMemories };

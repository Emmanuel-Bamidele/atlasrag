const CUSTOM_MODEL_SENTINEL = "__custom__";

const DEFAULT_ANSWER_MODEL = "gpt-4o";
const DEFAULT_EMBED_MODEL = "text-embedding-3-large";
const DEFAULT_REFLECT_MODEL = "gpt-4o-mini";

const GENERATION_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "gpt-4o",
    label: "Balanced default",
    family: "gpt-4o",
    supportsTemperature: true,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: "gpt-4.1",
    label: "Stronger text output",
    family: "gpt-4.1",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "3",
    model: "gpt-4o-mini",
    label: "Fastest / lowest cost",
    family: "gpt-4o",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "4",
    model: "gpt-4.1-mini",
    label: "Fast GPT-4.1",
    family: "gpt-4.1",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "5",
    model: "gpt-4.1-nano",
    label: "Lowest-cost GPT-4.1",
    family: "gpt-4.1",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "6",
    model: "gpt-5.2",
    label: "Recent flagship reasoning",
    family: "gpt-5",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "7",
    model: "gpt-5-mini",
    label: "Recent fast GPT-5",
    family: "gpt-5",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "8",
    model: "gpt-5-nano",
    label: "Recent smallest GPT-5",
    family: "gpt-5",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "9",
    model: "o1",
    label: "Deeper reasoning",
    family: "o-series",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "10",
    model: "o3",
    label: "Stronger reasoning",
    family: "o-series",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "11",
    model: "o3-mini",
    label: "Lower-cost reasoning",
    family: "o-series",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "12",
    model: "o4-mini",
    label: "Recent fast reasoning",
    family: "o-series",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "13",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id",
    family: "custom",
    supportsTemperature: false
  })
]);

const EMBEDDING_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "text-embedding-3-large",
    label: "Best quality (default)",
    dimensions: 3072,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: "text-embedding-3-small",
    label: "Lower cost",
    dimensions: 1536
  }),
  Object.freeze({
    key: "3",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id"
  })
]);

function normalizeModelId(value) {
  const clean = String(value || "").trim();
  return clean || null;
}

function findGenerationModelPreset(value) {
  const clean = normalizeModelId(value);
  if (!clean) return null;
  return GENERATION_MODEL_PRESETS.find((item) => item.key === clean || item.model === clean) || null;
}

function findEmbeddingModelPreset(value) {
  const clean = normalizeModelId(value);
  if (!clean) return null;
  return EMBEDDING_MODEL_PRESETS.find((item) => item.key === clean || item.model === clean) || null;
}

function defaultGenerationModelSelection(value, fallback = DEFAULT_ANSWER_MODEL) {
  const clean = normalizeModelId(value) || normalizeModelId(fallback) || DEFAULT_ANSWER_MODEL;
  const match = findGenerationModelPreset(clean);
  return match ? match.key : clean;
}

function normalizeGenerationModelSelection(value, fallback = DEFAULT_ANSWER_MODEL) {
  const clean = normalizeModelId(value) || normalizeModelId(fallback) || DEFAULT_ANSWER_MODEL;
  const match = findGenerationModelPreset(clean);
  if (!match) return clean;
  if (match.model === CUSTOM_MODEL_SENTINEL) {
    throw new Error("Custom model id is required.");
  }
  return match.model;
}

function isReasoningStyleModel(modelId) {
  const clean = String(normalizeModelId(modelId) || "").toLowerCase();
  return /^o\d/.test(clean) || /^gpt-5/i.test(clean);
}

function supportsTemperature(modelId) {
  const preset = findGenerationModelPreset(modelId);
  if (preset) return preset.supportsTemperature !== false;
  return !isReasoningStyleModel(modelId);
}

function buildResponsesCreateParams({ model, temperature, ...rest }) {
  const params = { model, ...rest };
  if (temperature !== undefined && supportsTemperature(model)) {
    params.temperature = temperature;
  }
  return params;
}

function buildPublicModelCatalog() {
  return {
    generation: GENERATION_MODEL_PRESETS.map((item) => ({
      key: item.key,
      model: item.model,
      label: item.label,
      family: item.family,
      supportsTemperature: item.supportsTemperature !== false,
      recommended: Boolean(item.recommended),
      custom: item.model === CUSTOM_MODEL_SENTINEL
    })),
    embeddings: EMBEDDING_MODEL_PRESETS.map((item) => ({
      key: item.key,
      model: item.model,
      label: item.label,
      dimensions: item.dimensions || null,
      recommended: Boolean(item.recommended),
      custom: item.model === CUSTOM_MODEL_SENTINEL
    })),
    notes: {
      customModelAllowed: true,
      compatibility: "AtlasRAG omits temperature automatically for reasoning-style models that do not accept it.",
      availability: "Model availability depends on your OpenAI account and region."
    }
  };
}

module.exports = {
  CUSTOM_MODEL_SENTINEL,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  GENERATION_MODEL_PRESETS,
  EMBEDDING_MODEL_PRESETS,
  normalizeModelId,
  findGenerationModelPreset,
  findEmbeddingModelPreset,
  defaultGenerationModelSelection,
  normalizeGenerationModelSelection,
  isReasoningStyleModel,
  supportsTemperature,
  buildResponsesCreateParams,
  buildPublicModelCatalog
};

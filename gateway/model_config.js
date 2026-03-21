const DEFAULT_ANSWER_MODEL = "gpt-4o";
// Keep the runtime fallback conservative for older installs that never pinned EMBED_MODEL.
// Fresh installs and CLI-managed env files explicitly write the recommended embed model.
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_REFLECT_MODEL = "gpt-4o-mini";

function normalizeModelId(value) {
  const clean = String(value || "").trim();
  return clean || null;
}

function resolveEnvModelDefaults(env = process.env) {
  const answerModel = normalizeModelId(env.ANSWER_MODEL) || DEFAULT_ANSWER_MODEL;
  const booleanAskModel = normalizeModelId(env.BOOLEAN_ASK_MODEL) || answerModel;
  const reflectModel = normalizeModelId(env.REFLECT_MODEL) || DEFAULT_REFLECT_MODEL;
  const compactModel = normalizeModelId(env.COMPACT_MODEL) || reflectModel;
  const embedModel = normalizeModelId(env.EMBED_MODEL) || DEFAULT_EMBED_MODEL;
  return {
    answerModel,
    booleanAskModel,
    embedModel,
    reflectModel,
    compactModel
  };
}

function extractTenantModelOverrides(record = {}) {
  return {
    answerModel: normalizeModelId(record.answer_model ?? record.answerModel),
    booleanAskModel: normalizeModelId(record.boolean_ask_model ?? record.booleanAskModel),
    reflectModel: normalizeModelId(record.reflect_model ?? record.reflectModel),
    compactModel: normalizeModelId(record.compact_model ?? record.compactModel)
  };
}

function resolveTenantModelSettings(record = {}, env = process.env) {
  const configured = extractTenantModelOverrides(record);
  const instanceDefaults = resolveEnvModelDefaults(env);
  const answerModel = configured.answerModel || instanceDefaults.answerModel;
  const reflectModel = configured.reflectModel || instanceDefaults.reflectModel;
  return {
    configured,
    instanceDefaults,
    effective: {
      answerModel,
      booleanAskModel: configured.booleanAskModel || configured.answerModel || instanceDefaults.booleanAskModel,
      embedModel: instanceDefaults.embedModel,
      reflectModel,
      compactModel: configured.compactModel || configured.reflectModel || instanceDefaults.compactModel
    }
  };
}

function parseTenantModelSettingsInput(body = {}) {
  const models = body && typeof body.models === "object" && body.models ? body.models : {};
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

  if (has(models, "embedModel") || has(body, "embedModel") || has(body, "embed_model")) {
    const error = new Error("embedModel is instance-wide. Change it in the self-hosted env or with `atlasrag changemodel`.");
    error.code = "INSTANCE_WIDE_MODEL";
    throw error;
  }

  const parseValue = (value) => {
    if (value === undefined) return undefined;
    return normalizeModelId(value);
  };

  return {
    answerModel: parseValue(has(models, "answerModel") ? models.answerModel : (has(body, "answerModel") ? body.answerModel : body.answer_model)),
    booleanAskModel: parseValue(has(models, "booleanAskModel") ? models.booleanAskModel : (has(body, "booleanAskModel") ? body.booleanAskModel : body.boolean_ask_model)),
    reflectModel: parseValue(has(models, "reflectModel") ? models.reflectModel : (has(body, "reflectModel") ? body.reflectModel : body.reflect_model)),
    compactModel: parseValue(has(models, "compactModel") ? models.compactModel : (has(body, "compactModel") ? body.compactModel : body.compact_model))
  };
}

function hasTenantModelSettingsInput(input = {}) {
  return input.answerModel !== undefined
    || input.booleanAskModel !== undefined
    || input.reflectModel !== undefined
    || input.compactModel !== undefined;
}

module.exports = {
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  normalizeModelId,
  resolveEnvModelDefaults,
  extractTenantModelOverrides,
  resolveTenantModelSettings,
  parseTenantModelSettingsInput,
  hasTenantModelSettingsInput
};

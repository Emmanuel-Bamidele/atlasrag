const assert = require("assert/strict");

const {
  resolveEnvModelDefaults,
  resolveTenantModelSettings,
  parseTenantModelSettingsInput
} = require("../model_config");
const { __testHooks: answerHooks } = require("../answer");
const { __testHooks: aiHooks } = require("../ai");
const { __testHooks: reflectHooks } = require("../memory_reflect");

function withEnv(updates, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(updates || {})) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function testTenantModelInheritance() {
  const resolved = resolveTenantModelSettings({
    answer_model: "gpt-4.1",
    boolean_ask_model: null,
    reflect_model: "gpt-4o-mini",
    compact_model: null
  }, {
    ANSWER_MODEL: "gpt-4o",
    BOOLEAN_ASK_MODEL: "",
    EMBED_MODEL: "text-embedding-3-large",
    REFLECT_MODEL: "gpt-4o-mini",
    COMPACT_MODEL: ""
  });

  assert.equal(resolved.effective.answerModel, "gpt-4.1");
  assert.equal(resolved.effective.booleanAskModel, "gpt-4.1");
  assert.equal(resolved.effective.reflectModel, "gpt-4o-mini");
  assert.equal(resolved.effective.compactModel, "gpt-4o-mini");
  assert.equal(resolved.effective.embedModel, "text-embedding-3-large");
}

function testEmbedFallbackStaysCompatible() {
  const resolved = resolveEnvModelDefaults({
    ANSWER_MODEL: "",
    BOOLEAN_ASK_MODEL: "",
    EMBED_MODEL: "",
    REFLECT_MODEL: "",
    COMPACT_MODEL: ""
  });

  assert.equal(resolved.embedModel, "text-embedding-3-small");
}

function testTenantModelInputParsing() {
  const parsed = parseTenantModelSettingsInput({
    models: {
      answerModel: " gpt-4.1 ",
      booleanAskModel: "",
      reflectModel: "gpt-4o-mini",
      compactModel: null
    }
  });

  assert.equal(parsed.answerModel, "gpt-4.1");
  assert.equal(parsed.booleanAskModel, null);
  assert.equal(parsed.reflectModel, "gpt-4o-mini");
  assert.equal(parsed.compactModel, null);
  assert.throws(
    () => parseTenantModelSettingsInput({ models: { embedModel: "text-embedding-3-large" } }),
    /instance-wide/
  );
}

function testAnswerModelResolvers() {
  withEnv({
    ANSWER_MODEL: "gpt-4o",
    BOOLEAN_ASK_MODEL: ""
  }, () => {
    assert.equal(answerHooks.resolveAnswerModel({ model: "gpt-4.1" }), "gpt-4.1");
    assert.equal(answerHooks.resolveAnswerModel({}), "gpt-4o");
    assert.equal(answerHooks.resolveBooleanAskModel({ answerModel: "gpt-4.1" }), "gpt-4.1");
    assert.equal(answerHooks.resolveBooleanAskModel({ model: "gpt-4o-mini" }), "gpt-4o-mini");
  });
}

function testEmbedAndReflectResolvers() {
  withEnv({
    EMBED_MODEL: "text-embedding-3-large",
    REFLECT_MODEL: "gpt-4o-mini",
    COMPACT_MODEL: ""
  }, () => {
    assert.equal(aiHooks.resolveEmbedModel({}), "text-embedding-3-large");
    assert.equal(aiHooks.resolveEmbedModel({ embedModel: "text-embedding-3-small" }), "text-embedding-3-small");
    assert.equal(reflectHooks.resolveReflectModel({}), "gpt-4o-mini");
    assert.equal(reflectHooks.resolveCompactModel({ reflectModel: "gpt-4.1-mini" }), "gpt-4.1-mini");
  });
}

function main() {
  testEmbedFallbackStaysCompatible();
  testTenantModelInheritance();
  testTenantModelInputParsing();
  testAnswerModelResolvers();
  testEmbedAndReflectResolvers();
  console.log("model config tests passed");
}

main();

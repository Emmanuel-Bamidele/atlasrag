const assert = require("assert");
const { __testHooks } = require("../index");

assert(__testHooks, "expected __testHooks export from gateway/index.js");

const {
  normalizeMemoryPolicy,
  getMemoryPolicy,
  resolveMemoryPolicyConfig,
  normalizeTier,
  resolveTierThresholds,
  resolveTierForValue,
  resolveInitialValueScore,
  decayMemoryValue,
  buildValueUpdateForMemory,
  MEMORY_TIER_THRESHOLDS,
  MEMORY_VALUE_MAX,
  MEMORY_VALUE_DECAY_LAMBDA,
  MEMORY_ACCESS_ALPHA,
  MEMORY_CONTRIBUTION_BETA
} = __testHooks;

function approxEqual(actual, expected, eps = 1e-8) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

const NOW = Date.parse("2026-02-18T00:00:00Z");
const DAY_MS = 86400000;

(() => {
  assert.strictEqual(normalizeMemoryPolicy(undefined), "amvl");
  assert.strictEqual(normalizeMemoryPolicy("AMV-L"), "amvl");
  assert.strictEqual(normalizeMemoryPolicy("ttl"), "ttl");
  assert.strictEqual(normalizeMemoryPolicy("lru"), "lru");
})();

(() => {
  assert.strictEqual(getMemoryPolicy({ metadata: { _policy: "lru" } }), "lru");
  assert.strictEqual(getMemoryPolicy({ metadata: { _policy: "ttl" } }), "ttl");
  assert.strictEqual(getMemoryPolicy({ metadata: { _policy: "not-real" } }), "amvl");
})();

(() => {
  const init = resolveInitialValueScore();
  assert.ok(init >= MEMORY_TIER_THRESHOLDS.warmUp, "initial value should be >= warmUp");
  assert.ok(init < MEMORY_TIER_THRESHOLDS.hotUp, "initial value should be < hotUp");
})();

(() => {
  const ttlThresholds = resolveTierThresholds("ttl");
  assert.ok(ttlThresholds.warmUp > ttlThresholds.hotDown, "ttl should preserve the HOT/WARM hysteresis gap");
  const ttlInit = resolveInitialValueScore("ttl");
  assert.ok(ttlInit >= ttlThresholds.warmUp, "ttl initial value should stay in warm band");
  assert.ok(ttlInit < ttlThresholds.hotUp, "ttl initial value should stay below hot promotion");
})();

(() => {
  assert.strictEqual(normalizeTier("hot"), "HOT");
  assert.strictEqual(normalizeTier("warm"), "WARM");
  assert.strictEqual(normalizeTier("cold"), "COLD");
  assert.strictEqual(normalizeTier("invalid", "WARM"), "WARM");
})();

(() => {
  const baseline = {
    value_score: 0.4,
    tier: "WARM",
    pinned: false,
    value_last_update_ts: NOW,
    tier_last_update_ts: NOW - 1000
  };
  const updated = buildValueUpdateForMemory(baseline, "retrieved", 0, NOW);
  const expected = Math.min(MEMORY_VALUE_MAX, 0.4 + MEMORY_ACCESS_ALPHA);
  approxEqual(updated.valueScore, expected);
  assert.strictEqual(updated.tier, "WARM");
  assert.strictEqual(updated.tierLastUpdateTs, baseline.tier_last_update_ts);
})();

(() => {
  const baseline = {
    value_score: 0.2,
    tier: "WARM",
    pinned: false,
    value_last_update_ts: NOW,
    tier_last_update_ts: NOW - 1000
  };
  const updated = buildValueUpdateForMemory(baseline, "used_in_answer", 1, NOW);
  const expected = Math.min(MEMORY_VALUE_MAX, 0.2 + MEMORY_ACCESS_ALPHA + MEMORY_CONTRIBUTION_BETA);
  approxEqual(updated.valueScore, expected);
})();

(() => {
  const days = 2;
  const baseline = {
    value_score: 0.8,
    tier: "HOT",
    pinned: false,
    value_last_update_ts: NOW - days * DAY_MS,
    tier_last_update_ts: NOW - 5000
  };

  const decayed = buildValueUpdateForMemory(baseline, "retrieved", 0, NOW, { decayOnly: true });
  const expectedDecay = 0.8 * Math.exp(-MEMORY_VALUE_DECAY_LAMBDA * days);
  approxEqual(decayed.valueScore, expectedDecay);

  const withAccess = buildValueUpdateForMemory(baseline, "retrieved", 0, NOW);
  approxEqual(withAccess.valueScore, Math.min(MEMORY_VALUE_MAX, expectedDecay + MEMORY_ACCESS_ALPHA));
})();

(() => {
  const capped = buildValueUpdateForMemory({
    value_score: MEMORY_VALUE_MAX,
    tier: "HOT",
    pinned: false,
    value_last_update_ts: NOW,
    tier_last_update_ts: NOW
  }, "used_in_answer", 1, NOW);
  assert.strictEqual(capped.valueScore, MEMORY_VALUE_MAX);
})();

(() => {
  const hotPromote = resolveTierForValue(
    "WARM",
    MEMORY_TIER_THRESHOLDS.hotUp + 0.001,
    false
  );
  assert.strictEqual(hotPromote, "HOT", "warm should promote to hot above hotUp");

  const hotDemote = resolveTierForValue(
    "HOT",
    MEMORY_TIER_THRESHOLDS.hotDown - 0.001,
    false
  );
  assert.strictEqual(hotDemote, "WARM", "hot should demote to warm below hotDown");

  const warmDemote = resolveTierForValue(
    "WARM",
    MEMORY_TIER_THRESHOLDS.warmDown - 0.001,
    false
  );
  assert.strictEqual(warmDemote, "COLD", "warm should demote to cold below warmDown");

  const coldPromote = resolveTierForValue(
    "COLD",
    MEMORY_TIER_THRESHOLDS.warmUp + 0.001,
    false
  );
  assert.strictEqual(coldPromote, "WARM", "cold should promote to warm at/above warmUp");
})();

(() => {
  const pinnedHot = resolveTierForValue(
    "HOT",
    MEMORY_TIER_THRESHOLDS.hotDown - 0.2,
    true
  );
  assert.strictEqual(pinnedHot, "HOT", "pinned hot should not demote");

  const pinnedWarm = resolveTierForValue(
    "WARM",
    MEMORY_TIER_THRESHOLDS.warmDown - 0.2,
    true
  );
  assert.strictEqual(pinnedWarm, "WARM", "pinned warm should not demote");
})();

(() => {
  const baseline = {
    value_score: MEMORY_TIER_THRESHOLDS.hotUp + 0.01,
    tier: "WARM",
    pinned: false,
    value_last_update_ts: NOW,
    tier_last_update_ts: NOW - 1234
  };
  const updated = buildValueUpdateForMemory(baseline, "retrieved", 0, NOW);
  assert.strictEqual(updated.tier, "HOT");
  assert.strictEqual(updated.tierLastUpdateTs, NOW, "tier transition should stamp current timestamp");
})();

(() => {
  const decayed = decayMemoryValue(0.6, NOW - DAY_MS, NOW);
  const expected = 0.6 * Math.exp(-MEMORY_VALUE_DECAY_LAMBDA);
  approxEqual(decayed, expected);
})();

(() => {
  const lruConfig = resolveMemoryPolicyConfig("lru");
  assert.strictEqual(lruConfig.retrievalWarmSelection, "lru");
  assert.strictEqual(lruConfig.accessAlpha, 0);
  assert.strictEqual(lruConfig.contributionBeta, 0);

  const baseline = {
    value_score: 0.5,
    tier: "WARM",
    pinned: false,
    value_last_update_ts: NOW - DAY_MS,
    tier_last_update_ts: NOW - 1000,
    metadata: { _policy: "lru" }
  };
  const updated = buildValueUpdateForMemory(baseline, "used_in_answer", 1, NOW);
  assert.strictEqual(updated.valueScore, 0.5, "lru items should not change value from access/contribution events");
  assert.strictEqual(updated.tier, "WARM", "lru items should remain warm with zeroed dynamics");
})();

console.log("AMV-L value lifecycle unit tests passed");

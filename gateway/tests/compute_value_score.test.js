const assert = require("assert");
const { computeValueScore } = require("../memory_value");

function approxEqual(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} to be within ${eps} of ${expected}`);
}

const NOW = new Date("2026-02-14T00:00:00Z");

(() => {
  const score = computeValueScore({
    reuse_count: 2,
    utility_ema: 0.3,
    redundancy_score: 0.2,
    trust_score: 0.6,
    importance_hint: 0.1,
    last_used_at: NOW,
    created_at: new Date("2026-02-01T00:00:00Z"),
    tokens_est: 500
  }, {
    now: NOW,
    recencyHalfLifeDays: 30,
    costScaleTokens: 2000
  });

  const R = Math.log1p(2);
  const U = 0.3;
  const N = 1 - 0.2;
  const T = 0.6;
  const A = 1;
  const H = 0.1;
  const C = 500 / 2000;
  const x = 1.2 * R + 2.0 * U + 1.0 * N + 1.0 * T + 0.5 * A + 1.0 * H - 1.0 * C;
  const expected = 1 / (1 + Math.exp(-x));
  approxEqual(score, expected);
})();

(() => {
  const lowReuse = computeValueScore({
    reuse_count: 0,
    utility_ema: 0.2,
    redundancy_score: 0.1,
    trust_score: 0.5,
    last_used_at: NOW,
    tokens_est: 0
  }, { now: NOW });

  const highReuse = computeValueScore({
    reuse_count: 5,
    utility_ema: 0.2,
    redundancy_score: 0.1,
    trust_score: 0.5,
    last_used_at: NOW,
    tokens_est: 0
  }, { now: NOW });

  assert.ok(highReuse > lowReuse, "higher reuse should increase value score");
})();

(() => {
  const recent = computeValueScore({
    reuse_count: 1,
    utility_ema: 0.2,
    redundancy_score: 0.1,
    trust_score: 0.5,
    last_used_at: NOW,
    tokens_est: 0
  }, { now: NOW });

  const old = computeValueScore({
    reuse_count: 1,
    utility_ema: 0.2,
    redundancy_score: 0.1,
    trust_score: 0.5,
    last_used_at: new Date("2025-01-01T00:00:00Z"),
    tokens_est: 0
  }, { now: NOW });

  assert.ok(recent > old, "recent usage should increase value score");
})();

(() => {
  const lowCost = computeValueScore({
    reuse_count: 1,
    utility_ema: 0.2,
    redundancy_score: 0.1,
    trust_score: 0.5,
    last_used_at: NOW,
    tokens_est: 0
  }, { now: NOW });

  const highCost = computeValueScore({
    reuse_count: 1,
    utility_ema: 0.2,
    redundancy_score: 0.1,
    trust_score: 0.5,
    last_used_at: NOW,
    tokens_est: 4000
  }, { now: NOW, costScaleTokens: 2000 });

  assert.ok(lowCost > highCost, "higher token cost should reduce value score");
})();

console.log("compute_value_score tests passed");

// memory_value.js
// Adaptive Memory Value + Lifecycle (AMV-L) scoring helpers.

const DEFAULT_RECENCY_HALFLIFE_DAYS = parseFloat(process.env.MEMORY_RECENCY_HALFLIFE_DAYS || "30");
const DEFAULT_COST_SCALE_TOKENS = parseFloat(process.env.MEMORY_COST_SCALE_TOKENS || "2000");

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

function estimateTokensFromText(text) {
  const clean = String(text || "").trim();
  if (!clean) return 0;
  return Math.max(1, Math.ceil(clean.length / 4));
}

function computeRecencyDecay(lastUsedAt, createdAt, now, halfLifeDays) {
  const refTime = lastUsedAt || createdAt || now || new Date();
  const refDate = refTime instanceof Date ? refTime : new Date(refTime);
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const ageMs = Math.max(0, nowDate.getTime() - refDate.getTime());
  const ageDays = ageMs / 86400000;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_RECENCY_HALFLIFE_DAYS;
  const decay = Math.exp(-ageDays / halfLife);
  return clamp(decay, 0, 1);
}

function computeCost(tokensEst, costScaleTokens) {
  const scale = Number.isFinite(costScaleTokens) && costScaleTokens > 0 ? costScaleTokens : DEFAULT_COST_SCALE_TOKENS;
  const cost = Number(tokensEst || 0) / scale;
  return clamp(cost, 0, 2);
}

function computeValueScore(memory, options = {}) {
  const reuseCount = Number(memory?.reuse_count ?? memory?.reuseCount ?? 0);
  const R = Math.log1p(Math.max(0, reuseCount));

  const U = clamp(Number(memory?.utility_ema ?? memory?.utilityEma ?? 0), -1, 1);
  const redundancyScore = clamp(Number(memory?.redundancy_score ?? memory?.redundancyScore ?? 0), 0, 1);
  const N = 1 - redundancyScore;
  const T = clamp(Number(memory?.trust_score ?? memory?.trustScore ?? 0.5), 0, 1);
  const H = clamp(Number(memory?.importance_hint ?? memory?.importanceHint ?? 0), -1, 1);

  const now = options.now ? new Date(options.now) : new Date();
  const A = computeRecencyDecay(
    memory?.last_used_at ?? memory?.lastUsedAt,
    memory?.created_at ?? memory?.createdAt,
    now,
    options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALFLIFE_DAYS
  );

  const tokensEst =
    Number(
      memory?.tokens_est ??
      memory?.tokensEst ??
      memory?.metadata?._tokens_est ??
      memory?.metadata?.tokens_est ??
      0
    );
  const C = computeCost(tokensEst, options.costScaleTokens ?? DEFAULT_COST_SCALE_TOKENS);

  const x = 1.2 * R + 2.0 * U + 1.0 * N + 1.0 * T + 0.5 * A + 1.0 * H - 1.0 * C;
  const V = sigmoid(x);
  return clamp(V, 0, 1);
}

module.exports = {
  computeValueScore,
  estimateTokensFromText,
  computeRecencyDecay,
  computeCost
};

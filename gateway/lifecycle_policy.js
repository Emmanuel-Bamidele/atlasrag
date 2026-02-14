// lifecycle_policy.js
// Lifecycle guardrails for AMV-L decisions.

function isBelowMinAgeForLifecycle(item, now, minAgeHours) {
  const hours = Number.isFinite(minAgeHours) ? minAgeHours : 0;
  if (!hours || hours <= 0) return false;
  const createdAt = item?.created_at ?? item?.createdAt;
  if (!createdAt) return false;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const ageMs = nowDate.getTime() - created.getTime();
  return ageMs < hours * 3600000;
}

function normalizeMaxDeletes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function createDeleteBudget(maxDeletes) {
  return { limit: normalizeMaxDeletes(maxDeletes), used: 0 };
}

function canConsumeDeleteBudget(budget, count = 1) {
  if (!budget) return true;
  if (!budget.limit) return true;
  const amount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 1;
  if (amount === 0) return true;
  return budget.used + amount <= budget.limit;
}

function consumeDeleteBudget(budget, count = 1) {
  if (!budget) return true;
  if (!budget.limit) return true;
  const amount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 1;
  if (amount === 0) return true;
  if (!canConsumeDeleteBudget(budget, amount)) return false;
  budget.used += amount;
  return true;
}

module.exports = {
  isBelowMinAgeForLifecycle,
  normalizeMaxDeletes,
  createDeleteBudget,
  canConsumeDeleteBudget,
  consumeDeleteBudget
};

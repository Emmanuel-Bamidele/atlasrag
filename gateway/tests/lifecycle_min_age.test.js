const assert = require("assert");
const {
  isBelowMinAgeForLifecycle,
  createDeleteBudget,
  canConsumeDeleteBudget,
  consumeDeleteBudget
} = require("../lifecycle_policy");

const NOW = new Date("2026-02-14T00:00:00Z");

(() => {
  const item = { created_at: new Date("2026-02-13T12:00:00Z") }; // 12 hours old
  assert.ok(isBelowMinAgeForLifecycle(item, NOW, 24), "newer item should be below min age");
})();

(() => {
  const item = { created_at: new Date("2026-02-12T00:00:00Z") }; // 48 hours old
  assert.ok(!isBelowMinAgeForLifecycle(item, NOW, 24), "older item should not be below min age");
})();

(() => {
  const item = { created_at: new Date("2026-02-13T23:30:00Z") }; // 30 minutes old
  assert.ok(!isBelowMinAgeForLifecycle(item, NOW, 0), "min age <= 0 should not block lifecycle");
})();

(() => {
  const item = { created_at: "not a date" };
  assert.ok(!isBelowMinAgeForLifecycle(item, NOW, 24), "invalid created_at should not block lifecycle");
})();

(() => {
  const item = {};
  assert.ok(!isBelowMinAgeForLifecycle(item, NOW, 24), "missing created_at should not block lifecycle");
})();

console.log("lifecycle_min_age tests passed");

(() => {
  const budget = createDeleteBudget(2);
  assert.ok(canConsumeDeleteBudget(budget, 1), "should allow first delete");
  assert.ok(consumeDeleteBudget(budget, 1), "consume first delete");
  assert.ok(canConsumeDeleteBudget(budget, 1), "should allow second delete");
  assert.ok(consumeDeleteBudget(budget, 1), "consume second delete");
  assert.ok(!canConsumeDeleteBudget(budget, 1), "should block after limit");
  assert.ok(!consumeDeleteBudget(budget, 1), "consume should fail after limit");
})();

(() => {
  const budget = createDeleteBudget(0);
  assert.ok(canConsumeDeleteBudget(budget, 100), "unlimited budget should allow deletes");
  assert.ok(consumeDeleteBudget(budget, 100), "unlimited budget should consume without limit");
})();

console.log("lifecycle_delete_budget tests passed");

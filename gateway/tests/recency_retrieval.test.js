const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

{
  assert.equal(__testHooks.resolveRequestedFavorRecency({ favorRecency: true }), true);
  assert.equal(__testHooks.resolveRequestedFavorRecency({ favor_recency: "false" }), false);
  assert.equal(__testHooks.resolveRequestedFavorRecency({ favorRecency: "auto" }), null);
}

{
  const freshness = __testHooks.memoryFreshnessTimestampMs({
    created_at: "2026-01-10T00:00:00.000Z",
    metadata: {
      updatedAt: "2026-03-10T00:00:00.000Z"
    }
  });
  assert.equal(
    freshness,
    Date.parse("2026-03-10T00:00:00.000Z")
  );
}

{
  const newer = __testHooks.computeMemoryRetrievalRecencyScore({
    created_at: "2026-04-01T00:00:00.000Z"
  }, Date.parse("2026-04-02T00:00:00.000Z"), 14);
  const older = __testHooks.computeMemoryRetrievalRecencyScore({
    created_at: "2026-01-01T00:00:00.000Z"
  }, Date.parse("2026-04-02T00:00:00.000Z"), 14);
  assert.ok(newer > older);
}

{
  const mode = __testHooks.determineRecencyBoostMode({
    explicitFavorRecency: null,
    memory: {
      item_type: "artifact",
      metadata: {
        knowledgeType: "episodic"
      }
    },
    candidateTypes: ["artifact"]
  });
  assert.equal(mode, "memory");
}

{
  const mode = __testHooks.determineRecencyBoostMode({
    explicitFavorRecency: null,
    memory: {
      item_type: "artifact",
      metadata: {
        knowledgeType: "conversation",
        favorRecency: false
      }
    },
    candidateTypes: ["artifact"]
  });
  assert.equal(mode, "off");
}

{
  const mode = __testHooks.determineRecencyBoostMode({
    explicitFavorRecency: null,
    memory: {
      item_type: "semantic"
    },
    candidateTypes: ["conversation", "semantic"]
  });
  assert.equal(mode, "context");
}

process.exit(0);

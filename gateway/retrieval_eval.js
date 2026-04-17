const { rankSearchCandidates } = require("./hybrid_retrieval");
const { computeRecencyDecay } = require("./memory_value");
const {
  buildRetrievalPlan,
  determineRecencyBoostMode,
  matchesRetrievalFilters,
  memoryFreshnessTimestampMs,
  normalizeRetrievalTimeField
} = require("./retrieval_planner");

function normalizeStringList(values, { lower = true } = {}) {
  const list = Array.isArray(values) ? values : (values === undefined || values === null ? [] : [values]);
  return list
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => (lower ? value.toLowerCase() : value));
}

function parseOptionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeEvalFilters(filters = {}) {
  return {
    tenantId: String(filters.tenantId || filters.tenant_id || "").trim() || null,
    collection: String(filters.collection || "").trim() || null,
    docIds: normalizeStringList(filters.docIds || filters.doc_ids || filters.docId || filters.doc_id, { lower: false }),
    namespaceIds: normalizeStringList(
      filters.namespaceIds || filters.namespace_ids || filters.namespaceId || filters.namespace_id,
      { lower: false }
    ),
    tags: normalizeStringList(filters.tags),
    agentId: String(filters.agentId || filters.agent_id || "").trim() || null,
    sourceTypes: normalizeStringList(filters.sourceTypes || filters.source_types || filters.sourceType || filters.source_type),
    documentTypes: normalizeStringList(
      filters.documentTypes || filters.document_types || filters.documentType || filters.document_type
    ),
    since: parseOptionalDate(filters.since),
    until: parseOptionalDate(filters.until),
    timeField: normalizeRetrievalTimeField(filters.timeField || filters.time_field || "created_at", "created_at")
  };
}

function createFixtureMemory(chunk = {}) {
  const metadata = chunk.metadata && typeof chunk.metadata === "object" && !Array.isArray(chunk.metadata)
    ? { ...chunk.metadata }
    : {};
  if (chunk.updatedAt && metadata.updatedAt === undefined) metadata.updatedAt = chunk.updatedAt;
  if (chunk.updated_at && metadata.updated_at === undefined) metadata.updated_at = chunk.updated_at;
  if (chunk.publishedAt && metadata.publishedAt === undefined) metadata.publishedAt = chunk.publishedAt;
  if (chunk.effectiveAt && metadata.effectiveAt === undefined) metadata.effectiveAt = chunk.effectiveAt;
  if (chunk.syncedAt && metadata.syncedAt === undefined) metadata.syncedAt = chunk.syncedAt;

  return {
    id: chunk.memoryId || chunk.id || chunk.namespaceId || chunk.docId || null,
    tenant_id: chunk.tenantId || chunk.tenant_id || null,
    collection: chunk.collection || null,
    namespace_id: chunk.namespaceId || chunk.namespace_id || chunk.docId || null,
    external_id: chunk.externalId || chunk.external_id || chunk.docId || null,
    source_type: chunk.sourceType || chunk.source_type || null,
    agent_id: chunk.agentId || chunk.agent_id || null,
    tags: Array.isArray(chunk.tags) ? chunk.tags.slice() : [],
    metadata,
    created_at: chunk.createdAt || chunk.created_at || null,
    item_type: chunk.itemType || chunk.item_type || "artifact"
  };
}

function buildFixtureCandidates(testCase = {}) {
  const chunkMap = new Map();
  for (const chunk of testCase.chunks || []) {
    const memory = createFixtureMemory(chunk);
    const row = {
      chunk_id: chunk.chunkId,
      doc_id: memory.namespace_id,
      idx: chunk.idx,
      text: chunk.text
    };
    chunkMap.set(chunk.chunkId, {
      row,
      memory,
      parsed: {
        collection: memory.collection,
        docId: memory.external_id,
        tenantId: memory.tenant_id
      }
    });
  }

  const candidates = new Map();

  function ensureCandidate(chunkId) {
    const base = chunkMap.get(chunkId);
    if (!base) throw new Error(`unknown retrieval fixture chunk id: ${chunkId}`);
    if (!candidates.has(chunkId)) {
      candidates.set(chunkId, {
        ...base,
        vectorScore: null,
        lexicalScore: null,
        vectorRank: null,
        lexicalRank: null
      });
    }
    return candidates.get(chunkId);
  }

  (testCase.vectorResults || []).forEach((match, index) => {
    const candidate = ensureCandidate(match.chunkId);
    candidate.vectorScore = Number(match.score);
    candidate.vectorRank = index + 1;
  });

  (testCase.lexicalResults || []).forEach((match, index) => {
    const candidate = ensureCandidate(match.chunkId);
    candidate.lexicalScore = Number(match.score);
    candidate.lexicalRank = index + 1;
  });

  return Array.from(candidates.values());
}

function computeMemoryRetrievalRecencyScore(memory, now = Date.now(), halfLifeDays = 14) {
  const freshnessTs = memoryFreshnessTimestampMs(memory);
  if (!Number.isFinite(freshnessTs) || freshnessTs <= 0) return 0;
  return computeRecencyDecay(
    null,
    new Date(freshnessTs),
    new Date(now),
    Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 14
  );
}

function reciprocalRank(rank) {
  return Number.isFinite(rank) && rank >= 1 ? 1 / rank : 0;
}

function computeRecallAtK(resultChunkIds, relevantChunkIds, k) {
  const relevant = new Set(normalizeStringList(relevantChunkIds, { lower: false }));
  if (!relevant.size) return 0;
  const topIds = (Array.isArray(resultChunkIds) ? resultChunkIds : []).slice(0, k);
  let hits = 0;
  for (const chunkId of topIds) {
    if (relevant.has(chunkId)) hits += 1;
  }
  return hits / relevant.size;
}

function computeNdcgAtK(resultChunkIds, relevantChunkIds, k) {
  const relevant = new Set(normalizeStringList(relevantChunkIds, { lower: false }));
  if (!relevant.size) return 0;
  const topIds = (Array.isArray(resultChunkIds) ? resultChunkIds : []).slice(0, k);
  const dcg = topIds.reduce((sum, chunkId, index) => {
    if (!relevant.has(chunkId)) return sum;
    return sum + (1 / Math.log2(index + 2));
  }, 0);
  const idealSize = Math.min(relevant.size, Number.isFinite(k) && k > 0 ? Math.floor(k) : relevant.size);
  const idealDcg = Array.from({ length: idealSize }).reduce((sum, _value, index) => {
    return sum + (1 / Math.log2(index + 2));
  }, 0);
  return idealDcg > 0 ? dcg / idealDcg : 0;
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * clamped) - 1));
  return sorted[index];
}

function evaluateRetrievalCase(testCase, options = {}) {
  const topK = Number.isFinite(Number(options.k)) && Number(options.k) > 0
    ? Math.floor(Number(options.k))
    : Math.max(1, Math.floor(Number(testCase.k || 5)));
  const filters = normalizeEvalFilters({
    ...(testCase.filters || {}),
    ...(options.filters || {})
  });
  const candidateTypes = Array.isArray(options.candidateTypes) && options.candidateTypes.length
    ? options.candidateTypes
    : (Array.isArray(testCase.candidateTypes) && testCase.candidateTypes.length ? testCase.candidateTypes : ["artifact"]);
  const retrievalPlan = buildRetrievalPlan({
    query: testCase.query,
    explicitFavorRecency: options.favorRecency !== undefined ? options.favorRecency : (testCase.favorRecency ?? null),
    candidateTypes,
    timeField: filters.timeField,
    queryRecencyAutoEnabled: options.queryRecencyAutoEnabled !== false
  });

  const start = process.hrtime.bigint();
  const allCandidates = buildFixtureCandidates(testCase);
  const filteredCandidates = allCandidates.filter((candidate) => matchesRetrievalFilters(candidate, filters));
  const ranked = rankSearchCandidates(filteredCandidates, {
    query: testCase.query,
    useHybrid: options.useHybrid !== undefined ? options.useHybrid : true,
    fusionMode: options.fusionMode || "rrf",
    vectorWeight: options.vectorWeight ?? 0.72,
    lexicalWeight: options.lexicalWeight ?? 0.28,
    rankConstant: options.rankConstant ?? 60,
    overlapBoostScale: options.overlapBoostScale ?? 0.12,
    exactBoostScale: options.exactBoostScale ?? 0.08,
    favorRecency: retrievalPlan.effectiveFavorRecency,
    candidateTypes,
    recencyWeight: options.recencyWeight ?? 0.3,
    recencyHalfLifeDays: options.recencyHalfLifeDays ?? 14,
    determineRecencyBoostMode: options.determineRecencyBoostMode || determineRecencyBoostMode,
    computeMemoryRetrievalRecencyScore
  });
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;

  const topResults = ranked.slice(0, topK);
  const topChunkIds = topResults.map((candidate) => candidate.row.chunk_id);
  const relevantChunkIds = normalizeStringList(testCase.relevantChunkIds || testCase.relevantChunkId, { lower: false });
  const evidenceChunkIds = normalizeStringList(
    testCase.evidenceChunkIds || testCase.evidenceChunkId || relevantChunkIds,
    { lower: false }
  );
  const relevantRank = ranked.findIndex((candidate) => relevantChunkIds.includes(candidate.row.chunk_id)) + 1;

  return {
    name: testCase.name || null,
    query: testCase.query || "",
    filters,
    retrievalPlan,
    totalCandidates: allCandidates.length,
    filteredCandidates: filteredCandidates.length,
    topChunkIds,
    relevantChunkIds,
    evidenceChunkIds,
    relevantRank: relevantRank || null,
    recallAtK: computeRecallAtK(topChunkIds, relevantChunkIds, topK),
    mrr: reciprocalRank(relevantRank || 0),
    ndcgAtK: computeNdcgAtK(topChunkIds, relevantChunkIds, topK),
    evidenceHit: computeRecallAtK(topChunkIds, evidenceChunkIds, topK) > 0,
    latencyMs,
    results: topResults.map((candidate) => ({
      chunkId: candidate.row.chunk_id,
      namespaceId: candidate.row.doc_id,
      score: candidate.finalScore,
      fusedScore: candidate.fusedScore,
      recencyScore: candidate.recencyScore,
      recencyMode: candidate.recencyMode,
      vectorRank: candidate.vectorRank,
      lexicalRank: candidate.lexicalRank
    }))
  };
}

function evaluateRetrievalCases(testCases, options = {}) {
  const cases = (Array.isArray(testCases) ? testCases : []).map((testCase) => evaluateRetrievalCase(testCase, options));
  const count = cases.length || 1;
  const latencies = cases.map((testCase) => testCase.latencyMs);
  return {
    summary: {
      cases: cases.length,
      k: Number.isFinite(Number(options.k)) && Number(options.k) > 0 ? Math.floor(Number(options.k)) : null,
      recallAtK: cases.reduce((sum, testCase) => sum + testCase.recallAtK, 0) / count,
      mrr: cases.reduce((sum, testCase) => sum + testCase.mrr, 0) / count,
      ndcgAtK: cases.reduce((sum, testCase) => sum + testCase.ndcgAtK, 0) / count,
      evidenceHitRate: cases.reduce((sum, testCase) => sum + (testCase.evidenceHit ? 1 : 0), 0) / count,
      latencyMsAvg: latencies.reduce((sum, value) => sum + value, 0) / count,
      latencyMsP50: percentile(latencies, 0.5),
      latencyMsP95: percentile(latencies, 0.95)
    },
    cases
  };
}

module.exports = {
  buildFixtureCandidates,
  computeMemoryRetrievalRecencyScore,
  computeNdcgAtK,
  computeRecallAtK,
  evaluateRetrievalCase,
  evaluateRetrievalCases,
  normalizeEvalFilters,
  reciprocalRank
};

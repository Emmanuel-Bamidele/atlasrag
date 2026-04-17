const RECENCY_QUERY_HINTS = /\b(latest|newest|recent|recently|current|currently|today|yesterday|now|status|updated?|updates?|release|releases|changelog|incident|incidents|timeline|pricing|price|availability|stock|version)\b/i;
const FRESHNESS_METADATA_KEYS = [
  "updatedAt",
  "updated_at",
  "lastUpdatedAt",
  "last_updated_at",
  "modifiedAt",
  "modified_at",
  "publishedAt",
  "published_at",
  "effectiveAt",
  "effective_at",
  "sourceUpdatedAt",
  "source_updated_at",
  "syncedAt",
  "synced_at",
  "lastSyncedAt",
  "last_synced_at"
];

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : NaN;
}

function memoryMetadataValue(memory, keys = []) {
  const metadata = memory?.metadata && typeof memory.metadata === "object" && !Array.isArray(memory.metadata)
    ? memory.metadata
    : null;
  if (!metadata) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      return metadata[key];
    }
  }
  return undefined;
}

function resolveMemoryKnowledgeType(memory) {
  const raw = memoryMetadataValue(memory, ["knowledgeType", "knowledge_type"]);
  const clean = String(raw || "").trim().toLowerCase();
  if (clean === "semantic" || clean === "procedural" || clean === "episodic" || clean === "conversation" || clean === "summary") {
    return clean;
  }
  return null;
}

function resolveMemoryFavorRecencyPreference(memory) {
  const value = memoryMetadataValue(memory, ["favorRecency", "favor_recency"]);
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === false) return value;
  const clean = String(value).trim().toLowerCase();
  if (!clean || clean === "auto" || clean === "default") return null;
  if (clean === "true" || clean === "1" || clean === "yes" || clean === "on") return true;
  if (clean === "false" || clean === "0" || clean === "no" || clean === "off") return false;
  return null;
}

function memoryFreshnessTimestampMs(memory) {
  for (const key of FRESHNESS_METADATA_KEYS) {
    const metadataTs = parseTimestampMs(memoryMetadataValue(memory, [key]));
    if (Number.isFinite(metadataTs) && metadataTs > 0) return metadataTs;
  }
  const created = memory?.created_at ? new Date(memory.created_at).getTime() : NaN;
  if (Number.isFinite(created)) return created;
  return 0;
}

function normalizeRetrievalTimeField(raw, fallback = "created_at") {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const clean = String(raw).trim().toLowerCase();
  if (!clean || clean === "default" || clean === "auto") return fallback;
  if (clean === "created" || clean === "createdat" || clean === "created_at" || clean === "created-at") {
    return "created_at";
  }
  if (
    clean === "freshness"
    || clean === "updated"
    || clean === "updatedat"
    || clean === "updated_at"
    || clean === "updated-at"
    || clean === "synced"
    || clean === "syncedat"
    || clean === "synced_at"
    || clean === "effective"
    || clean === "effectiveat"
    || clean === "effective_at"
  ) {
    return "freshness";
  }
  throw new Error("timeField must be createdAt or freshness");
}

function queryLooksRecencySensitive(query) {
  return RECENCY_QUERY_HINTS.test(String(query || ""));
}

function isRecencyBiasedType(type) {
  const clean = String(type || "").trim().toLowerCase();
  return clean === "episodic" || clean === "conversation";
}

function determineRecencyBoostMode({ explicitFavorRecency, memory, candidateTypes }) {
  if (explicitFavorRecency === false) return "off";
  if (explicitFavorRecency === true) return "all";
  const memoryPreference = resolveMemoryFavorRecencyPreference(memory);
  if (memoryPreference === false) return "off";
  if (memoryPreference === true) return "memory";
  if (isRecencyBiasedType(memory?.item_type) || isRecencyBiasedType(resolveMemoryKnowledgeType(memory))) {
    return "memory";
  }
  const requestedTypes = Array.isArray(candidateTypes) ? candidateTypes : [];
  return requestedTypes.some(isRecencyBiasedType) ? "context" : "off";
}

function buildRetrievalPlan({
  query,
  explicitFavorRecency = null,
  candidateTypes = null,
  timeField = "created_at",
  queryRecencyAutoEnabled = true
} = {}) {
  const normalizedTimeField = normalizeRetrievalTimeField(timeField, "created_at");
  const queryRecencySensitive = queryRecencyAutoEnabled
    && explicitFavorRecency !== false
    && queryLooksRecencySensitive(query);
  return {
    timeField: normalizedTimeField,
    candidateTypes: Array.isArray(candidateTypes) ? candidateTypes.slice() : [],
    queryRecencySensitive,
    preferFreshnessOrdering: normalizedTimeField === "freshness" || explicitFavorRecency === true || queryRecencySensitive,
    effectiveFavorRecency: explicitFavorRecency === null && queryRecencySensitive ? true : explicitFavorRecency
  };
}

function extractDocumentType(memory) {
  const metadata = memory?.metadata && typeof memory.metadata === "object" && !Array.isArray(memory.metadata)
    ? memory.metadata
    : null;
  const raw = metadata?.documentType ?? metadata?.document_type ?? metadata?.docType ?? metadata?.doc_type ?? null;
  const clean = String(raw || "").trim().toLowerCase();
  return clean || null;
}

function extractCandidateTimeMs(candidate, timeField = "created_at") {
  const memory = candidate?.memory || candidate;
  if (normalizeRetrievalTimeField(timeField, "created_at") === "freshness") {
    return memoryFreshnessTimestampMs(memory);
  }
  const created = memory?.created_at ? new Date(memory.created_at).getTime() : NaN;
  return Number.isFinite(created) ? created : 0;
}

function matchesRetrievalFilters(candidate, filters = {}) {
  if (!candidate) return false;
  const memory = candidate.memory || null;
  const parsed = candidate.parsed || null;
  const row = candidate.row || null;

  if (filters.tenantId) {
    const tenantId = String(memory?.tenant_id || parsed?.tenantId || "").trim();
    if (tenantId !== filters.tenantId) return false;
  }

  if (filters.collection) {
    const collection = parsed?.collection || memory?.collection || null;
    if (collection !== filters.collection) return false;
  }

  if (filters.docIds?.length) {
    const docId = parsed?.docId || memory?.external_id || null;
    if (!filters.docIds.includes(docId)) return false;
  }

  if (filters.namespaceIds?.length) {
    const namespaceId = row?.doc_id || memory?.namespace_id || null;
    if (!filters.namespaceIds.includes(namespaceId)) return false;
  }

  if (filters.agentId) {
    if (String(memory?.agent_id || "").trim() !== filters.agentId) return false;
  }

  if (filters.tags?.length) {
    const tags = Array.isArray(memory?.tags) ? memory.tags.map((tag) => String(tag || "").trim().toLowerCase()) : [];
    if (!filters.tags.some((tag) => tags.includes(tag))) return false;
  }

  if (filters.sourceTypes?.length) {
    const sourceType = String(memory?.source_type || "").trim().toLowerCase();
    if (!filters.sourceTypes.includes(sourceType)) return false;
  }

  if (filters.documentTypes?.length) {
    const documentType = extractDocumentType(memory);
    if (!documentType || !filters.documentTypes.includes(documentType)) return false;
  }

  const candidateTime = extractCandidateTimeMs(candidate, filters.timeField || "created_at");
  if (filters.since instanceof Date && Number.isFinite(filters.since.getTime()) && candidateTime < filters.since.getTime()) {
    return false;
  }
  if (filters.until instanceof Date && Number.isFinite(filters.until.getTime()) && candidateTime > filters.until.getTime()) {
    return false;
  }

  return true;
}

module.exports = {
  FRESHNESS_METADATA_KEYS,
  buildRetrievalPlan,
  determineRecencyBoostMode,
  extractCandidateTimeMs,
  extractDocumentType,
  isRecencyBiasedType,
  matchesRetrievalFilters,
  memoryFreshnessTimestampMs,
  memoryMetadataValue,
  normalizeRetrievalTimeField,
  parseTimestampMs,
  queryLooksRecencySensitive,
  resolveMemoryFavorRecencyPreference,
  resolveMemoryKnowledgeType
};

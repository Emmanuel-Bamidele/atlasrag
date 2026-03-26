const BYTES_PER_GIB = 1024 * 1024 * 1024;
const VECTOR_FLOAT_BYTES = 4;
const STORAGE_BILLING_FORMULA_VERSION = "storage_v1";

function toDate(value, fallback = null) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback : new Date(value.getTime());
  }
  if (value === undefined || value === null || value === "") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toNonNegativeNumber(value, fallback = 0) {
  return Math.max(0, toFiniteNumber(value, fallback));
}

function toNonNegativeInt(value, fallback = 0) {
  return Math.floor(toNonNegativeNumber(value, fallback));
}

function startOfUtcMonth(value = new Date()) {
  const date = toDate(value, new Date());
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function nextUtcMonth(value = new Date()) {
  const start = startOfUtcMonth(value);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function buildUtcMonthWindow(value = new Date()) {
  const periodStart = startOfUtcMonth(value);
  const periodEnd = nextUtcMonth(periodStart);
  return { periodStart, periodEnd };
}

function splitRangeByUtcMonth(startValue, endValue) {
  const start = toDate(startValue);
  const end = toDate(endValue);
  if (!start || !end || end <= start) return [];

  const segments = [];
  let cursor = new Date(start.getTime());
  while (cursor < end) {
    const { periodStart, periodEnd } = buildUtcMonthWindow(cursor);
    const segmentEnd = end < periodEnd ? new Date(end.getTime()) : periodEnd;
    const elapsedSeconds = Math.max(0, (segmentEnd.getTime() - cursor.getTime()) / 1000);
    segments.push({
      periodStart,
      periodEnd,
      segmentStart: new Date(cursor.getTime()),
      segmentEnd,
      elapsedSeconds
    });
    cursor = new Date(segmentEnd.getTime());
  }
  return segments;
}

function estimateVectorBytes({ chunkCount = 0, vectorDim = 0, bytesPerFloat = VECTOR_FLOAT_BYTES } = {}) {
  const cleanChunkCount = toNonNegativeInt(chunkCount);
  const cleanVectorDim = toNonNegativeInt(vectorDim);
  const cleanBytesPerFloat = toNonNegativeInt(bytesPerFloat, VECTOR_FLOAT_BYTES);
  return cleanChunkCount * cleanVectorDim * cleanBytesPerFloat;
}

function normalizeStorageBreakdown(input = {}) {
  const chunkTextBytes = toNonNegativeInt(input.chunkTextBytes ?? input.chunk_text_bytes);
  const metadataBytes = toNonNegativeInt(input.metadataBytes ?? input.metadata_bytes);
  const vectorBytes = toNonNegativeInt(input.vectorBytes ?? input.vector_bytes);
  const vectorDim = toNonNegativeInt(input.vectorDim ?? input.vector_dim);
  const chunks = toNonNegativeInt(input.chunks);
  const documents = toNonNegativeInt(input.documents);
  const memoryItems = toNonNegativeInt(input.memoryItems ?? input.memory_items);
  const collections = toNonNegativeInt(input.collections);
  const totalBytes = chunkTextBytes + metadataBytes + vectorBytes;
  return {
    bytes: totalBytes,
    chunk_text_bytes: chunkTextBytes,
    metadata_bytes: metadataBytes,
    vector_bytes: vectorBytes,
    vector_dim: vectorDim,
    chunks,
    documents,
    memory_items: memoryItems,
    collections
  };
}

function computePendingByteSeconds({
  currentBytes = 0,
  lastAccruedAt,
  now = new Date(),
  periodStart,
  periodEnd
}) {
  const start = toDate(lastAccruedAt);
  const end = toDate(now, new Date());
  const windowStart = toDate(periodStart);
  const windowEnd = toDate(periodEnd);
  if (!start || !windowStart || !windowEnd) return 0;
  const effectiveStart = start > windowStart ? start : windowStart;
  const effectiveEnd = end < windowEnd ? end : windowEnd;
  if (effectiveEnd <= effectiveStart) return 0;
  return toNonNegativeNumber(currentBytes) * ((effectiveEnd.getTime() - effectiveStart.getTime()) / 1000);
}

function computeStoragePeriodSummary({
  periodStart,
  periodEnd,
  byteSeconds = 0,
  currentBytes = 0,
  lastAccruedAt = null,
  now = new Date(),
  storagePricePerGBMonth = 0,
  includedGBMonth = 0
}) {
  const start = toDate(periodStart);
  const end = toDate(periodEnd);
  const currentTime = toDate(now, new Date());
  if (!start || !end || end <= start) {
    return {
      periodStart: start ? start.toISOString() : null,
      periodEnd: end ? end.toISOString() : null,
      totalSeconds: 0,
      elapsedSeconds: 0,
      remainingSeconds: 0,
      currentBytes: toNonNegativeInt(currentBytes),
      effectiveByteSeconds: 0,
      averageBytesToDate: 0,
      projectedByteSeconds: 0,
      projectedAverageBytes: 0,
      averageGiBToDate: 0,
      projectedAverageGiB: 0,
      includedGiBMonth: toNonNegativeNumber(includedGBMonth),
      billableGiBMonthToDate: 0,
      projectedBillableGiBMonth: 0,
      chargeToDate: 0,
      projectedCharge: 0
    };
  }

  const totalSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  const elapsedEnd = currentTime < end ? currentTime : end;
  const elapsedSeconds = Math.max(0, (elapsedEnd.getTime() - start.getTime()) / 1000);
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  const pendingByteSeconds = computePendingByteSeconds({
    currentBytes,
    lastAccruedAt,
    now: currentTime,
    periodStart: start,
    periodEnd: end
  });
  const effectiveByteSeconds = toNonNegativeNumber(byteSeconds) + pendingByteSeconds;
  const averageBytesToDate = elapsedSeconds > 0 ? effectiveByteSeconds / elapsedSeconds : 0;
  const projectedByteSeconds = effectiveByteSeconds + (toNonNegativeNumber(currentBytes) * remainingSeconds);
  const projectedAverageBytes = totalSeconds > 0 ? projectedByteSeconds / totalSeconds : 0;
  const averageGiBToDate = averageBytesToDate / BYTES_PER_GIB;
  const projectedAverageGiB = projectedAverageBytes / BYTES_PER_GIB;
  const includedGiBMonth = toNonNegativeNumber(includedGBMonth);
  const billableGiBMonthToDate = Math.max(0, averageGiBToDate - includedGiBMonth);
  const projectedBillableGiBMonth = Math.max(0, projectedAverageGiB - includedGiBMonth);
  const chargeToDate = toNonNegativeNumber(storagePricePerGBMonth) > 0
    ? parseFloat((billableGiBMonthToDate * toNonNegativeNumber(storagePricePerGBMonth)).toFixed(6))
    : 0;
  const projectedCharge = toNonNegativeNumber(storagePricePerGBMonth) > 0
    ? parseFloat((projectedBillableGiBMonth * toNonNegativeNumber(storagePricePerGBMonth)).toFixed(6))
    : 0;

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalSeconds,
    elapsedSeconds,
    remainingSeconds,
    currentBytes: toNonNegativeInt(currentBytes),
    effectiveByteSeconds,
    averageBytesToDate,
    projectedByteSeconds,
    projectedAverageBytes,
    averageGiBToDate,
    projectedAverageGiB,
    includedGiBMonth,
    billableGiBMonthToDate,
    projectedBillableGiBMonth,
    chargeToDate,
    projectedCharge
  };
}

module.exports = {
  BYTES_PER_GIB,
  VECTOR_FLOAT_BYTES,
  STORAGE_BILLING_FORMULA_VERSION,
  startOfUtcMonth,
  nextUtcMonth,
  buildUtcMonthWindow,
  splitRangeByUtcMonth,
  estimateVectorBytes,
  normalizeStorageBreakdown,
  computePendingByteSeconds,
  computeStoragePeriodSummary
};

// metrics.js
// Lightweight latency tracking with percentiles.

const DEFAULT_WINDOW = parseInt(process.env.METRICS_WINDOW || "500", 10);

function createRing(capacity) {
  const cap = Number.isFinite(capacity) && capacity > 0 ? capacity : 500;
  return { cap, idx: 0, size: 0, values: new Array(cap) };
}

function recordValue(ring, value) {
  ring.values[ring.idx] = value;
  ring.idx = (ring.idx + 1) % ring.cap;
  ring.size = Math.min(ring.size + 1, ring.cap);
}

function snapshotValues(ring) {
  const out = [];
  for (let i = 0; i < ring.size; i += 1) {
    const idx = (ring.idx - ring.size + i + ring.cap) % ring.cap;
    const v = ring.values[idx];
    if (typeof v === "number") out.push(v);
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, idx));
  return sorted[clamped];
}

function summarize(ring, count, errorCount) {
  const values = snapshotValues(ring);
  values.sort((a, b) => a - b);
  const total = values.reduce((acc, v) => acc + v, 0);
  const avg = values.length ? total / values.length : null;
  const errRate = count ? errorCount / count : 0;

  return {
    count,
    error_count: errorCount,
    error_rate: errRate,
    avg_ms: avg,
    p50_ms: percentile(values, 50),
    p90_ms: percentile(values, 90),
    p95_ms: percentile(values, 95),
    p99_ms: percentile(values, 99)
  };
}

const overall = {
  count: 0,
  errorCount: 0,
  ring: createRing(DEFAULT_WINDOW)
};

const routes = new Map();
const tenants = new Map();

function getRouteStat(key) {
  if (!routes.has(key)) {
    routes.set(key, {
      count: 0,
      errorCount: 0,
      ring: createRing(DEFAULT_WINDOW)
    });
  }
  return routes.get(key);
}

function getTenantStat(tenantId) {
  if (!tenants.has(tenantId)) {
    tenants.set(tenantId, {
      overall: {
        count: 0,
        errorCount: 0,
        ring: createRing(DEFAULT_WINDOW)
      },
      routes: new Map()
    });
  }
  return tenants.get(tenantId);
}

function getTenantRouteStat(tenantStats, key) {
  if (!tenantStats.routes.has(key)) {
    tenantStats.routes.set(key, {
      count: 0,
      errorCount: 0,
      ring: createRing(DEFAULT_WINDOW)
    });
  }
  return tenantStats.routes.get(key);
}

function recordLatency(key, ms, status, tenantId) {
  const isError = Number(status) >= 500;

  overall.count += 1;
  if (isError) overall.errorCount += 1;
  recordValue(overall.ring, ms);

  if (key) {
    const stat = getRouteStat(key);
    stat.count += 1;
    if (isError) stat.errorCount += 1;
    recordValue(stat.ring, ms);
  }

  if (tenantId) {
    const tenantStats = getTenantStat(tenantId);
    tenantStats.overall.count += 1;
    if (isError) tenantStats.overall.errorCount += 1;
    recordValue(tenantStats.overall.ring, ms);

    if (key) {
      const tenantRoute = getTenantRouteStat(tenantStats, key);
      tenantRoute.count += 1;
      if (isError) tenantRoute.errorCount += 1;
      recordValue(tenantRoute.ring, ms);
    }
  }
}

function getLatencyStats(tenantId) {
  if (tenantId) {
    const tenantStats = tenants.get(tenantId);
    if (!tenantStats) {
      return { overall: summarize(createRing(DEFAULT_WINDOW), 0, 0), routes: {} };
    }
    const out = {
      overall: summarize(
        tenantStats.overall.ring,
        tenantStats.overall.count,
        tenantStats.overall.errorCount
      ),
      routes: {}
    };
    for (const [key, stat] of tenantStats.routes.entries()) {
      out.routes[key] = summarize(stat.ring, stat.count, stat.errorCount);
    }
    return out;
  }

  const out = {
    overall: summarize(overall.ring, overall.count, overall.errorCount),
    routes: {}
  };

  for (const [key, stat] of routes.entries()) {
    out.routes[key] = summarize(stat.ring, stat.count, stat.errorCount);
  }

  return out;
}

function getAllTenantLatencyStats() {
  const out = {};
  for (const [tenantId, tenantStats] of tenants.entries()) {
    const entry = {
      overall: summarize(
        tenantStats.overall.ring,
        tenantStats.overall.count,
        tenantStats.overall.errorCount
      ),
      routes: {}
    };
    for (const [key, stat] of tenantStats.routes.entries()) {
      entry.routes[key] = summarize(stat.ring, stat.count, stat.errorCount);
    }
    out[tenantId] = entry;
  }
  return out;
}

module.exports = {
  recordLatency,
  getLatencyStats,
  getAllTenantLatencyStats
};

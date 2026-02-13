function $(id){
  return document.getElementById(id);
}

function setBanner(el, kind, msg){
  el.classList.add("show");
  el.classList.remove("ok","err");
  if (kind === "ok") el.classList.add("ok");
  if (kind === "err") el.classList.add("err");
  el.textContent = msg;
}

function clearBanner(el){
  el.classList.remove("show","ok","err");
  el.textContent = "";
}

const AUTH_TOKEN_KEY = "atlasragAuthToken";
const AUTH_TYPE_KEY = "atlasragAuthType";
const LEGACY_JWT_KEY = "atlasragJwt";
let metricsLoaded = false;
let usageLoaded = false;
let metricsLoading = false;
let usageLoading = false;

function loadStoredAuth(){
  let token = localStorage.getItem(AUTH_TOKEN_KEY);
  let type = localStorage.getItem(AUTH_TYPE_KEY);

  if (!token){
    const legacy = localStorage.getItem(LEGACY_JWT_KEY);
    if (legacy){
      token = legacy;
      type = "bearer";
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      localStorage.setItem(AUTH_TYPE_KEY, type);
    }
  }

  return {
    token: (token || "").trim(),
    type: (type || "bearer").trim()
  };
}

function saveStoredAuth(type, token){
  localStorage.setItem(AUTH_TYPE_KEY, type);
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  if (type === "bearer"){
    localStorage.setItem(LEGACY_JWT_KEY, token);
  }
}

function clearStoredAuth(){
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TYPE_KEY);
  localStorage.removeItem(LEGACY_JWT_KEY);
}

function apiHeaders(){
  const auth = loadStoredAuth();
  const headers = { "Content-Type":"application/json" };
  if (auth.token){
    if (auth.type === "api_key"){
      headers["X-API-Key"] = auth.token;
    }else{
      headers["Authorization"] = `Bearer ${auth.token}`;
    }
  }
  return headers;
}

function requireKeyOrWarn(bannerEl){
  if (!loadStoredAuth().token){
    setBanner(bannerEl, "err", "No token saved. Go to Settings and paste your token.");
    return false;
  }
  return true;
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

function formatNumber(value){
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString();
}

function formatRate(value){
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatMs(value){
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)} ms`;
}

function formatDuration(totalSeconds){
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "-";
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function maskToken(value){
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 8) return "****";
  const head = raw.slice(0, 4);
  const tail = raw.slice(-4);
  return `${head}****${tail}`;
}

function slugifyDocId(value){
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isValidDocId(value){
  return /^[a-zA-Z0-9._-]+$/.test(String(value || ""));
}

function getSelectedDocIds(selectEl){
  if (!selectEl) return [];
  return Array.from(selectEl.selectedOptions || [])
    .map(opt => opt.value)
    .filter(Boolean);
}

function clearDocSelection(selectEl){
  if (!selectEl) return;
  Array.from(selectEl.options || []).forEach(opt => { opt.selected = false; });
  selectEl.selectedIndex = -1;
}

function setDocsStatus(message){
  const targets = [$("searchDocsStatus"), $("askDocsStatus")].filter(Boolean);
  targets.forEach(el => { el.textContent = message; });
}

function setDocOptions(docs){
  const selects = [$("searchDocs"), $("askDocs")].filter(Boolean);
  selects.forEach((selectEl) => {
    selectEl.innerHTML = "";
    selectEl.disabled = false;
    if (!docs || docs.length === 0){
      const opt = document.createElement("option");
      opt.textContent = "No docs indexed yet";
      opt.disabled = true;
      selectEl.appendChild(opt);
      selectEl.disabled = true;
      return;
    }
    docs.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.docId;
      opt.textContent = `${doc.docId} (${doc.chunks})`;
      selectEl.appendChild(opt);
    });
    clearDocSelection(selectEl);
  });
}

async function loadDocsList(){
  if (!loadStoredAuth().token){
    setDocsStatus("Save a token to load docs.");
    setDocOptions([]);
    return;
  }

  setDocsStatus("Loading docs...");
  try{
    const res = await fetch("/docs/list", { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && Array.isArray(data.docs)){
      setDocOptions(data.docs);
      setDocsStatus(`${data.docs.length} doc(s) available.`);
    }else{
      setDocsStatus(data.error || "Failed to load docs.");
      setDocOptions([]);
    }
  }catch(e){
    setDocsStatus("Error loading docs.");
    setDocOptions([]);
  }
}

function suggestDocIdFromFilename(name){
  const base = String(name || "").replace(/\.[^/.]+$/, "");
  return slugifyDocId(base);
}

function suggestDocIdFromUrl(value){
  try{
    const url = new URL(String(value || ""));
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return slugifyDocId(`${url.hostname}${path}`);
  }catch{
    return "";
  }
}

function showPage(pageId){
  const tabs = [
    ["tabProduct","pageProduct"],
    ["tabPlayground","pagePlayground"],
    ["tabMetrics","pageMetrics"],
    ["tabUsage","pageUsage"],
    ["tabJobs","pageJobs"],
    ["tabCollections","pageCollections"],
    ["tabDocs","pageDocs"],
    ["tabSettings","pageSettings"]
  ];

  for (const [t,p] of tabs){
    $(t).classList.remove("active");
    $(t).setAttribute("aria-selected", "false");
    $(p).classList.remove("active");
  }

  const found = tabs.find(x => x[1] === pageId);
  if (found){
    $(found[0]).classList.add("active");
    $(found[0]).setAttribute("aria-selected", "true");
    $(found[1]).classList.add("active");
  }

  if (pageId === "pageMetrics" && !metricsLoaded){
    loadStats();
  }
  if (pageId === "pageUsage" && !usageLoaded){
    loadUsage();
  }
}

function showPlayPane(paneId){
  const tabs = [
    ["playTabIngest","playPaneIngest"],
    ["playTabSearch","playPaneSearch"],
    ["playTabAsk","playPaneAsk"]
  ];

  for (const [t,p] of tabs){
    $(t).classList.remove("active");
    $(t).setAttribute("aria-selected", "false");
    $(p).classList.remove("active");
  }

  const found = tabs.find(x => x[1] === paneId);
  if (found){
    $(found[0]).classList.add("active");
    $(found[0]).setAttribute("aria-selected", "true");
    $(found[1]).classList.add("active");
  }
}

function initDocTabs(){
  const groups = document.querySelectorAll(".doc-tabs[data-doc-tabs]");
  groups.forEach((group) => {
    const groupId = group.dataset.docTabs;
    const panelWrap = document.querySelector(`.doc-panels[data-doc-panels="${groupId}"]`);
    if (!panelWrap) return;
    const buttons = Array.from(group.querySelectorAll(".doc-tab"));
    const panels = Array.from(panelWrap.querySelectorAll(".doc-panel"));

    const activate = (name) => {
      buttons.forEach((btn) => {
        const isActive = btn.dataset.docTab === name;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      panels.forEach((panel) => {
        const isActive = panel.dataset.docPanel === name;
        panel.classList.toggle("active", isActive);
      });
    };

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => activate(btn.dataset.docTab));
    });

    const current = buttons.find((btn) => btn.classList.contains("active")) || buttons[0];
    if (current) activate(current.dataset.docTab);
  });
}

function renderSearch(results){
  const wrap = $("searchCards");
  wrap.innerHTML = "";
  if (!results || results.length === 0){
    wrap.innerHTML = "<div class=\"card reveal\"><div class=\"preview\">No matches found.</div></div>";
    return;
  }

  results.forEach((r, idx) => {
    const score = (typeof r.score === "number") ? r.score.toFixed(4) : String(r.score);
    const html = `
      <div class="card reveal" style="animation-delay:${idx * 40}ms;">
        <div class="cardhead">
          <span class="chip">Chunk <span class="mono">${escapeHtml(r.id)}</span></span>
          <span class="chip">Score <span class="mono">${escapeHtml(score)}</span></span>
          <span class="chip">Doc <span class="mono">${escapeHtml(r.docId || "?")}</span></span>
        </div>
        <div class="preview">${escapeHtml(r.preview || "")}</div>
      </div>
    `;
    wrap.insertAdjacentHTML("beforeend", html);
  });
}

function renderAnswer(data){
  const wrap = $("askAnswerCard");
  wrap.innerHTML = "";

  const answerText = data?.answer || "(no answer)";

  const html = `
    <div class="card reveal" style="animation-delay:20ms;">
      <div class="cardhead">
        <span class="chip">Answer</span>
      </div>
      <div class="preview">${escapeHtml(answerText)}</div>
    </div>
  `;
  wrap.insertAdjacentHTML("beforeend", html);
}

function renderStats(data){
  const wrap = $("statsCards");
  wrap.innerHTML = "";

  const stats = data || {};
  const uptime = Number(stats.uptime_seconds || 0);
  const commands = Number(stats.commands_processed || 0);
  const ops = uptime > 0 ? commands / uptime : 0;

  const vectors = Number(stats.vectors || 0);
  const vset = Number(stats.vset_count || 0);
  const vsearch = Number(stats.vsearch_count || 0);
  const vdel = Number(stats.vdel_count || 0);
  const vops = uptime > 0 ? (vset + vsearch + vdel) / uptime : 0;

  const cards = [
    {
      label: "Uptime",
      value: formatDuration(uptime),
      meta: `${formatNumber(uptime)} seconds`
    },
    {
      label: "Commands",
      value: formatNumber(commands),
      meta: `${formatRate(ops)} ops/sec`
    },
    {
      label: "Connections",
      value: formatNumber(stats.active_connections),
      meta: `${formatNumber(stats.total_connections)} total`
    },
    {
      label: "Keyspace",
      value: formatNumber(stats.keys),
      meta: `${formatNumber(stats.expired_removed)} expired removed`
    },
    {
      label: "Vector index",
      value: formatNumber(vectors),
      meta: `dims ${formatNumber(stats.vector_dims)}`
    },
    {
      label: "Vector ops",
      value: formatNumber(vset + vsearch + vdel),
      meta: `${formatRate(vops)} ops/sec`
    },
    {
      label: "VSET",
      value: formatNumber(vset),
      meta: "vector inserts"
    },
    {
      label: "VSEARCH",
      value: formatNumber(vsearch),
      meta: "vector queries"
    },
    {
      label: "Latency p50",
      value: formatMs(stats.gateway?.latency?.overall?.p50_ms),
      meta: "overall"
    },
    {
      label: "Latency p95",
      value: formatMs(stats.gateway?.latency?.overall?.p95_ms),
      meta: "overall"
    },
    {
      label: "Latency p99",
      value: formatMs(stats.gateway?.latency?.overall?.p99_ms),
      meta: "overall"
    }
  ];

  const html = cards.map((card) => {
    return `
      <div class="stat">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value">${escapeHtml(card.value)}</div>
        <div class="stat-meta">${escapeHtml(card.meta)}</div>
      </div>
    `;
  }).join("");

  wrap.insertAdjacentHTML("beforeend", html);
}

function renderUsage(stats){
  const wrap = $("usageCards");
  if (!wrap) return;
  wrap.innerHTML = "";

  const gateway = stats?.gateway?.latency || {};
  const overall = gateway.overall || {};
  const count = Number(overall.count || 0);
  const errRate = Number(overall.error_rate || 0);

  const cards = [
    { label: "Requests", value: formatNumber(count), meta: "total" },
    { label: "Error rate", value: `${(errRate * 100).toFixed(2)}%`, meta: "gateway 5xx" },
    { label: "Latency p50", value: formatMs(overall.p50_ms), meta: "overall" },
    { label: "Latency p95", value: formatMs(overall.p95_ms), meta: "overall" },
    { label: "Latency p99", value: formatMs(overall.p99_ms), meta: "overall" },
    { label: "Vector ops", value: formatNumber((stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0)), meta: "total" }
  ];

  const html = cards.map((card) => {
    return `
      <div class="stat">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value">${escapeHtml(card.value)}</div>
        <div class="stat-meta">${escapeHtml(card.meta)}</div>
      </div>
    `;
  }).join("");

  wrap.insertAdjacentHTML("beforeend", html);
}

function renderUsageRoutes(routes){
  const wrap = $("usageRoutesTable");
  if (!wrap) return;
  const entries = Object.entries(routes || {});
  if (!entries.length){
    wrap.textContent = "(no data)";
    return;
  }

  entries.sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
  const rows = entries.map(([route, stats]) => {
    const count = Number(stats?.count || 0);
    const errRate = Number(stats?.error_rate || 0);
    return `
      <tr>
        <td class="mono">${escapeHtml(route)}</td>
        <td>${escapeHtml(formatNumber(count))}</td>
        <td>${escapeHtml((errRate * 100).toFixed(2))}%</td>
        <td>${escapeHtml(formatMs(stats?.p50_ms))}</td>
        <td>${escapeHtml(formatMs(stats?.p95_ms))}</td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Route</th>
          <th>Requests</th>
          <th>Error rate</th>
          <th>p50</th>
          <th>p95</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadStats(){
  if (metricsLoading) return;
  clearBanner($("statsBanner"));
  if (!requireKeyOrWarn($("statsBanner"))) return;

  metricsLoading = true;
  $("statsBtn").disabled = true;
  $("statsBtn").textContent = "Loading...";

  try{
    const res = await fetch("/stats", { headers: apiHeaders() });
    const data = await res.json();
    $("statsRaw").textContent = JSON.stringify(data, null, 2);

    if (res.ok){
      setBanner($("statsBanner"), "ok", "Stats loaded.");
      renderStats(data);
      $("statsUpdated").textContent = new Date().toLocaleString();
      metricsLoaded = true;
    }else{
      setBanner($("statsBanner"), "err", data.error || "Stats failed.");
    }
  }catch(e){
    setBanner($("statsBanner"), "err", "Error: " + e);
  }finally{
    metricsLoading = false;
    $("statsBtn").disabled = false;
    $("statsBtn").textContent = "Refresh stats";
  }
}

async function loadUsage(){
  if (usageLoading) return;
  clearBanner($("usageBanner"));
  if (!requireKeyOrWarn($("usageBanner"))) return;

  usageLoading = true;
  $("usageRefreshBtn").disabled = true;
  $("usageRefreshBtn").textContent = "Loading...";

  try{
    const res = await fetch("/v1/admin/usage", { headers: apiHeaders() });
    const data = await res.json();
    $("usageRaw").textContent = JSON.stringify(data, null, 2);

    if (res.ok && data.ok){
      renderUsage(data.data);
      renderUsageRoutes(data.data?.gateway?.latency?.routes || {});
      $("usageUpdated").textContent = new Date().toLocaleString();
      setBanner($("usageBanner"), "ok", "Usage loaded.");
      usageLoaded = true;
    }else{
      setBanner($("usageBanner"), "err", data?.error?.message || "Usage failed.");
    }
  }catch(e){
    setBanner($("usageBanner"), "err", "Error loading usage.");
  }finally{
    usageLoading = false;
    $("usageRefreshBtn").disabled = false;
    $("usageRefreshBtn").textContent = "Refresh usage";
  }
}

function renderJobDetails(job){
  const target = $("jobDetails");
  if (!target) return;
  target.textContent = job ? JSON.stringify(job, null, 2) : "(no job loaded)";
}

function renderJobsTable(jobs){
  const wrap = $("jobListTable");
  if (!wrap) return;
  if (!jobs || jobs.length === 0){
    wrap.textContent = "(no data)";
    return;
  }

  const rows = jobs.map((job) => {
    return `
      <tr>
        <td class="mono">${escapeHtml(job.id)}</td>
        <td>${escapeHtml(job.status || "-")}</td>
        <td>${escapeHtml(job.jobType || job.job_type || "-")}</td>
        <td>${escapeHtml(job.createdAt || job.created_at || "-")}</td>
        <td>${escapeHtml(job.updatedAt || job.updated_at || "-")}</td>
        <td><button class="btn secondary job-view-btn" data-id="${escapeHtml(job.id)}">View</button></td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Status</th>
          <th>Type</th>
          <th>Created</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll(".job-view-btn").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (!id) return;
      $("jobIdInput").value = id;
      fetchJobById(id);
    };
  });
}

function renderCollections(collections){
  const wrap = $("collectionsTable");
  if (!wrap) return;
  if (!collections || collections.length === 0){
    wrap.textContent = "(no data)";
    return;
  }

  const rows = collections.map((col) => {
    const titles = Array.isArray(col.titles) ? col.titles : [];
    const docList = titles.length
      ? titles.map((title) => {
          return `
            <div class="doc-pill">
              <span class="mono">${escapeHtml(title)}</span>
              <button class="btn tiny danger doc-delete-btn" data-collection="${escapeHtml(col.collection)}" data-doc="${escapeHtml(title)}">Delete</button>
            </div>
          `;
        }).join("")
      : `<span class="muted">No docs</span>`;
    return `
      <tr>
        <td class="mono">${escapeHtml(col.collection)}</td>
        <td>${escapeHtml(String(col.totalDocs || 0))}</td>
        <td><div class="doc-list">${docList}</div></td>
        <td><button class="btn danger collection-delete-btn" data-collection="${escapeHtml(col.collection)}">Delete</button></td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Collection</th>
          <th>Docs</th>
          <th>Titles</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll(".collection-delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.collection;
      if (!name) return;
      if (!confirm(`Delete collection "${name}"? This removes stored chunk text and memory items.`)) {
        return;
      }
      clearBanner($("collectionsBanner"));
      if (!requireKeyOrWarn($("collectionsBanner"))) return;
      try{
        const res = await fetch(`/v1/collections/${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: apiHeaders()
        });
        const data = await res.json();
        if (res.ok && data.ok){
          setBanner($("collectionsBanner"), "ok", `Deleted collection "${name}".`);
          await fetchCollections();
        }else{
          const msg = data?.error?.message || data?.error || "Delete failed.";
          setBanner($("collectionsBanner"), "err", msg);
        }
      }catch(e){
        setBanner($("collectionsBanner"), "err", "Error deleting collection.");
      }
    };
  });

  wrap.querySelectorAll(".doc-delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      const docId = btn.dataset.doc;
      const collection = btn.dataset.collection || "default";
      if (!docId) return;
      if (!confirm(`Delete document "${docId}" from "${collection}"?`)) {
        return;
      }
      clearBanner($("collectionsBanner"));
      if (!requireKeyOrWarn($("collectionsBanner"))) return;
      try{
        const res = await fetch(`/v1/docs/${encodeURIComponent(docId)}?collection=${encodeURIComponent(collection)}`, {
          method: "DELETE",
          headers: apiHeaders()
        });
        const data = await res.json();
        if (res.ok && data.ok){
          setBanner($("collectionsBanner"), "ok", `Deleted document "${docId}".`);
          await fetchCollections();
          loadDocsList();
        }else{
          const msg = data?.error?.message || data?.error || "Delete failed.";
          setBanner($("collectionsBanner"), "err", msg);
        }
      }catch(e){
        setBanner($("collectionsBanner"), "err", "Error deleting document.");
      }
    };
  });
}

async function fetchJobById(id){
  clearBanner($("jobsBanner"));
  if (!requireKeyOrWarn($("jobsBanner"))) return;
  if (!id){
    setBanner($("jobsBanner"), "err", "Provide a job ID.");
    return;
  }
  try{
    const res = await fetch(`/v1/jobs/${encodeURIComponent(id)}`, { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && data.data?.job){
      renderJobDetails(data.data.job);
      setBanner($("jobsBanner"), "ok", "Job loaded.");
    }else{
      renderJobDetails(null);
      const msg = data?.error?.message || data?.error || "Job not found.";
      setBanner($("jobsBanner"), "err", msg);
    }
  }catch(e){
    setBanner($("jobsBanner"), "err", "Error loading job.");
  }
}

async function fetchInProgressJobs(){
  clearBanner($("jobsBanner"));
  if (!requireKeyOrWarn($("jobsBanner"))) return;
  try{
    const res = await fetch("/v1/jobs?status=in_progress&limit=50", { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.data?.jobs)){
      renderJobsTable(data.data.jobs);
      setBanner($("jobsBanner"), "ok", "In-progress jobs loaded.");
    }else{
      renderJobsTable([]);
      const msg = data?.error?.message || data?.error || "Failed to load jobs.";
      setBanner($("jobsBanner"), "err", msg);
    }
  }catch(e){
    setBanner($("jobsBanner"), "err", "Error loading jobs.");
  }
}

async function fetchCollections(){
  clearBanner($("collectionsBanner"));
  if (!requireKeyOrWarn($("collectionsBanner"))) return;
  try{
    const res = await fetch("/v1/collections", { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.data?.collections)){
      renderCollections(data.data.collections);
      $("collectionsUpdated").textContent = new Date().toLocaleString();
      setBanner($("collectionsBanner"), "ok", "Collections loaded.");
    }else{
      renderCollections([]);
      const msg = data?.error?.message || data?.error || "Failed to load collections.";
      setBanner($("collectionsBanner"), "err", msg);
    }
  }catch(e){
    setBanner($("collectionsBanner"), "err", "Error loading collections.");
  }
}

async function refreshHealth(){
  const dot = $("healthDot");
  const text = $("healthText");
  dot.className = "dot";
  text.textContent = "Checking /health...";

  try{
    const res = await fetch("/health");
    const data = await res.json();
    if (data.ok){
      dot.classList.add("good");
      text.textContent = "Healthy (gateway to TCP OK)";
    }else{
      dot.classList.add("bad");
      text.textContent = "Unhealthy (check logs)";
    }
  }catch(e){
    dot.classList.add("bad");
    text.textContent = "Health check failed";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initDocTabs();
  $("tabPlayground").onclick = () => showPage("pagePlayground");
  $("tabMetrics").onclick = () => showPage("pageMetrics");
  $("tabUsage").onclick = () => showPage("pageUsage");
  $("tabDocs").onclick = () => showPage("pageDocs");
  $("tabSettings").onclick = () => showPage("pageSettings");
  $("tabProduct").onclick = () => showPage("pageProduct");
  $("playTabIngest").onclick = () => showPlayPane("playPaneIngest");
  $("playTabSearch").onclick = () => showPlayPane("playPaneSearch");
  $("playTabAsk").onclick = () => showPlayPane("playPaneAsk");

  refreshHealth();
  setInterval(refreshHealth, 12000);

  const auth = loadStoredAuth();
  $("apiKey").value = auth.token;
  if ($("authType")) $("authType").value = auth.type || "bearer";

  $("saveKeyBtn").onclick = () => {
    const authType = $("authType") ? $("authType").value : "bearer";
    const key = $("apiKey").value.trim();
    if (!key){
      setBanner($("settingsBanner"), "err", "Please paste a token first.");
      return;
    }
    saveStoredAuth(authType, key);
    setBanner($("settingsBanner"), "ok", "Saved. You can now Index, Search, and Ask.");
    loadDocsList();
  };

  $("loginBtn").onclick = async () => {
    clearBanner($("settingsBanner"));
    const username = $("loginUser").value.trim();
    const password = $("loginPass").value;

    if (!username || !password) {
      setBanner($("settingsBanner"), "err", "Please enter username and password.");
      return;
    }

    $("loginBtn").disabled = true;
    $("loginBtn").textContent = "Logging in...";

    try{
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.token){
        saveStoredAuth("bearer", data.token);
        $("apiKey").value = data.token;
        if ($("authType")) $("authType").value = "bearer";
        $("loginPass").value = "";
        setBanner($("settingsBanner"), "ok", "Token saved. You can now Index, Search, and Ask.");
        loadDocsList();
      }else{
        setBanner($("settingsBanner"), "err", data.error || "Login failed.");
      }
    }catch(e){
      setBanner($("settingsBanner"), "err", "Error: " + e);
    }finally{
      $("loginBtn").disabled = false;
      $("loginBtn").textContent = "Login and save token";
    }
  };

  $("clearKeyBtn").onclick = () => {
    clearStoredAuth();
    $("apiKey").value = "";
    if ($("authType")) $("authType").value = "bearer";
    setBanner($("settingsBanner"), "ok", "Removed saved token.");
    setDocsStatus("Save a token to load docs.");
    setDocOptions([]);
  };

  $("createApiKeyBtn").onclick = async () => {
    clearBanner($("apiKeyBanner"));
    $("copyCreatedApiKeyBtn").disabled = true;
    $("useCreatedApiKeyBtn").disabled = true;
    const auth = loadStoredAuth();
    if (!auth.token){
      setBanner($("apiKeyBanner"), "err", "Save a token first (admin/owner required).");
      return;
    }

    const name = $("apiKeyName").value.trim();
    if (!name){
      setBanner($("apiKeyBanner"), "err", "API key name is required.");
      return;
    }

    const principalId = $("apiKeyPrincipal").value.trim();
    const rolesRaw = $("apiKeyRoles").value.trim();
    const roles = rolesRaw
      ? rolesRaw.split(",").map(r => r.trim()).filter(Boolean)
      : [];
    const expiresRaw = $("apiKeyExpires").value;
    let expiresAt = null;
    if (expiresRaw){
      const dt = new Date(expiresRaw);
      if (Number.isNaN(dt.getTime())){
        setBanner($("apiKeyBanner"), "err", "Invalid expiration date.");
        return;
      }
      expiresAt = dt.toISOString();
    }

    const body = { name };
    if (principalId) body.principalId = principalId;
    if (roles.length) body.roles = roles;
    if (expiresAt) body.expiresAt = expiresAt;

    $("createApiKeyBtn").disabled = true;
    $("createApiKeyBtn").textContent = "Creating...";

    try{
      const res = await fetch("/v1/admin/service-tokens", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok && data.ok && data.data?.token){
        const token = data.data.token;
        $("createdApiKey").textContent = maskToken(token);
        $("useCreatedApiKeyBtn").disabled = false;
        $("copyCreatedApiKeyBtn").disabled = false;
        $("useCreatedApiKeyBtn").dataset.token = token;
        $("copyCreatedApiKeyBtn").dataset.token = token;
        setBanner($("apiKeyBanner"), "ok", "API key created. Save it now.");
      }else{
        const msg = data?.error?.message || data?.error || "Failed to create API key.";
        setBanner($("apiKeyBanner"), "err", msg);
      }
    }catch(e){
      setBanner($("apiKeyBanner"), "err", "Error creating API key.");
    }finally{
      $("createApiKeyBtn").disabled = false;
      $("createApiKeyBtn").textContent = "Create API key";
    }
  };

  $("useCreatedApiKeyBtn").onclick = () => {
    const token = $("useCreatedApiKeyBtn").dataset.token;
    if (!token){
      setBanner($("apiKeyBanner"), "err", "No API key to use yet.");
      return;
    }
    if ($("authType")) $("authType").value = "api_key";
    $("apiKey").value = token;
    saveStoredAuth("api_key", token);
    setBanner($("apiKeyBanner"), "ok", "API key saved. You can now Index, Search, and Ask.");
    loadDocsList();
  };

  $("copyCreatedApiKeyBtn").onclick = async () => {
    const token = $("copyCreatedApiKeyBtn").dataset.token;
    if (!token){
      setBanner($("apiKeyBanner"), "err", "No API key to copy yet.");
      return;
    }
    try{
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
      } else {
        const tmp = document.createElement("textarea");
        tmp.value = token;
        tmp.setAttribute("readonly", "true");
        tmp.style.position = "absolute";
        tmp.style.left = "-9999px";
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        document.body.removeChild(tmp);
      }
      setBanner($("apiKeyBanner"), "ok", "API key copied to clipboard.");
    }catch(e){
      setBanner($("apiKeyBanner"), "err", "Failed to copy API key.");
    }
  };

  $("indexClearBtn").onclick = () => {
    $("docId").value = "";
    $("docText").value = "";
    $("docUrl").value = "";
    $("docFile").value = "";
    $("indexRaw").textContent = "(no output)";
    clearBanner($("indexBanner"));
  };

  $("searchDocsRefreshBtn").onclick = () => loadDocsList();
  $("searchDocsAllBtn").onclick = () => clearDocSelection($("searchDocs"));
  $("askDocsRefreshBtn").onclick = () => loadDocsList();
  $("askDocsAllBtn").onclick = () => clearDocSelection($("askDocs"));

  $("docUrl").addEventListener("blur", () => {
    if ($("docId").value.trim()) return;
    const suggested = suggestDocIdFromUrl($("docUrl").value.trim());
    if (suggested) $("docId").value = suggested;
  });

  $("docFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setBanner($("indexBanner"), "err", "File too large. Max size is 5 MB.");
      return;
    }

    try{
      const text = await file.text();
      $("docText").value = text;

      if (!$("docId").value.trim()) {
        const suggested = suggestDocIdFromFilename(file.name) || "upload";
        $("docId").value = suggested;
      }

      setBanner($("indexBanner"), "ok", `Loaded "${file.name}" (${text.length} chars).`);
    }catch(e){
      setBanner($("indexBanner"), "err", "Failed to read file: " + e);
    }
  });

  $("indexBtn").onclick = async () => {
    clearBanner($("indexBanner"));
    if (!requireKeyOrWarn($("indexBanner"))) return;

    let docId = $("docId").value.trim();
    const text = $("docText").value.trim();
    const url = $("docUrl").value.trim();

    if (!docId && url) {
      docId = suggestDocIdFromUrl(url);
      if (docId) $("docId").value = docId;
    }

    if (!docId){
      setBanner($("indexBanner"), "err", "Please provide a Doc ID.");
      return;
    }
    if (!isValidDocId(docId)){
      setBanner($("indexBanner"), "err", "Doc ID must use only letters, numbers, dot, dash, or underscore (no spaces).");
      return;
    }

    $("indexBtn").disabled = true;
    $("indexBtn").textContent = "Indexing...";

    try{
      let res;
      if (url){
        res = await fetch("/docs/url", {
          method:"POST",
          headers: apiHeaders(),
          body: JSON.stringify({ docId, url })
        });
      }else{
        if (!text.trim()){
          setBanner($("indexBanner"), "err", "Paste text or provide a URL.");
          return;
        }
        res = await fetch("/docs", {
          method:"POST",
          headers: apiHeaders(),
          body: JSON.stringify({ docId, text })
        });
      }

      const data = await res.json();
      $("indexRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.ok){
        const extra = data.truncated || data.docTruncated ? " (truncated)" : "";
        const sourceLabel = url ? " from URL" : "";
        setBanner($("indexBanner"), "ok", `Indexed "${docId}"${sourceLabel}${extra} (${data.chunksIndexed} chunks).`);
        showPage("pagePlayground");
        showPlayPane("playPaneSearch");
        loadDocsList();
      }else{
        setBanner($("indexBanner"), "err", data.error || "Index failed.");
      }
    }catch(e){
      setBanner($("indexBanner"), "err", "Error: " + e);
    }finally{
      $("indexBtn").disabled = false;
      $("indexBtn").textContent = "Index content";
    }
  };

  $("searchClearBtn").onclick = () => {
    $("searchCards").innerHTML = "";
    $("searchRaw").textContent = "(no output)";
    clearBanner($("searchBanner"));
  };

  $("searchBtn").onclick = async () => {
    clearBanner($("searchBanner"));
    if (!requireKeyOrWarn($("searchBanner"))) return;

    const q = $("searchQ").value.trim();
    const k = parseInt($("searchK").value || "5", 10);
    const docIds = getSelectedDocIds($("searchDocs"));

    if (!q){
      setBanner($("searchBanner"), "err", "Please enter a search query.");
      return;
    }

    $("searchBtn").disabled = true;
    $("searchBtn").textContent = "Searching...";

    try{
      const docParam = docIds.length ? `&docIds=${encodeURIComponent(docIds.join(","))}` : "";
      const res = await fetch(`/search?q=${encodeURIComponent(q)}&k=${k}${docParam}`, {
        headers: apiHeaders()
      });

      const data = await res.json();
      $("searchRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.results){
        setBanner($("searchBanner"), "ok", `Found ${data.results.length} result(s).`);
        renderSearch(data.results);
      }else{
        setBanner($("searchBanner"), "err", data.error || "Search failed.");
      }
    }catch(e){
      setBanner($("searchBanner"), "err", "Error: " + e);
    }finally{
      $("searchBtn").disabled = false;
      $("searchBtn").textContent = "Search";
    }
  };

  $("askClearBtn").onclick = () => {
    $("askAnswerCard").innerHTML = "";
    $("askRaw").textContent = "(no output)";
    clearBanner($("askBanner"));
  };

  $("askBtn").onclick = async () => {
    clearBanner($("askBanner"));
    if (!requireKeyOrWarn($("askBanner"))) return;

    const question = $("askQ").value.trim();
    const k = parseInt($("askK").value || "5", 10);
    const docIds = getSelectedDocIds($("askDocs"));

    if (!question){
      setBanner($("askBanner"), "err", "Please enter a question.");
      return;
    }

    $("askBtn").disabled = true;
    $("askBtn").textContent = "Thinking...";

    try{
      const res = await fetch("/ask", {
        method:"POST",
        headers: apiHeaders(),
        body: JSON.stringify({ question, k, docIds })
      });

      const data = await res.json();
      $("askRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.answer){
        setBanner($("askBanner"), "ok", "Answer generated.");
        renderAnswer(data);
      }else{
        setBanner($("askBanner"), "err", data.error || "Ask failed.");
      }
    }catch(e){
      setBanner($("askBanner"), "err", "Error: " + e);
    }finally{
      $("askBtn").disabled = false;
      $("askBtn").textContent = "Generate answer";
    }
  };

  $("statsClearBtn").onclick = () => {
    $("statsRaw").textContent = "(no output)";
    $("statsCards").innerHTML = "";
    $("statsUpdated").textContent = "-";
    clearBanner($("statsBanner"));
    metricsLoaded = false;
  };

  $("statsBtn").onclick = async () => {
    loadStats();
  };

  $("usageRefreshBtn").onclick = async () => {
    loadUsage();
  };

  $("jobFetchBtn").onclick = () => {
    const id = $("jobIdInput").value.trim();
    if (!id) {
      fetchInProgressJobs();
      return;
    }
    fetchJobById(id);
  };

  $("jobListBtn").onclick = () => {
    fetchInProgressJobs();
  };

  $("tabJobs").onclick = () => {
    showPage("pageJobs");
    fetchInProgressJobs();
  };

  $("collectionsRefreshBtn").onclick = () => {
    fetchCollections();
  };

  $("tabCollections").onclick = () => {
    showPage("pageCollections");
    fetchCollections();
  };

  loadDocsList();
});

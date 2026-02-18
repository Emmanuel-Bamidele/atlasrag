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
const UI_THEME_KEY = "atlasragUiTheme";
const UI_THEME_USER_SET_KEY = "atlasragUiThemeUserSet";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: light)";
let activeThemePreference = "system";
let metricsLoaded = false;
let usageLoaded = false;
let metricsLoading = false;
let usageLoading = false;
let lastUsageStats = null;
const usageWindowByCard = {};
const USAGE_WINDOWS = ["24h", "7d", "all"];
const USAGE_WINDOW_LABELS = { "24h": "24h", "7d": "7d", "all": "All" };
const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
const PDFJS_LIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const MAMMOTH_LIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js";
const externalScriptCache = new Map();
const DOC_CONNECT_BASE_URL_PLACEHOLDER = "https://YOUR_ATLASRAG_BASE_URL";
const DOC_CONNECT_SERVER_NAME = "atlasrag-docs";

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

function setThemeButtonState(theme){
  const btn = $("themeToggleBtn");
  const icon = $("themeToggleIcon");
  if (!btn) return;

  const isLight = theme === "light";
  btn.setAttribute("aria-pressed", isLight ? "true" : "false");
  btn.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
  btn.setAttribute("title", isLight ? "Switch to dark theme" : "Switch to light theme");
  if (icon){
    icon.textContent = isLight ? "◑" : "◐";
  }
}

function getSystemTheme(){
  return (window.matchMedia && window.matchMedia(SYSTEM_THEME_QUERY).matches) ? "light" : "dark";
}

function resolveTheme(preference){
  if (preference === "light" || preference === "dark"){
    return preference;
  }
  return getSystemTheme();
}

function renderTheme(preference){
  const active = resolveTheme(preference);
  document.body.classList.toggle("light-theme", active === "light");
  setThemeButtonState(active);
}

function applyThemePreference(preference, options = {}){
  const next = (preference === "light" || preference === "dark") ? preference : "system";
  const persist = options.persist === true;
  const userSet = options.userSet === true;
  activeThemePreference = next;
  renderTheme(next);
  if (persist){
    localStorage.setItem(UI_THEME_KEY, next);
    localStorage.setItem(UI_THEME_USER_SET_KEY, userSet ? "1" : "0");
  }
}

function initTheme(){
  const saved = localStorage.getItem(UI_THEME_KEY);
  const userSet = localStorage.getItem(UI_THEME_USER_SET_KEY) === "1";
  const initial = (userSet && (saved === "light" || saved === "dark")) ? saved : "system";
  applyThemePreference(initial, { persist: false });

  if (!userSet){
    localStorage.removeItem(UI_THEME_KEY);
    localStorage.removeItem(UI_THEME_USER_SET_KEY);
  }

  const btn = $("themeToggleBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const active = resolveTheme(activeThemePreference);
    const next = active === "light" ? "dark" : "light";
    applyThemePreference(next, { persist: true, userSet: true });
  });

  if (window.matchMedia){
    const mq = window.matchMedia(SYSTEM_THEME_QUERY);
    const onSystemThemeChange = () => {
      if (activeThemePreference === "system"){
        renderTheme("system");
      }
    };
    if (typeof mq.addEventListener === "function"){
      mq.addEventListener("change", onSystemThemeChange);
    }else if (typeof mq.addListener === "function"){
      mq.addListener(onSystemThemeChange);
    }
  }
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

async function copyTextToClipboard(text){
  const value = String(text || "");
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const tmp = document.createElement("textarea");
  tmp.value = value;
  tmp.setAttribute("readonly", "true");
  tmp.style.position = "absolute";
  tmp.style.left = "-9999px";
  document.body.appendChild(tmp);
  tmp.select();
  document.execCommand("copy");
  document.body.removeChild(tmp);
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

function formatBytes(value){
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, value);
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1){
    size /= 1024;
    idx += 1;
  }
  const precision = size >= 10 || idx === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[idx]}`;
}

function getUsageWindow(cardId){
  return usageWindowByCard[cardId] || "7d";
}

function setUsageWindow(cardId, window){
  usageWindowByCard[cardId] = window;
  if (lastUsageStats){
    renderUsage(lastUsageStats);
  }
}

function bindUsageWindowClicks(){
  const wrap = $("usageCards");
  if (!wrap || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-usage-window]");
    if (!btn) return;
    const cardId = btn.dataset.card;
    const window = btn.dataset.usageWindow;
    if (!cardId || !window) return;
    setUsageWindow(cardId, window);
  });
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

function isValidCollectionName(value){
  return /^[a-zA-Z0-9._-]+$/.test(String(value || ""));
}

function normalizeCollectionName(value){
  const clean = String(value || "").trim();
  return clean || "default";
}

function getPlaygroundCollection(options = {}){
  const input = $("playCollection");
  const collection = normalizeCollectionName(input ? input.value : "default");
  if (input) input.value = collection;

  if (!isValidCollectionName(collection)){
    const message = "Collection must use only letters, numbers, dot, dash, or underscore (no spaces).";
    if (options.bannerEl) setBanner(options.bannerEl, "err", message);
    return null;
  }
  return collection;
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

  const collection = getPlaygroundCollection();
  if (!collection){
    setDocsStatus("Collection is invalid.");
    setDocOptions([]);
    return;
  }

  setDocsStatus(`Loading docs in "${collection}"...`);
  try{
    const res = await fetch(`/docs/list?collection=${encodeURIComponent(collection)}`, { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && Array.isArray(data.docs)){
      setDocOptions(data.docs);
      setDocsStatus(`${data.docs.length} doc(s) available in "${collection}".`);
    }else{
      setDocsStatus(data.error || "Failed to load docs.");
      setDocOptions([]);
    }
  }catch(e){
    setDocsStatus("Error loading docs.");
    setDocOptions([]);
  }
}

function setCollectionScopeOptions(collections){
  const names = Array.from(new Set(
    (Array.isArray(collections) ? collections : [])
      .map((name) => String(name || "").trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const selects = [$("searchCollectionScope"), $("askCollectionScope")].filter(Boolean);
  selects.forEach((selectEl) => {
    const previous = String(selectEl.value || "all");
    selectEl.innerHTML = "";

    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All collections";
    selectEl.appendChild(allOpt);

    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      selectEl.appendChild(opt);
    });

    const hasPrevious = Array.from(selectEl.options).some((opt) => opt.value === previous);
    selectEl.value = hasPrevious ? previous : "all";
  });
}

async function loadCollectionScopeOptions(){
  if (!loadStoredAuth().token){
    setCollectionScopeOptions([]);
    return;
  }

  try{
    const res = await fetch("/v1/collections", { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.data?.collections)){
      const names = data.data.collections
        .map((row) => row?.collection)
        .filter(Boolean);
      setCollectionScopeOptions(names);
    } else {
      setCollectionScopeOptions([]);
    }
  }catch{
    setCollectionScopeOptions([]);
  }
}

function suggestDocIdFromFilename(name){
  const base = String(name || "").replace(/\.[^/.]+$/, "");
  return slugifyDocId(base);
}

function getFileExtension(name){
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const parts = raw.split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1];
}

function detectUploadFileType(file){
  const ext = getFileExtension(file?.name);
  const mime = String(file?.type || "").toLowerCase();
  if (ext === "pdf" || mime.includes("application/pdf")) return "pdf";
  if (ext === "docx" || mime.includes("wordprocessingml.document")) return "docx";
  if (ext === "doc" || mime.includes("application/msword")) return "doc";
  return "text";
}

function normalizeExtractedText(value){
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function loadExternalScript(url, globalName){
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (externalScriptCache.has(url)) return externalScriptCache.get(url);

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.getElementsByTagName("script"))
      .find((script) => script.src === url);

    const onReady = () => {
      if (!globalName || window[globalName]) {
        resolve(globalName ? window[globalName] : true);
      } else {
        reject(new Error(`Loaded script but missing ${globalName}`));
      }
    };

    if (existing) {
      if (existing.dataset.ready === "1") {
        onReady();
        return;
      }
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${url}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => {
      script.dataset.ready = "1";
      onReady();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load script: ${url}`)), { once: true });
    document.head.appendChild(script);
  });

  const cached = promise.catch((err) => {
    externalScriptCache.delete(url);
    throw err;
  });
  externalScriptCache.set(url, cached);
  return cached;
}

async function extractTextFromPdfFile(file){
  await loadExternalScript(PDFJS_LIB_URL, "pdfjsLib");
  const pdfjs = window.pdfjsLib;
  if (!pdfjs || !pdfjs.getDocument) {
    throw new Error("PDF parser failed to load");
  }
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const lines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const textLine = (textContent.items || [])
      .map((item) => String(item?.str || ""))
      .join(" ")
      .trim();
    if (textLine) lines.push(textLine);
  }

  return normalizeExtractedText(lines.join("\n\n"));
}

async function extractTextFromDocxFile(file){
  await loadExternalScript(MAMMOTH_LIB_URL, "mammoth");
  const mammoth = window.mammoth;
  if (!mammoth || typeof mammoth.extractRawText !== "function") {
    throw new Error("Word parser failed to load");
  }

  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return normalizeExtractedText(result?.value || "");
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

function resolveDocConnectBaseUrl(){
  const raw = String(window.location?.origin || "").trim();
  if (!raw || raw === "null") return DOC_CONNECT_BASE_URL_PLACEHOLDER;
  return raw.replace(/\/+$/, "");
}

function buildDocConnectContent(baseUrl){
  const root = String(baseUrl || DOC_CONNECT_BASE_URL_PLACEHOLDER).replace(/\/+$/, "");
  const docsUrl = `${root}/#pageDocsTop`;
  const apiDocsUrl = `${root}/docs`;
  const llmsUrl = `${root}/llms.txt`;
  const mcpUrl = `${root}/mcp`;
  const serverName = DOC_CONNECT_SERVER_NAME;

  const cursorConfig = {
    mcpServers: {
      [serverName]: {
        url: mcpUrl
      }
    }
  };

  const vscodeConfig = {
    servers: {
      [serverName]: {
        url: mcpUrl
      }
    }
  };

  const antigravityConfig = {
    mcpServers: {
      [serverName]: {
        serverUrl: mcpUrl
      }
    }
  };

  return {
    docsUrl,
    apiDocsUrl,
    llmsUrl,
    mcpUrl,
    claudeProjectCmd: `claude mcp add --transport http ${serverName} ${mcpUrl}`,
    claudeUserCmd: `claude mcp add --transport http ${serverName} --scope user ${mcpUrl}`,
    codexCmd: `codex mcp add ${serverName} --url ${mcpUrl}`,
    cursorConfig: JSON.stringify(cursorConfig, null, 2),
    vscodeConfig: JSON.stringify(vscodeConfig, null, 2),
    antigravityConfig: JSON.stringify(antigravityConfig, null, 2),
    quickPrompt: [
      "Use AtlasRAG documentation as your source of truth.",
      `Documentation UI tab: ${docsUrl}`,
      `API docs: ${apiDocsUrl}`,
      `llms.txt: ${llmsUrl}`,
      `MCP server: ${mcpUrl}`,
      "When answering, cite the endpoint path and required headers for each AtlasRAG API call."
    ].join("\n")
  };
}

function setTextById(id, value){
  const el = $(id);
  if (!el) return;
  el.textContent = String(value || "");
}

function setLinkById(id, value){
  const el = $(id);
  if (!el) return;
  const text = String(value || "");
  el.textContent = text;
  if (el.tagName === "A") {
    el.setAttribute("href", text);
  }
}

function initDocsAgentConnect(){
  const section = $("docAgentConnect");
  if (!section) return;

  const bannerEl = $("docAgentConnectBanner");
  if (bannerEl) clearBanner(bannerEl);

  const content = buildDocConnectContent(resolveDocConnectBaseUrl());
  setLinkById("atlasDocsLink", content.docsUrl);
  setLinkById("atlasApiDocsLink", content.apiDocsUrl);
  setLinkById("atlasLlmsLink", content.llmsUrl);
  setLinkById("atlasMcpLink", content.mcpUrl);
  setLinkById("atlasMcpInlineLink", content.mcpUrl);
  setTextById("mcpDesktopUrl", content.mcpUrl);

  setTextById("mcpClaudeProjectCmd", content.claudeProjectCmd);
  setTextById("mcpClaudeUserCmd", content.claudeUserCmd);
  setTextById("mcpCodexCmd", content.codexCmd);
  setTextById("mcpCursorConfig", content.cursorConfig);
  setTextById("mcpVsCodeConfig", content.vscodeConfig);
  setTextById("mcpAntigravityConfig", content.antigravityConfig);
  setTextById("mcpQuickPrompt", content.quickPrompt);

  const copyButtons = Array.from(section.querySelectorAll("[data-copy-target]"));
  copyButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.getAttribute("data-copy-target");
      const targetEl = targetId ? $(targetId) : null;
      const value = String(targetEl?.textContent || "").trim();
      if (!value) {
        if (bannerEl) setBanner(bannerEl, "err", "Nothing to copy.");
        return;
      }

      try {
        await copyTextToClipboard(value);
        if (bannerEl) setBanner(bannerEl, "ok", "Copied to clipboard.");
      } catch {
        if (bannerEl) setBanner(bannerEl, "err", "Failed to copy.");
      }
    });
  });
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

const HASH_PAGE_ROUTES = new Map([
  ["pageproduct", "pageProduct"],
  ["pageplayground", "pagePlayground"],
  ["pagemetrics", "pageMetrics"],
  ["pageusage", "pageUsage"],
  ["pagejobs", "pageJobs"],
  ["pagecollections", "pageCollections"],
  ["pagedocs", "pageDocs"],
  ["pagedocstop", "pageDocs"],
  ["pagesettings", "pageSettings"],
  ["docs", "pageDocs"],
  ["documentation", "pageDocs"]
]);

function resolvePageIdFromHash(rawHash){
  const clean = decodeURIComponent(String(rawHash || "").replace(/^#/, "").trim()).toLowerCase();
  if (!clean) return null;
  if (HASH_PAGE_ROUTES.has(clean)) return HASH_PAGE_ROUTES.get(clean);
  if (clean.startsWith("doc-") || clean.startsWith("amv-")) return "pageDocs";
  return null;
}

function openPageFromHash(options = {}){
  const rawHash = String(window.location?.hash || "");
  if (!rawHash) return false;
  const targetId = rawHash.replace(/^#/, "").trim();
  const pageId = resolvePageIdFromHash(rawHash);
  if (!pageId) return false;

  showPage(pageId);
  if (pageId === "pageDocs") {
    syncDocsPanelFromHash(rawHash);
  }

  if (targetId && options.scroll !== false) {
    const behavior = options.smooth ? "smooth" : "auto";
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior, block: "start" });
      }
    });
  }

  return true;
}

function activateDocPanel(groupId, panelName){
  const group = document.querySelector(`.doc-tabs[data-doc-tabs="${groupId}"]`);
  const panelWrap = document.querySelector(`.doc-panels[data-doc-panels="${groupId}"]`);
  if (!group || !panelWrap) return false;

  const buttons = Array.from(group.querySelectorAll(".doc-tab"));
  const panels = Array.from(panelWrap.querySelectorAll(".doc-panel"));
  const hasTarget = buttons.some((btn) => btn.dataset.docTab === panelName);
  if (!hasTarget) return false;

  buttons.forEach((btn) => {
    const isActive = btn.dataset.docTab === panelName;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  panels.forEach((panel) => {
    const isActive = panel.dataset.docPanel === panelName;
    panel.classList.toggle("active", isActive);
  });
  return true;
}

function syncDocsPanelFromHash(rawHash){
  const clean = decodeURIComponent(String(rawHash || "").replace(/^#/, "").trim()).toLowerCase();
  if (!clean) return;
  if (clean.startsWith("amv-")) {
    activateDocPanel("docs", "amv");
    return;
  }
  if (clean.startsWith("doc-") || clean === "pagedocstop" || clean === "pagedocs" || clean === "docs") {
    activateDocPanel("docs", "core");
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

  let sources = [];
  if (Array.isArray(data?.sources)) {
    sources = data.sources;
  } else if (Array.isArray(data?.citations)) {
    if (data.citations.length > 0 && typeof data.citations[0] === "string") {
      sources = data.citations.map((chunkId) => ({ chunkId }));
    } else {
      sources = data.citations;
    }
  }

  const html = `
    <div class="card reveal" style="animation-delay:20ms;">
      <div class="cardhead">
        <span class="chip">Answer</span>
      </div>
      <div class="preview">${escapeHtml(answerText)}</div>
    </div>
  `;
  wrap.insertAdjacentHTML("beforeend", html);

  const sourcesHtml = sources.length
    ? sources.map((src, idx) => {
      const docId = src?.docId || src?.doc_id || null;
      const collection = src?.collection || src?.collection_id || null;
      const chunkId = src?.chunkId || src?.chunk_id || src?.id || null;
      const chips = [];
      chips.push(`<span class="chip">Source ${idx + 1}</span>`);
      if (docId) chips.push(`<span class="chip">Doc <span class="mono">${escapeHtml(docId)}</span></span>`);
      if (collection) chips.push(`<span class="chip">Collection <span class="mono">${escapeHtml(collection)}</span></span>`);
      if (chunkId) chips.push(`<span class="chip">Chunk <span class="mono">${escapeHtml(chunkId)}</span></span>`);
      return `
        <div class="source-item">
          <div class="chips">
            ${chips.join("")}
          </div>
        </div>
      `;
    }).join("")
    : `<div class="preview">No sources returned.</div>`;

  const sourcesCard = `
    <div class="card reveal" style="animation-delay:60ms;">
      <div class="cardhead">
        <span class="chip">Sources</span>
        <span class="chip">${sources.length} total</span>
      </div>
      ${sourcesHtml}
    </div>
  `;
  wrap.insertAdjacentHTML("beforeend", sourcesCard);
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
  const usage = stats?.usage || {};
  const windows = usage.windows || {};
  const winAll = windows.all || {};
  const win24 = windows["24h"] || {};
  const win7 = windows["7d"] || {};
  const storage = usage.storage || {};

  const embedTotals = {
    all: Number(winAll.tokens?.embedding?.total || 0),
    "24h": Number(win24.tokens?.embedding?.total || 0),
    "7d": Number(win7.tokens?.embedding?.total || 0)
  };
  const embedReqs = {
    all: Number(winAll.tokens?.embedding?.requests || 0),
    "24h": Number(win24.tokens?.embedding?.requests || 0),
    "7d": Number(win7.tokens?.embedding?.requests || 0)
  };
  const genTotals = {
    all: Number(winAll.tokens?.generation?.total || 0),
    "24h": Number(win24.tokens?.generation?.total || 0),
    "7d": Number(win7.tokens?.generation?.total || 0)
  };
  const genReqs = {
    all: Number(winAll.tokens?.generation?.requests || 0),
    "24h": Number(win24.tokens?.generation?.requests || 0),
    "7d": Number(win7.tokens?.generation?.requests || 0)
  };

  const storageBytes = Number(storage.bytes || 0);
  const storageChunks = Number(storage.chunks || 0);
  const storageDocs = Number(storage.documents || 0);
  const storageItems = Number(storage.memoryItems || 0);
  const storageCollections = Number(storage.collections || 0);

  const cards = [
    {
      id: "requests",
      label: "Requests",
      values: { all: count, "24h": count, "7d": count },
      meta: { all: "since restart", "24h": "since restart", "7d": "since restart" }
    },
    {
      id: "error_rate",
      label: "Error rate",
      values: { all: errRate, "24h": errRate, "7d": errRate },
      format: (value) => `${(Number(value || 0) * 100).toFixed(2)}%`,
      meta: { all: "gateway 5xx", "24h": "gateway 5xx", "7d": "gateway 5xx" }
    },
    {
      id: "embedding_tokens",
      label: "Embedding tokens",
      values: embedTotals,
      meta: {
        all: `${formatNumber(embedReqs.all)} calls`,
        "24h": `${formatNumber(embedReqs["24h"])} calls`,
        "7d": `${formatNumber(embedReqs["7d"])} calls`
      }
    },
    {
      id: "generation_tokens",
      label: "Generation tokens",
      values: genTotals,
      meta: {
        all: `${formatNumber(genReqs.all)} calls`,
        "24h": `${formatNumber(genReqs["24h"])} calls`,
        "7d": `${formatNumber(genReqs["7d"])} calls`
      }
    },
    {
      id: "storage_used",
      label: "Storage used",
      values: { all: storageBytes, "24h": storageBytes, "7d": storageBytes },
      format: formatBytes,
      meta: { all: `${formatNumber(storageChunks)} chunks`, "24h": "current", "7d": "current" }
    },
    {
      id: "documents",
      label: "Documents",
      values: { all: storageDocs, "24h": storageDocs, "7d": storageDocs },
      meta: { all: `${formatNumber(storageCollections)} collections`, "24h": "current", "7d": "current" }
    },
    {
      id: "memory_items",
      label: "Memory items",
      values: { all: storageItems, "24h": storageItems, "7d": storageItems },
      meta: { all: "total", "24h": "current", "7d": "current" }
    },
    {
      id: "latency_p50",
      label: "Latency p50",
      values: { all: overall.p50_ms, "24h": overall.p50_ms, "7d": overall.p50_ms },
      format: formatMs,
      meta: { all: "overall", "24h": "rolling", "7d": "rolling" }
    },
    {
      id: "latency_p95",
      label: "Latency p95",
      values: { all: overall.p95_ms, "24h": overall.p95_ms, "7d": overall.p95_ms },
      format: formatMs,
      meta: { all: "overall", "24h": "rolling", "7d": "rolling" }
    },
    {
      id: "latency_p99",
      label: "Latency p99",
      values: { all: overall.p99_ms, "24h": overall.p99_ms, "7d": overall.p99_ms },
      format: formatMs,
      meta: { all: "overall", "24h": "rolling", "7d": "rolling" }
    },
    {
      id: "vector_ops",
      label: "Vector ops",
      values: { all: (stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0), "24h": (stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0), "7d": (stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0) },
      meta: { all: "total", "24h": "since restart", "7d": "since restart" }
    }
  ];

  const html = cards.map((card) => {
    const selected = getUsageWindow(card.id);
    const rawValue = card.values?.[selected] ?? card.value ?? "-";
    const value = card.format ? card.format(rawValue) : formatNumber(rawValue);
    const meta = typeof card.meta === "object"
      ? (card.meta?.[selected] ?? card.meta?.all ?? "")
      : (card.meta || "");
    const tabs = USAGE_WINDOWS.map((window) => {
      const label = USAGE_WINDOW_LABELS[window] || window;
      const active = selected === window ? "active" : "";
      return `<button class="stat-tab ${active}" type="button" data-usage-window="${window}" data-card="${card.id}">${label}</button>`;
    }).join("");
    return `
      <div class="stat">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-meta">${escapeHtml(meta)}</div>
        <div class="stat-tabs">${tabs}</div>
      </div>
    `;
  }).join("");

  wrap.insertAdjacentHTML("beforeend", html);
  bindUsageWindowClicks();
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
      lastUsageStats = data.data;
      renderUsage(lastUsageStats);
      renderUsageRoutes(lastUsageStats?.gateway?.latency?.routes || {});
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
      loadCollectionScopeOptions();
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

async function loadTenantSettings(){
  const banner = $("tenantAuthBanner");
  const loadBtn = $("tenantAuthLoadBtn");
  if (!banner || !loadBtn) return;
  clearBanner(banner);
  if (!requireKeyOrWarn(banner)) return;

  loadBtn.disabled = true;
  const originalLabel = loadBtn.textContent;
  loadBtn.textContent = "Loading...";

  try{
    const res = await fetch("/v1/admin/tenant", { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && data.data?.tenant){
      const tenant = data.data.tenant;
      if ($("tenantAuthTenantId")) $("tenantAuthTenantId").value = tenant.id || "";
      if ($("tenantAuthTenantName")) $("tenantAuthTenantName").value = tenant.name || "";
      if ($("tenantAuthMode")) $("tenantAuthMode").value = tenant.authMode || "sso_plus_password";
      const providersRaw = tenant.ssoProviders;
      const providers = Array.isArray(providersRaw) ? providersRaw : ["google", "azure", "okta"];
      const allowed = new Set(providers);
      if ($("tenantSsoGoogle")) $("tenantSsoGoogle").checked = allowed.has("google");
      if ($("tenantSsoAzure")) $("tenantSsoAzure").checked = allowed.has("azure");
      if ($("tenantSsoOkta")) $("tenantSsoOkta").checked = allowed.has("okta");
      setBanner(banner, "ok", "Tenant settings loaded.");
    }else{
      const msg = data?.error?.message || data?.error || "Failed to load tenant settings.";
      setBanner(banner, "err", msg);
    }
  }catch(e){
    setBanner(banner, "err", "Error loading tenant settings.");
  }finally{
    loadBtn.disabled = false;
    loadBtn.textContent = originalLabel;
  }
}

async function saveTenantSettings(){
  const banner = $("tenantAuthBanner");
  const saveBtn = $("tenantAuthSaveBtn");
  if (!banner || !saveBtn) return;
  clearBanner(banner);
  if (!requireKeyOrWarn(banner)) return;

  const authMode = $("tenantAuthMode") ? $("tenantAuthMode").value : "";
  if (!authMode){
    setBanner(banner, "err", "Select an auth mode.");
    return;
  }
  const ssoProviders = [];
  if ($("tenantSsoGoogle")?.checked) ssoProviders.push("google");
  if ($("tenantSsoAzure")?.checked) ssoProviders.push("azure");
  if ($("tenantSsoOkta")?.checked) ssoProviders.push("okta");

  saveBtn.disabled = true;
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = "Saving...";

  try{
    const res = await fetch("/v1/admin/tenant", {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify({ authMode, ssoProviders })
    });
    const data = await res.json();
    if (res.ok && data.ok && data.data?.tenant){
      const tenant = data.data.tenant;
      if ($("tenantAuthTenantId")) $("tenantAuthTenantId").value = tenant.id || "";
      if ($("tenantAuthTenantName")) $("tenantAuthTenantName").value = tenant.name || "";
      if ($("tenantAuthMode")) $("tenantAuthMode").value = tenant.authMode || authMode;
      setBanner(banner, "ok", "Tenant auth mode updated.");
    }else{
      const msg = data?.error?.message || data?.error || "Failed to update tenant settings.";
      setBanner(banner, "err", msg);
    }
  }catch(e){
    setBanner(banner, "err", "Error updating tenant settings.");
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initDocTabs();
  initDocsAgentConnect();
  $("tabPlayground").onclick = () => showPage("pagePlayground");
  $("tabMetrics").onclick = () => showPage("pageMetrics");
  $("tabUsage").onclick = () => showPage("pageUsage");
  $("tabDocs").onclick = () => showPage("pageDocs");
  $("tabSettings").onclick = () => showPage("pageSettings");
  $("tabProduct").onclick = () => showPage("pageProduct");
  $("playTabIngest").onclick = () => showPlayPane("playPaneIngest");
  $("playTabSearch").onclick = () => showPlayPane("playPaneSearch");
  $("playTabAsk").onclick = () => showPlayPane("playPaneAsk");

  if (!openPageFromHash({ smooth: false })) {
    showPage("pageProduct");
  }
  window.addEventListener("hashchange", () => {
    openPageFromHash({ smooth: true });
  });

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
      loadCollectionScopeOptions();
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
        loadCollectionScopeOptions();
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
    setCollectionScopeOptions([]);
  };

  $("createApiKeyBtn").onclick = async () => {
    clearBanner($("apiKeyBanner"));
    $("copyCreatedApiKeyBtn").disabled = true;
    $("useCreatedApiKeyBtn").disabled = true;
    const auth = loadStoredAuth();
    if (!auth.token){
      setBanner($("apiKeyBanner"), "err", "Save a token first (admin required).");
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
    loadCollectionScopeOptions();
  };

  $("copyCreatedApiKeyBtn").onclick = async () => {
    const token = $("copyCreatedApiKeyBtn").dataset.token;
    if (!token){
      setBanner($("apiKeyBanner"), "err", "No API key to copy yet.");
      return;
    }
    try{
      await copyTextToClipboard(token);
      setBanner($("apiKeyBanner"), "ok", "API key copied to clipboard.");
    }catch(e){
      setBanner($("apiKeyBanner"), "err", "Failed to copy API key.");
    }
  };

  if ($("tenantAuthLoadBtn")) {
    $("tenantAuthLoadBtn").onclick = () => loadTenantSettings();
  }
  if ($("tenantAuthSaveBtn")) {
    $("tenantAuthSaveBtn").onclick = () => saveTenantSettings();
  }
  const tenantTabBtn = document.querySelector('.doc-tabs[data-doc-tabs="settings"] .doc-tab[data-doc-tab="tenant"]');
  if (tenantTabBtn){
    tenantTabBtn.addEventListener("click", () => loadTenantSettings());
  }

  $("indexClearBtn").onclick = () => {
    $("docId").value = "";
    $("docText").value = "";
    $("docUrl").value = "";
    $("docFile").value = "";
    $("indexRaw").textContent = "(no output)";
    clearBanner($("indexBanner"));
  };

  if ($("searchCollectionScope")) {
    $("searchCollectionScope").addEventListener("focus", () => {
      loadCollectionScopeOptions();
    });
  }
  if ($("askCollectionScope")) {
    $("askCollectionScope").addEventListener("focus", () => {
      loadCollectionScopeOptions();
    });
  }

  $("docUrl").addEventListener("blur", () => {
    if ($("docId").value.trim()) return;
    const suggested = suggestDocIdFromUrl($("docUrl").value.trim());
    if (suggested) $("docId").value = suggested;
  });

  const collectionInput = $("playCollection");
  if (collectionInput){
    collectionInput.addEventListener("blur", () => {
      collectionInput.value = normalizeCollectionName(collectionInput.value);
    });
    collectionInput.addEventListener("change", () => {
      collectionInput.value = normalizeCollectionName(collectionInput.value);
      loadDocsList();
    });
  }

  $("docFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      setBanner($("indexBanner"), "err", "File too large. Max size is 5 MB.");
      return;
    }

    const uploadType = detectUploadFileType(file);
    try{
      let text = "";
      if (uploadType === "pdf") {
        setBanner($("indexBanner"), "ok", `Extracting text from PDF "${file.name}"...`);
        text = await extractTextFromPdfFile(file);
      } else if (uploadType === "docx") {
        setBanner($("indexBanner"), "ok", `Extracting text from Word file "${file.name}"...`);
        text = await extractTextFromDocxFile(file);
      } else if (uploadType === "doc") {
        throw new Error("Legacy .doc is not supported. Save as .docx and upload again.");
      } else {
        text = normalizeExtractedText(await file.text());
      }

      if (!text.trim()) {
        throw new Error("No extractable text found in file.");
      }

      $("docText").value = text;

      if (!$("docId").value.trim()) {
        const suggested = suggestDocIdFromFilename(file.name) || "upload";
        $("docId").value = suggested;
      }

      const kindLabel = uploadType === "pdf"
        ? "PDF"
        : (uploadType === "docx" ? "Word (.docx)" : "text");
      setBanner($("indexBanner"), "ok", `Loaded ${kindLabel} file "${file.name}" (${text.length} chars).`);
    }catch(e){
      setBanner($("indexBanner"), "err", "Failed to read file: " + e);
    }
  });

  $("indexBtn").onclick = async () => {
    clearBanner($("indexBanner"));
    if (!requireKeyOrWarn($("indexBanner"))) return;

    const collection = getPlaygroundCollection({ bannerEl: $("indexBanner") });
    if (!collection) return;

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
          body: JSON.stringify({ docId, url, collection })
        });
      }else{
        if (!text.trim()){
          setBanner($("indexBanner"), "err", "Paste text or provide a URL.");
          return;
        }
        res = await fetch("/docs", {
          method:"POST",
          headers: apiHeaders(),
          body: JSON.stringify({ docId, text, collection })
        });
      }

      const data = await res.json();
      $("indexRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.ok){
        const extra = data.truncated || data.docTruncated ? " (truncated)" : "";
        const sourceLabel = url ? " from URL" : "";
        setBanner($("indexBanner"), "ok", `Indexed "${docId}"${sourceLabel} in "${collection}"${extra} (${data.chunksIndexed} chunks).`);
        showPage("pagePlayground");
        showPlayPane("playPaneSearch");
        loadDocsList();
        loadCollectionScopeOptions();
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
    const scope = String($("searchCollectionScope")?.value || "all").trim();

    if (!q){
      setBanner($("searchBanner"), "err", "Please enter a search query.");
      return;
    }

    $("searchBtn").disabled = true;
    $("searchBtn").textContent = "Searching...";

    try{
      const effectiveCollection = scope === "all" ? null : scope;
      const collectionParam = effectiveCollection
        ? `&collection=${encodeURIComponent(effectiveCollection)}`
        : "&collectionScope=all";
      const res = await fetch(`/search?q=${encodeURIComponent(q)}&k=${k}${collectionParam}`, {
        headers: apiHeaders()
      });

      const data = await res.json();
      $("searchRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.results){
        const label = effectiveCollection || "all collections";
        setBanner($("searchBanner"), "ok", `Found ${data.results.length} result(s) in "${label}".`);
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
    const scope = String($("askCollectionScope")?.value || "all").trim();

    if (!question){
      setBanner($("askBanner"), "err", "Please enter a question.");
      return;
    }

    $("askBtn").disabled = true;
    $("askBtn").textContent = "Thinking...";

    try{
      const body = { question, k };
      if (scope === "all"){
        body.collectionScope = "all";
      } else {
        body.collection = scope;
      }

      const res = await fetch("/ask", {
        method:"POST",
        headers: apiHeaders(),
        body: JSON.stringify(body)
      });

      const data = await res.json();
      $("askRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.answer){
        const label = scope === "all" ? "all collections" : scope;
        setBanner($("askBanner"), "ok", `Answer generated from "${label}".`);
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
  loadCollectionScopeOptions();
});

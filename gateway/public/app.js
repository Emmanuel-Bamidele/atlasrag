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

function getApiKey(){
  return (localStorage.getItem("miniRedisApiKey") || "").trim();
}

function apiHeaders(){
  const key = getApiKey();
  return {
    "Content-Type":"application/json",
    "x-api-key": key
  };
}

function requireKeyOrWarn(bannerEl){
  if (!getApiKey()){
    setBanner(bannerEl, "err", "No API key saved. Go to Settings and paste the API key.");
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

function slugifyDocId(value){
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isValidDocId(value){
  return /^[a-zA-Z0-9._-]+$/.test(String(value || ""));
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
    ["tabIndex","pageIndex"],
    ["tabSearch","pageSearch"],
    ["tabAsk","pageAsk"],
    ["tabMetrics","pageMetrics"],
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
  $("tabIndex").onclick = () => showPage("pageIndex");
  $("tabSearch").onclick = () => showPage("pageSearch");
  $("tabAsk").onclick = () => showPage("pageAsk");
  $("tabMetrics").onclick = () => showPage("pageMetrics");
  $("tabDocs").onclick = () => showPage("pageDocs");
  $("tabSettings").onclick = () => showPage("pageSettings");

  refreshHealth();
  setInterval(refreshHealth, 12000);

  $("apiKey").value = getApiKey();

  $("saveKeyBtn").onclick = () => {
    const key = $("apiKey").value.trim();
    if (!key){
      setBanner($("settingsBanner"), "err", "Please paste an API key first.");
      return;
    }
    localStorage.setItem("miniRedisApiKey", key);
    setBanner($("settingsBanner"), "ok", "Saved. You can now Index, Search, and Ask.");
  };

  $("clearKeyBtn").onclick = () => {
    localStorage.removeItem("miniRedisApiKey");
    $("apiKey").value = "";
    setBanner($("settingsBanner"), "ok", "Removed saved API key.");
  };

  $("indexClearBtn").onclick = () => {
    $("docId").value = "";
    $("docText").value = "";
    $("docUrl").value = "";
    $("docFile").value = "";
    $("indexRaw").textContent = "(no output)";
    clearBanner($("indexBanner"));
  };

  $("clearUrlBtn").onclick = () => {
    $("docUrl").value = "";
    clearBanner($("indexBanner"));
  };

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

    const docId = $("docId").value.trim();
    const text = $("docText").value;

    if (!docId || !text.trim()){
      setBanner($("indexBanner"), "err", "Please provide Doc ID and document text.");
      return;
    }
    if (!isValidDocId(docId)){
      setBanner($("indexBanner"), "err", "Doc ID must use only letters, numbers, dot, dash, or underscore (no spaces).");
      return;
    }

    $("indexBtn").disabled = true;
    $("indexBtn").textContent = "Indexing...";

    try{
      const res = await fetch("/docs", {
        method:"POST",
        headers: apiHeaders(),
        body: JSON.stringify({ docId, text })
      });

      const data = await res.json();
      $("indexRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.ok){
        const extra = data.truncated ? " (truncated)" : "";
        setBanner($("indexBanner"), "ok", `Indexed "${docId}"${extra} (${data.chunksIndexed} chunks).`);
        showPage("pageSearch");
      }else{
        setBanner($("indexBanner"), "err", data.error || "Index failed.");
      }
    }catch(e){
      setBanner($("indexBanner"), "err", "Error: " + e);
    }finally{
      $("indexBtn").disabled = false;
      $("indexBtn").textContent = "Index document";
    }
  };

  $("indexUrlBtn").onclick = async () => {
    clearBanner($("indexBanner"));
    if (!requireKeyOrWarn($("indexBanner"))) return;

    const url = $("docUrl").value.trim();
    let docId = $("docId").value.trim();

    if (!docId) {
      docId = suggestDocIdFromUrl(url);
      if (docId) $("docId").value = docId;
    }

    if (!docId || !url) {
      setBanner($("indexBanner"), "err", "Please provide Doc ID and URL.");
      return;
    }
    if (!isValidDocId(docId)){
      setBanner($("indexBanner"), "err", "Doc ID must use only letters, numbers, dot, dash, or underscore (no spaces).");
      return;
    }

    $("indexUrlBtn").disabled = true;
    $("indexUrlBtn").textContent = "Indexing URL...";

    try{
      const res = await fetch("/docs/url", {
        method:"POST",
        headers: apiHeaders(),
        body: JSON.stringify({ docId, url })
      });

      const data = await res.json();
      $("indexRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.ok){
        const extra = data.docTruncated ? " (truncated)" : "";
        setBanner($("indexBanner"), "ok", `Indexed "${docId}" from URL${extra} (${data.chunksIndexed} chunks).`);
        showPage("pageSearch");
      }else{
        setBanner($("indexBanner"), "err", data.error || "Index URL failed.");
      }
    }catch(e){
      setBanner($("indexBanner"), "err", "Error: " + e);
    }finally{
      $("indexUrlBtn").disabled = false;
      $("indexUrlBtn").textContent = "Index URL";
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

    if (!q){
      setBanner($("searchBanner"), "err", "Please enter a search query.");
      return;
    }

    $("searchBtn").disabled = true;
    $("searchBtn").textContent = "Searching...";

    try{
      const res = await fetch(`/search?q=${encodeURIComponent(q)}&k=${k}`, {
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
        body: JSON.stringify({ question, k })
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
  };

  $("statsBtn").onclick = async () => {
    clearBanner($("statsBanner"));
    if (!requireKeyOrWarn($("statsBanner"))) return;

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
      }else{
        setBanner($("statsBanner"), "err", data.error || "Stats failed.");
      }
    }catch(e){
      setBanner($("statsBanner"), "err", "Error: " + e);
    }finally{
      $("statsBtn").disabled = false;
      $("statsBtn").textContent = "Refresh stats";
    }
  };
});

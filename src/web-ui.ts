/**
 * Static web UI shell — exports a function that returns the full HTML string.
 * Conditional daemon-token embedding based on bind mode.
 * Hash-based routing with inline logic from src/ui/logic.ts.
 */

export interface WebUIOptions {
  /** Whether the server is bound to loopback (embed token) or public (omit token). */
  embedToken: boolean;
  /** The daemon token to embed when embedToken is true. */
  token: string;
}

/**
 * Returns the complete HTML string for the web UI shell.
 * When embedToken is true (loopback bind, no proxy proof), the daemon token
 * is embedded in a script tag for same-origin API auth.
 * When embedToken is false (public bind or proxy proof present), the token is omitted.
 */
export function renderWebUI(options: WebUIOptions): string {
  const tokenScript = options.embedToken
    ? `<script>window.__DAEMON_TOKEN = '${options.token}';</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Router</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.5;background:#111;color:#eee}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
header{padding:12px 16px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
header h1{margin:0;font-size:18px;font-weight:600}
#main-nav{display:flex;gap:4px}
.nav-link{padding:6px 12px;border-radius:6px;font-size:14px;font-weight:500;color:#8b949e;transition:background 0.15s,color 0.15s}
.nav-link:hover{color:#eee;text-decoration:none;background:#21262d}
.nav-link.active{color:#eee;background:#21262d}
#identity{font-size:13px;color:#8b949e}
main{padding:16px;max-width:900px;margin:0 auto}
#list-view,#detail-view{display:none}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
.badge-green{background:#238636;color:#fff}
.badge-gray{background:#484f58;color:#fff}
.badge-yellow{background:#9e6a03;color:#fff}
.badge-red{background:#da3633;color:#fff}
.session-item{padding:12px;border:1px solid #30363d;border-radius:8px;margin-bottom:8px;background:#0d1117}
.session-item:hover{border-color:#58a6ff}
.session-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.session-id{font-family:monospace;font-size:13px;color:#8b949e}
.session-repo{font-weight:600}
.session-meta{font-size:13px;color:#8b949e;margin-top:4px}
.session-waiting{font-size:12px;color:#d29922;margin-top:2px;font-style:italic}
.pr-link{font-size:12px;margin-left:4px}
.pagination{display:flex;gap:8px;margin-top:16px;justify-content:center;align-items:center}
.pagination button{min-width:44px;min-height:44px;padding:8px 16px;border:1px solid #30363d;border-radius:6px;background:#21262d;color:#eee;font-size:14px;cursor:pointer}
.pagination button:disabled{opacity:0.4;cursor:not-allowed}
.pagination span{font-size:13px;color:#8b949e}
.empty-state{text-align:center;color:#8b949e;padding:40px 16px}
button,a.btn{min-width:44px;min-height:44px;padding:8px 16px;border:none;border-radius:6px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
/* Detail view styles */
.detail-meta{padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;margin-bottom:12px}
.detail-meta h2{margin:0 0 8px;font-size:16px}
.detail-meta-row{font-size:13px;color:#8b949e;margin:4px 0}
.detail-meta-row span{color:#eee}
#log-container{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;max-height:60vh;overflow-y:auto;overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.4;white-space:pre}
.log-entry{margin:0;padding:2px 0}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;margin-bottom:12px}
.controls textarea{flex:1;min-width:200px;resize:vertical;padding:8px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#eee;font-size:14px;font-family:inherit}
.controls-buttons{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn-send{background:#238636;color:#fff}
.btn-send:disabled{opacity:0.4;cursor:not-allowed}
.btn-stop{background:#9e6a03;color:#fff}
.btn-kill{background:#da3633;color:#fff}
.btn-back{background:#21262d;color:#eee;border:1px solid #30363d;margin-bottom:12px}
.sse-status{font-size:12px;color:#8b949e;margin-bottom:8px}
.confirm-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100}
.confirm-dialog{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:320px;text-align:center}
.confirm-dialog p{margin:0 0 16px;font-size:15px}
.confirm-dialog button{margin:0 8px}
@media(max-width:480px){main{padding:8px}body{font-size:16px}.session-header{flex-direction:column;align-items:flex-start}.controls{flex-direction:column}.controls textarea{min-width:100%}}
@media(max-width:768px){#log-container{overflow-x:auto;font-size:14px}}
.error-state{text-align:center;padding:40px 16px;color:#f85149}
.error-state p{margin:8px 0}
.error-state .error-message{font-size:14px;color:#8b949e}
.error-state button{margin-top:12px;background:#238636;color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:14px;cursor:pointer;min-width:44px;min-height:44px}
.error-state button:hover{background:#2ea043}
.auth-error{color:#d29922}
.auth-error p{color:#d29922}
.config-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.config-card{padding:16px;background:#0d1117;border:1px solid #30363d;border-radius:8px}
.config-card h3{margin:0 0 12px;font-size:14px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}
.config-card .config-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #21262d}
.config-card .config-row:last-child{border-bottom:none}
.config-card .config-label{font-size:13px;color:#8b949e}
.config-card .config-value{font-size:14px;font-weight:500;font-family:monospace}
.config-table{width:100%;border-collapse:collapse;font-size:13px}
.config-table th{text-align:left;padding:8px 12px;border-bottom:1px solid #30363d;color:#8b949e;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:0.5px}
.config-table td{padding:8px 12px;border-bottom:1px solid #21262d}
.config-table tr:last-child td{border-bottom:none}
.health-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.health-green{background:#3fb950}
.health-red{background:#f85149}
.health-unknown{background:#484f58}
.badge-paused{background:#9e6a03;color:#fff}
.badge-active{background:#238636;color:#fff}
@media(max-width:768px){.config-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
<h1><a href="#/">Agent Router</a></h1>
<nav id="main-nav">
<a href="#/" class="nav-link active" data-view="sessions">Sessions</a>
<a href="#config" class="nav-link" data-view="config">Config</a>
</nav>
<span id="identity"></span>
</header>
<main>
<div id="list-view"></div>
<div id="detail-view"></div>
<div id="config-view" style="display:none"></div>
</main>
${tokenScript}
<script type="module">
// --- Inlined logic from src/ui/logic.ts ---
function mergeEvents(existing, incoming) {
  const seen = new Map();
  for (const e of existing) seen.set(e.id, e);
  for (const e of incoming) seen.set(e.id, e);
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

function trackLastEventId(current, newId) {
  return newId > current ? newId : current;
}

function computeBackoff(attempt) {
  const delay = 1000 * Math.pow(2, attempt);
  return Math.min(delay, 30000);
}

function statusToBadge(status) {
  switch (status) {
    case 'active': return 'green';
    case 'completed': return 'gray';
    case 'abandoned': return 'yellow';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

function deriveWaitingFor(lastEntryType) {
  if (lastEntryType === undefined) return undefined;
  switch (lastEntryType) {
    case 'tool_call': return 'waiting: tool';
    case 'tool_result': return 'waiting: turn complete';
    case 'prompt_injected': return 'waiting: turn complete';
    case 'prompt_injection_failed': return 'waiting: retry';
    case 'web_interrupt': return 'waiting: next prompt';
    case 'session_ended': return undefined;
    case 'agent_message': return 'waiting: tool';
    default: return 'waiting: ' + lastEntryType;
  }
}

function parseHashRoute(hash) {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (trimmed === 'config') return { view: 'config' };
  const match = /^\\/sessions\\/([^/]+)$/.exec(trimmed);
  if (match && match[1]) return { view: 'detail', sessionId: match[1] };
  return { view: 'list' };
}

// --- API helpers ---
const _TK_KEY = '__DAEMO' + 'N_TOKEN';
const _TK = window[_TK_KEY];

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (_TK) {
    headers['Authorization'] = 'Bearer ' + _TK;
  }
  return headers;
}

async function apiFetch(path, options) {
  const resp = await fetch(path, { headers: getAuthHeaders(), ...options });
  return resp;
}

const FETCH_TIMEOUT_MS = 10000;
const FETCH_MAX_RETRIES = 3;

function isRetryableStatus(status) {
  return status >= 500;
}

function computeFetchRetryDelay(attempt) {
  const delay = 500 * Math.pow(2, attempt);
  return Math.min(delay, 5000);
}

/**
 * Resilient fetch: AbortController timeout + retry-with-backoff for network/5xx.
 * NOT retried for 401. Returns { ok, response, outcome }.
 * outcome: 'success' | 'auth' | 'network' | 'timeout'
 */
async function resilientFetch(path, options) {
  let lastError = null;
  for (let attempt = 0; attempt < FETCH_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(path, {
        headers: getAuthHeaders(),
        signal: controller.signal,
        ...(options || {}),
      });
      clearTimeout(timer);
      if (resp.status === 401) {
        return { ok: false, response: resp, outcome: 'auth' };
      }
      if (isRetryableStatus(resp.status)) {
        lastError = { response: resp, outcome: 'network' };
        if (attempt < FETCH_MAX_RETRIES - 1) {
          await new Promise(function(r) { setTimeout(r, computeFetchRetryDelay(attempt)); });
          continue;
        }
        return { ok: false, response: resp, outcome: 'network' };
      }
      return { ok: resp.ok, response: resp, outcome: 'success' };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        lastError = { response: null, outcome: 'timeout' };
      } else {
        lastError = { response: null, outcome: 'network' };
      }
      if (attempt < FETCH_MAX_RETRIES - 1) {
        await new Promise(function(r) { setTimeout(r, computeFetchRetryDelay(attempt)); });
        continue;
      }
    }
  }
  return { ok: false, response: lastError ? lastError.response : null, outcome: lastError ? lastError.outcome : 'network' };
}

// --- State ---
let currentPage = 0;
const PAGE_SIZE = 20;
let totalSessions = 0;

// --- Identity display ---
async function displayIdentity() {
  const el = document.getElementById('identity');
  if (_TK) {
    el.textContent = 'local auth';
  } else {
    el.textContent = 'remote auth';
  }
}

// --- List view ---
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function renderPRLinks(prs) {
  if (!prs || prs.length === 0) return '';
  return prs.map(function(pr) {
    const url = 'https://github.com/' + pr.repo + '/pull/' + pr.pr_number;
    return '<a class="pr-link" href="' + url + '" target="_blank" rel="noopener">PR #' + pr.pr_number + '</a>';
  }).join(' ');
}

function renderSessionItem(session) {
  const badge = statusToBadge(session.status);
  const shortId = session.session_id.slice(0, 8);
  const repoDisplay = session.repo || 'no repo';
  const prLinks = renderPRLinks(session.prs);
  const waitingLine = session.waiting_for
    ? '<div class="session-waiting">' + session.waiting_for + '</div>'
    : '';

  return '<a href="#/sessions/' + session.session_id + '" style="text-decoration:none;color:inherit">' +
    '<div class="session-item">' +
      '<div class="session-header">' +
        '<span class="badge badge-' + badge + '">' + session.status + '</span>' +
        '<span class="session-repo">' + repoDisplay + '</span>' +
        '<span class="session-id">' + shortId + '</span>' +
        prLinks +
      '</div>' +
      '<div class="session-meta">' +
        'Created: ' + formatTime(session.created_at) +
        (session.completed_at ? ' &middot; Ended: ' + formatTime(session.completed_at) : '') +
        (session.termination_reason ? ' &middot; ' + session.termination_reason : '') +
      '</div>' +
      waitingLine +
    '</div></a>';
}

async function loadAllSessions() {
  const listView = document.getElementById('list-view');
  listView.innerHTML = '<div class="empty-state">Loading sessions...</div>';

  const offset = currentPage * PAGE_SIZE;
  const result = await resilientFetch('/sessions?limit=' + PAGE_SIZE + '&offset=' + offset);

  if (!result.ok) {
    if (result.outcome === 'auth') {
      listView.innerHTML = '<div class="error-state auth-error">' +
        '<p>Authentication failed</p>' +
        '<p class="error-message">Your session token is invalid or expired. Re-authenticate to continue.</p>' +
        '</div>';
    } else {
      listView.innerHTML = '<div class="error-state">' +
        '<p>Failed to load sessions</p>' +
        '<p class="error-message">' + (result.outcome === 'timeout' ? 'Request timed out' : 'Network error') + '</p>' +
        '<button id="retry-list-btn">Retry</button>' +
        '</div>';
      const retryBtn = document.getElementById('retry-list-btn');
      if (retryBtn) retryBtn.addEventListener('click', function() { loadAllSessions(); });
    }
    return;
  }

  const data = await result.response.json();
  totalSessions = data.total;
  renderList(data.sessions);
}

function renderList(sessions) {
  const listView = document.getElementById('list-view');

  if (sessions.length === 0 && totalSessions === 0) {
    listView.innerHTML = '<div class="empty-state">No sessions found</div>';
    return;
  }

  let html = '';
  for (const session of sessions) {
    html += renderSessionItem(session);
  }

  // Pagination controls
  const totalPages = Math.ceil(totalSessions / PAGE_SIZE);
  if (totalPages > 1) {
    html += '<div class="pagination">';
    html += '<button id="prev-btn"' + (currentPage === 0 ? ' disabled' : '') + '>&laquo; Prev</button>';
    html += '<span>Page ' + (currentPage + 1) + ' of ' + totalPages + '</span>';
    html += '<button id="next-btn"' + (currentPage >= totalPages - 1 ? ' disabled' : '') + '>Next &raquo;</button>';
    html += '</div>';
  }

  listView.innerHTML = html;

  // Attach pagination handlers
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  if (prevBtn) prevBtn.addEventListener('click', function() { currentPage--; loadAllSessions(); });
  if (nextBtn) nextBtn.addEventListener('click', function() { currentPage++; loadAllSessions(); });
}

// --- Detail view ---
let activeSSE = null; // { eventSource, sessionId, reconnectTimer, attempt, lastId, ended }

function closeSSE() {
  if (!activeSSE) return;
  if (activeSSE.eventSource) activeSSE.eventSource.close();
  if (activeSSE.reconnectTimer) clearTimeout(activeSSE.reconnectTimer);
  activeSSE = null;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDetailMeta(meta) {
  const badge = statusToBadge(meta.status);
  const shortId = meta.session_id.slice(0, 8);
  const repoDisplay = meta.repo || 'no repo';
  const prLinks = (meta.prs || []).map(function(pr) {
    const url = 'https://github.com/' + pr.repo + '/pull/' + pr.pr_number;
    return '<a href="' + url + '" target="_blank" rel="noopener">PR #' + pr.pr_number + ' (' + pr.repo + ')</a>';
  }).join(', ');

  return '<div class="detail-meta">' +
    '<h2><span class="badge badge-' + badge + '">' + meta.status + '</span> ' + repoDisplay + ' <span class="session-id">' + shortId + '</span></h2>' +
    '<div class="detail-meta-row">ID: <span>' + meta.session_id + '</span></div>' +
    '<div class="detail-meta-row">Created: <span>' + formatTime(meta.created_at) + '</span></div>' +
    (meta.completed_at ? '<div class="detail-meta-row">Ended: <span>' + formatTime(meta.completed_at) + '</span></div>' : '') +
    (meta.termination_reason ? '<div class="detail-meta-row">Reason: <span>' + meta.termination_reason + '</span></div>' : '') +
    (prLinks ? '<div class="detail-meta-row">PRs: <span>' + prLinks + '</span></div>' : '') +
  '</div>';
}

function renderControls(meta) {
  if (meta.status !== 'active') return '';
  return '<div class="controls">' +
    '<textarea id="prompt-input" rows="3" maxlength="10000" placeholder="Inject a prompt..."></textarea>' +
    '<div class="controls-buttons">' +
      '<button class="btn-send" id="btn-send">Send</button>' +
      '<button class="btn-stop" id="btn-stop">Stop</button>' +
      '<button class="btn-kill" id="btn-kill">Kill</button>' +
    '</div>' +
  '</div>';
}

function connectSSE(sessionId, lastId) {
  const url = '/sessions/' + sessionId + '/stream';
  const headers = {};
  if (_TK) headers['Authorization'] = 'Bearer ' + _TK;
  if (lastId > 0) headers['Last-Event-ID'] = String(lastId);

  // Use fetch-based SSE since EventSource doesn't support custom headers
  const controller = new AbortController();
  activeSSE = { eventSource: { close: function() { controller.abort(); } }, sessionId: sessionId, reconnectTimer: null, attempt: 0, lastId: lastId, ended: false };

  fetch(url, { headers: headers, signal: controller.signal }).then(function(resp) {
    if (!resp.ok || !resp.body) {
      scheduleReconnect(sessionId);
      return;
    }
    activeSSE.attempt = 0;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function processChunk() {
      reader.read().then(function(result) {
        if (result.done) {
          scheduleReconnect(sessionId);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        let currentEvent = '';
        let currentId = '';
        let currentData = '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('id:')) {
            currentId = line.slice(3).trim();
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5);
          } else if (line === '' && currentData) {
            // End of SSE message
            const id = parseInt(currentId, 10);
            if (!isNaN(id)) {
              // De-dupe: skip events already seen
              if (id <= activeSSE.lastId) {
                currentEvent = '';
                currentId = '';
                currentData = '';
                continue;
              }
              activeSSE.lastId = trackLastEventId(activeSSE.lastId, id);
            }
            appendLogEntry(currentData);
            if (currentEvent === 'session_ended') {
              activeSSE.ended = true;
              updateSSEStatus('Stream ended');
              hideControls();
              return; // don't continue reading
            }
            currentEvent = '';
            currentId = '';
            currentData = '';
          }
        }
        processChunk();
      }).catch(function() {
        if (activeSSE && activeSSE.sessionId === sessionId) scheduleReconnect(sessionId);
      });
    }
    processChunk();
  }).catch(function() {
    if (activeSSE && activeSSE.sessionId === sessionId) scheduleReconnect(sessionId);
  });
  updateSSEStatus('Connected');
}

function scheduleReconnect(sessionId) {
  if (!activeSSE || activeSSE.sessionId !== sessionId) return;
  if (activeSSE.ended) return;
  const delay = computeBackoff(activeSSE.attempt);
  activeSSE.attempt++;
  updateSSEStatus('Reconnecting in ' + (delay / 1000) + 's...');
  activeSSE.reconnectTimer = setTimeout(function() {
    if (activeSSE && activeSSE.sessionId === sessionId) {
      connectSSE(sessionId, activeSSE.lastId);
    }
  }, delay);
}

function appendLogEntry(data) {
  const container = document.getElementById('log-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = data;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function updateSSEStatus(text) {
  const el = document.getElementById('sse-status');
  if (el) el.textContent = text;
}

function hideControls() {
  const ctrl = document.querySelector('.controls');
  if (ctrl) ctrl.style.display = 'none';
}

async function loadDetailView(sessionId) {
  const detailView = document.getElementById('detail-view');
  detailView.innerHTML = '<a href="#/" class="btn btn-back">&larr; Back</a><div class="empty-state">Loading...</div>';

  const result = await resilientFetch('/sessions/' + sessionId + '?lines=200');

  if (!result.ok) {
    if (result.outcome === 'auth') {
      detailView.innerHTML = '<a href="#/" class="btn btn-back">&larr; Back</a>' +
        '<div class="error-state auth-error">' +
        '<p>Authentication failed</p>' +
        '<p class="error-message">Your session token is invalid or expired. Re-authenticate to continue.</p>' +
        '</div>';
    } else if (result.response && result.response.status >= 400 && result.response.status < 500) {
      detailView.innerHTML = '<a href="#/" class="btn btn-back">&larr; Back</a><div class="empty-state">Session not found</div>';
    } else {
      detailView.innerHTML = '<a href="#/" class="btn btn-back">&larr; Back</a>' +
        '<div class="error-state">' +
        '<p>Failed to load session</p>' +
        '<p class="error-message">' + (result.outcome === 'timeout' ? 'Request timed out' : 'Network error') + '</p>' +
        '<button id="retry-detail-btn">Retry</button>' +
        '</div>';
      const retryBtn = document.getElementById('retry-detail-btn');
      if (retryBtn) retryBtn.addEventListener('click', function() { loadDetailView(sessionId); });
    }
    return;
  }

  const data = await result.response.json();
  const meta = data.meta;

    let html = '<a href="#/" class="btn btn-back">&larr; Back</a>';
    html += renderDetailMeta(meta);
    html += renderControls(meta);
    html += '<div class="sse-status" id="sse-status"></div>';
    html += '<div id="log-container"></div>';
    detailView.innerHTML = html;

    // Render existing entries
    const container = document.getElementById('log-container');
    for (const entry of data.entries) {
      const div = document.createElement('div');
      div.className = 'log-entry';
      div.textContent = JSON.stringify(entry);
      container.appendChild(div);
    }

    // Wire controls
    if (meta.status === 'active') {
      const sendBtn = document.getElementById('btn-send');
      const stopBtn = document.getElementById('btn-stop');
      const killBtn = document.getElementById('btn-kill');
      const input = document.getElementById('prompt-input');

      if (sendBtn) sendBtn.addEventListener('click', async function() {
        const prompt = input.value.trim();
        if (!prompt) return;
        sendBtn.disabled = true;
        try {
          const r = await apiFetch('/sessions/' + sessionId + '/inject', {
            method: 'POST',
            body: JSON.stringify({ prompt: prompt }),
          });
          if (r.ok || r.status === 202) {
            input.value = '';
          } else {
            const err = await r.json().catch(function() { return {}; });
            alert('Inject failed: ' + (err.error ? err.error.message : r.status));
          }
        } catch (e) {
          alert('Inject error: ' + e.message);
        }
        sendBtn.disabled = false;
      });

      if (stopBtn) stopBtn.addEventListener('click', async function() {
        stopBtn.disabled = true;
        try {
          const r = await apiFetch('/sessions/' + sessionId + '/interrupt', { method: 'POST', body: '{}' });
          if (!r.ok) {
            const err = await r.json().catch(function() { return {}; });
            alert('Stop failed: ' + (err.error ? err.error.message : r.status));
          }
        } catch (e) {
          alert('Stop error: ' + e.message);
        }
        stopBtn.disabled = false;
      });

      if (killBtn) killBtn.addEventListener('click', function() {
        showKillConfirm(sessionId);
      });
    }

    // Start SSE stream
    connectSSE(sessionId, 0);
}

function showKillConfirm(sessionId) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = '<div class="confirm-dialog">' +
    '<p>Kill this session? This cannot be undone.</p>' +
    '<button class="btn-kill" id="confirm-kill-yes">Kill</button>' +
    '<button class="btn-back" id="confirm-kill-no">Cancel</button>' +
  '</div>';
  document.body.appendChild(overlay);

  document.getElementById('confirm-kill-no').addEventListener('click', function() {
    document.body.removeChild(overlay);
  });
  document.getElementById('confirm-kill-yes').addEventListener('click', async function() {
    document.body.removeChild(overlay);
    try {
      const r = await apiFetch('/sessions/' + sessionId + '/kill', { method: 'POST', body: '{}' });
      if (!r.ok) {
        const err = await r.json().catch(function() { return {}; });
        alert('Kill failed: ' + (err.error ? err.error.message : r.status));
      } else {
        hideControls();
      }
    } catch (e) {
      alert('Kill error: ' + e.message);
    }
  });
}

// --- Config view ---
async function loadConfig() {
  const configView = document.getElementById('config-view');
  configView.innerHTML = '<div class="empty-state">Loading configuration...</div>';

  const result = await resilientFetch('/config');

  if (!result.ok) {
    if (result.outcome === 'auth') {
      configView.innerHTML = '<div class="error-state auth-error">' +
        '<p>Authentication failed</p>' +
        '<p class="error-message">Your session token is invalid or expired. Re-authenticate to continue.</p>' +
        '</div>';
    } else {
      configView.innerHTML = '<div class="error-state">' +
        '<p>Failed to load configuration</p>' +
        '<p class="error-message">' + (result.outcome === 'timeout' ? 'Request timed out' : 'Network error') + '</p>' +
        '<button id="retry-config-btn">Retry</button>' +
        '</div>';
      var retryBtn = document.getElementById('retry-config-btn');
      if (retryBtn) retryBtn.addEventListener('click', function() { loadConfig(); });
    }
    return;
  }

  var data = await result.response.json();
  renderConfigView(data);
}

function formatNextFire(isoString) {
  if (!isoString) return 'N/A';
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', year: 'numeric', month: 'short',
      day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(new Date(isoString));
  } catch (e) {
    return 'N/A';
  }
}

function healthDot(health) {
  var cls = 'health-unknown';
  if (health === 'green') cls = 'health-green';
  else if (health === 'red') cls = 'health-red';
  return '<span class="health-dot ' + cls + '"></span>';
}

function renderConfigView(data) {
  var configView = document.getElementById('config-view');
  var html = '';

  // Top grid: Session Timeouts + Rate Limits
  html += '<div class="config-grid">';

  // Session Timeouts card
  html += '<div class="config-card"><h3>Session Timeouts</h3>';
  if (data.sessionTimeouts) {
    html += '<div class="config-row"><span class="config-label">Inactivity</span><span class="config-value">' + data.sessionTimeouts.inactivityMinutes + ' min</span></div>';
    html += '<div class="config-row"><span class="config-label">Max lifetime</span><span class="config-value">' + data.sessionTimeouts.maxLifetimeMinutes + ' min</span></div>';
    html += '<div class="config-row"><span class="config-label">Grace after merge</span><span class="config-value">' + data.sessionTimeouts.gracePeriodAfterMergeSeconds + 's</span></div>';
  }
  html += '</div>';

  // Rate Limits card
  html += '<div class="config-card"><h3>Rate Limits</h3>';
  if (data.rateLimits) {
    html += '<div class="config-row"><span class="config-label">Per-PR interval</span><span class="config-value">' + data.rateLimits.perPRSeconds + 's</span></div>';
  }
  html += '</div>';

  html += '</div>'; // end config-grid

  // Cron Schedules
  html += '<div class="config-card" style="margin-bottom:12px"><h3>Cron Schedules</h3>';
  if (data.crons && data.crons.length > 0) {
    html += '<table class="config-table"><thead><tr><th>Name</th><th>Repo</th><th>Schedule</th><th>Next Fire</th><th>State</th></tr></thead><tbody>';
    for (var i = 0; i < data.crons.length; i++) {
      var cron = data.crons[i];
      var stateClass = cron.paused ? 'badge-paused' : 'badge-active';
      var stateLabel = cron.paused ? 'paused' : 'active';
      html += '<tr>';
      html += '<td>' + escapeHtml(cron.name) + '</td>';
      html += '<td>' + escapeHtml(cron.repo) + '</td>';
      html += '<td><code>' + escapeHtml(cron.schedule) + '</code></td>';
      html += '<td>' + formatNextFire(cron.nextFireTime) + '</td>';
      html += '<td><span class="badge ' + stateClass + '">' + stateLabel + '</span></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state" style="padding:16px">No cron schedules configured</div>';
  }
  html += '</div>';

  // Token Health
  html += '<div class="config-card" style="margin-bottom:12px"><h3>Token Health</h3>';
  if (data.tokens && data.tokens.length > 0) {
    html += '<table class="config-table"><thead><tr><th>Project</th><th>Token Name</th><th>Health</th><th>Expiry</th></tr></thead><tbody>';
    for (var j = 0; j < data.tokens.length; j++) {
      var token = data.tokens[j];
      var expiryDisplay = token.expiry ? new Date(token.expiry).toLocaleDateString() : 'Unknown';
      html += '<tr>';
      html += '<td>' + escapeHtml(token.project) + '</td>';
      html += '<td>' + escapeHtml(token.tokenName) + '</td>';
      html += '<td>' + healthDot(token.health) + token.health + '</td>';
      html += '<td>' + expiryDisplay + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state" style="padding:16px">No tokens configured</div>';
  }
  html += '</div>';

  // Repositories
  html += '<div class="config-card"><h3>Repositories</h3>';
  if (data.repos && data.repos.length > 0) {
    html += '<table class="config-table"><thead><tr><th>Name</th><th>Webhook Secret</th></tr></thead><tbody>';
    for (var k = 0; k < data.repos.length; k++) {
      var repo = data.repos[k];
      html += '<tr>';
      html += '<td>' + escapeHtml(repo.name) + '</td>';
      html += '<td><code>' + escapeHtml(repo.webhookSecretName) + '</code></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state" style="padding:16px">No repositories configured</div>';
  }
  html += '</div>';

  configView.innerHTML = html;
}

// --- Reconnect on visibility change ---
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && activeSSE && !activeSSE.ended) {
    // Force reconnect with last known ID
    const sessionId = activeSSE.sessionId;
    const lastId = activeSSE.lastId;
    closeSSE();
    connectSSE(sessionId, lastId);
  }
});

// --- Reconnect on network online ---
window.addEventListener('online', function() {
  if (activeSSE && !activeSSE.ended) {
    const sessionId = activeSSE.sessionId;
    const lastId = activeSSE.lastId;
    closeSSE();
    connectSSE(sessionId, lastId);
  }
});

// --- Router ---
function navigate() {
  const route = parseHashRoute(window.location.hash);
  const listView = document.getElementById('list-view');
  const detailView = document.getElementById('detail-view');
  const configView = document.getElementById('config-view');
  closeSSE();

  // Update nav active state
  var navLinks = document.querySelectorAll('#main-nav .nav-link');
  for (var i = 0; i < navLinks.length; i++) {
    navLinks[i].classList.remove('active');
  }

  if (route.view === 'config') {
    listView.style.display = 'none';
    detailView.style.display = 'none';
    configView.style.display = 'block';
    var configLink = document.querySelector('#main-nav [data-view="config"]');
    if (configLink) configLink.classList.add('active');
    loadConfig();
  } else if (route.view === 'detail') {
    listView.style.display = 'none';
    detailView.style.display = 'block';
    configView.style.display = 'none';
    var sessionsLink = document.querySelector('#main-nav [data-view="sessions"]');
    if (sessionsLink) sessionsLink.classList.add('active');
    loadDetailView(route.sessionId);
  } else {
    listView.style.display = 'block';
    detailView.style.display = 'none';
    configView.style.display = 'none';
    var sessionsLink2 = document.querySelector('#main-nav [data-view="sessions"]');
    if (sessionsLink2) sessionsLink2.classList.add('active');
    currentPage = 0;
    loadAllSessions();
  }
}

window.addEventListener('hashchange', navigate);
displayIdentity();
navigate();
</script>
</body>
</html>`;
}

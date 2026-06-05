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
header{padding:12px 16px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between}
header h1{margin:0;font-size:18px;font-weight:600}
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
</style>
</head>
<body>
<header>
<h1><a href="#/">Agent Router</a></h1>
<span id="identity"></span>
</header>
<main>
<div id="list-view"></div>
<div id="detail-view"></div>
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

// --- State ---
let currentPage = 0;
const PAGE_SIZE = 20;
let sessions = [];

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

function renderSessionItem(session, waitingFor) {
  const badge = statusToBadge(session.status);
  const shortId = session.session_id.slice(0, 8);
  const repoDisplay = session.repo || 'no repo';
  const prLinks = renderPRLinks(session.prs);
  const waitingLine = waitingFor
    ? '<div class="session-waiting">' + waitingFor + '</div>'
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

async function fetchWaitingFor(sessionId) {
  try {
    const resp = await apiFetch('/sessions/' + sessionId + '?lines=1');
    if (!resp.ok) return undefined;
    const data = await resp.json();
    if (data.entries && data.entries.length > 0) {
      return deriveWaitingFor(data.entries[data.entries.length - 1].type);
    }
  } catch (e) {
    // Ignore fetch errors for waiting-for
  }
  return undefined;
}

async function loadAllSessions() {
  const listView = document.getElementById('list-view');
  listView.innerHTML = '<div class="empty-state">Loading sessions...</div>';

  try {
    const resp = await apiFetch('/sessions?limit=500');
    if (!resp.ok) {
      listView.innerHTML = '<div class="empty-state">Failed to load sessions</div>';
      return;
    }
    sessions = await resp.json();
  } catch (e) {
    listView.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
    return;
  }

  renderList();
}

async function renderList() {
  const listView = document.getElementById('list-view');
  const start = currentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const page = sessions.slice(start, end);

  if (sessions.length === 0) {
    listView.innerHTML = '<div class="empty-state">No sessions found</div>';
    return;
  }

  // Fetch waiting-for for active sessions in parallel
  const waitingForMap = new Map();
  const activePromises = page
    .filter(function(s) { return s.status === 'active'; })
    .map(async function(s) {
      const wf = await fetchWaitingFor(s.session_id);
      if (wf) waitingForMap.set(s.session_id, wf);
    });
  await Promise.all(activePromises);

  let html = '';
  for (const session of page) {
    html += renderSessionItem(session, waitingForMap.get(session.session_id));
  }

  // Pagination controls
  const totalPages = Math.ceil(sessions.length / PAGE_SIZE);
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
  if (prevBtn) prevBtn.addEventListener('click', function() { currentPage--; renderList(); });
  if (nextBtn) nextBtn.addEventListener('click', function() { currentPage++; renderList(); });
}

// --- Detail view ---
let activeSSE = null; // { eventSource, sessionId, reconnectTimer, attempt, lastId }

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
  activeSSE = { eventSource: { close: function() { controller.abort(); } }, sessionId: sessionId, reconnectTimer: null, attempt: 0, lastId: lastId };

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
            if (!isNaN(id)) activeSSE.lastId = trackLastEventId(activeSSE.lastId, id);
            appendLogEntry(currentData);
            if (currentEvent === 'session_ended') {
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

  try {
    const resp = await apiFetch('/sessions/' + sessionId + '?lines=200');
    if (!resp.ok) {
      detailView.innerHTML = '<a href="#/" class="btn btn-back">&larr; Back</a><div class="empty-state">Session not found</div>';
      return;
    }
    const data = await resp.json();
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

  } catch (e) {
    detailView.innerHTML = '<a href="#/" class="btn btn-back">&larr; Back</a><div class="empty-state">Error: ' + e.message + '</div>';
  }
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

// --- Reconnect on visibility change ---
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && activeSSE) {
    // Force reconnect with last known ID
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
  closeSSE();
  if (route.view === 'detail') {
    listView.style.display = 'none';
    detailView.style.display = 'block';
    loadDetailView(route.sessionId);
  } else {
    listView.style.display = 'block';
    detailView.style.display = 'none';
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

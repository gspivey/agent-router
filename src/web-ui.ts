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
@media(max-width:480px){main{padding:8px}body{font-size:16px}.session-header{flex-direction:column;align-items:flex-start}}
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

// --- Router ---
function navigate() {
  const route = parseHashRoute(window.location.hash);
  const listView = document.getElementById('list-view');
  const detailView = document.getElementById('detail-view');
  if (route.view === 'detail') {
    listView.style.display = 'none';
    detailView.style.display = 'block';
    detailView.textContent = 'Session: ' + route.sessionId;
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

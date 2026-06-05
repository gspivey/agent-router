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
button,a.btn{min-width:44px;min-height:44px;padding:8px 16px;border:none;border-radius:6px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
@media(max-width:480px){main{padding:8px}body{font-size:16px}}
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
    listView.textContent = 'Loading sessions...';
  }
}

window.addEventListener('hashchange', navigate);
navigate();
</script>
</body>
</html>`;
}

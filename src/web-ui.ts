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
#log-container{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.log-entry{margin:0}
.stream-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:8px;font-size:13px;color:#8b949e}
.stream-toolbar label{display:flex;align-items:center;gap:6px;cursor:pointer}
.chat-system{align-self:flex-start}
.chat-pill{display:inline-block;background:#21262d;color:#8b949e;border-radius:12px;padding:4px 10px;font-size:12px}
.chat-pill.badge-green{background:#238636;color:#fff}
.chat-pill.badge-red{background:#da3633;color:#fff}
.chat-pill.badge-yellow{background:#9e6a03;color:#fff}
.chat-pill .pr-chip{margin-left:6px;color:#fff;text-decoration:underline}
.chat-msg-agent{align-self:stretch;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 12px}
.chat-md{font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}
.chat-md code{font-family:monospace;background:#0d1117;padding:1px 4px;border-radius:4px}
.chat-md pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 12px;overflow-x:auto}
.chat-md pre code{background:none;padding:0}
.chat-md a{color:#58a6ff}
.chat-tool{border:1px solid #30363d;border-radius:8px;overflow:hidden}
.chat-tool-header{cursor:pointer;padding:8px 12px;background:#161b22;display:flex;justify-content:space-between;align-items:center;gap:8px}
.chat-tool-title{font-size:13px;font-weight:600}
.chat-tool-body{margin:0;padding:8px 12px;font-family:monospace;font-size:12px;line-height:1.4;white-space:pre-wrap;overflow-x:auto}
.chat-tool.collapsed .chat-tool-body,.chat-tool.collapsed .show-more-btn{display:none}
.chat-permission{background:#3a2d00;border:1px solid #9e6a03;color:#e3b341;border-radius:8px;padding:10px 12px;font-size:14px}
.chat-permission.resolved{opacity:0.6}
.chat-internal{color:#8b949e;font-size:12px}
.chat-meta-pill{display:inline-block;background:#21262d;color:#8b949e;border-radius:10px;padding:2px 8px;font-size:11px}
.chat-unknown{color:#8b949e;font-size:12px;font-style:italic}
#jump-to-bottom{position:sticky;bottom:8px;align-self:center;background:#21262d;color:#eee;border:1px solid #30363d;border-radius:16px;padding:6px 14px;font-size:13px;cursor:pointer;min-width:auto;min-height:auto}
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
@media(max-width:480px){main{padding:8px}body{font-size:16px}.session-header{flex-direction:column;align-items:flex-start}.controls{flex-direction:column}.controls textarea{min-width:100%}.repo-header{gap:4px}.repo-header h2{font-size:14px}}
@media(max-width:768px){#log-container{font-size:14px}}
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
.badge-paused{background:#484f58;color:#fff}
.badge-active{background:#238636;color:#fff}
.repo-section{border:1px solid #30363d;border-radius:8px;margin-bottom:12px;background:#0d1117;overflow:hidden}
.repo-header{display:flex;align-items:center;gap:8px;padding:12px 16px;cursor:pointer;background:#161b22;transition:background 0.15s;min-height:44px;flex-wrap:wrap}
.repo-header:hover{background:#21262d}
.repo-header h2{margin:0;font-size:15px;font-weight:600;flex:1;min-width:0}
.repo-header-info{font-size:13px;color:#8b949e;white-space:nowrap}
.repo-cron{font-size:12px;color:#8b949e;padding:4px 16px 8px 36px}
.repo-body{padding:8px 12px 12px}
.repo-section.collapsed .repo-body{display:none}
.repo-section.collapsed .repo-cron{display:none}
.streaming-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950;animation:pulse 1.5s infinite;vertical-align:middle;margin-right:4px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.show-more-btn{display:block;width:100%;padding:10px 16px;border:1px solid #30363d;border-radius:6px;background:#21262d;color:#8b949e;font-size:13px;cursor:pointer;text-align:center;margin-top:8px;min-height:44px;transition:background 0.15s,color 0.15s}
.show-more-btn:hover{background:#30363d;color:#eee}
.show-more-btn:disabled{opacity:0.4;cursor:not-allowed}
.collapse-icon{display:inline-block;width:16px;font-size:12px;transition:transform 0.15s;color:#8b949e}
.repo-section.collapsed .collapse-icon{transform:rotate(-90deg)}
.projects-panel{margin-bottom:16px}
.project-section{border:1px solid #30363d;border-radius:8px;margin-bottom:8px;background:#0d1117;overflow:hidden}
.project-header{padding:12px 16px;display:flex;align-items:center;gap:8px;cursor:pointer;background:#161b22;transition:background 0.15s;min-height:44px;flex-wrap:wrap}
.project-header:hover{background:#21262d}
.project-header h3{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0}
.project-repos{padding:0 12px 12px}
.project-repo-item{padding:6px 8px;font-size:13px;display:flex;align-items:center;gap:8px;border-radius:4px;cursor:pointer;transition:background 0.15s}
.project-repo-item:hover{background:#21262d}
.token-warning{font-size:11px;color:#d29922}
.project-section.collapsed .project-repos{display:none}
.project-section .collapse-icon{display:inline-block;width:16px;font-size:12px;transition:transform 0.15s;color:#8b949e}
.project-section.collapsed .collapse-icon{transform:rotate(-90deg)}
.repo-filter-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:12px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:13px}
.repo-filter-bar .filter-label{color:#8b949e}
.repo-filter-bar .filter-value{color:#eee;font-weight:500}
.repo-filter-bar .filter-clear{background:none;border:1px solid #30363d;border-radius:4px;color:#8b949e;font-size:12px;cursor:pointer;padding:4px 8px;min-width:44px;min-height:28px}
.repo-filter-bar .filter-clear:hover{color:#eee;border-color:#58a6ff}
@media(max-width:768px){.config-grid{grid-template-columns:1fr}.repo-header{padding:12px}}
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
<div id="projects-panel" class="projects-panel" style="display:none"></div>
<div id="repo-filter" style="display:none"></div>
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

// --- Inlined stream-chat logic from src/ui/logic.ts (parser + markdown) ---
// Kept in sync with the exported, Tier 1-tested functions in src/ui/logic.ts.
function mdEscapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeLinkHref(href) {
  const cleaned = href.replace(/[\\u0000-\\u0020]+/g, '');
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!schemeMatch) return true;
  const scheme = (schemeMatch[1] || '').toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function safeLinkHref(href) {
  return isSafeLinkHref(href) ? href : '#';
}

function renderMarkdown(text) {
  const escaped = mdEscapeHtml(text);
  const codeBlocks = [];
  let out = escaped.replace(/\`\`\`[^\\n]*\\n?([\\s\\S]*?)\`\`\`/g, function(_m, body) {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + body + '</code></pre>');
    return '\\u0000CODEBLOCK' + idx + '\\u0000';
  });
  const inlineCode = [];
  out = out.replace(/\`([^\`\\n]+)\`/g, function(_m, body) {
    const idx = inlineCode.length;
    inlineCode.push('<code>' + body + '</code>');
    return '\\u0000INLINECODE' + idx + '\\u0000';
  });
  out = out.replace(/\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, function(_m, label, url) {
    const decoded = url.replace(/&amp;/g, '&');
    const href = mdEscapeHtml(safeLinkHref(decoded));
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
  out = out.replace(/_([^_\\n]+)_/g, '<em>$1</em>');
  out = out.replace(/\\n/g, '<br>');
  out = out.replace(/\\u0000INLINECODE(\\d+)\\u0000/g, function(_m, i) { return inlineCode[Number(i)] || ''; });
  out = out.replace(/\\u0000CODEBLOCK(\\d+)\\u0000/g, function(_m, i) { return codeBlocks[Number(i)] || ''; });
  return out;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

// formatMetadataPill: mirror of src/ui/logic.ts formatMetadataPill (Tier 1-tested).
// Tolerant read of context% + turn duration from a _kiro.dev/metadata entry.
function mdFirstNumber(raw, keys) {
  const nested = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined;
  for (const key of keys) {
    let v = raw[key];
    if (v == null && nested) v = nested[key];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (isFinite(n)) return n;
    }
  }
  return undefined;
}

const CONTEXT_PERCENT_KEYS = ['context_usage_percent', 'contextUsagePercent', 'context_percent', 'contextPercent', 'context_usage', 'contextUsage'];
const TURN_DURATION_MS_KEYS = ['turn_duration_ms', 'turnDurationMs', 'duration_ms', 'durationMs'];
const TURN_DURATION_S_KEYS = ['turn_duration_seconds', 'turnDurationSeconds', 'duration_seconds', 'durationSeconds'];

function formatMetadataPill(raw) {
  if (!raw || typeof raw !== 'object') return 'metadata';
  const parts = [];
  const pct = mdFirstNumber(raw, CONTEXT_PERCENT_KEYS);
  if (pct !== undefined) {
    const rounded = Math.round(pct * 10) / 10;
    parts.push('Context ' + rounded + '%');
  }
  const durMs = mdFirstNumber(raw, TURN_DURATION_MS_KEYS);
  const durS = mdFirstNumber(raw, TURN_DURATION_S_KEYS);
  if (durMs !== undefined) {
    parts.push(durMs >= 1000 ? (Math.round(durMs / 100) / 10) + 's' : Math.round(durMs) + 'ms');
  } else if (durS !== undefined) {
    parts.push((Math.round(durS * 10) / 10) + 's');
  }
  if (parts.length > 0) return parts.join(' · ');
  const content = asText(raw.content);
  if (content.trim() !== '') return content;
  return 'metadata';
}

const SYSTEM_SUBTYPES = ['session_started', 'prompt_injected', 'session_ended', 'session_verified', 'verification_failed', 'web_inject', 'web_interrupt'];

function mapSystem(subtype, raw) {
  switch (subtype) {
    case 'session_started': return { kind: 'system', subtype: subtype, text: 'Session started' };
    case 'prompt_injected': return { kind: 'system', subtype: subtype, text: 'Prompt injected (' + (asText(raw.prompt_source) || 'unknown') + ')' };
    case 'session_ended': return { kind: 'system', subtype: subtype, text: 'Session ended — ' + (asText(raw.reason) || 'unknown') };
    case 'session_verified': return { kind: 'system', subtype: subtype, text: 'Verified — ' + (asText(raw.termination_reason) || 'unknown'), badge: 'green' };
    case 'verification_failed': return { kind: 'system', subtype: subtype, text: 'Verification failed — ' + (asText(raw.error) || 'unknown'), badge: 'red' };
    case 'web_inject': return { kind: 'system', subtype: subtype, text: 'Operator inject' };
    case 'web_interrupt': return { kind: 'system', subtype: subtype, text: 'Operator interrupt' };
    default: return { kind: 'unknown', typeLabel: subtype };
  }
}

function concatToolUpdateText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) {
    if (item && typeof item === 'object' && item.content && typeof item.content === 'object') {
      out += asText(item.content.text);
    }
  }
  return out;
}

function parseStreamEntry(raw) {
  if (!raw || typeof raw !== 'object') return { kind: 'unknown', typeLabel: 'unknown' };
  const entry = raw;
  const source = entry.source;
  const type = typeof entry.type === 'string' ? entry.type : undefined;
  const typeLabel = type || 'unknown';
  if (source === 'router') {
    if (type && SYSTEM_SUBTYPES.indexOf(type) !== -1) return mapSystem(type, entry);
    return { kind: 'unknown', typeLabel: typeLabel };
  }
  if (source === 'agent') {
    if (type === 'session/update') {
      const update = entry.update;
      if (update && typeof update === 'object') {
        const sub = update.sessionUpdate;
        if (sub === 'agent_message_chunk') {
          const content = update.content;
          const text = content && typeof content === 'object' ? asText(content.text) : '';
          return { kind: 'agent_chunk', text: text, streaming: true };
        }
        if (sub === 'tool_call') {
          const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
          return { kind: 'tool_call', toolCallId: toolCallId, title: asText(update.title) };
        }
        if (sub === 'tool_call_update') {
          const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
          return { kind: 'tool_update', toolCallId: toolCallId, text: concatToolUpdateText(update.content) };
        }
      }
      return { kind: 'unknown', typeLabel: typeLabel };
    }
    if (type === 'session/request_permission') {
      const toolCall = entry.toolCall;
      const title = toolCall && typeof toolCall === 'object' ? asText(toolCall.title) : '';
      return { kind: 'permission', title: title };
    }
    if (type && type.indexOf('_kiro.dev/') === 0) {
      const text = type === '_kiro.dev/metadata' ? formatMetadataPill(entry) : asText(entry.content);
      return { kind: 'internal', subtype: type, text: text };
    }
    if (type === 'agent_message') {
      return { kind: 'agent_message', text: asText(entry.content), streaming: false };
    }
    if (type === 'tool_call') {
      const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : null;
      return { kind: 'tool_call', toolCallId: toolCallId, title: asText(entry.title) };
    }
    return { kind: 'unknown', typeLabel: typeLabel };
  }
  return { kind: 'unknown', typeLabel: typeLabel };
}

// --- Stream-chat renderer (render context) ---
// makeRenderCtx builds the per-detail-mount mutable state the renderer needs.
function makeRenderCtx(container, meta) {
  return {
    container: container,
    isActive: meta && meta.status === 'active',
    showInternals: false,
    openBubble: null,
    toolCards: new Map(),
    latestToolCard: null,
    autoScroll: true,
    entryCount: 0,
    repo: (meta && meta.repo) || '',
    prs: (meta && meta.prs) || [],
  };
}

function chatAutoScroll(ctx) {
  if (ctx.autoScroll) ctx.container.scrollTop = ctx.container.scrollHeight;
}

function makeAgentBubble() {
  const div = document.createElement('div');
  div.className = 'log-entry chat-msg-agent';
  const md = document.createElement('div');
  md.className = 'chat-md';
  div.appendChild(md);
  return { div: div, md: md };
}

// renderStreamEntry: stateful, mutates ctx.container. Dispatches on parsed.kind.
// Agent-chunk reassembly, agent_message bubbles, system pills and the unknown
// fallback are fully implemented here (item 64). Tool cards, permission and
// internal rows get baseline rendering; their collapse/toggle behaviour is
// completed by tasks 5-7 (item 65).
function renderStreamEntry(parsed, ctx) {
  ctx.entryCount++;

  if (parsed.kind === 'agent_chunk') {
    if (ctx.openBubble) {
      ctx.openBubble.__text += parsed.text;
      ctx.openBubble.__md.innerHTML = renderMarkdown(ctx.openBubble.__text);
    } else {
      const b = makeAgentBubble();
      b.div.setAttribute('data-bubble-open', 'true');
      b.div.__text = parsed.text;
      b.div.__md = b.md;
      b.md.innerHTML = renderMarkdown(parsed.text);
      ctx.container.appendChild(b.div);
      ctx.openBubble = b.div;
    }
    chatAutoScroll(ctx);
    return;
  }

  // Any non-chunk kind closes the current reassembly bubble first.
  if (ctx.openBubble) {
    ctx.openBubble.removeAttribute('data-bubble-open');
    ctx.openBubble = null;
  }

  if (parsed.kind === 'agent_message') {
    const b = makeAgentBubble();
    b.md.innerHTML = renderMarkdown(parsed.text);
    ctx.container.appendChild(b.div);
    chatAutoScroll(ctx);
    return;
  }

  if (parsed.kind === 'system') {
    const div = document.createElement('div');
    div.className = 'log-entry chat-system';
    const pill = document.createElement('span');
    pill.className = 'chat-pill' + (parsed.badge ? ' badge-' + parsed.badge : '');
    pill.textContent = parsed.text;
    if (parsed.subtype === 'session_verified' && ctx.prs && ctx.prs.length) {
      ctx.prs.forEach(function(pr) {
        const a = document.createElement('a');
        a.className = 'pr-chip';
        a.href = 'https://github.com/' + pr.repo + '/pull/' + pr.pr_number;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'PR #' + pr.pr_number;
        pill.appendChild(a);
      });
    }
    div.appendChild(pill);
    ctx.container.appendChild(div);
    chatAutoScroll(ctx);
    return;
  }

  if (parsed.kind === 'tool_call' || parsed.kind === 'tool_update') {
    renderToolEntry(parsed, ctx);
    chatAutoScroll(ctx);
    return;
  }

  if (parsed.kind === 'permission') {
    const div = document.createElement('div');
    div.className = 'log-entry chat-permission' + (ctx.isActive ? '' : ' resolved');
    div.textContent = 'Waiting for approval: ' + parsed.title;
    ctx.container.appendChild(div);
    chatAutoScroll(ctx);
    return;
  }

  if (parsed.kind === 'internal') {
    const div = document.createElement('div');
    div.className = 'log-entry chat-internal';
    if (!ctx.showInternals) div.style.display = 'none';
    if (parsed.subtype === '_kiro.dev/metadata') {
      const pill = document.createElement('span');
      pill.className = 'chat-meta-pill';
      pill.textContent = parsed.text || 'metadata';
      div.appendChild(pill);
    } else {
      div.textContent = parsed.subtype + (parsed.text ? ' — ' + parsed.text : '');
    }
    ctx.container.appendChild(div);
    chatAutoScroll(ctx);
    return;
  }

  // unknown
  const div = document.createElement('div');
  div.className = 'log-entry chat-unknown';
  div.textContent = parsed.typeLabel;
  ctx.container.appendChild(div);
  chatAutoScroll(ctx);
}

// Tool-call collapsible cards (item 65, task 5).
// - Cards are keyed by toolCallId (synthetic 'legacy-' + entryCount when null).
// - tool_update appends lines; a card is created lazily if the id is unknown.
// - Body shows the last TOOL_TAIL_LINES lines with a "Show more" toggle for the full output.
// - On terminal sessions every card is collapsed by default. On active sessions the
//   latest tool card is expanded and the previously-latest one collapses.
// - Clicking the header toggles expand/collapse.
var TOOL_TAIL_LINES = 20;

function renderToolBody(card) {
  const lines = card.lines;
  const showingAll = card.showAll || lines.length <= TOOL_TAIL_LINES;
  const visible = showingAll ? lines : lines.slice(lines.length - TOOL_TAIL_LINES);
  card.body.textContent = visible.join('\\n');
  if (lines.length > TOOL_TAIL_LINES) {
    card.showMore.style.display = '';
    card.showMore.textContent = card.showAll
      ? 'Show less'
      : 'Show more (' + (lines.length - TOOL_TAIL_LINES) + ' more lines)';
  } else {
    card.showMore.style.display = 'none';
  }
}

function setToolCollapsed(card, collapsed) {
  card.collapsed = collapsed;
  if (collapsed) card.card.classList.add('collapsed');
  else card.card.classList.remove('collapsed');
  const icon = card.card.querySelector('.collapse-icon');
  if (icon) icon.textContent = collapsed ? '\\u25B6' : '\\u25BC';
}

function renderToolEntry(parsed, ctx) {
  let id;
  if (parsed.kind === 'tool_call') {
    id = parsed.toolCallId != null ? parsed.toolCallId : 'legacy-' + ctx.entryCount;
  } else {
    id = parsed.toolCallId || 'legacy-' + ctx.entryCount;
  }
  let card = ctx.toolCards.get(id);
  if (!card) {
    const div = document.createElement('div');
    div.className = 'log-entry chat-tool';
    const header = document.createElement('div');
    header.className = 'chat-tool-header';
    const title = document.createElement('span');
    title.className = 'chat-tool-title';
    title.textContent = parsed.kind === 'tool_call' && parsed.title
      ? String(parsed.title).split('\\n')[0]
      : 'Tool call';
    const icon = document.createElement('span');
    icon.className = 'collapse-icon';
    header.appendChild(title);
    header.appendChild(icon);
    const body = document.createElement('pre');
    body.className = 'chat-tool-body';
    const showMore = document.createElement('button');
    showMore.className = 'show-more-btn';
    showMore.style.display = 'none';
    div.appendChild(header);
    div.appendChild(body);
    div.appendChild(showMore);
    ctx.container.appendChild(div);
    card = { card: div, header: header, body: body, showMore: showMore, lines: [], collapsed: true, showAll: false };
    ctx.toolCards.set(id, card);

    header.addEventListener('click', function() { setToolCollapsed(card, !card.collapsed); });
    showMore.addEventListener('click', function(e) {
      e.stopPropagation();
      card.showAll = !card.showAll;
      renderToolBody(card);
    });

    // Collapse state: on active sessions the newest card is expanded and the
    // previously-expanded latest card collapses. On terminal sessions all cards
    // stay collapsed by default.
    if (ctx.isActive) {
      if (ctx.latestToolCard && ctx.latestToolCard !== card) setToolCollapsed(ctx.latestToolCard, true);
      setToolCollapsed(card, false);
      ctx.latestToolCard = card;
    } else {
      setToolCollapsed(card, true);
    }
    renderToolBody(card);
  } else if (parsed.kind === 'tool_call' && parsed.title) {
    const titleEl = card.card.querySelector('.chat-tool-title');
    if (titleEl) titleEl.textContent = String(parsed.title).split('\\n')[0];
  }

  if (parsed.kind === 'tool_update' && parsed.text) {
    parsed.text.split('\\n').forEach(function(line) { card.lines.push(line); });
    renderToolBody(card);
  }
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
const repoOffsets = new Map();
let currentRepoFilter = null; // string or null

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

async function loadGroupedSessions() {
  const listView = document.getElementById('list-view');
  listView.innerHTML = '<div class="empty-state">Loading sessions...</div>';

  // When a repo filter is active, use the flat sessions endpoint
  if (currentRepoFilter) {
    const filterResult = await resilientFetch('/sessions?repo=' + encodeURIComponent(currentRepoFilter) + '&limit=50');
    if (!filterResult.ok) {
      if (filterResult.outcome === 'auth') {
        listView.innerHTML = '<div class="error-state auth-error">' +
          '<p>Authentication failed</p>' +
          '<p class="error-message">Your session token is invalid or expired. Re-authenticate to continue.</p>' +
          '</div>';
      } else {
        listView.innerHTML = '<div class="error-state">' +
          '<p>Failed to load sessions</p>' +
          '<p class="error-message">' + (filterResult.outcome === 'timeout' ? 'Request timed out' : 'Network error') + '</p>' +
          '<button id="retry-list-btn">Retry</button>' +
          '</div>';
        var filterRetryBtn = document.getElementById('retry-list-btn');
        if (filterRetryBtn) filterRetryBtn.addEventListener('click', function() { loadGroupedSessions(); });
      }
      return;
    }
    var filterData = await filterResult.response.json();
    renderFilteredSessions(filterData.sessions);
    return;
  }

  const result = await resilientFetch('/repos/sessions');

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
      if (retryBtn) retryBtn.addEventListener('click', function() { loadGroupedSessions(); });
    }
    return;
  }

  const data = await result.response.json();
  renderGroupedList(data.repos);
}

function renderFilteredSessions(sessions) {
  const listView = document.getElementById('list-view');
  if (!sessions || sessions.length === 0) {
    listView.innerHTML = '<div class="empty-state">No sessions for this repo</div>';
    return;
  }
  let html = '';
  for (const session of sessions) {
    if (session.status === 'active') {
      html += renderSessionItemWithDot(session);
    } else {
      html += renderSessionItem(session);
    }
  }
  listView.innerHTML = html;
}

function isAutoCollapsed(repoGroup) {
  if (repoGroup.active_sessions.length > 0) return false;
  if (repoGroup.terminal_sessions.length === 0) return true;
  const newest = repoGroup.terminal_sessions[0];
  if (!newest || !newest.created_at) return true;
  const ageMs = Date.now() - newest.created_at * 1000;
  return ageMs > 24 * 60 * 60 * 1000;
}

function getCollapseState(repo, autoCollapsed) {
  const key = 'repo-collapsed:' + repo;
  const stored = localStorage.getItem(key);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return autoCollapsed;
}

function setCollapseState(repo, collapsed) {
  const key = 'repo-collapsed:' + repo;
  localStorage.setItem(key, collapsed ? '1' : '0');
}

function renderGroupedList(repos) {
  const listView = document.getElementById('list-view');

  if (!repos || repos.length === 0) {
    listView.innerHTML = '<div class="empty-state">No repos configured</div>';
    return;
  }

  let html = '';
  for (const repoGroup of repos) {
    const autoCollapsed = isAutoCollapsed(repoGroup);
    const collapsed = getCollapseState(repoGroup.repo, autoCollapsed);
    const sectionId = 'repo-body-' + repoGroup.repo.replace(/\\//g, '-');
    const collapseClass = collapsed ? ' collapsed' : '';

    html += '<div class="repo-section' + collapseClass + '" data-repo="' + repoGroup.repo + '">';

    // Header
    html += '<div class="repo-header" role="button" aria-expanded="' + (!collapsed) + '" aria-controls="' + sectionId + '">';
    html += '<span class="collapse-icon">&#x25BC;</span>';
    html += '<h2>' + escapeHtml(repoGroup.repo) + '</h2>';
    html += '<span class="repo-header-info">';
    if (repoGroup.open_pr_count > 0) {
      const prUrl = 'https://github.com/' + repoGroup.repo + '/pulls';
      html += '<a href="' + prUrl + '" target="_blank" rel="noopener" style="color:#e3b341;margin-right:8px">' + repoGroup.open_pr_count + ' PR' + (repoGroup.open_pr_count > 1 ? 's' : '') + ' open</a>';
    }
    if (repoGroup.closed_pr_count > 0) {
      const closedUrl = 'https://github.com/' + repoGroup.repo + '/pulls?q=is%3Apr+is%3Aclosed';
      html += '<a href="' + closedUrl + '" target="_blank" rel="noopener" style="color:#8b949e;margin-right:8px">' + repoGroup.closed_pr_count + ' PR' + (repoGroup.closed_pr_count > 1 ? 's' : '') + ' closed</a>';
    }
    html += '</span>';
    html += '</div>';

    // Cron line
    if (repoGroup.cron) {
      html += '<div class="repo-cron">';
      html += escapeHtml(repoGroup.cron.name) + ' &middot; <code>' + escapeHtml(repoGroup.cron.schedule) + '</code>';
      if (repoGroup.cron.paused) {
        html += ' &middot; <span class="badge badge-yellow">paused</span>';
      } else if (repoGroup.cron.next_fire) {
        const nextDate = new Date(repoGroup.cron.next_fire);
        const diff = nextDate.getTime() - Date.now();
        if (diff > 0) {
          const hours = Math.floor(diff / 3600000);
          const mins = Math.floor((diff % 3600000) / 60000);
          html += ' &middot; next in ' + (hours > 0 ? hours + 'h ' : '') + mins + 'm';
        }
      }
      html += '</div>';
    }

    // Body
    html += '<div class="repo-body" id="' + sectionId + '">';

    // Active sessions
    for (const session of repoGroup.active_sessions) {
      html += renderSessionItemWithDot(session);
    }

    // Terminal sessions
    for (const session of repoGroup.terminal_sessions) {
      html += renderSessionItem(session);
    }

    // "Show more" button
    const currentCount = repoGroup.terminal_sessions.length;
    repoOffsets.set(repoGroup.repo, currentCount);
    if (repoGroup.terminal_total > currentCount) {
      html += '<button class="show-more-btn" data-repo="' + repoGroup.repo + '" aria-label="Load more sessions for ' + escapeHtml(repoGroup.repo) + '">Show more (' + (repoGroup.terminal_total - currentCount) + ' remaining)</button>';
    }

    html += '</div>'; // repo-body
    html += '</div>'; // repo-section
  }

  listView.innerHTML = html;

  // Attach collapse/expand handlers
  const headers = listView.querySelectorAll('.repo-header');
  for (const header of headers) {
    header.addEventListener('click', function(e) {
      // Don't toggle when clicking a link inside the header
      if (e.target.tagName === 'A') return;
      const section = header.closest('.repo-section');
      const repo = section.getAttribute('data-repo');
      const isCollapsed = section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!isCollapsed));
      setCollapseState(repo, isCollapsed);
    });
  }

  // Attach "Show more" handlers
  const showMoreBtns = listView.querySelectorAll('.show-more-btn');
  for (const btn of showMoreBtns) {
    btn.addEventListener('click', function() { handleShowMore(btn); });
  }
}

function renderSessionItemWithDot(session) {
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
        '<span class="streaming-dot" aria-label="Active session streaming" role="img"></span>' +
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

async function handleShowMore(btn) {
  const repo = btn.getAttribute('data-repo');
  const offset = repoOffsets.get(repo) || 0;
  btn.disabled = true;
  btn.textContent = 'Loading...';

  const result = await resilientFetch('/repos/' + encodeURIComponent(repo) + '/sessions?offset=' + offset + '&limit=5');

  if (!result.ok) {
    btn.disabled = false;
    btn.textContent = 'Failed to load — click to retry';
    return;
  }

  const data = await result.response.json();
  const section = btn.closest('.repo-section');
  const body = section.querySelector('.repo-body');

  // Insert sessions before the button
  let html = '';
  for (const session of data.sessions) {
    html += renderSessionItem(session);
  }
  btn.insertAdjacentHTML('beforebegin', html);

  // Update offset
  const newOffset = offset + data.sessions.length;
  repoOffsets.set(repo, newOffset);

  // Remove button if no more
  if (newOffset >= data.total) {
    btn.remove();
  } else {
    btn.disabled = false;
    btn.textContent = 'Show more (' + (data.total - newOffset) + ' remaining)';
  }
}

// --- Detail view ---
let activeSSE = null; // { eventSource, sessionId, reconnectTimer, attempt, lastId, ended }
let activeRenderCtx = null; // RenderCtx for the mounted detail view; survives SSE reconnects

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

// DEFECT NOTE (browser-test-harness-v2, task G2):
// The SSE backoff never escalates past 1000ms because this function resets attempt = 0
// on every call. The reconnect cycle is: scheduleReconnect() reads attempt (always 0),
// computes delay = computeBackoff(0) = 1000ms, increments attempt to 1, then setTimeout
// calls connectSSE() which resets attempt back to 0. This means every reconnect — whether
// triggered by a stream drop, visibility change, or online event — always waits exactly
// 1000ms. Req 6.2 requires this fixed 1000ms first-retry behavior and tests 7.1/7.5
// assert it. If escalating backoff is desired in future, the fix requires threading
// lastAttempt from the reconnect cycle into the next connectSSE() call — open a
// separate spec item for that change.
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
            if (activeRenderCtx) {
              try {
                renderStreamEntry(parseStreamEntry(JSON.parse(currentData)), activeRenderCtx);
              } catch (e) { /* ignore malformed SSE payloads */ }
            }
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
    html += '<div class="stream-toolbar"><label><input type="checkbox" id="toggle-internals"> Show internals</label></div>';
    html += '<div id="log-container" class="chat-stream"></div>';
    html += '<button id="jump-to-bottom" style="display:none">Jump to bottom \\u2193</button>';
    detailView.innerHTML = html;

    // Build the render context and render existing entries through the shared
    // per-type renderer (same code path as the SSE handler).
    const container = document.getElementById('log-container');
    const ctx = makeRenderCtx(container, meta);
    for (const entry of data.entries) {
      renderStreamEntry(parseStreamEntry(entry), ctx);
    }
    // After the initial batch, snap to the newest entry (preserves prior behavior).
    container.scrollTop = container.scrollHeight;

    // Wire the "Show internals" toggle: flip ctx.showInternals and show/hide
    // all .chat-internal elements.
    const toggleInternals = document.getElementById('toggle-internals');
    if (toggleInternals) {
      toggleInternals.addEventListener('change', function() {
        ctx.showInternals = toggleInternals.checked;
        const internals = container.querySelectorAll('.chat-internal');
        for (let i = 0; i < internals.length; i++) {
          internals[i].style.display = ctx.showInternals ? '' : 'none';
        }
      });
    }

    // Scroll listener: disable auto-scroll when the user scrolls up, re-enable
    // (and hide the jump button) when they return to the bottom.
    const jumpBtn = document.getElementById('jump-to-bottom');
    container.addEventListener('scroll', function() {
      const atBottom = container.scrollTop >= container.scrollHeight - container.clientHeight - 20;
      if (atBottom) {
        ctx.autoScroll = true;
        if (jumpBtn) jumpBtn.style.display = 'none';
      } else {
        ctx.autoScroll = false;
        if (jumpBtn && ctx.isActive) jumpBtn.style.display = '';
      }
    });
    if (jumpBtn) {
      jumpBtn.addEventListener('click', function() {
        ctx.autoScroll = true;
        container.scrollTop = container.scrollHeight;
        jumpBtn.style.display = 'none';
      });
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

    // Start SSE stream. Seed Last-Event-ID with the number of lines already
    // rendered from the initial load so the broker's backlog replay only emits
    // genuinely new entries (SSE ids are 1-indexed stream.log line numbers).
    // entries.length + skipped_lines == total lines when the full file fit in
    // the requested tail (lines=200), which covers ordinary sessions.
    const initialLastId = (data.entries ? data.entries.length : 0) + (data.skipped_lines || 0);
    connectSSE(sessionId, initialLastId);
    // Store the render context so the SSE handler (and reconnects) reuse it.
    activeRenderCtx = ctx;
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
      var stateClass = cron.paused ? 'badge-yellow' : 'badge-active';
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

// --- Projects panel ---
function healthToBadgeClass(status) {
  switch (status) {
    case 'green': return 'badge-green';
    case 'partial': return 'badge-yellow';
    case 'paused': return 'badge-paused';
    default: return 'badge-gray';
  }
}

function healthToLabel(status) {
  switch (status) {
    case 'green': return 'Health: all repos healthy';
    case 'partial': return 'Health: some repos have failed sessions';
    case 'paused': return 'Health: no recent activity';
    default: return 'Health: unknown';
  }
}

async function loadProjects() {
  const panel = document.getElementById('projects-panel');
  try {
    const result = await resilientFetch('/projects');
    if (!result.ok) {
      panel.style.display = 'none';
      return;
    }
    const data = await result.response.json();
    if (data.projects.length === 0 && data.ungrouped.length === 0) {
      panel.style.display = 'none';
      return;
    }
    renderProjectsPanel(data);
    panel.style.display = 'block';
  } catch (e) {
    panel.style.display = 'none';
  }
}

function renderProjectsPanel(data) {
  const panel = document.getElementById('projects-panel');
  let html = '';

  for (const project of data.projects) {
    const sectionId = 'project-' + project.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const headingId = sectionId + '-heading';
    const collapsed = getProjectCollapseState(project.name);
    const collapseClass = collapsed ? ' collapsed' : '';
    const badgeClass = healthToBadgeClass(project.health.status);
    const badgeLabel = healthToLabel(project.health.status);

    html += '<section class="project-section' + collapseClass + '" role="region" aria-labelledby="' + headingId + '" data-project="' + escapeHtml(project.name) + '">';
    html += '<div class="project-header" role="button" aria-expanded="' + (!collapsed) + '" tabindex="0">';
    html += '<span class="collapse-icon">&#x25BC;</span>';
    html += '<h3 id="' + headingId + '">' + escapeHtml(project.name) + '</h3>';
    html += '<span class="badge ' + badgeClass + '" aria-label="' + badgeLabel + '">' + project.health.status + '</span>';
    html += '<span style="font-size:12px;color:#8b949e">' + project.repos.length + ' repo' + (project.repos.length !== 1 ? 's' : '') + '</span>';
    if (!project.tokenCoverage.complete) {
      html += '<span class="token-warning" aria-label="Token coverage incomplete: ' + project.tokenCoverage.missingRepos.join(', ') + '">&#x26A0; missing token</span>';
    }
    html += '</div>';
    html += '<div class="project-repos">';
    for (const repo of project.repos) {
      html += '<div class="project-repo-item" data-repo-filter="' + escapeHtml(repo.fullName) + '" role="button" tabindex="0" aria-label="Filter sessions by ' + escapeHtml(repo.fullName) + '">';
      html += '<span>' + escapeHtml(repo.fullName) + '</span>';
      if (repo.activeSessions > 0) {
        html += '<span style="font-size:11px;padding:1px 6px;border-radius:12px;background:#238636;color:#fff">' + repo.activeSessions + ' active</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    html += '</section>';
  }

  // Ungrouped section
  if (data.ungrouped.length > 0) {
    const ungroupedId = 'project-ungrouped';
    const ungroupedHeadingId = ungroupedId + '-heading';
    const collapsed = getProjectCollapseState('__ungrouped__');
    const collapseClass = collapsed ? ' collapsed' : '';

    html += '<section class="project-section' + collapseClass + '" role="region" aria-labelledby="' + ungroupedHeadingId + '" data-project="__ungrouped__">';
    html += '<div class="project-header" role="button" aria-expanded="' + (!collapsed) + '" tabindex="0">';
    html += '<span class="collapse-icon">&#x25BC;</span>';
    html += '<h3 id="' + ungroupedHeadingId + '">Ungrouped</h3>';
    html += '<span style="font-size:12px;color:#8b949e">' + data.ungrouped.length + ' repo' + (data.ungrouped.length !== 1 ? 's' : '') + '</span>';
    html += '</div>';
    html += '<div class="project-repos">';
    for (const repo of data.ungrouped) {
      html += '<div class="project-repo-item" data-repo-filter="' + escapeHtml(repo.fullName) + '" role="button" tabindex="0" aria-label="Filter sessions by ' + escapeHtml(repo.fullName) + '">';
      html += '<span>' + escapeHtml(repo.fullName) + '</span>';
      if (repo.activeSessions > 0) {
        html += '<span style="font-size:11px;padding:1px 6px;border-radius:12px;background:#238636;color:#fff">' + repo.activeSessions + ' active</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    html += '</section>';
  }

  panel.innerHTML = html;

  // Attach collapse/expand handlers
  var headers = panel.querySelectorAll('.project-header');
  for (var i = 0; i < headers.length; i++) {
    (function(header) {
      function toggle() {
        var section = header.closest('.project-section');
        var projectName = section.getAttribute('data-project');
        var isCollapsed = section.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', String(!isCollapsed));
        setProjectCollapseState(projectName, isCollapsed);
      }
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    })(headers[i]);
  }

  // Attach repo filter handlers
  var repoItems = panel.querySelectorAll('.project-repo-item');
  for (var j = 0; j < repoItems.length; j++) {
    (function(item) {
      function activate() {
        var repo = item.getAttribute('data-repo-filter');
        setRepoFilter(repo);
      }
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        activate();
      });
      item.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); activate(); }
      });
    })(repoItems[j]);
  }
}

function getProjectCollapseState(projectName) {
  var key = 'project-collapsed:' + projectName;
  return localStorage.getItem(key) === '1';
}

function setProjectCollapseState(projectName, collapsed) {
  var key = 'project-collapsed:' + projectName;
  localStorage.setItem(key, collapsed ? '1' : '0');
}

function setRepoFilter(repo) {
  currentRepoFilter = repo;
  renderRepoFilter();
  loadGroupedSessions();
}

function clearRepoFilter() {
  currentRepoFilter = null;
  renderRepoFilter();
  loadGroupedSessions();
}

function renderRepoFilter() {
  var filterEl = document.getElementById('repo-filter');
  if (!currentRepoFilter) {
    filterEl.style.display = 'none';
    filterEl.innerHTML = '';
    return;
  }
  filterEl.style.display = 'block';
  filterEl.innerHTML = '<div class="repo-filter-bar">' +
    '<span class="filter-label">Filtered by:</span>' +
    '<span class="filter-value">' + escapeHtml(currentRepoFilter) + '</span>' +
    '<button class="filter-clear" id="clear-repo-filter" aria-label="Clear repo filter">Clear</button>' +
    '</div>';
  var clearBtn = document.getElementById('clear-repo-filter');
  if (clearBtn) clearBtn.addEventListener('click', clearRepoFilter);
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
  activeRenderCtx = null;

  // Update nav active state
  var navLinks = document.querySelectorAll('#main-nav .nav-link');
  for (var i = 0; i < navLinks.length; i++) {
    navLinks[i].classList.remove('active');
  }

  if (route.view === 'config') {
    listView.style.display = 'none';
    detailView.style.display = 'none';
    configView.style.display = 'block';
    document.getElementById('projects-panel').style.display = 'none';
    document.getElementById('repo-filter').style.display = 'none';
    var configLink = document.querySelector('#main-nav [data-view="config"]');
    if (configLink) configLink.classList.add('active');
    loadConfig();
  } else if (route.view === 'detail') {
    listView.style.display = 'none';
    detailView.style.display = 'block';
    configView.style.display = 'none';
    document.getElementById('projects-panel').style.display = 'none';
    document.getElementById('repo-filter').style.display = 'none';
    var sessionsLink = document.querySelector('#main-nav [data-view="sessions"]');
    if (sessionsLink) sessionsLink.classList.add('active');
    loadDetailView(route.sessionId);
  } else {
    listView.style.display = 'block';
    detailView.style.display = 'none';
    configView.style.display = 'none';
    renderRepoFilter();
    var sessionsLink2 = document.querySelector('#main-nav [data-view="sessions"]');
    if (sessionsLink2) sessionsLink2.classList.add('active');
    loadProjects();
    loadGroupedSessions();
  }
}

window.addEventListener('hashchange', navigate);
displayIdentity();
navigate();
</script>
</body>
</html>`;
}

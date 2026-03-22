/** Dashboard inline JavaScript — extracted to stay under 500-line file limit. */

export function getDashboardScripts(): string {
  return `
const $ = id => document.getElementById(id);
const api = path => fetch('/api/' + path).then(r => r.json());

// --- Theme system ---
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('justclaw-theme', theme);
  const label = $('theme-label');
  if (label) label.textContent = theme;
}
function cycleTheme() {
  const themes = ['midnight', 'light', 'high-contrast', 'cresto'];
  const current = document.documentElement.getAttribute('data-theme') || 'midnight';
  const next = themes[(themes.indexOf(current) + 1) % themes.length];
  applyTheme(next);
}
(function initTheme() {
  const saved = localStorage.getItem('justclaw-theme');
  if (saved) applyTheme(saved);
})();

// --- Tab navigation ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('page-' + tab.dataset.tab).classList.add('active');
    const name = tab.dataset.tab;
    if (name === 'processes') refreshProcesses();
    if (name === 'conversations') refreshConversations();
    if (name === 'logs') refreshLogs();
  });
});

// --- Clock & uptime ---
let _startTime = null;
function updateClock() {
  $('clock').textContent = new Date().toLocaleString();
  if (_startTime) {
    const secs = Math.floor(Date.now() / 1000 - _startTime);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    let txt = '';
    if (h > 0) txt += h + 'h ';
    if (m > 0 || h > 0) txt += m + 'm ';
    txt += s + 's';
    $('uptime').textContent = 'up ' + txt;
  }
}
async function fetchUptime() {
  try { const d = await api('uptime'); _startTime = d.start_time; } catch {}
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Overview renderers ---
${getOverviewRenderers()}

// --- Conversation panel ---
${getConversationScripts()}

// --- Processes ---
${getProcessScripts()}

// --- Logs ---
${getLogScripts()}

// --- SSE ---
${getSseScripts()}

// --- Init ---
fetchUptime();
updateClock();
setInterval(updateClock, 1000);
setInterval(fetchUptime, 60000);
refreshOverview();
setInterval(refreshOverview, 10000);
`;
}

function getOverviewRenderers(): string {
  return `
function renderStats(d) {
  const g = d._ghost || {};
  $('stats').innerHTML = [
    ['Work Queue', d.pending_tasks?.length || 0, 'accent'],
    ['Memories', d.memory_count, 'purple'],
    ['Messages 24h', d.messages_24h, 'green'],
    ['Log Today', d.today_log_entries, 'yellow'],
    ['Ghost Checks', g.total_checks || 0, g.forced_remaining > 0 ? 'red' : 'green'],
  ].map(([l,v,c]) => '<div class="stat-card"><div class="label">' + l +
    '</div><div class="value ' + c + '">' + v + '</div></div>').join('');
  const bar = $('snapshot-bar');
  if (d.last_snapshot) {
    bar.style.display = 'block';
    bar.innerHTML = '<strong>Last context:</strong> ' + esc(d.last_snapshot.summary?.slice(0,200)) +
      ' <span style="margin-left:8px;color:var(--text2)">' + d.last_snapshot.created_at + '</span>';
  } else { bar.style.display = 'none'; }
}

function renderTasks(tasks) {
  const el = $('tasks');
  if (!tasks.length) { el.innerHTML = '<div class="empty">No work items</div>'; return; }
  el.innerHTML = tasks.map(t => '<div class="task-item"><span class="badge ' + t.status + '">' +
    t.status + '</span><span class="task-title">' + esc(t.title) +
    '</span><span class="task-priority">P' + t.priority + '</span></div>').join('');
}

function renderScheduledTasks(tasks) {
  const el = $('scheduled-tasks');
  if (!tasks.length) { el.innerHTML = '<div class="empty">No scheduled tasks</div>'; return; }
  const now = new Date();
  el.innerHTML = tasks.map(t => {
    const due = t.due_at ? new Date(t.due_at + 'Z') : null;
    const isOverdue = due && due < now && t.status === 'pending';
    const dueClass = isOverdue ? 'overdue' : 'upcoming';
    const dueLabel = due ? formatDue(due, now) : 'no schedule';
    const lastRun = t.status === 'completed' && t.result
      ? '<div class="sched-result">Last: ' + esc(t.result.slice(0, 100)) + '</div>' : '';
    return '<div class="sched-item">' +
      '<div class="sched-title">' + esc(t.title) + '</div>' +
      '<div class="sched-meta">' +
        '<span class="sched-recurrence">' + esc(t.recurrence) + '</span>' +
        '<span class="badge ' + t.status + '">' + t.status + '</span>' +
        '<span class="sched-due ' + dueClass + '">Next: ' + dueLabel + '</span>' +
      '</div>' +
      lastRun +
    '</div>';
  }).join('');
}

function formatDue(due, now) {
  const diff = due - now;
  const absDiff = Math.abs(diff);
  const mins = Math.floor(absDiff / 60000);
  const hours = Math.floor(absDiff / 3600000);
  if (diff < 0) {
    if (mins < 60) return mins + 'm overdue';
    if (hours < 24) return hours + 'h overdue';
    return Math.floor(hours / 24) + 'd overdue';
  }
  if (mins < 60) return 'in ' + mins + 'm';
  if (hours < 24) return 'in ' + hours + 'h';
  return 'in ' + Math.floor(hours / 24) + 'd';
}

function renderMemories(mems) {
  const el = $('memories');
  if (!mems.length) { el.innerHTML = '<div class="empty">No memories</div>'; return; }
  el.innerHTML = mems.map(m => '<div class="mem-item"><div class="mem-key">' + esc(m.key) +
    '</div><div class="mem-content">' + esc(m.content?.slice(0,150)) +
    '</div><div class="mem-meta"><span class="mem-tag">' + m.type + '</span>' +
    (m.tags ? m.tags.split(',').map(t => '<span class="mem-tag">' + esc(t.trim()) + '</span>').join('') : '') +
    '</div></div>').join('');
}

function renderConvoList(msgs, targetId) {
  const el = $(targetId);
  if (!msgs.length) { el.innerHTML = '<div class="empty">No conversations</div>'; return; }
  el.innerHTML = msgs.map(m => {
    const isCharlie = m.is_from_charlie;
    return '<div class="msg ' + (isCharlie ? 'msg-charlie' : 'msg-user') + '">' +
      '<span class="sender ' + (isCharlie ? 'charlie' : '') + '">' + esc(m.sender) +
      '</span><span class="time">' + (m.created_at?.slice(11,16) || '') +
      '</span><div class="text">' + esc(m.message) + '</div></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderDailyLog(entries) {
  const el = $('daily-log');
  if (!entries.length) { el.innerHTML = '<div class="empty">No activity today</div>'; return; }
  el.innerHTML = entries.map(e => '<div class="log-entry">' +
    (e.category ? '<span class="log-cat">' + esc(e.category) + '</span>' : '') +
    esc(e.entry) + '<span style="color:var(--text2);font-size:0.7rem;margin-left:4px">' +
    (e.created_at?.slice(11,16) || '') + '</span></div>').join('');
}

async function refreshOverview() {
  try {
    const [status, tasks, scheduled, mems, convos, log, ghost] = await Promise.all([
      api('status'), api('tasks'), api('scheduled-tasks'), api('memories'),
      api('conversations?limit=20'), api('daily-log'), api('ghost-state'),
    ]);
    status._ghost = ghost;
    renderStats(status);
    renderTasks(tasks);
    renderScheduledTasks(scheduled);
    renderMemories(mems);
    renderConvoList(convos, 'overview-convos');
    renderDailyLog(log);
    $('status-dot').style.background = 'var(--green)';
  } catch {
    $('status-dot').style.background = 'var(--red)';
  }
}

let searchTimer;
$('mem-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = e.target.value.trim();
    const mems = await api('memories' + (q ? '?q=' + encodeURIComponent(q) : ''));
    renderMemories(mems);
  }, 300);
});
`;
}

function getConversationScripts(): string {
  return `
let _activeChannel = '';

async function refreshChannelTabs() {
  const channels = await api('conversations/channels');
  const bar = $('channel-tabs');
  if (!bar) return;
  const total = channels.reduce((s, c) => s + c.count, 0);
  let html = '<button class="channel-tab' + (_activeChannel === '' ? ' active' : '') +
    '" onclick="selectChannel(\\'\\')">' +
    'All <span class="ch-count">' + total + '</span></button>';
  for (const ch of channels) {
    const active = _activeChannel === ch.channel ? ' active' : '';
    html += '<button class="channel-tab' + active +
      '" onclick="selectChannel(\\'' + esc(ch.channel) + '\\')">' +
      esc(ch.channel) + ' <span class="ch-count">' + ch.count + '</span></button>';
  }
  bar.innerHTML = html;
}

function selectChannel(ch) {
  _activeChannel = ch;
  document.querySelectorAll('.channel-tab').forEach(t => t.classList.remove('active'));
  event.target.closest('.channel-tab').classList.add('active');
  refreshConversations();
}

async function refreshConversations() {
  await refreshChannelTabs();
  const qs = _activeChannel
    ? '?limit=100&channel=' + encodeURIComponent(_activeChannel)
    : '?limit=100';
  const msgs = await api('conversations' + qs);
  renderConvoList(msgs, 'convo-messages');
}

let _sending = false;
${getSendMessageScript()}

$('convo-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
`;
}

function getSendMessageScript(): string {
  return `
async function sendMessage() {
  const input = $('convo-input');
  const sendBtn = document.querySelector('.btn.send');
  const msg = input.value.trim();
  if (!msg || _sending) return;
  _sending = true;
  input.value = '';
  input.disabled = true;
  if (sendBtn) { sendBtn.textContent = 'Thinking...'; sendBtn.disabled = true; }

  const msgEl = $('convo-messages');
  const now = new Date().toTimeString().slice(0,5);
  msgEl.innerHTML += '<div class="msg msg-user"><span class="sender">user</span>' +
    '<span class="time">' + now + '</span><div class="text">' + esc(msg) + '</div></div>';
  msgEl.innerHTML += '<div class="msg msg-charlie" id="thinking-indicator"><span class="sender charlie">charlie</span>' +
    '<span class="time">' + now + '</span><div class="text" style="color:var(--text2);font-style:italic">Thinking...</div></div>';
  msgEl.scrollTop = msgEl.scrollHeight;

  try {
    const r = await fetch('/api/conversations/send', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: msg, sender: 'user', channel: 'dashboard'}),
    });
    const data = await r.json();
    const indicator = $('thinking-indicator');
    if (indicator) indicator.remove();
    if (data.reply) {
      msgEl.innerHTML += '<div class="msg msg-charlie"><span class="sender charlie">charlie</span>' +
        '<span class="time">' + now + '</span><div class="text">' + esc(data.reply) + '</div></div>';
      msgEl.scrollTop = msgEl.scrollHeight;
    } else if (data.error) {
      msgEl.innerHTML += '<div class="msg"><span class="sender" style="color:var(--red)">error</span>' +
        '<div class="text" style="color:var(--red)">' + esc(data.error) + '</div></div>';
      msgEl.scrollTop = msgEl.scrollHeight;
    }
  } catch (e) {
    const indicator = $('thinking-indicator');
    if (indicator) indicator.remove();
    msgEl.innerHTML += '<div class="msg"><span class="sender" style="color:var(--red)">error</span>' +
      '<div class="text" style="color:var(--red)">Failed to reach Claude</div></div>';
    input.value = msg;
  }
  _sending = false;
  input.disabled = false;
  if (sendBtn) { sendBtn.textContent = 'Send'; sendBtn.disabled = false; }
  input.focus();
}`;
}

function getProcessScripts(): string {
  return `
async function refreshProcesses() {
  const [procs, ghost] = await Promise.all([api('processes'), api('ghost-state')]);
  const tbody = $('proc-body');
  const rows = [];
  for (const [key, val] of Object.entries(procs)) {
    if (!val || typeof val !== 'object') continue;
    const statusHtml = val.alive
      ? '<span style="color:var(--green)">alive</span>'
      : key === 'mcp_server'
        ? '<span style="color:var(--yellow)" title="stdio MCP server runs only while Claude Code is connected">standby</span>'
        : '<span style="color:var(--red)">dead</span>';
    rows.push('<tr><td class="pid">' + (val.pid || '-') + '</td><td>' + key +
      '</td><td>' + statusHtml + '</td><td>-</td></tr>');
  }
  tbody.innerHTML = rows.length ? rows.join('') :
    '<tr><td colspan="4" class="empty">No processes found</td></tr>';
  $('ghost-state').innerHTML = '<pre style="font-family:var(--mono);font-size:0.8rem;color:var(--text2)">' +
    JSON.stringify(ghost, null, 2) + '</pre>';
}
`;
}

function getLogScripts(): string {
  return `
const logColors = { info: 'var(--text2)', warn: 'var(--yellow)', error: 'var(--red)', debug: 'var(--purple)' };

async function refreshLogs() {
  const logger = $('log-filter').value;
  const qs = logger ? '?logger=' + logger + '&lines=200' : '?lines=200';
  const entries = await api('logs' + qs);
  const el = $('log-entries');
  if (!entries.length) { el.innerHTML = '<div class="empty">No log entries</div>'; return; }
  el.innerHTML = entries.map(e => {
    const color = logColors[e.level] || 'var(--text)';
    const ts = e.ts ? e.ts.slice(11, 19) : '';
    const extra = Object.keys(e).filter(k => !['ts','level','logger','msg'].includes(k))
      .map(k => '<span style="color:var(--text2)">' + k + '=</span>' + esc(String(e[k]))).join(' ');
    return '<div style="padding:2px 0;border-bottom:1px solid var(--border)">' +
      '<span style="color:var(--text2)">' + ts + '</span> ' +
      '<span style="color:' + color + ';font-weight:600">' + e.level.toUpperCase().padEnd(5) + '</span> ' +
      '<span style="color:var(--accent)">[' + esc(e.logger) + ']</span> ' +
      esc(e.msg) + ' ' + extra + '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}
`;
}

function getSseScripts(): string {
  return `
let sse;
function connectSse() {
  sse = new EventSource('/api/events');
  sse.addEventListener('refresh', () => {
    refreshOverview();
    if ($('page-processes').classList.contains('active')) refreshProcesses();
    if ($('page-conversations').classList.contains('active')) refreshConversations();
    if ($('page-logs').classList.contains('active')) refreshLogs();
  });
  sse.addEventListener('new_message', (e) => {
    if ($('page-conversations').classList.contains('active')) refreshConversations();
    refreshOverview();
  });
  sse.addEventListener('connected', () => { $('status-dot').style.background = 'var(--green)'; });
  sse.onerror = () => { $('status-dot').style.background = 'var(--red)'; };
}
connectSse();
`;
}

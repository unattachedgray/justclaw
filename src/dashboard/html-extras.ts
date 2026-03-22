/**
 * Dashboard extras — Activity Heatmap + Quick Actions panel.
 * Extracted to a separate file because html.ts (491/500) and html-scripts.ts (500/500)
 * are at or near the 500-line limit.
 */

// --- Activity Heatmap ---

export function getHeatmapStyles(): string {
  return `
.heatmap-grid {
  display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px;
  width: 100%; padding: 4px 0;
}
.heatmap-cell {
  aspect-ratio: 1; border-radius: 2px; background: var(--surface2);
  transition: background 0.2s; position: relative;
}
.heatmap-cell:hover { outline: 1px solid var(--accent); z-index: 1; }
.heatmap-cell[title] { cursor: default; }
.heatmap-labels {
  display: flex; justify-content: space-between; font-size: 0.55rem;
  color: var(--text2); padding: 0 2px; margin-top: 2px;
}
.heatmap-day-labels {
  display: grid; grid-template-rows: repeat(7, 1fr); gap: 2px;
  font-size: 0.55rem; color: var(--text2); text-align: right;
  padding-right: 4px; align-items: center;
}
.heatmap-wrapper {
  display: grid; grid-template-columns: 28px 1fr; align-items: start;
}
.heatmap-legend {
  display: flex; align-items: center; gap: 4px; font-size: 0.55rem;
  color: var(--text2); margin-top: 4px; justify-content: flex-end;
}
.heatmap-legend-cell {
  width: 10px; height: 10px; border-radius: 2px;
}
`;
}

export function getHeatmapScripts(): string {
  return `
function renderHeatmap(grid, max, days) {
  const el = $('heatmap');
  if (!el) return;
  if (!grid || !grid.length) {
    el.innerHTML = '<div class="empty">No activity data</div>';
    return;
  }
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#58a6ff';

  // Parse accent color to RGB for interpolation
  function hexToRgb(hex) {
    const c = hex.replace('#','');
    if (c.length === 3) return [parseInt(c[0]+c[0],16), parseInt(c[1]+c[1],16), parseInt(c[2]+c[2],16)];
    return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
  }
  const rgb = hexToRgb(accent);

  // Build day labels
  let dayLabelsHtml = '<div class="heatmap-day-labels">';
  for (let d = 0; d < 7; d++) dayLabelsHtml += '<span>' + dayNames[d] + '</span>';
  dayLabelsHtml += '</div>';

  // Build grid cells (7 rows × 24 cols per day, but we show days × hours)
  let cellsHtml = '<div class="heatmap-grid" style="grid-template-columns:repeat(24,1fr);grid-template-rows:repeat(' + grid.length + ',1fr)">';
  for (let d = 0; d < grid.length; d++) {
    for (let h = 0; h < 24; h++) {
      const val = grid[d][h] || 0;
      const intensity = max > 0 ? val / max : 0;
      const alpha = intensity > 0 ? 0.15 + intensity * 0.85 : 0;
      const bg = alpha > 0
        ? 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(2) + ')'
        : 'var(--surface2)';
      const dayLabel = days && days[d] ? days[d] : 'Day ' + d;
      const title = dayLabel + ' ' + h + ':00 — ' + val + ' event' + (val !== 1 ? 's' : '');
      cellsHtml += '<div class="heatmap-cell" style="background:' + bg + '" title="' + title + '"></div>';
    }
  }
  cellsHtml += '</div>';

  // Hour labels
  let hourLabels = '<div class="heatmap-labels">';
  for (let h = 0; h < 24; h += 3) hourLabels += '<span>' + h + '</span>';
  hourLabels += '</div>';

  // Legend
  const legend = '<div class="heatmap-legend"><span>Less</span>' +
    [0, 0.25, 0.5, 0.75, 1].map(i => {
      const a = i > 0 ? 0.15 + i * 0.85 : 0;
      const c = a > 0 ? 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(2) + ')' : 'var(--surface2)';
      return '<div class="heatmap-legend-cell" style="background:' + c + '"></div>';
    }).join('') + '<span>More</span></div>';

  el.innerHTML = '<div class="heatmap-wrapper">' + dayLabelsHtml + '<div>' + cellsHtml + hourLabels + '</div></div>' + legend;
}

async function fetchHeatmap() {
  try {
    const data = await api('heatmap');
    renderHeatmap(data.grid, data.max, data.days);
  } catch {
    const el = $('heatmap');
    if (el) el.innerHTML = '<div class="empty">Heatmap unavailable</div>';
  }
}
`;
}

// --- Quick Actions ---

export function getQuickActionsHtml(): string {
  return `<div class="quick-actions" id="quick-actions">
  <button class="btn qa-btn" onclick="qaRestartDashboard()" title="Restart the dashboard process">Restart Dashboard</button>
  <button class="btn qa-btn" onclick="qaRunBuild()" title="Run npm run build">Run Build</button>
  <button class="btn qa-btn" onclick="qaClearGhosts()" title="Check and clear ghost PIDs">Clear Ghost PIDs</button>
  <button class="btn qa-btn primary" onclick="qaCheckHealth()" title="Refresh all panels">Check Health</button>
</div>
<div id="qa-toast" class="qa-toast"></div>`;
}

export function getQuickActionsStyles(): string {
  return `
.quick-actions {
  display: flex; gap: 8px; flex-shrink: 0; margin-bottom: var(--gap);
  flex-wrap: wrap; align-items: center;
}
.qa-btn { padding: 6px 14px; font-size: 0.75rem; }
.qa-toast {
  position: fixed; bottom: 20px; right: 20px; padding: 10px 18px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-size: 0.8rem;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000;
  opacity: 0; transition: opacity 0.3s; pointer-events: none;
}
.qa-toast.visible { opacity: 1; pointer-events: auto; }
.qa-toast.success { border-color: var(--green); }
.qa-toast.error { border-color: var(--red); }
`;
}

export function getQuickActionsScripts(): string {
  return `
function showToast(msg, type, duration) {
  const el = $('qa-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'qa-toast visible ' + (type || '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'qa-toast'; }, duration || 3000);
}

async function qaRestartDashboard() {
  if (!confirm('Restart the dashboard? The page will reload after a few seconds.')) return;
  showToast('Restarting dashboard...', '', 10000);
  try {
    const procs = await api('processes');
    const dashPid = procs.dashboard?.pid;
    if (!dashPid) { showToast('Dashboard PID not found', 'error'); return; }
    await fetch('/api/processes/kill', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({pid: dashPid}),
    });
    showToast('Dashboard killed — reloading in 3s...', 'success', 4000);
    setTimeout(() => { location.reload(); }, 3000);
  } catch (e) { showToast('Failed: ' + e.message, 'error'); }
}

async function qaRunBuild() {
  if (!confirm('Run npm run build? This may take up to 60 seconds.')) return;
  showToast('Building...', '', 65000);
  try {
    const r = await fetch('/api/actions/build', { method: 'POST' });
    const data = await r.json();
    if (data.ok) {
      showToast('Build succeeded', 'success', 5000);
    } else {
      showToast('Build failed: ' + (data.error || 'unknown'), 'error', 8000);
    }
  } catch (e) { showToast('Build error: ' + e.message, 'error', 5000); }
}

async function qaClearGhosts() {
  if (!confirm('Check for ghost PIDs and display results?')) return;
  showToast('Checking ghost PIDs...', '', 5000);
  try {
    const r = await fetch('/api/processes/check-ghosts', { method: 'POST' });
    const data = await r.json();
    const stale = data.stale_pid_files || [];
    if (stale.length === 0) {
      showToast('No ghost PIDs found', 'success');
    } else {
      showToast('Stale PID files: ' + stale.join(', '), 'error', 6000);
    }
  } catch (e) { showToast('Ghost check failed: ' + e.message, 'error'); }
}

function qaCheckHealth() {
  showToast('Refreshing all panels...', '', 2000);
  refreshOverview();
  setTimeout(() => { showToast('Health check complete', 'success'); }, 1500);
}
`;
}

// --- Claude Sessions Panel ---

export function getClaudeSessionsStyles(): string {
  return `
.session-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); align-items: center; font-size: 0.75rem; }
.session-row:last-child { border: none; }
.session-model { color: var(--purple); font-size: 0.65rem; }
.session-tokens { color: var(--text2); font-size: 0.65rem; text-align: right; }
.session-cache { color: var(--green); font-size: 0.65rem; }
.session-cost { color: var(--yellow); font-size: 0.65rem; font-weight: 600; }
.usage-stat { display: flex; flex-direction: column; align-items: center; padding: 4px 8px; }
.usage-stat .val { font-size: 1.2rem; font-weight: 700; color: var(--accent); }
.usage-stat .lbl { font-size: 0.6rem; color: var(--text2); }
.usage-bar { display: flex; gap: 12px; justify-content: space-around; margin-bottom: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
`;
}

export function getClaudeSessionsScripts(): string {
  return `
async function fetchClaudeSessions() {
  try {
    const [sessions, usage] = await Promise.all([api('claude-sessions?limit=10'), api('claude-usage?days=7')]);
    const el = $('claude-sessions');
    if (!el) return;
    let html = '<div class="usage-bar">';
    html += '<div class="usage-stat"><span class="val">' + usage.total_sessions + '</span><span class="lbl">Sessions (7d)</span></div>';
    html += '<div class="usage-stat"><span class="val">' + fmtTokens(usage.total_tokens) + '</span><span class="lbl">Total Tokens</span></div>';
    html += '<div class="usage-stat"><span class="val">' + usage.avg_cache_hit_rate + '%</span><span class="lbl">Cache Hit</span></div>';
    html += '<div class="usage-stat"><span class="val">$' + usage.total_cost_usd.toFixed(2) + '</span><span class="lbl">Est. Cost</span></div>';
    html += '</div>';
    if (!sessions.length) { html += '<div class="empty">No sessions found</div>'; }
    for (const s of sessions) {
      const age = timeAgo(s.last_activity);
      const proj = s.project.split('/').pop() || s.project;
      html += '<div class="session-row">';
      html += '<div><strong>' + esc(proj) + '</strong> <span class="session-model">' + esc(s.model) + '</span><br><span class="session-tokens">' + s.turns + ' turns · ' + age + '</span></div>';
      html += '<div class="session-tokens">' + fmtTokens(s.input_tokens) + ' in</div>';
      html += '<div class="session-cache">' + s.cache_hit_rate + '% cache</div>';
      html += '<div class="session-cost">$' + s.estimated_cost_usd.toFixed(2) + '</div>';
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) {
    const el = $('claude-sessions');
    if (el) el.innerHTML = '<div class="empty">Sessions unavailable</div>';
  }
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return Math.round(diff) + 's ago';
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  return Math.round(diff / 86400) + 'd ago';
}
`;
}

// --- Init scripts (extracted from html-scripts.ts to free up lines) ---

export function getInitScripts(): string {
  return `
let _refreshIn = 10;
function tickCountdown() {
  _refreshIn--;
  const el = $('refresh-countdown');
  if (el) el.textContent = _refreshIn + 's';
  if (_refreshIn <= 0) { _refreshIn = 10; refreshOverview(); }
}
fetchUptime();
updateClock();
setInterval(updateClock, 1000);
setInterval(fetchUptime, 60000);
refreshOverview();
setInterval(tickCountdown, 1000);
`;
}

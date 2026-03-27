/**
 * System Resources panel — CSS, HTML, and client JS for the dashboard.
 * Shows live memory usage graph + process-level memory breakdown.
 */

export function getResourcePanelHtml(): string {
  return `<div class="panel" data-pid="panel-resources">
  <div class="panel-header"><span class="collapse-indicator">&#9660;</span> System Resources</div>
  <div class="panel-body">
    <div class="resource-stats" id="resource-stats"></div>
    <canvas id="mem-chart" height="120" style="width:100%"></canvas>
    <div class="resource-procs" id="resource-procs"></div>
  </div>
</div>`;
}

export function getResourceStyles(): string {
  return `
.resource-stats { display: flex; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.resource-stat { font-size: 0.75rem; }
.resource-stat .rs-val { font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.resource-stat .rs-lbl { color: var(--text2); }
.resource-bar { height: 6px; background: var(--border); border-radius: 3px; margin: 4px 0; overflow: hidden; }
.resource-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.resource-procs { margin-top: 8px; font-size: 0.75rem; }
.resource-proc { display: flex; justify-content: space-between; padding: 2px 0; border-bottom: 1px solid var(--border); }
.resource-proc:last-child { border-bottom: none; }
`;
}

export function getResourceScripts(): string {
  return `
function renderResources(data) {
  if (!data) return;
  renderResourceStats(data.current);
  renderMemChart(data.history);
  renderResourceProcs(data.processes);
}

function renderResourceStats(cur) {
  var el = $('resource-stats');
  if (!el || !cur) return;
  var pct = cur.mem_percent;
  var barColor = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)';
  var html = '<div class="resource-stat"><div class="rs-lbl">RAM</div>' +
    '<div class="rs-val" style="color:' + barColor + '">' + pct + '%</div>' +
    '<div style="font-size:0.65rem;color:var(--text2)">' + cur.mem_used_mb + ' / ' + cur.mem_total_mb + ' MB</div>' +
    '<div class="resource-bar"><div class="resource-bar-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div></div>';
  if (cur.swap_used_mb > 0) {
    var swapPct = cur.swap_total_mb > 0 ? Math.round(cur.swap_used_mb / cur.swap_total_mb * 100) : 0;
    html += '<div class="resource-stat"><div class="rs-lbl">Swap</div>' +
      '<div class="rs-val">' + swapPct + '%</div>' +
      '<div style="font-size:0.65rem;color:var(--text2)">' + cur.swap_used_mb + ' / ' + cur.swap_total_mb + ' MB</div></div>';
  }
  el.innerHTML = html;
}

function renderMemChart(history) {
  var canvas = $('mem-chart');
  if (!canvas || !history || history.length < 2) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  var W = rect.width, H = rect.height;
  var pad = { top: 8, right: 50, bottom: 20, left: 35 };
  var plotW = W - pad.left - pad.right;
  var plotH = H - pad.top - pad.bottom;

  // Resolve CSS colors
  var cs = getComputedStyle(document.documentElement);
  var borderC = cs.getPropertyValue('--border').trim() || '#30363d';
  var textC = cs.getPropertyValue('--text2').trim() || '#8b949e';
  var accentC = cs.getPropertyValue('--accent').trim() || '#58a6ff';
  var greenC = cs.getPropertyValue('--green').trim() || '#3fb950';
  var purpleC = cs.getPropertyValue('--purple').trim() || '#bc8cff';

  drawChartGrid(ctx, pad, plotW, plotH, borderC, textC);
  drawChartLines(ctx, history, pad, plotW, plotH, accentC, greenC, purpleC);
  drawChartLegend(ctx, W, pad, accentC, greenC, purpleC, textC);
}

function drawChartGrid(ctx, pad, plotW, plotH, borderC, textC) {
  ctx.strokeStyle = borderC;
  ctx.lineWidth = 0.5;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = textC;
  for (var i = 0; i <= 4; i++) {
    var y = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText((100 - i * 25) + '%', pad.left - 4, y + 3);
  }
}

function drawChartLines(ctx, history, pad, plotW, plotH, accentC, greenC, purpleC) {
  var len = history.length;
  var step = plotW / Math.max(len - 1, 1);

  // Find max MB for right-side scale
  var maxMb = 10;
  for (var i = 0; i < len; i++) {
    var d = history[i];
    if ((d.dashboard_mb || 0) > maxMb) maxMb = d.dashboard_mb;
    if ((d.discord_mb || 0) > maxMb) maxMb = d.discord_mb;
  }
  maxMb = Math.ceil(maxMb / 50) * 50 || 50;

  // Right-side MB scale labels
  var cs2 = getComputedStyle(document.documentElement);
  var textC = cs2.getPropertyValue('--text2').trim() || '#8b949e';
  ctx.fillStyle = textC;
  ctx.textAlign = 'left';
  var rightX = pad.left + plotW + 4;
  for (var i = 0; i <= 4; i++) {
    var y = pad.top + (plotH / 4) * i;
    var mbVal = Math.round(maxMb - (maxMb / 4) * i);
    ctx.fillText(mbVal + 'M', rightX, y + 3);
  }

  // System memory % line (thick, accent color)
  drawLine(ctx, history, 'mem_pct', len, step, pad, plotH, 100, accentC, 2);

  // Dashboard MB line (thin, green)
  drawLine(ctx, history, 'dashboard_mb', len, step, pad, plotH, maxMb, greenC, 1);

  // Discord MB line (thin, purple)
  drawLine(ctx, history, 'discord_mb', len, step, pad, plotH, maxMb, purpleC, 1);
}

function drawLine(ctx, data, key, len, step, pad, plotH, maxVal, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  var started = false;
  for (var i = 0; i < len; i++) {
    var v = data[i][key] || 0;
    var x = pad.left + i * step;
    var y = pad.top + plotH - (v / maxVal) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawChartLegend(ctx, W, pad, accentC, greenC, purpleC, textC) {
  var y = pad.top - 1;
  ctx.font = '9px sans-serif';
  var items = [
    { label: 'System %', color: accentC },
    { label: 'Dashboard', color: greenC },
    { label: 'Discord', color: purpleC },
  ];
  var x = pad.left;
  for (var i = 0; i < items.length; i++) {
    ctx.fillStyle = items[i].color;
    ctx.fillRect(x, y - 6, 12, 3);
    ctx.fillStyle = textC;
    ctx.textAlign = 'left';
    ctx.fillText(items[i].label, x + 15, y);
    x += ctx.measureText(items[i].label).width + 26;
  }
}

function renderResourceProcs(procs) {
  var el = $('resource-procs');
  if (!el) return;
  if (!procs || !procs.length) { el.innerHTML = '<div class="empty">No processes</div>'; return; }
  var html = '';
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i];
    html += '<div class="resource-proc"><span>' + esc(p.name) + ' <span style="color:var(--text2)">(PID ' + p.pid + ')</span></span>' +
      '<span style="font-weight:600;font-variant-numeric:tabular-nums">' + p.rss_mb + ' MB</span></div>';
  }
  el.innerHTML = html;
}

async function fetchResources() {
  try {
    var data = await api('system-resources');
    renderResources(data);
  } catch (e) {
    console.warn('System resources:', e);
  }
}
`;
}

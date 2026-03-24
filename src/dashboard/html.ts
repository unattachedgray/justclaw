/** Dashboard HTML template — justclaw Control Plane. */

import { getDashboardScripts } from './html-scripts.js';
import { getEditModeStyles, getEditToggleHtml } from './html-edit-mode.js';
import { getHeatmapStyles, getQuickActionsHtml, getQuickActionsStyles, getClaudeSessionsStyles } from './html-extras.js';

function getThemeStyles(): string {
  return `
[data-theme="midnight"] {
  --bg: #0d1117; --surface: #161b22; --surface2: #1c2129;
  --border: #30363d; --text: #e6edf3; --text2: #8b949e;
  --accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
  --red: #f85149; --purple: #bc8cff; --orange: #f0883e;
  --input-bg: #0d1117; --hover: #1f2937;
}
[data-theme="light"] {
  --bg: #ffffff; --surface: #f6f8fa; --surface2: #eaeef2;
  --border: #d0d7de; --text: #1f2328; --text2: #656d76;
  --accent: #0969da; --green: #1a7f37; --yellow: #9a6700;
  --red: #cf222e; --purple: #8250df; --orange: #bc4c00;
  --input-bg: #ffffff; --hover: #eaeef2;
}
[data-theme="high-contrast"] {
  --bg: #000000; --surface: #0a0a0a; --surface2: #141414;
  --border: #ffffff; --text: #ffffff; --text2: #e0e0e0;
  --accent: #ffff00; --green: #00ff41; --yellow: #ffff00;
  --red: #ff3333; --purple: #da70d6; --orange: #ff8c00;
  --input-bg: #0a0a0a; --hover: #1a1a1a;
}
[data-theme="cresto"] {
  --bg: #0f172a; --surface: #1e293b; --surface2: #1e3a5f;
  --border: rgba(212,175,55,0.25); --text: #e2e8f0; --text2: #94a3b8;
  --accent: #d4af37; --green: #3fb950; --yellow: #d4af37;
  --red: #f85149; --purple: #bc8cff; --orange: #f0883e;
  --input-bg: #0f172a; --hover: #1e3a5f;
}
[data-theme="cresto"] body { font-size: 1.15rem; }
[data-theme="cresto"] header h1 { font-size: 1.6rem; font-family: 'Playfair Display', Georgia, serif; }
[data-theme="cresto"] .tabs .tab { font-size: 0.95rem; padding: 10px 18px; }
[data-theme="cresto"] .panel-header { font-size: 1.05rem; }
[data-theme="cresto"] .panel-body { font-size: 0.95rem; }
[data-theme="cresto"] header { background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); border-bottom: 1px solid rgba(212,175,55,0.3); }
`;
}

function getBaseStyles(): string {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5;
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  --radius: 10px; --gap: 12px;
  --mono: 'Cascadia Code', 'SF Mono', Consolas, monospace;
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
header h1 { font-size: 1.3rem; font-weight: 600; white-space: nowrap; }
.dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--green); animation: pulse 2s infinite; flex-shrink: 0;
}
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
.service-indicators { display: flex; gap: 6px; margin-left: 12px; }
.svc-dot {
  font-size: 0.6rem; padding: 2px 8px; border-radius: 10px; font-weight: 600;
  background: var(--surface2); color: var(--text2); border: 1px solid var(--border);
}
.svc-dot.online { background: rgba(63,185,80,0.15); color: var(--green); border-color: rgba(63,185,80,0.3); }
.svc-dot.standby { background: rgba(210,153,34,0.15); color: var(--yellow); border-color: rgba(210,153,34,0.3); }
.svc-dot.offline { background: rgba(248,81,73,0.15); color: var(--red); border-color: rgba(248,81,73,0.3); }
.header-right {
  margin-left: auto; display: flex; align-items: center; gap: 12px;
  font-size: 0.75rem; color: var(--text2);
}
.uptime-info { display: flex; align-items: center; gap: 6px; }
.uptime-badge {
  padding: 2px 8px; border-radius: 10px; font-size: 0.65rem;
  background: var(--surface2); border: 1px solid var(--border);
  font-family: var(--mono);
}
.theme-toggle {
  padding: 3px 10px; border-radius: 6px; font-size: 0.7rem;
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); cursor: pointer; font-weight: 500;
  transition: all 0.15s; display: flex; align-items: center; gap: 4px;
}
.theme-toggle:hover { border-color: var(--accent); color: var(--accent); }
`;
}

function getTabStyles(): string {
  return `
.tabs {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border); flex-shrink: 0; overflow-x: auto;
}
.tab-list { display: flex; gap: 2px; }
.tab-bar-right {
  display: flex; align-items: center; gap: 12px;
}
.tab-bar-group {
  display: flex; align-items: center; gap: 8px;
}
.tab-bar-sep {
  width: 1px; height: 18px; background: var(--border); flex-shrink: 0;
}
.tab-bar-stats-label {
  color: var(--text2); font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
}
.tab-bar-stat {
  color: var(--accent); font-weight: 700; font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}
.tab-bar-sparkline {
  display: flex; align-items: flex-end; gap: 1px; height: 20px;
}
.tab-bar-sparkline-bar {
  width: 6px; border-radius: 1px; background: var(--accent); opacity: 0.6;
  transition: height 0.3s;
}
.tab-bar-sparkline-bar:hover { opacity: 1; }
.tab {
  padding: 6px 16px; font-size: 0.8rem; font-weight: 500;
  background: transparent; border: 1px solid transparent;
  border-radius: 6px 6px 0 0; color: var(--text2); cursor: pointer;
  white-space: nowrap; transition: all 0.15s;
}
.tab:hover { color: var(--text); background: var(--surface); }
.tab.active {
  background: var(--surface); color: var(--accent);
  border-color: var(--border); border-bottom-color: var(--surface);
}
.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.tab-page { display: none; flex: 1; overflow: hidden; padding: var(--gap); }
.tab-page.active { display: flex; flex-direction: column; }
.channel-tabs {
  display: flex; gap: 0; padding: 0 var(--gap); flex-shrink: 0;
  border-bottom: 1px solid var(--border); overflow-x: auto;
}
.channel-tab {
  padding: 6px 14px; font-size: 0.75rem; font-weight: 500;
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--text2); cursor: pointer; white-space: nowrap; transition: all 0.15s;
}
.channel-tab:hover { color: var(--text); background: var(--surface); }
.channel-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.channel-tab .ch-count {
  font-size: 0.65rem; background: var(--surface2); padding: 1px 5px;
  border-radius: 8px; margin-left: 4px; color: var(--text2);
}
`;
}

function getCardAndPanelStyles(): string {
  return `
.stats {
  display: flex; gap: var(--gap); flex-shrink: 0; margin-bottom: var(--gap); overflow-x: auto;
}
.stat-card { flex: 1; min-width: 100px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
.stat-card .label {
  font-size: 0.65rem; color: var(--text2); text-transform: uppercase; letter-spacing: 0.05em;
}
.stat-card .value { font-size: 1.4rem; font-weight: 700; }
.stat-card .value.accent { color: var(--accent); }
.stat-card .value.green { color: var(--green); }
.stat-card .value.yellow { color: var(--yellow); }
.stat-card .value.purple { color: var(--purple); }
.stat-card .value.red { color: var(--red); }
.panel {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); display: flex; flex-direction: column;
  overflow: hidden; min-height: 80px; min-width: 100px;
}
.panel-header {
  padding: 8px 14px; font-weight: 600; font-size: 0.8rem;
  background: var(--surface2); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.panel-body { flex: 1; overflow-y: auto; padding: 10px 14px; }
.panel-body::-webkit-scrollbar { width: 5px; }
.panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.grid-overview {
  display: grid; grid-template-columns: 1fr 1fr 1fr; grid-auto-rows: minmax(200px, 1fr);
  gap: var(--gap); flex: 1; overflow: auto;
}
.widget-row { display: flex; gap: 10px; margin-top: 10px; }
.widget-card { flex: 1; background: var(--bg); border-radius: 6px; padding: 8px 10px; }
.widget-card h4 { font-size: 0.65rem; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 6px; }
.widget-stat { display: flex; align-items: baseline; gap: 6px; margin: 3px 0; }
.widget-stat .ws-val { font-size: 1rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.widget-stat .ws-lbl { font-size: 0.65rem; color: var(--text2); }
.gauge-bar { height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; margin: 2px 0 4px; }
.gauge-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
.gauge-fill.green { background: #4caf50; }
.gauge-fill.yellow { background: #ff9800; }
.gauge-fill.red { background: #f44336; }
.sparkline-svg { width: 100%; height: 40px; }
.sparkline-bar { fill: var(--accent); opacity: 0.7; }
.sparkline-bar:hover { opacity: 1; }
.monitor-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.monitor-pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px; font-size: 0.7rem; background: var(--surface2); }
.monitor-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.monitor-dot.ok { background: #4caf50; }
.monitor-dot.alert { background: #ff9800; }
.monitor-dot.critical { background: #f44336; }
.monitor-dot.unknown { background: var(--text2); }
.learning-item { padding: 6px 0; border-bottom: 1px solid var(--surface2); }
.learning-item:last-child { border-bottom: none; }
.learning-badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.6rem; font-weight: 600; text-transform: uppercase; }
.learning-badge.error { background: rgba(248,81,73,0.15); color: #f85149; }
.learning-badge.correction { background: rgba(255,152,0,0.15); color: #ff9800; }
.learning-badge.discovery { background: rgba(88,166,255,0.15); color: #58a6ff; }
.learning-badge.skill { background: rgba(76,175,80,0.15); color: #4caf50; }
.learning-text { font-size: 0.75rem; color: var(--text); margin-top: 2px; }
.learning-meta { font-size: 0.6rem; color: var(--text2); margin-top: 1px; }
.goal-item { padding: 4px 0; }
.goal-name { font-size: 0.75rem; font-weight: 600; color: var(--text); }
.goal-progress { height: 4px; background: var(--surface2); border-radius: 2px; margin-top: 3px; overflow: hidden; }
.goal-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; }
.goal-meta { font-size: 0.6rem; color: var(--text2); margin-top: 1px; }
.throughput-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.throughput-stat { text-align: center; }
.throughput-val { font-size: 1.5rem; font-weight: 700; color: var(--accent); line-height: 1.2; }
.throughput-lbl { font-size: 0.6rem; color: var(--text2); }
.donut-container { display: flex; align-items: center; gap: 10px; }
.donut-legend { font-size: 0.65rem; color: var(--text2); }
.donut-legend-item { display: flex; align-items: center; gap: 4px; margin: 2px 0; }
.donut-legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.grid-overview .span-bottom { grid-column: span 1; }
`;
}

function getMessageStyles(): string {
  return `
.convo-layout { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.convo-messages { flex: 1; overflow-y: auto; padding: 10px 14px; }
.convo-input-row {
  display: flex; gap: 8px; padding: 10px 14px;
  border-top: 1px solid var(--border); flex-shrink: 0;
}
.convo-input { flex: 1; padding: 8px 12px; font-size: 0.85rem; background: var(--input-bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); outline: none; font-family: inherit; }
.convo-input:focus { border-color: var(--accent); }
.convo-input::placeholder { color: var(--text2); }
.msg { padding: 6px 0; font-size: 0.8rem; }
.msg .sender { font-weight: 600; color: var(--accent); }
.msg .sender.charlie { color: var(--green); }
.msg .time { color: var(--text2); font-size: 0.7rem; margin-left: 6px; }
.msg .text { color: var(--text); margin-top: 2px; word-wrap: break-word; }
.msg-charlie { background: var(--surface2); border-radius: 8px; margin: 4px 0 4px 24px; padding: 8px 10px; }
.msg-user { margin: 4px 24px 4px 0; padding: 6px 0; }
`;
}

function getButtonStyles(): string {
  return `
.proc-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.proc-table th {
  text-align: left; padding: 6px 8px; color: var(--text2);
  border-bottom: 1px solid var(--border); font-size: 0.7rem;
  text-transform: uppercase; letter-spacing: 0.04em;
  position: sticky; top: 0; background: var(--surface);
}
.proc-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.proc-table .pid { font-family: var(--mono); color: var(--accent); }
.btn {
  padding: 4px 12px; font-size: 0.7rem; border: 1px solid var(--border);
  border-radius: 6px; background: var(--surface2); color: var(--text);
  cursor: pointer; font-weight: 500; white-space: nowrap; transition: all 0.15s;
}
.btn:hover { border-color: var(--accent); }
.btn.danger { border-color: var(--red); color: var(--red); }
.btn.danger:hover { background: var(--red); color: #fff; }
.btn.primary { border-color: var(--accent); color: var(--accent); }
.btn.primary:hover { background: var(--accent); color: #000; }
.btn.send {
  background: var(--accent); color: #000; border-color: var(--accent);
  font-weight: 600; padding: 8px 20px; font-size: 0.8rem;
}
.btn.send:hover { opacity: 0.85; }
.toolbar { display: flex; gap: 6px; margin-left: auto; align-items: center; }
`;
}

function getTaskStyles(): string {
  return `
/* Expandable item pattern — shared across panels */
.expandable { cursor: pointer; transition: background 0.1s; border-radius: 6px; margin: 0 -6px; padding: 8px 6px; }
.expandable:hover { background: var(--hover); }
.expand-detail {
  display: none; margin: 0 -6px; padding: 6px 10px 10px; font-size: 0.75rem;
  color: var(--text2); line-height: 1.6; border-bottom: 1px solid var(--border);
  background: var(--surface2); border-radius: 0 0 6px 6px;
}
.expand-detail.open { display: block; }
.expand-detail .detail-row { display: flex; gap: 6px; padding: 2px 0; }
.expand-detail .detail-label { color: var(--text2); min-width: 70px; flex-shrink: 0; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }
.expand-detail .detail-val { color: var(--text); word-break: break-word; }
.expand-detail .detail-desc { color: var(--text); padding: 4px 0; white-space: pre-wrap; }
.expand-chevron { font-size: 0.6rem; color: var(--text2); transition: transform 0.15s; display: inline-block; margin-right: 4px; }
.expandable.open .expand-chevron { transform: rotate(90deg); }

.task-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 8px 0;
}
.badge {
  font-size: 0.6rem; padding: 2px 8px; border-radius: 12px;
  font-weight: 600; text-transform: uppercase; white-space: nowrap; flex-shrink: 0;
}
.badge.pending { background: #1f2937; color: var(--yellow); }
.badge.active { background: #0c2d1a; color: var(--green); }
.badge.completed { background: #1a1a2e; color: var(--purple); }
.badge.blocked { background: #2a1a1a; color: var(--red); }
.badge.failed { background: #2a1a1a; color: var(--red); }
.task-title { font-size: 0.85rem; flex: 1; min-width: 0; word-wrap: break-word; }
.task-priority { font-size: 0.7rem; color: var(--text2); flex-shrink: 0; }
.sched-item { padding: 8px 0; }
.sched-title { font-size: 0.85rem; font-weight: 600; }
.sched-meta {
  display: flex; gap: 8px; margin-top: 3px; font-size: 0.7rem; color: var(--text2);
  flex-wrap: wrap; align-items: center;
}
.sched-recurrence {
  font-size: 0.6rem; padding: 2px 8px; border-radius: 12px;
  background: var(--surface2); color: var(--accent); font-weight: 600;
  text-transform: uppercase;
}
.sched-due { font-family: var(--mono); font-size: 0.7rem; }
.sched-due.overdue { color: var(--red); }
.sched-due.upcoming { color: var(--green); }
.sched-result {
  font-size: 0.75rem; color: var(--text2); margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`;
}

function getUtilStyles(): string {
  return `
.mem-item { padding: 8px 0; border-bottom: 1px solid var(--border); }
.mem-item:last-child { border-bottom: none; }
.mem-key {
  font-size: 0.8rem; font-weight: 600; color: var(--accent);
  font-family: var(--mono); word-break: break-all;
}
.mem-content {
  font-size: 0.8rem; color: var(--text2); margin-top: 2px;
  word-wrap: break-word; overflow-wrap: anywhere;
}
.mem-meta { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.mem-tag {
  font-size: 0.6rem; padding: 1px 6px; border-radius: 8px;
  background: var(--surface2); color: var(--text2);
}
.log-entry {
  padding: 4px 0; font-size: 0.8rem; border-bottom: 1px solid var(--border);
}
.log-entry:last-child { border-bottom: none; }
.log-cat {
  font-size: 0.6rem; padding: 1px 6px; border-radius: 8px;
  background: var(--surface2); color: var(--text2); margin-right: 4px;
}
.empty { color: var(--text2); font-size: 0.8rem; font-style: italic; padding: 12px 0; }
.search-box { padding: 4px 10px; font-size: 0.75rem; background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); outline: none; width: 120px; margin-left: auto; }
.search-box:focus { border-color: var(--accent); }
.search-box::placeholder { color: var(--text2); }
#alerts-banner .alert-item { padding: 3px 0; display: flex; gap: 8px; align-items: center; font-size: 0.8rem; }
#alerts-banner .alert-time { color: var(--text2); font-size: 0.7rem; font-family: var(--mono); flex-shrink: 0; }
#alerts-banner .alert-goal { color: var(--yellow); font-weight: 600; }
.snapshot-bar {
  margin-bottom: var(--gap); padding: 8px 14px; flex-shrink: 0; font-size: 0.8rem; color: var(--text2);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.snapshot-bar strong { color: var(--text); }
.sparkline { display: inline-block; vertical-align: middle; margin-left: 6px; }
.gauge-bar { height: 4px; border-radius: 2px; background: var(--surface2); margin-top: 6px; overflow: hidden; }
.gauge-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }
.stat-card .sub { font-size: 0.6rem; color: var(--text2); margin-top: 2px; }
`;
}

function getResponsiveStyles(): string {
  return `
@media (max-width: 900px) {
  .stats { flex-wrap: wrap; }
  .stat-card { min-width: 80px; }
  .grid-overview { grid-template-columns: 1fr; grid-template-rows: auto; }
  header h1 { font-size: 1.1rem; }
}
@media (max-width: 600px) {
  body { --gap: 8px; }
  header { padding: 8px 10px; gap: 8px; }
  .tabs { padding: 6px 10px; }
  .tab { padding: 5px 10px; font-size: 0.75rem; }
  .tab-page { padding: 8px; }
  .stat-card { padding: 8px 10px; }
  .stat-card .value { font-size: 1.1rem; }
}
[data-theme="high-contrast"] .panel { border-width: 2px; }
[data-theme="high-contrast"] .stat-card { border-width: 2px; }
[data-theme="high-contrast"] .tab.active { border-width: 2px; }
[data-theme="high-contrast"] .btn { border-width: 2px; }
`;
}

function getConversationPanelHtml(): string {
  return `
<div class="tab-page" id="page-conversations">
  <div class="panel" style="flex:1;display:flex;flex-direction:column">
    <div class="panel-header">
      Conversations
      <div class="toolbar">
        <button class="btn primary" onclick="refreshConversations()">Refresh</button>
      </div>
    </div>
    <div class="channel-tabs" id="channel-tabs"></div>
    <div class="convo-layout">
      <div class="convo-messages" id="convo-messages"></div>
      <div class="convo-input-row">
        <input class="convo-input" id="convo-input" placeholder="Type a message..." autocomplete="off" />
        <button class="btn send" onclick="sendMessage()">Send</button>
      </div>
    </div>
  </div>
</div>`;
}

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="midnight">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">
<title>Charlie — Control Plane</title>
<style>
${getThemeStyles()}
${getBaseStyles()}
${getTabStyles()}
${getCardAndPanelStyles()}
${getMessageStyles()}
${getButtonStyles()}
${getTaskStyles()}
${getUtilStyles()}
${getResponsiveStyles()}
${getEditModeStyles()}
${getHeatmapStyles()}
${getClaudeSessionsStyles()}
${getQuickActionsStyles()}
</style>
</head>
<body>

<header>
  <div class="dot" id="status-dot"></div>
  <h1>justclaw</h1>
  <div class="service-indicators" id="service-indicators">
    <span class="svc-dot" id="svc-mcp" title="MCP Server">MCP</span>
    <span class="svc-dot" id="svc-discord" title="Discord Bot">Bot</span>
    <span class="svc-dot" id="svc-dashboard" title="Dashboard">Dash</span>
  </div>
  <div class="header-right">
    ${getEditToggleHtml()}
    <button class="theme-toggle" onclick="cycleTheme()" title="Cycle theme">Theme: <span id="theme-label">midnight</span></button>
    <button class="reset-layout-btn" onclick="resetLayout()" title="Reset to default layout">Reset</button>
    <div class="uptime-info">
      <span id="clock"></span>
      <span class="uptime-badge" id="uptime" title="Dashboard uptime">--</span>
      <span class="uptime-badge" id="refresh-countdown" title="Next refresh">--</span>
    </div>
  </div>
</header>

<div class="tabs" id="tab-bar">
  <div class="tab-list">
    <div class="tab active" data-tab="overview">Overview</div>
    <div class="tab" data-tab="conversations">Conversations</div>
    <div class="tab" data-tab="processes">Processes</div>
    <div class="tab" data-tab="logs">Logs</div>
  </div>
  <div class="tab-bar-right">
    <div class="tab-bar-group" id="tab-bar-sparkline"></div>
    <div class="tab-bar-sep"></div>
    <div class="tab-bar-group">
      <span class="tab-bar-stats-label">Agent</span>
      <span class="tab-bar-stat" id="tbs-runs" title="Agent runs today">--</span>
      <span class="tab-bar-stat" id="tbs-duration" title="Avg duration">--</span>
      <span class="tab-bar-stat" id="tbs-success" title="Success rate">--</span>
    </div>
    <div class="tab-bar-sep"></div>
    <div class="tab-bar-group">
      <span class="tab-bar-stats-label">Claude Code</span>
      <span class="tab-bar-stat" id="tbs-sessions" title="Sessions (7d)">--</span>
      <span class="tab-bar-stat" id="tbs-tokens" title="Total tokens (7d)">--</span>
      <span class="tab-bar-stat" id="tbs-cache" title="Cache hit rate">--</span>
      <span class="tab-bar-stat" id="tbs-cost" title="API equivalent cost (7d)">--</span>
    </div>
  </div>
</div>

<div class="content">

<div class="tab-page active" id="page-overview">
  <div class="stats" id="stats"></div>
  <div id="snapshot-bar" class="snapshot-bar" style="display:none"></div>
  ${getQuickActionsHtml()}
  <div class="grid-overview">
    <div class="panel" data-pid="panel-tasks">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Work Queue</div>
      <div class="panel-body" id="tasks"></div>
    </div>
    <div class="panel" data-pid="panel-scheduled">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Scheduled Tasks</div>
      <div class="panel-body" id="scheduled-tasks"></div>
    </div>
    <div class="panel" data-pid="panel-memories">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Memories <input class="search-box" id="mem-search" placeholder="Search..." /></div>
      <div class="panel-body" id="memories"></div>
    </div>
    <div class="panel" data-pid="panel-convos">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Recent Conversations</div>
      <div class="panel-body" id="overview-convos"></div>
    </div>
    <div class="panel" data-pid="panel-alerts">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Recent Alerts</div>
      <div class="panel-body" id="alerts-banner"></div>
    </div>
    <div class="panel" data-pid="panel-dailylog">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Daily Log</div>
      <div class="panel-body" id="daily-log"></div>
    </div>
    <div class="panel" data-pid="panel-heatmap">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Activity Heatmap</div>
      <div class="panel-body" id="heatmap"></div>
    </div>
    <div class="panel" data-pid="panel-monitors">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Monitor Status</div>
      <div class="panel-body" id="monitor-status"></div>
    </div>
    <div class="panel" data-pid="panel-intelligence">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Agent Intelligence</div>
      <div class="panel-body">
        <div id="learnings-feed"></div>
        <div class="widget-row" id="intel-widgets">
          <div class="widget-card" id="goals-progress"></div>
          <div class="widget-card" id="memory-breakdown"></div>
        </div>
      </div>
    </div>
    <div class="panel" data-pid="panel-claude-sessions">
      <div class="panel-header"><span class="collapse-indicator">&#9660;</span> Claude Code Sessions</div>
      <div class="panel-body" id="claude-sessions"></div>
    </div>
  </div>
</div>

${getConversationPanelHtml()}

<div class="tab-page" id="page-processes">
  <div class="panel" style="flex:1;display:flex;flex-direction:column">
    <div class="panel-header">
      justclaw Processes
      <div class="toolbar">
        <button class="btn primary" onclick="refreshProcesses()">Refresh</button>
      </div>
    </div>
    <div class="panel-body">
      <table class="proc-table">
        <thead><tr><th>PID</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="proc-body"></tbody>
      </table>
    </div>
  </div>
  <div class="panel" style="margin-top:var(--gap);flex-shrink:0">
    <div class="panel-header">Ghost Check State</div>
    <div class="panel-body" id="ghost-state"></div>
  </div>
</div>

<div class="tab-page" id="page-logs">
  <div class="panel" style="flex:1;display:flex;flex-direction:column">
    <div class="panel-header">
      System Logs
      <div class="toolbar">
        <select id="log-filter" class="search-box" style="width:auto" onchange="refreshLogs()">
          <option value="">All loggers</option>
          <option value="mcp-server">MCP Server</option>
          <option value="dashboard">Dashboard</option>
        </select>
        <button class="btn primary" onclick="refreshLogs()">Refresh</button>
      </div>
    </div>
    <div class="panel-body" id="log-entries" style="font-family:var(--mono);font-size:0.75rem"></div>
  </div>
</div>

</div>

<script>
${getDashboardScripts()}
</script>
</body>
</html>`;

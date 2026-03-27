import { Hono } from 'hono';
import { execSync } from 'child_process';
import type { DB } from '../db.js';
import { freemem, totalmem } from 'os';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getAllSessions, getUsageStats } from './claude-sessions.js';
import {
  projectRoot,
  pidStatus,
  getPm2Processes,
  type ResourceHistoryPoint,
} from './api.js';
import { getSqliteUtcOffset, getTimezoneAbbr } from '../time-utils.js';

// Rolling 1-hour history for system resources (60 data points at 1-min resolution)
const resourceHistory: ResourceHistoryPoint[] = [];
const MAX_RESOURCE_HISTORY = 60;

export function registerDataRoutes(api: Hono, db: DB, startTime: number): void {
  api.get('/status', (c) => {
    const pending = db.fetchall(
      "SELECT id, title, priority, status FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC LIMIT 10",
    );
    const memCount = db.fetchone('SELECT COUNT(*) as n FROM memories');
    const logCount = db.fetchone('SELECT COUNT(*) as n FROM daily_log WHERE date = ?', [
      db.today(),
    ]);
    const msgCount = db.fetchone(
      "SELECT COUNT(*) as n FROM conversations WHERE created_at > datetime('now', '-24 hours')",
    );
    const snapshot = db.fetchone(
      'SELECT summary, created_at FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
    );
    return c.json({
      pending_tasks: pending,
      memory_count: (memCount?.n as number) ?? 0,
      today_log_entries: (logCount?.n as number) ?? 0,
      messages_24h: (msgCount?.n as number) ?? 0,
      last_snapshot: snapshot,
    });
  });

  api.get('/tasks', (c) => {
    const status = c.req.query('status') || '';
    const includeScheduled = c.req.query('include_scheduled') === '1';
    const recurrenceFilter = includeScheduled ? '' : 'AND recurrence IS NULL';
    let rows;
    if (status) {
      rows = db.fetchall(
        `SELECT * FROM tasks WHERE status = ? ${recurrenceFilter} ORDER BY priority ASC, created_at DESC`,
        [status],
      );
    } else {
      rows = db.fetchall(
        `SELECT * FROM tasks WHERE 1=1 ${recurrenceFilter} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, priority ASC, created_at DESC LIMIT 50`,
      );
    }
    return c.json(rows);
  });

  api.get('/scheduled-tasks', (c) => {
    const rows = db.fetchall(
      `SELECT id, title, description, status, priority, tags, recurrence, due_at, created_at, updated_at, result
       FROM tasks
       WHERE recurrence IS NOT NULL
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, due_at ASC
       LIMIT 50`,
    );
    return c.json(rows);
  });

  api.get('/memories', (c) => {
    const q = c.req.query('q') || '';
    let rows;
    if (q) {
      rows = db.fetchall(
        'SELECT m.key, m.content, m.type, m.tags, m.namespace, m.access_count, m.last_accessed, m.created_at, m.updated_at FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT 30',
        [q],
      );
    } else {
      rows = db.fetchall(
        'SELECT key, content, type, tags, namespace, access_count, last_accessed, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT 30',
      );
    }
    return c.json(rows);
  });

  api.get('/conversations/channels', (c) => {
    const rows = db.fetchall(
      'SELECT channel, COUNT(*) as count FROM conversations GROUP BY channel ORDER BY count DESC',
    );
    return c.json(rows);
  });

  api.get('/conversations', (c) => {
    const limit = parseInt(c.req.query('limit') || '40', 10);
    const channel = c.req.query('channel') || '';
    let rows;
    if (channel) {
      rows = db.fetchall(
        'SELECT channel, sender, message, is_from_charlie, created_at FROM conversations WHERE channel = ? ORDER BY created_at DESC LIMIT ?',
        [channel, limit],
      );
    } else {
      rows = db.fetchall(
        'SELECT channel, sender, message, is_from_charlie, created_at FROM conversations ORDER BY created_at DESC LIMIT ?',
        [limit],
      );
    }
    rows.reverse();
    return c.json(rows);
  });

  api.get('/daily-log', (c) => {
    const date = c.req.query('date') || db.today();
    const rows = db.fetchall(
      'SELECT entry, category, created_at FROM daily_log WHERE date = ? ORDER BY created_at ASC',
      [date],
    );
    return c.json(rows);
  });

  api.get('/uptime', (c) => {
    return c.json({
      start_time: startTime,
      uptime_seconds: Math.round(Date.now() / 1000 - startTime),
      pid: process.pid,
    });
  });

  api.get('/token-usage', (c) => {
    const todayStart = db.today() + ' 00:00:00';
    const todayTok = db.fetchone("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM process_registry WHERE started_at >= ?", [todayStart]);
    const weekTok = db.fetchone("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM process_registry WHERE started_at >= date('now', '-7 days')");
    const trend = db.fetchall("SELECT date(started_at) as day, SUM(input_tokens) as input, SUM(output_tokens) as output FROM process_registry WHERE started_at >= date('now', '-7 days') AND (input_tokens > 0 OR output_tokens > 0) GROUP BY day ORDER BY day");
    const wIn = (weekTok?.input as number) || 0, wOut = (weekTok?.output as number) || 0;
    return c.json({ today: todayTok, week: weekTok, trend, equivalent_cost_usd: Math.round(((wIn / 1e6) * 15 + (wOut / 1e6) * 75) * 100) / 100 });
  });

  api.get('/learnings', (c) => {
    const limit = parseInt(c.req.query('limit') || '5', 10);
    const rows = db.fetchall(
      'SELECT category, trigger, lesson, area, created_at FROM learnings ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    const stats = db.fetchall(
      'SELECT category, COUNT(*) as count FROM learnings GROUP BY category',
    );
    return c.json({ learnings: rows, stats });
  });

  api.get('/goals', (c) => {
    const goals = db.fetchall(
      "SELECT key, content, tags FROM memories WHERE type = 'goal' AND namespace = 'goals' ORDER BY created_at DESC",
    );
    const enriched = goals.map((g) => enrichGoal(db, g));
    return c.json({ goals: enriched });
  });

  api.get('/monitors-status', (c) => {
    try {
      const monitors = db.fetchall(
        `SELECT m.name, m.enabled, m.condition_type,
          (SELECT status FROM monitor_history WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1) as last_status,
          (SELECT value FROM monitor_history WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1) as last_value,
          (SELECT checked_at FROM monitor_history WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1) as last_checked
        FROM monitors m ORDER BY m.name`,
      );
      return c.json({ monitors });
    } catch { /* monitors table may not exist yet on fresh installs */
      return c.json({ monitors: [] });
    }
  });

  api.get('/memory-breakdown', (c) => {
    const byNamespace = db.fetchall(
      'SELECT COALESCE(namespace, \'default\') as namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY count DESC',
    );
    const byType = db.fetchall(
      'SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC',
    );
    const total = db.fetchone('SELECT COUNT(*) as n FROM memories');
    return c.json({ byNamespace, byType, total: (total?.n as number) || 0 });
  });

  api.get('/agent-throughput', (c) => {
    const todayStart = db.today() + ' 00:00:00';
    const runs = db.fetchone(
      "SELECT COUNT(*) as total, AVG(CASE WHEN retired_at IS NOT NULL THEN (julianday(retired_at) - julianday(started_at)) * 86400 END) as avg_duration_s FROM process_registry WHERE role = 'claude-p' AND started_at >= ?",
      [todayStart],
    );
    const active = db.fetchone(
      "SELECT COUNT(*) as n FROM process_registry WHERE role = 'claude-p' AND status = 'active'",
    );
    const tasksCompleted = db.fetchone(
      "SELECT COUNT(*) as n FROM tasks WHERE status = 'completed' AND completed_at >= ?",
      [todayStart],
    );
    const tasksFailed = db.fetchone(
      "SELECT COUNT(*) as n FROM tasks WHERE status = 'failed' AND completed_at >= ?",
      [todayStart],
    );
    return c.json({
      runs_today: (runs?.total as number) || 0,
      avg_duration_s: Math.round((runs?.avg_duration_s as number) || 0),
      active: (active?.n as number) || 0,
      tasks_completed: (tasksCompleted?.n as number) || 0,
      tasks_failed: (tasksFailed?.n as number) || 0,
    });
  });

  api.get('/heatmap', (c) => {
    const offset = getSqliteUtcOffset();
    const convRows = db.fetchall(
      `SELECT strftime('%w', created_at, '${offset}') as dow, strftime('%H', created_at, '${offset}') as hour, COUNT(*) as count FROM conversations WHERE created_at >= date('now', '-30 days') GROUP BY dow, hour`,
    );
    const procRows = db.fetchall(
      `SELECT strftime('%w', started_at, '${offset}') as dow, strftime('%H', started_at, '${offset}') as hour, COUNT(*) as count FROM process_registry WHERE started_at >= date('now', '-30 days') GROUP BY dow, hour`,
    );

    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    for (const row of [...convRows, ...procRows]) {
      const val = (grid[Number(row.dow)][Number(row.hour)] += row.count as number);
      if (val > max) max = val;
    }
    return c.json({
      grid,
      max,
      days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      tz: getTimezoneAbbr(),
    });
  });

  api.get('/claude-sessions', (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    return c.json(getAllSessions(Math.min(limit, 100)));
  });

  api.get('/claude-usage', (c) => {
    const days = parseInt(c.req.query('days') || '7', 10);
    return c.json(getUsageStats(Math.min(days, 90)));
  });

  api.get('/metrics', (c) => {
    return c.json(buildMetrics(db));
  });

  api.get('/system-resources', (c) => {
    return c.json(buildSystemResources(resourceHistory, MAX_RESOURCE_HISTORY));
  });

  api.get('/logs', (c) => {
    const loggerName = c.req.query('logger') || '';
    const lines = parseInt(c.req.query('lines') || '100', 10);
    return c.json(readLogEntries(loggerName, lines));
  });
}

// --- Helpers (extracted to stay under 50-line function limit) ---

function enrichGoal(db: DB, g: Record<string, unknown>): Record<string, unknown> {
  const title = (g.key as string) || '';
  const searchTerm = `%${title.split('-').join('%')}%`;
  const completed = db.fetchone(
    "SELECT COUNT(*) as n FROM tasks WHERE status = 'completed' AND (title LIKE ? OR tags LIKE ?)",
    [searchTerm, `%${title}%`],
  );
  const total = db.fetchone(
    'SELECT COUNT(*) as n FROM tasks WHERE title LIKE ? OR tags LIKE ?',
    [searchTerm, `%${title}%`],
  );
  return {
    title,
    content: (g.content as string || '').substring(0, 200),
    tags: g.tags,
    completed: (completed?.n as number) || 0,
    total: (total?.n as number) || 0,
  };
}

function buildMetrics(db: DB): Record<string, unknown> {
  const memFree = freemem();
  const memTotal = totalmem();
  const memUsedPct = Math.round((1 - memFree / memTotal) * 100);
  let diskUsedPct = 0;
  try {
    const df = execSync('df -h /home --output=pcent 2>/dev/null | tail -1', { timeout: 3000 }).toString().trim();
    diskUsedPct = parseInt(df.replace('%', ''), 10) || 0;
  } catch { /* df command unavailable or timed out, default to 0% */ }

  const { agentRuns, activeAgents } = getAgentStats(db);
  const msgTrend = db.fetchall(
    "SELECT date(created_at) as day, COUNT(*) as count FROM conversations WHERE created_at >= date('now', '-7 days') GROUP BY day ORDER BY day ASC",
  );
  const taskTrend = db.fetchall(
    "SELECT date(completed_at) as day, COUNT(*) as count FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= date('now', '-7 days') GROUP BY day ORDER BY day ASC",
  );
  const recentEscalations = db.fetchall(
    "SELECT goal, trigger_detail, outcome, created_at FROM escalation_log ORDER BY created_at DESC LIMIT 5",
  );
  const services = getServiceHealth(db);

  return {
    system: { mem_used_pct: memUsedPct, mem_total_mb: Math.round(memTotal / 1048576), disk_used_pct: diskUsedPct },
    agents: { runs_today: (agentRuns?.total as number) || 0, avg_duration_s: Math.round((agentRuns?.avg_duration_s as number) || 0), active: (activeAgents?.n as number) || 0 },
    trends: { messages: msgTrend, tasks_completed: taskTrend },
    escalations: recentEscalations,
    services,
  };
}

function getAgentStats(db: DB): { agentRuns: Record<string, unknown> | null; activeAgents: Record<string, unknown> | null } {
  const todayStart = db.today() + ' 00:00:00';
  const agentRuns = db.fetchone(
    "SELECT COUNT(*) as total, AVG(CAST((julianday(retired_at) - julianday(started_at)) * 86400 AS INTEGER)) as avg_duration_s FROM process_registry WHERE role = 'claude-p' AND started_at >= ? AND retired_at IS NOT NULL",
    [todayStart],
  );
  const activeAgents = db.fetchone(
    "SELECT COUNT(*) as n FROM process_registry WHERE role = 'claude-p' AND status = 'active'",
  );
  return { agentRuns, activeAgents };
}

function getServiceHealth(db: DB): Record<string, unknown> {
  const mcp = pidStatus('justclaw');
  const dashboard = pidStatus('dashboard');
  const discordBot = db.fetchone(
    "SELECT pid, status FROM process_registry WHERE role = 'discord-bot' AND status = 'active' ORDER BY started_at DESC LIMIT 1",
  );
  let botAlive = false;
  if (discordBot?.pid) {
    try { process.kill(discordBot.pid as number, 0); botAlive = true; } catch { /* ESRCH: process no longer running */ }
  }
  return {
    mcp: { alive: mcp.alive, pid: mcp.pid, label: mcp.alive ? 'online' : 'standby' },
    dashboard: { alive: dashboard.alive, pid: dashboard.pid, label: 'online' },
    discord: { alive: botAlive, pid: (discordBot?.pid as number) || null, label: botAlive ? 'online' : 'offline' },
  };
}

function buildSystemResources(
  history: ResourceHistoryPoint[],
  maxHistory: number,
): Record<string, unknown> {
  const memTotal = totalmem();
  const memUsed = memTotal - freemem();
  const memUsedMb = Math.round(memUsed / 1048576);
  const memTotalMb = Math.round(memTotal / 1048576);
  const memPercent = Math.round((memUsed / memTotal) * 100);

  let swapUsedMb = 0, swapTotalMb = 0;
  try {
    const freeOut = execSync('free -b 2>/dev/null | grep -i swap', { timeout: 3000 }).toString().trim();
    const parts = freeOut.split(/\s+/);
    if (parts.length >= 3) {
      swapTotalMb = Math.round(parseInt(parts[1], 10) / 1048576);
      swapUsedMb = Math.round(parseInt(parts[2], 10) / 1048576);
    }
  } catch { /* free command unavailable or timed out, default to 0 */ }

  const processes = getPm2Processes();

  // Collect history point (throttled to 1 per 60s)
  const now = Math.floor(Date.now() / 1000);
  const lastT = history.length > 0 ? history[history.length - 1].t : 0;
  if (now - lastT >= 60) {
    const dashProc = processes.find((p) => p.name.includes('dashboard'));
    const discordProc = processes.find((p) => p.name.includes('discord'));
    history.push({
      t: now,
      mem_pct: memPercent,
      dashboard_mb: dashProc?.rss_mb ?? 0,
      discord_mb: discordProc?.rss_mb ?? 0,
    });
    while (history.length > maxHistory) history.shift();
  }

  return {
    current: { mem_used_mb: memUsedMb, mem_total_mb: memTotalMb, mem_percent: memPercent, swap_used_mb: swapUsedMb, swap_total_mb: swapTotalMb },
    processes,
    history,
  };
}

function readLogEntries(loggerName: string, lines: number): unknown[] {
  const logDir = join(projectRoot(), 'data', 'logs');
  if (!existsSync(logDir)) return [];

  const pattern = loggerName ? `${loggerName}_` : '';
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith('.jsonl') && f.includes(pattern))
    .sort()
    .reverse();

  const entries: unknown[] = [];
  for (const f of files.slice(0, 7)) {
    try {
      const content = readFileSync(join(logDir, f), 'utf-8').trim().split('\n');
      for (const line of content.reverse()) {
        if (entries.length >= lines) break;
        try {
          entries.push(JSON.parse(line));
        } catch { /* malformed JSON log line, skip */ }
      }
    } catch { /* log file unreadable or deleted, skip */ }
    if (entries.length >= lines) break;
  }
  entries.reverse();
  return entries;
}

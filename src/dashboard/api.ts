import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { spawn as spawnChild, execSync } from 'child_process';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { addClient, removeClient, pushEvent } from './sse.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { freemem, totalmem } from 'os';
import { getAllSessions, getUsageStats } from './claude-sessions.js';

const log = getLogger('dashboard');

function projectRoot(): string {
  return process.env.JUSTCLAW_ROOT || process.cwd();
}

function pidFilePath(name: string): string {
  return join(projectRoot(), 'data', `${name}.pid`);
}

function pidStatus(name: string): { pid: number | null; alive: boolean; file: string } {
  const path = pidFilePath(name);
  if (!existsSync(path)) return { pid: null, alive: false, file: `${name}.pid` };
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return { pid, alive: true, file: `${name}.pid` };
  } catch {
    return { pid: null, alive: false, file: `${name}.pid` };
  }
}

export function createApiRoutes(db: DB): Hono {
  const api = new Hono();
  const startTime = Date.now() / 1000;

  // --- Data API endpoints ---
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

  // --- Token usage (equivalent cost — included in Max plan, shown for reference) ---
  api.get('/token-usage', (c) => {
    const todayStart = db.today() + ' 00:00:00';
    const todayTok = db.fetchone("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM process_registry WHERE started_at >= ?", [todayStart]);
    const weekTok = db.fetchone("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM process_registry WHERE started_at >= date('now', '-7 days')");
    const trend = db.fetchall("SELECT date(started_at) as day, SUM(input_tokens) as input, SUM(output_tokens) as output FROM process_registry WHERE started_at >= date('now', '-7 days') AND (input_tokens > 0 OR output_tokens > 0) GROUP BY day ORDER BY day");
    const wIn = (weekTok?.input as number) || 0, wOut = (weekTok?.output as number) || 0;
    return c.json({ today: todayTok, week: weekTok, trend, equivalent_cost_usd: Math.round(((wIn / 1e6) * 15 + (wOut / 1e6) * 75) * 100) / 100 });
  });

  let chatSessionId: string | null = null; // Persists across messages for multi-turn conversation
  api.post('/conversations/send', async (c) => {
    const body = await c.req.json<{ message?: string; sender?: string; channel?: string }>();
    const message = (body.message || '').trim();
    const sender = (body.sender || 'dashboard-user').trim();
    const channel = (body.channel || 'dashboard').trim();
    if (!message) return c.json({ error: 'message required' }, 400);

    // Log the user message.
    const now = db.now();
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
      [channel, sender, message, now],
    );

    // Call claude -p with session resume for multi-turn.
    try {
      const args = ['-p', message, '--output-format', 'json'];
      if (chatSessionId) {
        args.push('--resume', chatSessionId);
      }

      // Find claude binary — check common locations.
      const home = process.env.HOME || '';
      const candidates = [
        home + '/.local/bin/claude',
        home + '/.claude/local/claude',
        '/usr/local/bin/claude',
      ];
      let claudeBin = 'claude';
      for (const p of candidates) {
        if (existsSync(p)) { claudeBin = p; break; }
      }

      log.info('Calling claude', { bin: claudeBin, args: args.slice(0, 3), sessionId: chatSessionId });

      // Use setsid to run claude in a new session so it can't kill our process group.
      const shellCmd = [claudeBin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const response = await new Promise<string>((resolve, reject) => {
        const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
          log.error('claude spawn error', { error: String(err) });
          reject(new Error(String(err)));
        });
        child.on('close', (code) => {
          if (code !== 0) {
            log.error('claude -p exited non-zero', { code, stderr: stderr.slice(0, 500) });
            reject(new Error(stderr || `claude exited with code ${code}`));
          } else {
            resolve(stdout);
          }
        });
      });

      // Parse JSON response from claude.
      let replyText = '';
      let sessionId = chatSessionId;
      try {
        const parsed = JSON.parse(response);
        replyText = parsed.result || response;
        if (parsed.session_id) {
          sessionId = parsed.session_id;
          chatSessionId = sessionId;
        }
      } catch {
        // If not JSON, use raw output.
        replyText = response.trim();
      }

      // Log Claude's response.
      const replyNow = db.now();
      db.execute(
        'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
        [channel, 'charlie', replyText, replyNow],
      );

      pushEvent('refresh', JSON.stringify({ reason: 'chat_response' }));

      return c.json({
        ok: true,
        reply: replyText,
        session_id: sessionId,
        created_at: replyNow,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Process management ---
  api.get('/processes', (c) => c.json({ mcp_server: pidStatus('justclaw'), dashboard: pidStatus('dashboard') }));
  api.post('/processes/kill', async (c) => {
    const body = await c.req.json<{ pid?: number }>();
    if (!body.pid) return c.json({ error: 'pid required' }, 400);
    if (body.pid === process.pid) return c.json({ error: 'cannot kill self' }, 400);
    try {
      process.kill(body.pid, 'SIGTERM');
      log.info('Manual kill', { pid: body.pid });
      pushEvent('refresh', JSON.stringify({ reason: 'manual_kill', pid: body.pid }));
      return c.json({ killed: body.pid });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });
  api.post('/processes/check-ghosts', (c) => {
    const mcp = pidStatus('justclaw');
    const dashboard = pidStatus('dashboard');
    const stale: string[] = [];
    if (!mcp.alive && mcp.pid !== null) stale.push('justclaw.pid');
    if (!dashboard.alive && dashboard.pid !== null) stale.push('dashboard.pid');
    return c.json({ mcp_server: mcp, dashboard, stale_pid_files: stale });
  });
  api.get('/ghost-state', (c) => {
    const path = join(projectRoot(), 'data', 'ghost_check_state.json');
    if (existsSync(path)) {
      try {
        return c.json(JSON.parse(readFileSync(path, 'utf-8')));
      } catch {
        /* ignore */
      }
    }
    return c.json({ skip_budget: 0, forced_remaining: 0, total_checks: 0 });
  });

  api.get('/logs', (c) => {
    const loggerName = c.req.query('logger') || '';
    const lines = parseInt(c.req.query('lines') || '100', 10);
    const logDir = join(projectRoot(), 'data', 'logs');
    if (!existsSync(logDir)) return c.json([]);

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
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        /* ignore */
      }
      if (entries.length >= lines) break;
    }
    entries.reverse();
    return c.json(entries);
  });

  // --- Metrics (aggregated for dashboard) ---
  api.get('/metrics', (c) => {
    // System resources
    const memFree = freemem();
    const memTotal = totalmem();
    const memUsedPct = Math.round((1 - memFree / memTotal) * 100);
    let diskUsedPct = 0;
    try {
      const df = execSync('df -h /home --output=pcent 2>/dev/null | tail -1', { timeout: 3000 }).toString().trim();
      diskUsedPct = parseInt(df.replace('%', ''), 10) || 0;
    } catch { /* ignore */ }

    // Agent runs today (claude-p processes)
    const todayStart = db.today() + ' 00:00:00';
    const agentRuns = db.fetchone(
      "SELECT COUNT(*) as total, AVG(CAST((julianday(retired_at) - julianday(started_at)) * 86400 AS INTEGER)) as avg_duration_s FROM process_registry WHERE role = 'claude-p' AND started_at >= ? AND retired_at IS NOT NULL",
      [todayStart],
    );
    const activeAgents = db.fetchone(
      "SELECT COUNT(*) as n FROM process_registry WHERE role = 'claude-p' AND status = 'active'",
    );

    // Message trend (last 7 days)
    const msgTrend = db.fetchall(
      "SELECT date(created_at) as day, COUNT(*) as count FROM conversations WHERE created_at >= date('now', '-7 days') GROUP BY day ORDER BY day ASC",
    );

    // Task completion trend (last 7 days)
    const taskTrend = db.fetchall(
      "SELECT date(completed_at) as day, COUNT(*) as count FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= date('now', '-7 days') GROUP BY day ORDER BY day ASC",
    );

    // Recent escalations (alerts)
    const recentEscalations = db.fetchall(
      "SELECT goal, trigger_detail, outcome, created_at FROM escalation_log ORDER BY created_at DESC LIMIT 5",
    );

    // Service health
    const mcp = pidStatus('justclaw');
    const dashboard = pidStatus('dashboard');
    const discordBot = db.fetchone(
      "SELECT pid, status FROM process_registry WHERE role = 'discord-bot' AND status = 'active' ORDER BY started_at DESC LIMIT 1",
    );
    let botAlive = false;
    if (discordBot?.pid) {
      try { process.kill(discordBot.pid as number, 0); botAlive = true; } catch { /* dead */ }
    }

    return c.json({
      system: { mem_used_pct: memUsedPct, mem_total_mb: Math.round(memTotal / 1048576), disk_used_pct: diskUsedPct },
      agents: { runs_today: (agentRuns?.total as number) || 0, avg_duration_s: Math.round((agentRuns?.avg_duration_s as number) || 0), active: (activeAgents?.n as number) || 0 },
      trends: { messages: msgTrend, tasks_completed: taskTrend },
      escalations: recentEscalations,
      services: {
        mcp: { alive: mcp.alive, pid: mcp.pid, label: mcp.alive ? 'online' : 'standby' },
        dashboard: { alive: dashboard.alive, pid: dashboard.pid, label: 'online' },
        discord: { alive: botAlive, pid: (discordBot?.pid as number) || null, label: botAlive ? 'online' : 'offline' },
      },
    });
  });

  // --- Actions ---
  api.post('/actions/build', (c) => {
    try {
      const output = execSync('npm run build', { cwd: projectRoot(), timeout: 60000, encoding: 'utf-8' });
      log.info('Build completed via dashboard');
      return c.json({ ok: true, output: output.slice(-2000) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('Build failed via dashboard', { error: msg.slice(0, 500) });
      return c.json({ error: msg.slice(0, 2000) }, 500);
    }
  });

  // --- Activity Heatmap ---
  api.get('/heatmap', (c) => {
    const convRows = db.fetchall(
      "SELECT strftime('%w', created_at) as dow, strftime('%H', created_at) as hour, COUNT(*) as count FROM conversations WHERE created_at >= date('now', '-30 days') GROUP BY dow, hour",
    );
    const procRows = db.fetchall(
      "SELECT strftime('%w', started_at) as dow, strftime('%H', started_at) as hour, COUNT(*) as count FROM process_registry WHERE started_at >= date('now', '-30 days') GROUP BY dow, hour",
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
    });
  });

  // --- Webhook ---
  let lastWebhookTime = 0;
  api.post('/webhook', async (c) => {
    const token = process.env.JUSTCLAW_WEBHOOK_TOKEN;
    if (!token) return c.json({ error: 'Webhook not configured' }, 503);

    const auth = c.req.header('Authorization') || '';
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const now = Date.now();
    if (now - lastWebhookTime < 1000) {
      return c.json({ error: 'Rate limited' }, 429);
    }
    lastWebhookTime = now;

    const body = await c.req.json<{ message?: string; sender?: string; channel?: string }>();
    const message = (body.message || '').trim();
    if (!message) return c.json({ error: 'message required' }, 400);

    const sender = (body.sender || 'webhook').trim();
    const channel = (body.channel || 'webhook').trim();
    const ts = db.now();
    const result = db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
      [channel, sender, message, ts],
    );
    pushEvent('refresh', JSON.stringify({ reason: 'webhook' }));
    return c.json({ ok: true, id: Number(result.lastInsertRowid) });
  });

  // --- Claude Code CLI sessions ---
  api.get('/claude-sessions', (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    return c.json(getAllSessions(Math.min(limit, 100)));
  });

  api.get('/claude-usage', (c) => {
    const days = parseInt(c.req.query('days') || '7', 10);
    return c.json(getUsageStats(Math.min(days, 90)));
  });

  // --- SSE ---
  api.get('/events', (c) => {
    return stream(c, async (s) => {
      const readable = new ReadableStream<string>({
        start(controller) {
          const client = addClient(controller);
          controller.enqueue('event: connected\ndata: ok\n\n');

          // Cleanup on abort
          c.req.raw.signal.addEventListener('abort', () => {
            removeClient(client);
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          });
        },
      });

      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } catch {
        /* stream closed */
      }
    });
  });

  // ── Browser Extension Bridge ──

  // In-memory command queue for the browser extension
  // Commands are queued by agents/API, picked up by the extension via polling
  interface ExtensionCommand {
    id: string;
    type: string;
    createdAt: number;
    pickedUp: boolean;
    result?: unknown;
    completedAt?: number;
    [key: string]: unknown;
  }

  const extensionCommands: ExtensionCommand[] = [];
  const MAX_EXTENSION_COMMANDS = 100;
  const COMMAND_TTL_MS = 5 * 60 * 1000; // 5 min TTL

  function pruneExtensionCommands(): void {
    const now = Date.now();
    while (extensionCommands.length > 0 && now - extensionCommands[0].createdAt > COMMAND_TTL_MS) {
      extensionCommands.shift();
    }
    while (extensionCommands.length > MAX_EXTENSION_COMMANDS) {
      extensionCommands.shift();
    }
  }

  // GET /api/extension-commands — extension polls for pending commands
  api.get('/extension-commands', (c) => {
    pruneExtensionCommands();
    const pickup = c.req.query('pickup') === 'true';
    const pending = extensionCommands.filter((cmd) => !cmd.pickedUp && !cmd.result);

    if (pickup) {
      for (const cmd of pending) {
        cmd.pickedUp = true;
      }
    }

    return c.json({ commands: pending });
  });

  // POST /api/extension-commands — queue a new command OR post a result
  api.post('/extension-commands', async (c) => {
    const body = await c.req.json();

    // If body has cmdId + result, it's a result post from the extension
    if (body.cmdId && body.result !== undefined) {
      const cmd = extensionCommands.find((cmd) => cmd.id === body.cmdId);
      if (cmd) {
        cmd.result = body.result;
        cmd.completedAt = Date.now();
      }
      return c.json({ ok: true });
    }

    // Otherwise it's a new command to queue
    pruneExtensionCommands();
    const id = body.id || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cmd: ExtensionCommand = {
      id,
      type: body.type,
      createdAt: Date.now(),
      pickedUp: false,
      ...body,
    };
    extensionCommands.push(cmd);
    return c.json({ queued: true, id });
  });

  // GET /api/extension-commands/:id — check result of a specific command
  api.get('/extension-commands/:id', (c) => {
    const id = c.req.param('id');
    const cmd = extensionCommands.find((cmd) => cmd.id === id);
    if (!cmd) return c.json({ error: 'Command not found' }, 404);
    return c.json(cmd);
  });

  // POST /api/usage-calibration — receive usage data from the extension
  api.post('/usage-calibration', async (c) => {
    const data = await c.req.json();
    const now = new Date().toISOString();

    // Store in state table for persistence
    try {
      db.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('extension_usage', ?)",
        [JSON.stringify({ ...data, receivedAt: now })],
      );
      db.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('extension_last_seen', ?)",
        [now],
      );
    } catch (err) {
      log.error('Failed to store usage data', { error: String(err) });
    }

    log.info('Usage calibration received', {
      session: data.session,
      weeklyAll: data.weeklyAll,
      plan: data.planInfo,
    });

    return c.json({ ok: true, receivedAt: now });
  });

  // GET /api/usage-calibration — read last usage data
  api.get('/usage-calibration', (c) => {
    const row = db.fetchone("SELECT value FROM state WHERE key = 'extension_usage'");
    if (!row) return c.json({ error: 'No usage data yet' }, 404);
    try {
      return c.json(JSON.parse(row.value as string));
    } catch {
      return c.json({ error: 'Corrupt usage data' }, 500);
    }
  });

  // GET /api/extension-status — check if extension is connected
  api.get('/extension-status', (c) => {
    const lastSeen = db.fetchone("SELECT value FROM state WHERE key = 'extension_last_seen'");
    const usage = db.fetchone("SELECT value FROM state WHERE key = 'extension_usage'");

    let connected = false;
    let lastSeenAt: string | null = null;
    if (lastSeen) {
      lastSeenAt = lastSeen.value as string;
      const age = Date.now() - new Date(lastSeenAt).getTime();
      connected = age < 15 * 60 * 1000; // Connected if seen within 15 min
    }

    let usageData = null;
    if (usage) {
      try { usageData = JSON.parse(usage.value as string); } catch { /* ignore */ }
    }

    return c.json({
      connected,
      lastSeenAt,
      pendingCommands: extensionCommands.filter((cmd) => !cmd.pickedUp && !cmd.result).length,
      usage: usageData ? {
        session: usageData.session,
        weeklyAll: usageData.weeklyAll,
        weeklySonnet: usageData.weeklySonnet,
        planInfo: usageData.planInfo,
      } : null,
    });
  });

  return api;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from './db.js';
import { loadConfig, resolveDbPath, type CharlieConfig } from './config.js';
import { registerMemoryTools } from './memory.js';
import { registerTaskTools } from './tasks.js';
import { registerContextTools } from './context.js';
import { registerConversationTools } from './conversations.js';
import { registerGoalTools } from './goals.js';
import { registerLearningTools } from './learnings.js';
import { registerNotebookTools } from './notebooks.js';
import { gatherSignals, type AnticipationSignal } from './discord/anticipation.js';
import { addToWhitelist, removeFromWhitelist, getWhitelist, silenceAlert, unsilenceAlert, getActiveSilences } from './alert-manager.js';
import { auditProcesses, getSuspiciousProcesses, getSuggestions, registerProcess, retireProcess } from './process-registry.js';
import { spawnDashboard, readPidFile } from './processes.js';
import { getLogger } from './logger.js';

const log = getLogger('server');

let _db: DB | null = null;
let _config: CharlieConfig | null = null;

export function createServer(opts: {
  configPath?: string;
  projectRoot?: string;
}): McpServer {
  _config = loadConfig(opts.configPath);
  const dbPath = resolveDbPath(_config, opts.projectRoot);
  _db = new DB(dbPath);

  // Register this MCP server process so the heartbeat doesn't flag it as suspicious.
  registerProcess(_db, process.pid, 'mcp-server');

  const server = new McpServer({
    name: 'justclaw',
    version: '0.1.0',
  });

  // Register all tool modules.
  registerMemoryTools(server, _db);
  registerTaskTools(server, _db);
  registerContextTools(server, _db);
  registerConversationTools(server, _db);
  registerGoalTools(server, _db);
  registerLearningTools(server, _db);
  registerNotebookTools(server, _db);
  // Process management tools — delegate to process-registry.ts (SQLite-backed).
  server.tool(
    'process_check',
    'Audit justclaw processes: find dead, kill retired orphans, detect suspicious. Uses SQLite process registry with safety scoring.',
    {},
    async () => {
      const result = auditProcesses(_db!);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'process_restart_self',
    'Restart the justclaw MCP server to pick up code changes.',
    {},
    async () => {
      process.exit(0);
      return { content: [{ type: 'text', text: 'Restarting...' }] };
    },
  );

  server.tool(
    'process_restart_dashboard',
    'Restart the justclaw dashboard.',
    {},
    async () => {
      const dashPid = readPidFile('dashboard');
      const killed: number[] = [];
      if (dashPid !== null) {
        try {
          process.kill(dashPid, 'SIGTERM');
          killed.push(dashPid);
        } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('Dashboard kill failed', { dashPid, error: String(e) }); }
      }
      await new Promise((r) => setTimeout(r, 500));
      spawnDashboard();
      return {
        content: [{ type: 'text', text: JSON.stringify({ killed_old: killed, started_new: true }, null, 2) }],
      };
    },
  );

  server.tool(
    'process_ghost_status',
    'Get suspicious process tracking state from the registry.',
    {},
    async () => {
      const suspicious = getSuspiciousProcesses(_db!);
      const suggestions = getSuggestions(_db!);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ suspicious_count: suspicious.length, suspicious, suggestions }, null, 2),
        }],
      };
    },
  );

  // Inline tools: state_get, state_set, status.

  server.tool(
    'state_get',
    'Get a value from the persistent key-value store.',
    { key: z.string().describe('The key to look up') },
    async ({ key }) => {
      const row = _db!.fetchone('SELECT value FROM state WHERE key = ?', [key]);
      const text = row ? String(row.value) : `No state found for key '${key}'.`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'state_set',
    'Set a value in the persistent key-value store.',
    {
      key: z.string().describe("The key (e.g. 'last_briefing_date')"),
      value: z.string().describe('The value to store'),
    },
    async ({ key, value }) => {
      const now = _db!.now();
      _db!.execute(
        'INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
        [key, value, now],
      );
      return { content: [{ type: 'text', text: `State '${key}' set.` }] };
    },
  );

  server.tool(
    'status',
    "Get Charlie's current status: pending tasks, recent activity, memory count.",
    {},
    async () => {
      const pendingTasks = _db!.fetchall(
        "SELECT id, title, priority FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC LIMIT 5",
      );
      const memoryCount = _db!.fetchone('SELECT COUNT(*) as count FROM memories');
      const todayLogCount = _db!.fetchone(
        'SELECT COUNT(*) as count FROM daily_log WHERE date = ?',
        [_db!.today()],
      );
      const recentSnapshot = _db!.fetchone(
        'SELECT session_id, summary, created_at FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
      );
      const recentMessages = _db!.fetchone(
        "SELECT COUNT(*) as count FROM conversations WHERE created_at > datetime('now', '-24 hours')",
      );

      const result = {
        pending_tasks: pendingTasks,
        memory_count: memoryCount?.count ?? 0,
        today_log_entries: todayLogCount?.count ?? 0,
        last_context_snapshot: recentSnapshot,
        messages_last_24h: recentMessages?.count ?? 0,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // System health: escalation recommendations + escalation history.
  server.tool(
    'system_recommendations',
    `Get pending system improvement recommendations from automated troubleshooting.
When the heartbeat detects persistent issues, it escalates to Claude for diagnosis.
Claude's recommendations for improving the deterministic checks are stored here.
**When to use:** At session start, during system updates, or when investigating recurring issues.
Review these and implement the suggestions to make the system handle more cases automatically.`,
    {},
    async () => {
      const recs = _db!.fetchall(
        `SELECT id, goal, recommendation, diagnosis, action_taken, outcome, created_at
         FROM escalation_log WHERE recommendation != '' AND recommendation IS NOT NULL
         ORDER BY created_at DESC LIMIT 20`,
      );
      if (recs.length === 0) {
        return { content: [{ type: 'text', text: 'No pending recommendations. System is handling all cases deterministically.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(recs, null, 2) }] };
    },
  );

  server.tool(
    'system_escalation_history',
    'View history of automated troubleshooting escalations — diagnoses, actions taken, outcomes.',
    {
      limit: z.number().default(10).describe('Max entries to return'),
      goal: z.string().default('').describe('Filter by goal (e.g., "heartbeat:CRASH_LOOP"). Empty = all.'),
    },
    async ({ limit, goal }) => {
      let sql = 'SELECT * FROM escalation_log';
      const params: unknown[] = [];
      if (goal) { sql += ' WHERE goal = ?'; params.push(goal); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      const rows = _db!.fetchall(sql, params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  // Anticipation: predict what user needs next based on signals.
  server.tool(
    'anticipate_next',
    `Gather signals about recent work, goals, time patterns, learnings, and conversations,
then predict what the user likely wants or needs to do next.
Returns deterministic signals — the Discord bot uses these with an LLM to generate suggestions.
**When to use:** At session start, when the user seems unsure what to do, or to proactively suggest next steps.`,
    {},
    async () => {
      const signals: AnticipationSignal[] = gatherSignals(_db!);
      const formatted = signals.map((s) => ({
        category: s.category,
        detail: s.detail,
        data: s.data,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ signals: formatted, count: signals.length }, null, 2) }] };
    },
  );

  // Alert management tools.
  server.tool(
    'alert_whitelist',
    'Manage the process whitelist — add/remove/list processes that should never be flagged by the system monitor.',
    {
      action: z.enum(['add', 'remove', 'list']).describe('Action to perform'),
      pattern: z.string().default('').describe('Process name pattern (for add/remove)'),
      reason: z.string().default('').describe('Why this process is whitelisted (for add)'),
    },
    async ({ action, pattern, reason }) => {
      if (action === 'list') {
        const entries = getWhitelist(_db!);
        return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
      } else if (action === 'add' && pattern) {
        addToWhitelist(_db!, pattern, reason);
        return { content: [{ type: 'text', text: `Added '${pattern}' to process whitelist.` }] };
      } else if (action === 'remove' && pattern) {
        removeFromWhitelist(_db!, pattern);
        return { content: [{ type: 'text', text: `Removed '${pattern}' from process whitelist.` }] };
      }
      return { content: [{ type: 'text', text: 'Usage: action=add|remove|list, pattern=<name>' }] };
    },
  );

  server.tool(
    'alert_silence',
    'Silence or unsilence heartbeat alert codes. Silenced alerts are suppressed from Discord.',
    {
      action: z.enum(['silence', 'unsilence', 'list']).describe('Action to perform'),
      code: z.string().default('').describe('Alert code (e.g., SYSTEM_RESOURCES, UNANSWERED_MSG)'),
      hours: z.number().default(0).describe('Duration in hours. 0 = forever.'),
      reason: z.string().default('').describe('Why this alert is silenced'),
    },
    async ({ action, code, hours, reason }) => {
      if (action === 'list') {
        const silences = getActiveSilences(_db!);
        return { content: [{ type: 'text', text: JSON.stringify(silences, null, 2) }] };
      } else if (action === 'silence' && code) {
        silenceAlert(_db!, code, hours * 60, reason);
        const dur = hours > 0 ? `for ${hours}h` : 'permanently';
        return { content: [{ type: 'text', text: `Silenced ${code} ${dur}.` }] };
      } else if (action === 'unsilence' && code) {
        unsilenceAlert(_db!, code);
        return { content: [{ type: 'text', text: `Unsilenced ${code}.` }] };
      }
      return { content: [{ type: 'text', text: 'Usage: action=silence|unsilence|list, code=<ALERT_CODE>' }] };
    },
  );

  return server;
}

export function getDb(): DB | null {
  return _db;
}

export function shutdown(): void {
  if (_db) {
    try {
      retireProcess(_db, process.pid);
    } catch (e: unknown) {
      log.debug('Shutdown: retireProcess failed (DB may be closing)', { error: String(e) });
    }
    try {
      _db.close();
    } catch (e: unknown) {
      log.debug('Shutdown: DB close failed', { error: String(e) });
    }
    _db = null;
  }
}

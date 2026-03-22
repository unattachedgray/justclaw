import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

export function registerContextTools(server: McpServer, db: DB): void {
  server.tool(
    'context_flush',
    `Save a context snapshot to SQLite. This is the MOST CRITICAL tool for cross-session coherence.

**When to use:** ALWAYS call before: context compaction, session end, or finishing a scheduled task. A SessionStart hook will remind you, but call proactively too.
**What to include:** What you were doing, decisions made, key discoveries, what needs to happen next, and which task IDs are active.
**Side effects:** Also logs a summary entry to the daily log.`,
    {
      session_id: z.string().describe('Current Claude Code session ID (use ${CLAUDE_SESSION_ID})'),
      summary: z.string().describe('Natural language summary: current state, decisions, and next steps. Be thorough — this is what the next session reads first.'),
      key_facts: z.string().default('').describe('Important facts discovered this session that should persist'),
      active_task_ids: z.string().default('').describe('Comma-separated IDs of tasks being worked on'),
    },
    async ({ session_id, summary, key_facts, active_task_ids }) => {
      const now = db.now();
      db.execute(
        'INSERT INTO context_snapshots (session_id, summary, key_facts, active_task_ids, created_at) VALUES (?, ?, ?, ?, ?)',
        [session_id, summary, key_facts, active_task_ids, now],
      );
      db.execute(
        "INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, 'context', ?)",
        [db.today(), `Context flush: ${summary.slice(0, 200)}`, now],
      );
      return { content: [{ type: 'text', text: `Context snapshot saved for session ${session_id}.` }] };
    },
  );

  server.tool(
    'context_restore',
    `Restore the most recent context snapshot. Call at the START of every new session.

**When to use:** First thing in any new session or scheduled task. The SessionStart hook will remind you.
**What it returns:** The last context_flush snapshot — summary, key facts, active task IDs, and when it was saved.
**Tip:** Follow up with context_today() and task_list() for a complete picture.`,
    {
      session_id: z.string().default('').describe('Restore from a specific session. Empty = most recent from any session.'),
    },
    async ({ session_id }) => {
      let row: Record<string, unknown> | null;
      if (session_id) {
        row = db.fetchone(
          'SELECT session_id, summary, key_facts, active_task_ids, created_at FROM context_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
          [session_id],
        );
      } else {
        row = db.fetchone(
          'SELECT session_id, summary, key_facts, active_task_ids, created_at FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
        );
      }
      const text = row ? JSON.stringify(row, null, 2) : 'No context snapshots found.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'context_today',
    `Get all daily log entries for today. Shows what Charlie has already done today.

**When to use:** At session start (after context_restore) to see today's activity so far. Avoids duplicate work.`,
    {},
    async () => {
      const rows = db.fetchall(
        'SELECT entry, category, created_at FROM daily_log WHERE date = ? ORDER BY created_at ASC',
        [db.today()],
      );
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'daily_log_add',
    `Add an entry to today's activity log.

**When to use:** After completing significant work, making decisions, handling conversations, or observing something noteworthy. Think of it as a work journal.
**Categories:** task, conversation, decision, error, observation, briefing.`,
    {
      entry: z.string().describe('What happened. Be specific — "Deployed auth service to prod" not "did stuff".'),
      category: z.string().default('').describe('Category: task, conversation, decision, error, observation, briefing'),
    },
    async ({ entry, category }) => {
      db.execute(
        'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
        [db.today(), entry, category, db.now()],
      );
      return { content: [{ type: 'text', text: 'Logged.' }] };
    },
  );

  server.tool(
    'daily_log_get',
    `Get daily log entries for a specific date.

**When to use:** To review past activity — "what happened yesterday?", "what was done on Monday?".`,
    {
      date: z.string().default('').describe('Date in YYYY-MM-DD format. Empty = today.'),
      limit: z.number().default(50).describe('Max entries to return'),
    },
    async ({ date, limit }) => {
      const targetDate = date || db.today();
      const rows = db.fetchall(
        'SELECT entry, category, created_at FROM daily_log WHERE date = ? ORDER BY created_at ASC LIMIT ?',
        [targetDate, limit],
      );
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );
}

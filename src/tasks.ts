import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

/** Compute the next due date from a recurrence pattern and a base date. */
function computeNextDue(recurrence: string, baseDue: string | null): string {
  const base = baseDue ? new Date(baseDue) : new Date();
  switch (recurrence) {
    case 'daily':
      base.setDate(base.getDate() + 1);
      break;
    case 'weekly':
      base.setDate(base.getDate() + 7);
      break;
    case 'monthly':
      base.setMonth(base.getMonth() + 1);
      break;
    default:
      if (recurrence.startsWith('cron:')) {
        // For cron expressions, advance by 1 day as a safe default.
        // A full cron parser could be added later if needed.
        base.setDate(base.getDate() + 1);
      }
      break;
  }
  return base.toISOString().replace('T', ' ').slice(0, 19);
}

/** Create the next instance of a recurring task after completion. */
function spawnNextRecurrence(db: DB, task: Record<string, unknown>): Record<string, unknown> | null {
  const recurrence = task.recurrence as string | null;
  if (!recurrence) return null;

  const sourceId = (task.recurrence_source_id as number) || (task.id as number);
  const nextDue = computeNextDue(recurrence, task.due_at as string | null);
  const now = db.now();

  const result = db.execute(
    `INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, recurrence_source_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.title, task.description || '', task.priority || 5, task.tags || '', nextDue, '', recurrence, sourceId, now, now],
  );
  return { id: result.lastInsertRowid, title: task.title, due_at: nextDue, recurrence, recurrence_source_id: sourceId };
}

export function registerTaskTools(server: McpServer, db: DB): void {
  server.tool(
    'task_create',
    `Create a new task in the persistent queue.

**When to use:** When a user requests something that needs tracking, when you identify work during a session, or when breaking a large task into subtasks.
**When NOT to use:** For one-off actions you'll complete immediately — just do them.
**Priority scale:** 1=urgent/blocking, 3=high, 5=normal, 7=low, 10=backlog/someday.
**Dependencies:** Set depends_on to comma-separated task IDs that must complete first. task_next() respects these.`,
    {
      title: z.string().describe('Short task title (imperative mood, e.g. "Deploy auth service")'),
      description: z.string().default('').describe('Detailed description: what, why, acceptance criteria'),
      priority: z.number().default(5).describe('1=urgent, 5=normal, 10=backlog'),
      tags: z.string().default('').describe('Comma-separated tags (e.g. "deploy,backend,urgent")'),
      due_at: z.string().default('').describe('Deadline as ISO datetime (e.g. "2026-03-25T17:00:00")'),
      depends_on: z.string().default('').describe('Comma-separated task IDs that must complete first'),
      recurrence: z.string().default('').describe('Recurrence pattern: daily, weekly, monthly, or cron:<expression> (e.g. "cron:0 9 * * *")'),
    },
    async ({ title, description, priority, tags, due_at, depends_on, recurrence }) => {
      const now = db.now();
      const result = db.execute(
        'INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [title, description, priority, tags, due_at || null, depends_on, recurrence || null, now, now],
      );
      const task = { id: result.lastInsertRowid, title, status: 'pending', priority, depends_on, recurrence: recurrence || null };
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.tool(
    'task_update',
    `Update an existing task's status, description, priority, or result.

**Status flow:** pending -> active -> completed | failed | blocked.
**When to use:** To change task state, add notes, reprioritize, or mark as blocked with explanation.`,
    {
      id: z.number().describe('Task ID'),
      status: z.string().default('').describe('New status: pending, active, completed, failed, blocked'),
      description: z.string().default('').describe('Updated description'),
      priority: z.number().default(0).describe('Updated priority (1-10). 0 = no change'),
      result: z.string().default('').describe('Result/progress notes'),
      depends_on: z.string().default('').describe('Updated dependency list (comma-separated task IDs)'),
    },
    async ({ id, status, description, priority, result, depends_on }) => {
      const existing = db.fetchone('SELECT * FROM tasks WHERE id = ?', [id]);
      if (!existing) {
        return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
      }

      const updates: string[] = [];
      const params: unknown[] = [];

      if (status) {
        updates.push('status = ?');
        params.push(status);
        if (status === 'completed') {
          updates.push('completed_at = ?');
          params.push(db.now());
        }
      }
      if (description) { updates.push('description = ?'); params.push(description); }
      if (priority > 0) { updates.push('priority = ?'); params.push(priority); }
      if (result) { updates.push('result = ?'); params.push(result); }
      if (depends_on) { updates.push('depends_on = ?'); params.push(depends_on); }

      if (updates.length === 0) {
        return { content: [{ type: 'text', text: 'Nothing to update.' }] };
      }

      updates.push('updated_at = ?');
      params.push(db.now());
      params.push(id);
      db.execute(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, params);
      return { content: [{ type: 'text', text: `Updated task ${id}.` }] };
    },
  );

  server.tool(
    'task_list',
    `List tasks with optional filters.

**Default behavior:** Shows pending/active/blocked tasks (excludes completed/failed). Sorted by priority then creation date.
**Format:** Use "concise" for overview (id, title, status, priority). Use "detailed" for full fields including dependencies and assignment.`,
    {
      status: z.string().default('').describe('Filter by status. Empty = exclude completed/failed'),
      priority_max: z.number().default(10).describe('Only tasks with priority <= this value'),
      tags: z.string().default('').describe('Filter by tag substring'),
      assigned_to: z.string().default('').describe('Filter by assigned agent'),
      recurring: z.boolean().default(false).describe('If true, only show recurring task templates (tasks with a recurrence pattern)'),
      limit: z.number().default(20).describe('Max results'),
      format: z
        .enum(['concise', 'detailed'])
        .default('concise')
        .describe('concise = id+title+status+priority; detailed = all fields'),
    },
    async ({ status, priority_max, tags, assigned_to, recurring, limit, format }) => {
      const cols = format === 'detailed'
        ? 'id, title, description, status, priority, tags, result, depends_on, assigned_to, claimed_at, due_at, recurrence, recurrence_source_id, created_at, updated_at'
        : 'id, title, status, priority, tags, due_at, recurrence';

      let sql = `SELECT ${cols} FROM tasks WHERE 1=1`;
      const params: unknown[] = [];

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      } else {
        sql += " AND status NOT IN ('completed', 'failed')";
      }
      sql += ' AND priority <= ?';
      params.push(priority_max);
      if (tags) { sql += ' AND tags LIKE ?'; params.push(`%${tags}%`); }
      if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
      if (recurring) { sql += ' AND recurrence IS NOT NULL'; }
      sql += ' ORDER BY priority ASC, created_at ASC LIMIT ?';
      params.push(limit);

      const rows = db.fetchall(sql, params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'task_next',
    `Get the highest-priority pending task that's ready to work on (no unfinished dependencies).

**When to use:** At the start of a scheduled run or task-review session to pick up where you left off.
**Behavior:** Auto-marks the task as "active". Respects depends_on — won't return a task whose dependencies aren't completed.
**Returns:** The task object, or "No pending tasks." if the queue is empty.`,
    {},
    async () => {
      // Find pending tasks, excluding those with unfinished dependencies
      const pending = db.fetchall(
        "SELECT id, title, description, status, priority, tags, due_at, depends_on, assigned_to FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC, created_at ASC",
      );

      for (const task of pending) {
        const deps = String(task.depends_on || '').trim();
        if (deps) {
          const depIds = deps.split(',').map((d) => d.trim()).filter(Boolean);
          if (depIds.length > 0) {
            const placeholders = depIds.map(() => '?').join(',');
            const incomplete = db.fetchone(
              `SELECT COUNT(*) as count FROM tasks WHERE id IN (${placeholders}) AND status != 'completed'`,
              depIds,
            );
            if (incomplete && (incomplete.count as number) > 0) continue;
          }
        }
        // This task is ready
        db.execute(
          "UPDATE tasks SET status='active', updated_at=? WHERE id=? AND status='pending'",
          [db.now(), task.id],
        );
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      }

      return { content: [{ type: 'text', text: 'No pending tasks.' }] };
    },
  );

  server.tool(
    'task_claim',
    `Atomically claim a task for a specific agent. Prevents two agents from grabbing the same work.

**When to use:** In multi-agent scenarios where multiple workers might pick up tasks concurrently.
**Behavior:** Sets assigned_to and claimed_at. Fails if already claimed by a different agent.
**Stale claims:** Claims older than 1 hour with no progress can be overridden by passing force=true.`,
    {
      id: z.number().describe('Task ID to claim'),
      agent: z.string().describe('Agent identifier claiming the task (e.g. "task-worker-1")'),
      force: z.boolean().default(false).describe('Override a stale claim (>1hr old)'),
    },
    async ({ id, agent, force }) => {
      const task = db.fetchone('SELECT id, assigned_to, claimed_at, status FROM tasks WHERE id = ?', [id]);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
      }
      if (task.status === 'completed' || task.status === 'failed') {
        return { content: [{ type: 'text', text: `Task ${id} is already ${task.status}.` }] };
      }

      const currentAssignee = String(task.assigned_to || '');
      if (currentAssignee && currentAssignee !== agent) {
        // Check if claim is stale (>1 hour)
        const claimedAt = task.claimed_at as string | null;
        const isStale = claimedAt && (Date.now() - new Date(claimedAt).getTime() > 3600_000);
        if (!isStale && !force) {
          return {
            content: [{ type: 'text', text: `Task ${id} already claimed by '${currentAssignee}'. Use force=true to override.` }],
          };
        }
      }

      const now = db.now();
      db.execute(
        'UPDATE tasks SET assigned_to=?, claimed_at=?, status=CASE WHEN status=\'pending\' THEN \'active\' ELSE status END, updated_at=? WHERE id=?',
        [agent, now, now, id],
      );
      return { content: [{ type: 'text', text: `Task ${id} claimed by '${agent}'.` }] };
    },
  );

  server.tool(
    'task_complete',
    `Mark a task as completed with result notes. Also logs to the daily activity log.

**When to use:** After finishing a task. Include a brief summary of what was accomplished.
**Side effects:** Sets status=completed, records completed_at timestamp, adds a daily_log entry.`,
    {
      id: z.number().describe('Task ID'),
      result: z.string().default('').describe('Summary of what was done / outcome'),
    },
    async ({ id, result }) => {
      const existing = db.fetchone('SELECT * FROM tasks WHERE id = ?', [id]);
      if (!existing) {
        return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
      }
      const now = db.now();
      db.execute(
        "UPDATE tasks SET status='completed', result=?, completed_at=?, updated_at=? WHERE id=?",
        [result, now, now, id],
      );
      db.execute(
        "INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, 'task', ?)",
        [db.today(), `Completed task #${id}: ${result.slice(0, 200)}`, now],
      );

      // Spawn next instance if this is a recurring task
      const nextTask = spawnNextRecurrence(db, existing);
      if (nextTask) {
        return {
          content: [{ type: 'text', text: `Task ${id} completed. Next recurring instance created: #${nextTask.id} (due ${nextTask.due_at}).` }],
        };
      }
      return { content: [{ type: 'text', text: `Task ${id} completed.` }] };
    },
  );
}

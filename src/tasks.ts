import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';
import { cronNext } from './cron.js';
import { listTemplates, parseTemplateRef } from './task-templates.js';
import { autoRegisterFromTask, formatChannelSuggestions } from './output-channels.js';

/** Normalize due_at to SQLite datetime format (space separator, no T). */
function normalizeDueAt(due: string | null | undefined): string | null {
  if (!due) return null;
  // Replace ISO 'T' separator with space to match SQLite datetime('now') format
  return due.replace('T', ' ').slice(0, 19);
}

/** Add random jitter of -2 to +3 minutes to a date. Makes scheduled tasks look natural. */
function applyJitter(date: Date): Date {
  const jitterMs = (Math.random() * 5 - 2) * 60_000; // -2min to +3min
  return new Date(date.getTime() + jitterMs);
}

/** Compute the next due date from a recurrence pattern and a base date. */
export function computeNextDue(recurrence: string, baseDue: string | null): string {
  // Ensure UTC interpretation: append 'Z' if no timezone indicator present
  const raw = baseDue ? baseDue.replace(' ', 'T') : null;
  const base = raw ? new Date(raw.endsWith('Z') ? raw : raw + 'Z') : new Date();
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
        const expr = recurrence.slice(5);
        const next = applyJitter(cronNext(expr, base));
        return next.toISOString().replace('T', ' ').slice(0, 19);
      }
      break;
  }
  const jittered = applyJitter(base);
  return jittered.toISOString().replace('T', ' ').slice(0, 19);
}

/** Create the next instance of a recurring task after completion. */
function spawnNextRecurrence(db: DB, task: Record<string, unknown>): Record<string, unknown> | null {
  const recurrence = task.recurrence as string | null;
  if (!recurrence) return null;

  const sourceId = (task.recurrence_source_id as number) || (task.id as number);
  const nextDue = computeNextDue(recurrence, task.due_at as string | null);
  const now = db.now();

  const result = db.execute(
    `INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, recurrence_source_id, target_channel, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.title, task.description || '', task.priority || 5, task.tags || '', nextDue, '', recurrence, sourceId, task.target_channel || null, task.session_id || null, now, now],
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
      target_channel: z.string().default('').describe('Discord channel ID where scheduled task results should be posted. If empty, falls back to the heartbeat channel.'),
    },
    async ({ title, description, priority, tags, due_at, depends_on, recurrence, target_channel }) => {
      // Default target_channel to the Discord channel this was called from (set via JUSTCLAW_CHANNEL_ID env).
      const effectiveChannel = target_channel || process.env.JUSTCLAW_CHANNEL_ID || null;
      const now = db.now();
      const result = db.execute(
        'INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, target_channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [title, description, priority, tags, normalizeDueAt(due_at), depends_on, recurrence || null, effectiveChannel, now, now],
      );
      // Auto-register output channels from this task's variables.
      const ref = parseTemplateRef(description);
      if (ref) autoRegisterFromTask(db, ref.vars, effectiveChannel);

      const task = { id: result.lastInsertRowid, title, status: 'pending', priority, depends_on, recurrence: recurrence || null, target_channel: effectiveChannel };
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.tool(
    'task_update',
    `Update an existing task's fields: status, description, priority, schedule, title, or result.

**Status flow:** pending -> active -> completed | failed | blocked.
**When to use:** To change task state, reschedule, retitle, reprioritize, or mark as blocked.
**Schedule changes:** Set recurrence and/or due_at to change when a recurring task fires.`,
    {
      id: z.number().describe('Task ID'),
      status: z.string().default('').describe('New status: pending, active, completed, failed, blocked'),
      title: z.string().default('').describe('Updated title. Empty = no change.'),
      description: z.string().default('').describe('Updated description'),
      priority: z.number().default(0).describe('Updated priority (1-10). 0 = no change'),
      result: z.string().default('').describe('Result/progress notes'),
      depends_on: z.string().default('').describe('Updated dependency list (comma-separated task IDs)'),
      target_channel: z.string().default('').describe('Discord channel ID for posting results. Empty = no change.'),
      recurrence: z.string().default('').describe('Updated recurrence pattern (e.g. "cron:40 12 * * *"). Empty = no change.'),
      due_at: z.string().default('').describe('Updated due date as ISO datetime. Empty = no change.'),
    },
    async ({ id, status, title, description, priority, result, depends_on, target_channel, recurrence, due_at }) => {
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
      if (title) { updates.push('title = ?'); params.push(title); }
      if (description) { updates.push('description = ?'); params.push(description); }
      if (priority > 0) { updates.push('priority = ?'); params.push(priority); }
      if (result) { updates.push('result = ?'); params.push(result); }
      if (depends_on) { updates.push('depends_on = ?'); params.push(depends_on); }
      if (target_channel) { updates.push('target_channel = ?'); params.push(target_channel); }
      if (recurrence) { updates.push('recurrence = ?'); params.push(recurrence); }
      if (due_at) { updates.push('due_at = ?'); params.push(normalizeDueAt(due_at)); }

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
      // Find pending/active tasks and incomplete task IDs in two queries (avoids N+1).
      const pending = db.fetchall(
        "SELECT id, title, description, status, priority, tags, due_at, depends_on, assigned_to FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC, created_at ASC",
      );
      // Pre-load all non-completed task IDs for dependency checking.
      const incompleteIds = new Set(
        db.fetchall("SELECT id FROM tasks WHERE status != 'completed'")
          .map((r) => String(r.id)),
      );

      for (const task of pending) {
        const deps = String(task.depends_on || '').trim();
        if (deps) {
          const depIds = deps.split(',').map((d) => d.trim()).filter(Boolean);
          if (depIds.some((id) => incompleteIds.has(id))) continue;
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

  server.tool(
    'task_duplicate',
    `Duplicate an existing task with optional overrides. Creates a new task copying all fields from the source, then applies any overrides you specify.

**When to use:** "Create a report like the banking one but for real estate" — duplicate task #27 with modified description variables.
**What's copied:** title, description, priority, tags, recurrence, target_channel, due_at.
**What's NOT copied:** status (always pending), result, assigned_to, session_id.`,
    {
      source_id: z.number().describe('ID of the task to duplicate'),
      title: z.string().default('').describe('Override title (empty = copy from source)'),
      description: z.string().default('').describe('Override description (empty = copy from source). For template tasks, provide full template:name + vars block.'),
      priority: z.number().default(0).describe('Override priority (0 = copy from source)'),
      tags: z.string().default('').describe('Override tags (empty = copy from source)'),
      recurrence: z.string().default('').describe('Override recurrence (empty = copy from source)'),
      due_at: z.string().default('').describe('Override due_at (empty = compute next from source recurrence)'),
      target_channel: z.string().default('').describe('Override target Discord channel (empty = copy from source)'),
    },
    async ({ source_id, title, description, priority, tags, recurrence, due_at, target_channel }) => {
      const source = db.fetchone('SELECT * FROM tasks WHERE id = ?', [source_id]);
      if (!source) {
        return { content: [{ type: 'text', text: `Source task ${source_id} not found.` }] };
      }

      const newTitle = title || `${source.title} (copy)`;
      const newDesc = description || (source.description as string) || '';
      const newPriority = priority > 0 ? priority : (source.priority as number) || 5;
      const newTags = tags || (source.tags as string) || '';
      const newRecurrence = recurrence || (source.recurrence as string) || null;
      const newChannel = target_channel || (source.target_channel as string) || process.env.JUSTCLAW_CHANNEL_ID || null;

      // Compute due_at: use override, or compute next from recurrence, or copy from source.
      let newDueAt: string | null = null;
      if (due_at) {
        newDueAt = normalizeDueAt(due_at);
      } else if (newRecurrence) {
        newDueAt = computeNextDue(newRecurrence, source.due_at as string | null);
      } else {
        newDueAt = (source.due_at as string) || null;
      }

      const now = db.now();
      const result = db.execute(
        'INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, target_channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [newTitle, newDesc, newPriority, newTags, newDueAt, '', newRecurrence, newChannel, now, now],
      );

      // Auto-register output channels.
      const ref = parseTemplateRef(newDesc);
      if (ref) autoRegisterFromTask(db, ref.vars, newChannel);

      const task = { id: result.lastInsertRowid, title: newTitle, status: 'pending', priority: newPriority, recurrence: newRecurrence, due_at: newDueAt, target_channel: newChannel, duplicated_from: source_id };
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.tool(
    'task_create_from_template',
    `Create a recurring task from a named template. Templates live in data/task-templates/*.md with {{variable}} placeholders.

**When to use:** "Set up a daily crypto report" — pick a template, fill variables, set schedule.
**How it works:** The description stores "template:<name>" + variable assignments. At execution time, the template file is loaded and variables interpolated — so editing the template updates all tasks using it.
**List templates first:** Call with just template="" to see available templates and their required variables.`,
    {
      template: z.string().describe('Template name (e.g. "daily-report"). Pass empty string to list available templates.'),
      title: z.string().default('').describe('Task title'),
      variables: z.string().default('').describe('Template variables as "key: value" lines separated by newlines (e.g. "search_topics: BTC, ETH\\nlanguage: English")'),
      recurrence: z.string().default('').describe('Recurrence pattern (e.g. "cron:50 12 * * 1-5" for 8:50am EDT weekdays)'),
      due_at: z.string().default('').describe('First run as ISO datetime'),
      priority: z.number().default(5).describe('Priority (1-10)'),
      tags: z.string().default('').describe('Comma-separated tags'),
      target_channel: z.string().default('').describe('Discord channel ID for results'),
    },
    async ({ template, title, variables, recurrence, due_at, priority, tags, target_channel }) => {
      // List mode: show available templates
      if (!template) {
        const templates = listTemplates();
        if (templates.length === 0) {
          return { content: [{ type: 'text', text: 'No templates found in data/task-templates/.' }] };
        }
        const listing = templates.map((t) =>
          `**${t.name}**\n  Variables: ${t.variables.filter((v) => !['DATE', 'DATE_KR', 'YEAR', 'MONTH', 'DAY', 'DOW'].includes(v)).join(', ')}`
        ).join('\n\n');
        const channels = formatChannelSuggestions(db);
        return { content: [{ type: 'text', text: `Available templates:\n\n${listing}\n\nBuilt-in auto-variables (no need to set): DATE, DATE_KR, YEAR, MONTH, DAY, DOW\n\n${channels}` }] };
      }

      // Verify template exists
      const templates = listTemplates();
      const found = templates.find((t) => t.name === template);
      if (!found) {
        const available = templates.map((t) => t.name).join(', ');
        return { content: [{ type: 'text', text: `Template "${template}" not found. Available: ${available || 'none'}` }] };
      }

      if (!title) {
        return { content: [{ type: 'text', text: 'Title is required when creating a task from template.' }] };
      }

      // Build the template:name + variables description block
      const descLines = [`template:${template}`];
      if (variables) {
        for (const line of variables.split('\n')) {
          if (line.trim()) descLines.push(line.trim());
        }
      }
      const description = descLines.join('\n');

      const effectiveChannel = target_channel || process.env.JUSTCLAW_CHANNEL_ID || null;
      const now = db.now();
      const result = db.execute(
        'INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, target_channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [title, description, priority, tags, normalizeDueAt(due_at), '', recurrence || null, effectiveChannel, now, now],
      );

      // Check for unresolved variables (warn but don't block)
      const builtinVars = ['DATE', 'DATE_KR', 'YEAR', 'MONTH', 'DAY', 'DOW'];
      const providedVars = variables.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean);
      const required = found.variables.filter((v) => !builtinVars.includes(v));
      const missing = required.filter((v) => !providedVars.includes(v));

      // Auto-register output channels from variables.
      const varMap: Record<string, string> = {};
      for (const line of variables.split('\n')) {
        const ci = line.indexOf(':');
        if (ci > 0) varMap[line.slice(0, ci).trim()] = line.slice(ci + 1).trim();
      }
      autoRegisterFromTask(db, varMap, effectiveChannel);

      const task = { id: result.lastInsertRowid, title, status: 'pending', priority, recurrence: recurrence || null, due_at: normalizeDueAt(due_at), target_channel: effectiveChannel, template };
      let msg = JSON.stringify(task, null, 2);
      if (missing.length > 0) {
        msg += `\n\n⚠️ Missing template variables (will be unresolved at runtime): ${missing.join(', ')}`;
      }
      return { content: [{ type: 'text', text: msg }] };
    },
  );

  server.tool(
    'task_update_var',
    `Update one or more variables on a template-based task without rewriting the entire description.

**When to use:** "Change the banking report email to X" or "Add insurance to the search topics".
**How it works:** Reads the task's current template:name + vars block, updates the specified variables, writes back.
**Only works on template-based tasks** (description starts with "template:").`,
    {
      id: z.number().describe('Task ID'),
      updates: z.string().describe('Variables to update as "key: value" lines separated by newlines (e.g. "email_to: new@example.com")'),
    },
    async ({ id, updates }) => {
      const task = db.fetchone('SELECT id, description, recurrence, recurrence_source_id FROM tasks WHERE id = ?', [id]);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
      }

      const ref = parseTemplateRef(task.description as string);
      if (!ref) {
        return { content: [{ type: 'text', text: `Task ${id} is not template-based. Use task_update to change its description directly.` }] };
      }

      // Parse the updates
      const newVars: Record<string, string> = {};
      for (const line of updates.split('\n')) {
        const ci = line.indexOf(':');
        if (ci > 0) {
          const key = line.slice(0, ci).trim();
          const value = line.slice(ci + 1).trim();
          if (key && value) newVars[key] = value;
        }
      }

      if (Object.keys(newVars).length === 0) {
        return { content: [{ type: 'text', text: 'No valid key: value pairs found in updates.' }] };
      }

      // Merge: existing vars + new vars (new overwrite existing)
      const merged = { ...ref.vars, ...newVars };

      // Reconstruct the description
      const descLines = [`template:${ref.templateName}`];
      for (const [k, v] of Object.entries(merged)) {
        descLines.push(`${k}: ${v}`);
      }
      const newDesc = descLines.join('\n');

      const now = db.now();
      db.execute('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', [newDesc, now, id]);

      // Auto-register any new output channels
      autoRegisterFromTask(db, merged, null);

      // If this is a recurring task, also update future pending instances
      const sourceId = (task.recurrence_source_id as number) || id;
      const futureUpdated = db.execute(
        "UPDATE tasks SET description = ?, updated_at = ? WHERE recurrence_source_id = ? AND status = 'pending' AND id != ?",
        [newDesc, now, sourceId, id],
      );

      const changed = Object.keys(newVars).join(', ');
      let msg = `Updated task ${id}: ${changed}`;
      if (futureUpdated.changes > 0) {
        msg += ` (+ ${futureUpdated.changes} future recurring instance(s))`;
      }
      return { content: [{ type: 'text', text: msg }] };
    },
  );
}

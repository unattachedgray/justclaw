/**
 * Task scheduling tools — extracted from tasks.ts to keep files under 500 lines.
 *
 * Contains: task_duplicate, task_create_from_template, task_update_var.
 * These tools manage recurring task setup and template-based creation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';
import { computeNextDue } from './tasks.js';
import { listTemplates, parseTemplateRef } from './task-templates.js';
import { autoRegisterFromTask, formatChannelSuggestions } from './output-channels.js';

/** Normalize due_at to SQLite datetime format (space separator, no T). */
function normalizeDueAt(due: string | null | undefined): string | null {
  if (!due) return null;
  return due.replace('T', ' ').slice(0, 19);
}

export function registerSchedulingTools(server: McpServer, db: DB): void {
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
      variables: z.string().default('').describe('Template variables as "key: value" lines separated by newlines'),
      recurrence: z.string().default('').describe('Recurrence pattern (e.g. "cron:50 12 * * 1-5")'),
      due_at: z.string().default('').describe('First run as ISO datetime'),
      priority: z.number().default(5).describe('Priority (1-10)'),
      tags: z.string().default('').describe('Comma-separated tags'),
      target_channel: z.string().default('').describe('Discord channel ID for results'),
    },
    async ({ template, title, variables, recurrence, due_at, priority, tags, target_channel }) => {
      if (!template) {
        const templates = listTemplates();
        if (templates.length === 0) {
          return { content: [{ type: 'text', text: 'No templates found in data/task-templates/.' }] };
        }
        const builtinVars = ['DATE', 'DATE_KR', 'YEAR', 'MONTH', 'DAY', 'DOW'];
        const listing = templates.map((t) =>
          `**${t.name}**\n  Variables: ${t.variables.filter((v) => !builtinVars.includes(v)).join(', ')}`
        ).join('\n\n');
        const channels = formatChannelSuggestions(db);
        return { content: [{ type: 'text', text: `Available templates:\n\n${listing}\n\nBuilt-in auto-variables (no need to set): ${builtinVars.join(', ')}\n\n${channels}` }] };
      }

      const templates = listTemplates();
      const found = templates.find((t) => t.name === template);
      if (!found) {
        return { content: [{ type: 'text', text: `Template "${template}" not found. Available: ${templates.map((t) => t.name).join(', ') || 'none'}` }] };
      }
      if (!title) {
        return { content: [{ type: 'text', text: 'Title is required when creating a task from template.' }] };
      }

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

      const builtinVars = ['DATE', 'DATE_KR', 'YEAR', 'MONTH', 'DAY', 'DOW'];
      const providedVars = variables.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean);
      const missing = found.variables.filter((v) => !builtinVars.includes(v) && !providedVars.includes(v));

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
**Only works on template-based tasks** (description starts with "template:").`,
    {
      id: z.number().describe('Task ID'),
      updates: z.string().describe('Variables to update as "key: value" lines separated by newlines'),
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

      const merged = { ...ref.vars, ...newVars };
      const descLines = [`template:${ref.templateName}`];
      for (const [k, v] of Object.entries(merged)) {
        descLines.push(`${k}: ${v}`);
      }
      const newDesc = descLines.join('\n');

      const now = db.now();
      db.execute('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', [newDesc, now, id]);
      autoRegisterFromTask(db, merged, null);

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

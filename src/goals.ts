/**
 * Goals module — persistent user goals that drive autonomous task generation.
 *
 * Goals are high-level objectives the user is working toward. They persist
 * across sessions and are used by the daily task generation routine to
 * create actionable work items. Goals are few (5-10 max), long-lived,
 * and reviewed periodically.
 *
 * Stored in the memories table with type='goal', namespace='goals'.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

export function registerGoalTools(server: McpServer, db: DB): void {
  server.tool(
    'goal_set',
    `Create or update a goal. Goals drive autonomous daily task generation.
Use when the user shares an objective, project aim, or desired outcome.
Example: goal_set(key: "ship-v1", goal: "Ship justclaw v1.0 to npm", area: "project", priority: 1)`,
    {
      key: z.string().describe('Unique goal identifier (slug)'),
      goal: z.string().describe('Goal description — what the user wants to achieve'),
      area: z.string().optional().describe('Area: project, personal, learning, health, etc.'),
      priority: z.number().optional().describe('1=highest, 5=lowest. Default 3.'),
    },
    async ({ key, goal, area, priority }) => {
      const tags = ['goal', area || 'general'].join(',');
      const pri = priority ?? 3;

      const existing = db.fetchone(
        "SELECT id FROM memories WHERE key = ? AND namespace = 'goals'",
        [key],
      );

      if (existing) {
        db.execute(
          "UPDATE memories SET content = ?, tags = ?, updated_at = datetime('now') WHERE key = ? AND namespace = 'goals'",
          [`[P${pri}] ${goal}`, tags, key],
        );
      } else {
        db.execute(
          "INSERT INTO memories (key, content, type, tags, namespace, created_at, updated_at) VALUES (?, ?, 'goal', ?, 'goals', datetime('now'), datetime('now'))",
          [key, `[P${pri}] ${goal}`, tags],
        );
      }

      return { content: [{ type: 'text' as const, text: `Goal "${key}" saved: ${goal} (P${pri}, ${area || 'general'})` }] };
    },
  );

  server.tool(
    'goal_list',
    `List all active goals, sorted by priority. Used by daily task generation
to determine what work to suggest. Also useful for user to review their objectives.`,
    {},
    async () => {
      const rows = db.fetchall(
        "SELECT key, content, tags, created_at, updated_at FROM memories WHERE namespace = 'goals' AND type = 'goal' ORDER BY content ASC",
      );

      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No goals set. Use goal_set() to add objectives.' }] };
      }

      const lines = rows.map((r) => {
        const tags = (r.tags as string || '').split(',').filter(t => t !== 'goal').join(', ');
        return `- **${r.key}**: ${r.content} [${tags}] (set ${(r.created_at as string).slice(0, 10)})`;
      });

      return { content: [{ type: 'text' as const, text: `## Active Goals (${rows.length})\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'goal_archive',
    `Archive a completed or abandoned goal. Moves it out of the active goal list
so it no longer drives task generation. The goal memory is preserved for history.`,
    {
      key: z.string().describe('Goal key to archive'),
      reason: z.string().optional().describe('Why: completed, abandoned, superseded'),
    },
    async ({ key, reason }) => {
      const existing = db.fetchone(
        "SELECT id, content FROM memories WHERE key = ? AND namespace = 'goals'",
        [key],
      );

      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Goal "${key}" not found.` }] };
      }

      // Move to archived namespace, preserve content with reason.
      const archiveContent = `${existing.content} [ARCHIVED: ${reason || 'no reason'}]`;
      db.execute(
        "UPDATE memories SET namespace = 'goals-archived', content = ?, updated_at = datetime('now') WHERE key = ? AND namespace = 'goals'",
        [archiveContent, key],
      );

      return { content: [{ type: 'text' as const, text: `Goal "${key}" archived: ${reason || 'no reason'}` }] };
    },
  );
}

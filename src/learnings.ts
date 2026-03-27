/**
 * Learnings module — structured self-improvement from errors, corrections, and discoveries.
 *
 * Unlike free-text memories, learnings are structured: category, trigger, lesson.
 * They're injected into escalation prompts and daily task generation to prevent
 * repeating mistakes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

const VALID_CATEGORIES = ['error', 'correction', 'discovery', 'skill'] as const;

/** Programmatic learning creation — called by reflect module, not MCP. */
export function addLearningProgrammatic(
  db: DB,
  category: 'error' | 'correction' | 'discovery' | 'skill',
  trigger: string,
  lesson: string,
  area?: string,
  source?: string,
): void {
  db.execute(
    `INSERT INTO learnings (category, trigger, lesson, area, applied_count, created_at)
     VALUES (?, ?, ?, ?, 0, datetime('now'))`,
    [category, trigger.slice(0, 500), lesson.slice(0, 500), area || null],
  );
}

/** Increment applied_count for a learning (tracks when it's actually used). */
export function incrementAppliedCount(db: DB, learningId: number): void {
  db.execute('UPDATE learnings SET applied_count = applied_count + 1 WHERE id = ?', [learningId]);
}

export function registerLearningTools(server: McpServer, db: DB): void {
  server.tool(
    'learning_add',
    `Record a structured learning. Use when:
- An error occurred and was fixed (category: error)
- The user corrected your approach (category: correction)
- A better approach was discovered (category: discovery)
- A new skill/technique was learned (category: skill)
Example: learning_add(category: "correction", trigger: "Used rm -rf to clean build", lesson: "Use npm run clean instead — rm -rf can hit wrong directory")`,
    {
      category: z.enum(VALID_CATEGORIES).describe('error, correction, discovery, or skill'),
      trigger: z.string().describe('What happened that produced this learning'),
      lesson: z.string().describe('What was learned — actionable, specific'),
      area: z.string().optional().describe('Code area: heartbeat, dashboard, tasks, etc.'),
    },
    async ({ category, trigger, lesson, area }) => {
      db.execute(
        `INSERT INTO learnings (category, trigger, lesson, area, applied_count, created_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'))`,
        [category, trigger, lesson, area || null],
      );

      return {
        content: [{
          type: 'text' as const,
          text: `Learning recorded [${category}]: ${lesson.slice(0, 100)}`,
        }],
      };
    },
  );

  server.tool(
    'learning_search',
    `Search learnings by keyword or area. Useful before starting work in an area
to recall past mistakes and discoveries. Also used by escalation and task generation.`,
    {
      query: z.string().optional().describe('Keyword search'),
      category: z.enum([...VALID_CATEGORIES, 'all']).optional().describe('Filter by category'),
      area: z.string().optional().describe('Filter by code area'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async ({ query, category, area, limit }) => {
      const maxResults = Math.min(limit ?? 10, 50);
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (category && category !== 'all') {
        conditions.push('category = ?');
        params.push(category);
      }
      if (area) {
        conditions.push('area = ?');
        params.push(area);
      }
      if (query) {
        conditions.push('(trigger LIKE ? OR lesson LIKE ?)');
        params.push(`%${query}%`, `%${query}%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.fetchall(
        `SELECT id, category, trigger, lesson, area, applied_count, created_at
         FROM learnings ${where}
         ORDER BY created_at DESC LIMIT ?`,
        [...params, maxResults],
      );

      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No learnings found.' }] };
      }

      const lines = rows.map((r) => {
        const areaTag = r.area ? ` [${r.area}]` : '';
        return `- **[${r.category}]**${areaTag} ${r.lesson}\n  _Trigger: ${(r.trigger as string).slice(0, 100)}_ (${(r.created_at as string).slice(0, 10)}, applied ${r.applied_count}x)`;
      });

      return {
        content: [{
          type: 'text' as const,
          text: `## Learnings (${rows.length})\n${lines.join('\n')}`,
        }],
      };
    },
  );

  server.tool(
    'learning_stats',
    'Get learning statistics by category and area. Shows where most errors and discoveries happen.',
    {},
    async () => {
      const byCat = db.fetchall(
        'SELECT category, COUNT(*) as count FROM learnings GROUP BY category ORDER BY count DESC',
      );
      const byArea = db.fetchall(
        'SELECT area, COUNT(*) as count FROM learnings WHERE area IS NOT NULL GROUP BY area ORDER BY count DESC LIMIT 10',
      );
      const recent = db.fetchall(
        'SELECT category, trigger, lesson, created_at FROM learnings ORDER BY created_at DESC LIMIT 5',
      );

      const catLines = byCat.map((r) => `- ${r.category}: ${r.count}`).join('\n');
      const areaLines = byArea.map((r) => `- ${r.area}: ${r.count}`).join('\n');
      const recentLines = recent.map((r) =>
        `- [${r.category}] ${(r.lesson as string).slice(0, 80)} (${(r.created_at as string).slice(0, 10)})`,
      ).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: [
            `## Learning Stats`,
            `### By Category\n${catLines || 'None'}`,
            `### By Area\n${areaLines || 'None'}`,
            `### Recent\n${recentLines || 'None'}`,
          ].join('\n\n'),
        }],
      };
    },
  );
}

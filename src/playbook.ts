/**
 * Playbook module — learned remediation patterns with confidence scoring.
 *
 * The playbook table stores goal → pattern → action mappings that crystallize
 * from repeated learnings and escalation outcomes. Confidence is Bayesian:
 * times_succeeded / times_used, with floor at 0.1 and ceiling at 0.95.
 *
 * Tier model:
 *   - Tier 1 (core): playbook entries are CONSULTED but never auto-executed
 *   - Tier 2 (orchestration): auto-executed with validation (confidence >= 0.6)
 *   - Tier 3 (skills/scripts): auto-executed immediately (confidence >= 0.3)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';
import { getLogger } from './logger.js';

const log = getLogger('playbook');

const CONFIDENCE_FLOOR = 0.1;
const CONFIDENCE_CEILING = 0.95;
const DECAY_DAYS = 30;
const CRYSTALLIZE_THRESHOLD = 3; // learnings applied N+ times become playbook entries

export interface PlaybookEntry {
  id: number;
  goal: string;
  pattern: string;
  action: string;
  confidence: number;
  source: string;
  times_used: number;
  times_succeeded: number;
  learned_at: string;
  last_used: string | null;
}

/** Find a matching playbook entry for a goal + pattern. */
export function consultPlaybook(db: DB, goal: string, pattern: string): PlaybookEntry | null {
  const row = db.fetchone(
    `SELECT * FROM playbook
     WHERE goal = ? AND pattern = ? AND confidence >= ?
     ORDER BY confidence DESC LIMIT 1`,
    [goal, pattern, CONFIDENCE_FLOOR],
  );
  return row ? row as unknown as PlaybookEntry : null;
}

/** Find playbook entries by goal (any pattern). */
export function consultPlaybookByGoal(db: DB, goal: string): PlaybookEntry[] {
  return db.fetchall(
    `SELECT * FROM playbook WHERE goal = ? AND confidence >= ? ORDER BY confidence DESC LIMIT 5`,
    [goal, CONFIDENCE_FLOOR],
  ) as unknown as PlaybookEntry[];
}

/** Record or update a playbook entry. Upserts on goal + pattern. */
export function recordPlaybookEntry(
  db: DB, goal: string, pattern: string, action: string, source: string,
): void {
  const existing = db.fetchone(
    'SELECT id FROM playbook WHERE goal = ? AND pattern = ?',
    [goal, pattern],
  );

  if (existing) {
    db.execute(
      'UPDATE playbook SET action = ?, source = ?, last_used = datetime(\'now\') WHERE id = ?',
      [action, source, existing.id],
    );
  } else {
    db.execute(
      `INSERT INTO playbook (goal, pattern, action, confidence, source, times_used, times_succeeded)
       VALUES (?, ?, ?, 0.5, ?, 0, 0)`,
      [goal, pattern, action, source],
    );
  }
  log.info('Playbook entry recorded', { goal, pattern: pattern.slice(0, 60) });
}

/** Update outcome after a playbook entry was used. */
export function updatePlaybookOutcome(db: DB, entryId: number, succeeded: boolean): void {
  const entry = db.fetchone('SELECT times_used, times_succeeded FROM playbook WHERE id = ?', [entryId]);
  if (!entry) return;

  const used = (entry.times_used as number) + 1;
  const succeeded_n = (entry.times_succeeded as number) + (succeeded ? 1 : 0);
  const confidence = Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, succeeded_n / used));

  db.execute(
    'UPDATE playbook SET times_used = ?, times_succeeded = ?, confidence = ?, last_used = datetime(\'now\') WHERE id = ?',
    [used, succeeded_n, confidence, entryId],
  );
}

/**
 * Crystallize learnings into playbook entries.
 * Learnings with applied_count >= threshold are promoted.
 * Returns the number of new entries created.
 */
export function crystallizeFromLearnings(db: DB): number {
  const candidates = db.fetchall(
    `SELECT category, trigger, lesson, area FROM learnings
     WHERE applied_count >= ? AND area IS NOT NULL
     GROUP BY area, trigger
     ORDER BY applied_count DESC LIMIT 10`,
    [CRYSTALLIZE_THRESHOLD],
  );

  let created = 0;
  for (const c of candidates) {
    const goal = `learning:${c.area}`;
    const pattern = c.trigger as string;
    const existing = db.fetchone(
      'SELECT id FROM playbook WHERE goal = ? AND pattern = ?',
      [goal, pattern],
    );
    if (!existing) {
      recordPlaybookEntry(db, goal, pattern, c.lesson as string, 'crystallized');
      created++;
    }
  }

  if (created > 0) log.info('Crystallized learnings into playbook', { created });
  return created;
}

/**
 * Decay stale playbook entries — reduce confidence on unused entries.
 * Returns the number of entries decayed.
 */
export function decayStaleEntries(db: DB): number {
  const result = db.execute(
    `UPDATE playbook SET confidence = MAX(?, confidence - 0.1)
     WHERE last_used IS NOT NULL
       AND last_used < datetime('now', '-${DECAY_DAYS} days')
       AND confidence > ?`,
    [CONFIDENCE_FLOOR, CONFIDENCE_FLOOR],
  );
  if (result.changes > 0) log.info('Decayed stale playbook entries', { count: result.changes });
  return result.changes;
}

/** Get playbook statistics. */
export function getPlaybookStats(db: DB): Record<string, unknown> {
  const total = db.fetchone('SELECT COUNT(*) as n FROM playbook');
  const byGoal = db.fetchall(
    'SELECT goal, COUNT(*) as count, AVG(confidence) as avg_confidence FROM playbook GROUP BY goal ORDER BY count DESC LIMIT 10',
  );
  const topEntries = db.fetchall(
    'SELECT goal, pattern, action, confidence, times_used FROM playbook ORDER BY confidence DESC, times_used DESC LIMIT 5',
  );
  return { total: total?.n || 0, byGoal, topEntries };
}

/** Register playbook MCP tools. */
export function registerPlaybookTools(server: McpServer, db: DB): void {
  server.tool(
    'playbook_consult',
    `Look up learned remediation patterns for a goal or issue area.
Returns playbook entries with confidence scores based on past success rates.`,
    {
      goal: z.string().describe('Goal or issue area (e.g. "heartbeat:CRASH_LOOP", "learning:scheduled-tasks")'),
    },
    async ({ goal }) => {
      const entries = consultPlaybookByGoal(db, goal);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: `No playbook entries for "${goal}".` }] };
      }
      const lines = entries.map((e) =>
        `- **${e.pattern}** (${Math.round(e.confidence * 100)}% confidence, used ${e.times_used}x)\n  Action: ${e.action}`
      );
      return { content: [{ type: 'text', text: `## Playbook: ${goal}\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'playbook_stats',
    'Get playbook statistics: total entries, top goals, highest-confidence patterns.',
    {},
    async () => {
      const stats = getPlaybookStats(db);
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    },
  );
}

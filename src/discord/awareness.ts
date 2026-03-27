/**
 * Awareness module — proactive checks beyond health monitoring.
 *
 * Unlike heartbeat-checks.ts (which detects problems), awareness checks
 * detect opportunities and things worth mentioning. A lightweight LLM call
 * decides whether each signal is worth a Discord message.
 *
 * Runs every 3rd heartbeat cycle (~15 min). Respects active hours and
 * a daily message budget to prevent notification fatigue.
 */

import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { formatLocalTime } from '../time-utils.js';

const log = getLogger('awareness');

export interface AwarenessSignal {
  type: string;
  detail: string;
  priority: number; // 1=high, 3=low
}

/** Check for overdue tasks assigned to the user. */
function checkOverdueTasks(db: DB): AwarenessSignal | null {
  const rows = db.fetchall(
    `SELECT id, title, due_at FROM tasks
     WHERE due_at IS NOT NULL AND due_at < datetime('now')
       AND status IN ('pending', 'active')
       AND recurrence IS NULL
     ORDER BY due_at ASC LIMIT 3`,
  );

  if (rows.length === 0) return null;

  const titles = rows.map((r) => `"${r.title}" (due ${formatLocalTime(r.due_at as string, { includeDate: true })})`).join(', ');
  return {
    type: 'overdue_tasks',
    detail: `${rows.length} overdue task(s): ${titles}`,
    priority: 1,
  };
}

/** Check for goals with no task activity in 48h. */
function checkStaleGoals(db: DB): AwarenessSignal | null {
  const goals = db.fetchall(
    "SELECT key, content FROM memories WHERE namespace = 'goals' AND type = 'goal'",
  );

  if (goals.length === 0) return null;

  // Check if any tasks were completed in last 48h
  const recentActivity = db.fetchone(
    "SELECT COUNT(*) as n FROM tasks WHERE completed_at > datetime('now', '-48 hours')",
  );

  if ((recentActivity?.n as number) > 0) return null;

  return {
    type: 'stale_goals',
    detail: `No tasks completed in 48h. ${goals.length} active goal(s) with no progress.`,
    priority: 2,
  };
}

/** Check for auto-generated tasks ready for review. */
function checkAutoTaskResults(db: DB): AwarenessSignal | null {
  const completed = db.fetchall(
    `SELECT id, title, result FROM tasks
     WHERE tags LIKE '%auto-generated%'
       AND status = 'completed'
       AND updated_at > datetime('now', '-6 hours')
     LIMIT 3`,
  );

  if (completed.length === 0) return null;

  return {
    type: 'auto_task_results',
    detail: `${completed.length} auto-generated task(s) completed recently — results ready for review.`,
    priority: 3,
  };
}

/** Check for learnings that suggest recurring problems. */
function checkRecurringErrors(db: DB): AwarenessSignal | null {
  const recent = db.fetchone(
    `SELECT area, COUNT(*) as n FROM learnings
     WHERE category = 'error' AND created_at > datetime('now', '-7 days')
     GROUP BY area ORDER BY n DESC LIMIT 1`,
  );

  if (!recent || (recent.n as number) < 3) return null;

  return {
    type: 'recurring_errors',
    detail: `${recent.n} errors in "${recent.area}" area this week — may need systemic fix.`,
    priority: 2,
  };
}

/** Run all awareness checks. Returns signals sorted by priority. */
export function runAwarenessChecks(db: DB): AwarenessSignal[] {
  const signals: AwarenessSignal[] = [];

  const checks = [checkOverdueTasks, checkStaleGoals, checkAutoTaskResults, checkRecurringErrors];

  for (const check of checks) {
    try {
      const signal = check(db);
      if (signal) signals.push(signal);
    } catch (err) {
      log.error('Awareness check failed', { error: String(err) });
    }
  }

  return signals.sort((a, b) => a.priority - b.priority);
}

/** Check if current time is within active hours. */
export function isWithinActiveHours(
  startHour: number,
  endHour: number,
  timezone: string,
): boolean {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    });
    const currentHour = parseInt(formatter.format(now), 10);

    if (startHour <= endHour) {
      return currentHour >= startHour && currentHour < endHour;
    }
    // Wraps midnight (e.g., 22-6)
    return currentHour >= startHour || currentHour < endHour;
  } catch {
    // Invalid timezone — default to always active
    return true;
  }
}

/** Check daily proactive message budget. */
export function getMessageBudget(db: DB, maxPerDay: number): { remaining: number; used: number } {
  const today = db.today();
  const used = db.fetchone(
    "SELECT CAST(value AS INTEGER) as n FROM state WHERE key = ?",
    [`awareness_budget_${today}`],
  );

  const usedCount = (used?.n as number) || 0;
  return { remaining: Math.max(0, maxPerDay - usedCount), used: usedCount };
}

/** Increment daily message budget counter. */
export function spendMessageBudget(db: DB): void {
  const today = db.today();
  const key = `awareness_budget_${today}`;
  const existing = db.fetchone("SELECT value FROM state WHERE key = ?", [key]);

  if (existing) {
    db.execute("UPDATE state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?", [key]);
  } else {
    db.execute("INSERT INTO state (key, value) VALUES (?, '1')", [key]);
  }
}

/** Format signals into a Discord message. */
export function formatAwarenessMessage(signals: AwarenessSignal[]): string {
  if (signals.length === 0) return '';

  const lines = signals.map((s) => {
    const icon = s.priority === 1 ? '🔴' : s.priority === 2 ? '🟡' : '🟢';
    return `${icon} ${s.detail}`;
  });

  return `💡 **Awareness check**\n${lines.join('\n')}`;
}

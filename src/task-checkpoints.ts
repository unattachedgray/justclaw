/**
 * Task checkpoint system — save and restore intermediate task state.
 * Also includes git checkpoint and shadow validation utilities.
 */

import { execSync } from 'child_process';
import type { DB } from './db.js';
import { getLogger } from './logger.js';

const log = getLogger('task-checkpoints');

/** Save a checkpoint for a task at a given phase. */
export function saveCheckpoint(
  db: DB,
  taskId: number,
  step: number,
  phase: string,
  state: Record<string, unknown>,
): void {
  db.execute(
    `INSERT INTO task_checkpoints (task_id, step, phase, state_json) VALUES (?, ?, ?, ?)`,
    [taskId, step, phase, JSON.stringify(state)],
  );
  log.debug('Checkpoint saved', { taskId, step, phase });
}

/** Get the latest checkpoint for a task. */
export function getLatestCheckpoint(
  db: DB,
  taskId: number,
): { step: number; phase: string; state: Record<string, unknown> } | null {
  const row = db.fetchone(
    'SELECT step, phase, state_json FROM task_checkpoints WHERE task_id = ? ORDER BY step DESC LIMIT 1',
    [taskId],
  );
  if (!row) return null;
  try {
    return {
      step: row.step as number,
      phase: row.phase as string,
      state: JSON.parse(row.state_json as string),
    };
  } catch {
    return null;
  }
}

/** Get all checkpoints for a task (for debugging). */
export function getCheckpointHistory(
  db: DB,
  taskId: number,
): Array<{ step: number; phase: string; created_at: string }> {
  return db.fetchall(
    'SELECT step, phase, created_at FROM task_checkpoints WHERE task_id = ? ORDER BY step ASC',
    [taskId],
  ) as Array<{ step: number; phase: string; created_at: string }>;
}

/** Create a git checkpoint before task execution. Stores HEAD ref for rollback. */
export function createGitCheckpoint(db: DB, taskId: number, repoPath: string): void {
  try {
    const headRef = execSync('git rev-parse HEAD', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5000,
    }).trim();
    db.execute(
      'INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)',
      [`git_checkpoint:${taskId}`, JSON.stringify({ repo: repoPath, ref: headRef, created: new Date().toISOString() })],
    );
  } catch (e: unknown) {
    log.debug('Git checkpoint skipped', { taskId, error: String(e).slice(0, 100) });
  }
}

/** Run TypeScript compilation check. Returns true if no justclaw code or compilation passes. */
export function shadowValidate(taskDescription: string): boolean {
  if (!/justclaw.*\.(ts|js)/i.test(taskDescription)) return true;
  try {
    execSync('npx tsc --noEmit', {
      cwd: '/home/julian/temp/justclaw', encoding: 'utf-8', timeout: 30000,
    });
    return true;
  } catch {
    log.warn('Shadow validation failed — TypeScript compilation errors detected');
    return false;
  }
}

/** Clean up old checkpoints for completed tasks (keep last 500, prune after 7 days). */
export function pruneCheckpoints(db: DB): number {
  const result = db.execute(
    `DELETE FROM task_checkpoints WHERE id NOT IN (
      SELECT id FROM task_checkpoints
      ORDER BY created_at DESC LIMIT 500
    ) AND created_at < datetime('now', '-7 days')`,
  );
  if (result.changes > 0) log.info('Pruned old checkpoints', { count: result.changes });
  return result.changes;
}

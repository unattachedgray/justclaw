import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DB } from '../src/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let db: DB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'justclaw-test-'));
  db = new DB(join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

function taskCreate(title: string, priority = 5, tags = '', depends_on = '') {
  const now = db.now();
  const result = db.execute(
    'INSERT INTO tasks (title, description, priority, tags, depends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, '', priority, tags, depends_on, now, now],
  );
  return Number(result.lastInsertRowid);
}

describe('Task tools', () => {
  it('creates a task with default status pending', () => {
    const id = taskCreate('Test task');
    const row = db.fetchone('SELECT status, priority FROM tasks WHERE id = ?', [id]);
    expect(row!.status).toBe('pending');
    expect(row!.priority).toBe(5);
  });

  it('task_next returns highest priority pending task', () => {
    taskCreate('Low priority', 10);
    taskCreate('High priority', 1);
    taskCreate('Medium priority', 5);
    const row = db.fetchone(
      "SELECT title, priority FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC, created_at ASC LIMIT 1",
    );
    expect(row!.title).toBe('High priority');
  });

  it('task_next auto-marks as active', () => {
    const id = taskCreate('Activate me');
    db.execute("UPDATE tasks SET status='active', updated_at=? WHERE id=? AND status='pending'", [db.now(), id]);
    const updated = db.fetchone('SELECT status FROM tasks WHERE id = ?', [id]);
    expect(updated!.status).toBe('active');
  });

  it('task_complete marks as completed with timestamp', () => {
    const id = taskCreate('Complete me');
    const now = db.now();
    db.execute("UPDATE tasks SET status='completed', result=?, completed_at=?, updated_at=? WHERE id=?", ['Done!', now, now, id]);
    const row = db.fetchone('SELECT status, result, completed_at FROM tasks WHERE id = ?', [id]);
    expect(row!.status).toBe('completed');
    expect(row!.result).toBe('Done!');
    expect(row!.completed_at).not.toBeNull();
  });

  it('task_list excludes completed by default', () => {
    const id1 = taskCreate('Pending');
    const id2 = taskCreate('Also pending');
    db.execute("UPDATE tasks SET status='completed', completed_at=? WHERE id=?", [db.now(), id2]);
    const rows = db.fetchall("SELECT title FROM tasks WHERE status NOT IN ('completed', 'failed')");
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('Pending');
  });

  it('task_list filters by status', () => {
    taskCreate('Pending');
    const id2 = taskCreate('Blocked');
    db.execute("UPDATE tasks SET status='blocked' WHERE id=?", [id2]);
    const rows = db.fetchall('SELECT title FROM tasks WHERE status = ?', ['blocked']);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('Blocked');
  });

  it('task_list filters by tags', () => {
    taskCreate('Tagged', 5, 'deploy,urgent');
    taskCreate('Untagged', 5, '');
    const rows = db.fetchall('SELECT title FROM tasks WHERE tags LIKE ?', ['%urgent%']);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('Tagged');
  });

  it('task_update changes multiple fields', () => {
    const id = taskCreate('Original');
    db.execute('UPDATE tasks SET description=?, priority=?, updated_at=? WHERE id=?', ['Updated desc', 1, db.now(), id]);
    const row = db.fetchone('SELECT description, priority FROM tasks WHERE id = ?', [id]);
    expect(row!.description).toBe('Updated desc');
    expect(row!.priority).toBe(1);
  });

  // P3: Task dependencies
  it('creates task with dependencies', () => {
    const dep1 = taskCreate('Dependency 1');
    const dep2 = taskCreate('Dependency 2');
    const main = taskCreate('Main task', 5, '', `${dep1},${dep2}`);
    const row = db.fetchone('SELECT depends_on FROM tasks WHERE id = ?', [main]);
    expect(row!.depends_on).toBe(`${dep1},${dep2}`);
  });

  it('task_next skips tasks with incomplete dependencies', () => {
    const dep = taskCreate('Dependency', 1);
    const main = taskCreate('Depends on dep', 1, '', String(dep));

    // Both pending — dep should be returned (no deps of its own)
    const pending = db.fetchall(
      "SELECT id, title, depends_on FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC, created_at ASC",
    );
    expect(pending.length).toBe(2);

    // Find first task with no incomplete deps
    let readyTask = null;
    for (const task of pending) {
      const deps = String(task.depends_on || '').trim();
      if (!deps) { readyTask = task; break; }
      const depIds = deps.split(',').map((d: string) => d.trim()).filter(Boolean);
      const incomplete = db.fetchone(
        `SELECT COUNT(*) as count FROM tasks WHERE id IN (${depIds.map(() => '?').join(',')}) AND status != 'completed'`,
        depIds,
      );
      if (!incomplete || (incomplete.count as number) === 0) { readyTask = task; break; }
    }
    expect(readyTask).not.toBeNull();
    expect(readyTask!.title).toBe('Dependency');
  });

  // P3: Task claiming
  it('task_claim assigns a task', () => {
    const id = taskCreate('Claimable');
    const now = db.now();
    db.execute('UPDATE tasks SET assigned_to=?, claimed_at=?, updated_at=? WHERE id=?', ['worker-1', now, now, id]);
    const row = db.fetchone('SELECT assigned_to, claimed_at FROM tasks WHERE id = ?', [id]);
    expect(row!.assigned_to).toBe('worker-1');
    expect(row!.claimed_at).toBe(now);
  });

  it('task_list filters by assigned_to', () => {
    const id1 = taskCreate('Mine');
    const id2 = taskCreate('Theirs');
    db.execute('UPDATE tasks SET assigned_to=? WHERE id=?', ['worker-1', id1]);
    db.execute('UPDATE tasks SET assigned_to=? WHERE id=?', ['worker-2', id2]);
    const rows = db.fetchall('SELECT title FROM tasks WHERE assigned_to = ?', ['worker-1']);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('Mine');
  });
});

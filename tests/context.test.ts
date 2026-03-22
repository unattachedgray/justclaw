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

describe('Context tools', () => {
  it('context_flush saves a snapshot', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, key_facts, active_task_ids, created_at) VALUES (?, ?, ?, ?, ?)',
      ['sess-1', 'Working on tests', 'FTS5 works great', '1,2', now],
    );
    const row = db.fetchone('SELECT * FROM context_snapshots WHERE session_id = ?', ['sess-1']);
    expect(row!.summary).toBe('Working on tests');
    expect(row!.key_facts).toBe('FTS5 works great');
    expect(row!.active_task_ids).toBe('1,2');
  });

  it('context_flush also logs to daily_log', () => {
    const now = db.now();
    const today = db.today();
    db.execute(
      "INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, 'context', ?)",
      [today, 'Context flush: summary', now],
    );
    const rows = db.fetchall('SELECT * FROM daily_log WHERE category = ?', ['context']);
    expect(rows.length).toBe(1);
  });

  it('context_restore returns most recent snapshot', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, created_at) VALUES (?, ?, ?)',
      ['old-sess', 'Old snapshot', '2026-01-01 00:00:00'],
    );
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, created_at) VALUES (?, ?, ?)',
      ['new-sess', 'New snapshot', now],
    );
    const row = db.fetchone(
      'SELECT session_id, summary FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
    );
    expect(row!.session_id).toBe('new-sess');
    expect(row!.summary).toBe('New snapshot');
  });

  it('context_restore by session_id', () => {
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, created_at) VALUES (?, ?, ?)',
      ['sess-a', 'Snapshot A', db.now()],
    );
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, created_at) VALUES (?, ?, ?)',
      ['sess-b', 'Snapshot B', db.now()],
    );
    const row = db.fetchone(
      'SELECT summary FROM context_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
      ['sess-a'],
    );
    expect(row!.summary).toBe('Snapshot A');
  });

  it('daily_log_add and daily_log_get round-trip', () => {
    const today = db.today();
    const now = db.now();
    db.execute(
      'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
      [today, 'Did some work', 'task', now],
    );
    db.execute(
      'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
      [today, 'Had a conversation', 'conversation', now],
    );
    const rows = db.fetchall(
      'SELECT entry, category FROM daily_log WHERE date = ? ORDER BY created_at ASC',
      [today],
    );
    expect(rows.length).toBe(2);
    expect(rows[0].entry).toBe('Did some work');
    expect(rows[1].category).toBe('conversation');
  });

  it('context_today only returns today entries', () => {
    db.execute(
      'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
      ['2020-01-01', 'Old entry', '', db.now()],
    );
    db.execute(
      'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
      [db.today(), 'Today entry', '', db.now()],
    );
    const rows = db.fetchall(
      'SELECT entry FROM daily_log WHERE date = ? ORDER BY created_at ASC',
      [db.today()],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].entry).toBe('Today entry');
  });
});

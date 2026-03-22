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

describe('DB', () => {
  it('creates all tables on init', () => {
    const tables = db
      .fetchall("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toContain('memories');
    expect(tables).toContain('tasks');
    expect(tables).toContain('context_snapshots');
    expect(tables).toContain('conversations');
    expect(tables).toContain('daily_log');
    expect(tables).toContain('state');
    expect(tables).toContain('schema_meta');
  });

  it('sets current schema version', () => {
    const row = db.fetchone("SELECT value FROM schema_meta WHERE key='version'");
    expect(row).not.toBeNull();
    // Should match SCHEMA_VERSION in db.ts — update this if schema changes.
    expect(Number(row!.value)).toBeGreaterThanOrEqual(5);
  });

  it('enables WAL mode', () => {
    const row = db.fetchone('PRAGMA journal_mode');
    expect(row!.journal_mode).toBe('wal');
  });

  it('fetchone returns null for missing rows', () => {
    const row = db.fetchone('SELECT * FROM memories WHERE key = ?', ['nonexistent']);
    expect(row).toBeNull();
  });

  it('fetchall returns empty array for no results', () => {
    const rows = db.fetchall('SELECT * FROM memories');
    expect(rows).toEqual([]);
  });

  it('execute inserts and fetchone retrieves', () => {
    db.execute('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)', [
      'test', 'hello', db.now(),
    ]);
    const row = db.fetchone('SELECT value FROM state WHERE key = ?', ['test']);
    expect(row!.value).toBe('hello');
  });

  it('transaction commits on success', () => {
    db.transaction(() => {
      db.execute('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)', [
        'tx-test', 'committed', db.now(),
      ]);
    });
    const row = db.fetchone('SELECT value FROM state WHERE key = ?', ['tx-test']);
    expect(row!.value).toBe('committed');
  });

  it('transaction rolls back on error', () => {
    try {
      db.transaction(() => {
        db.execute('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)', [
          'tx-fail', 'should-not-persist', db.now(),
        ]);
        throw new Error('deliberate');
      });
    } catch { /* expected */ }
    const row = db.fetchone('SELECT value FROM state WHERE key = ?', ['tx-fail']);
    expect(row).toBeNull();
  });

  it('today() returns YYYY-MM-DD format', () => {
    expect(db.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('now() returns YYYY-MM-DD HH:MM:SS format', () => {
    expect(db.now()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  // Memory FTS tests
  it('FTS5 triggers sync on insert', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['test-key', 'some searchable content', 'fact', 'tag1', now, now],
    );
    const results = db.fetchall(
      "SELECT m.key FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH 'searchable'",
    );
    expect(results.length).toBe(1);
    expect(results[0].key).toBe('test-key');
  });

  it('FTS5 triggers sync on update', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['update-key', 'original content', 'fact', '', now, now],
    );
    db.execute('UPDATE memories SET content = ?, updated_at = ? WHERE key = ?', [
      'new replacement content', now, 'update-key',
    ]);
    const oldResults = db.fetchall(
      "SELECT m.key FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH 'original'",
    );
    expect(oldResults.length).toBe(0);
    const newResults = db.fetchall(
      "SELECT m.key FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH 'replacement'",
    );
    expect(newResults.length).toBe(1);
  });

  it('FTS5 triggers sync on delete', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['delete-key', 'deletable content', 'fact', '', now, now],
    );
    db.execute('DELETE FROM memories WHERE key = ?', ['delete-key']);
    const results = db.fetchall(
      "SELECT m.key FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH 'deletable'",
    );
    expect(results.length).toBe(0);
  });

  // Schema v2: namespace column
  it('memories table has namespace column', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['ns-test', 'scoped memory', 'fact', 'project:myapp', now, now],
    );
    const row = db.fetchone('SELECT namespace FROM memories WHERE key = ?', ['ns-test']);
    expect(row!.namespace).toBe('project:myapp');
  });

  it('memories default namespace is global', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['default-ns', 'test', 'general', now, now],
    );
    const row = db.fetchone('SELECT namespace FROM memories WHERE key = ?', ['default-ns']);
    expect(row!.namespace).toBe('global');
  });

  // Schema v2: access tracking
  it('memories have access_count and last_accessed', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['access-test', 'test', 'general', now, now],
    );
    const row = db.fetchone('SELECT access_count, last_accessed FROM memories WHERE key = ?', ['access-test']);
    expect(row!.access_count).toBe(0);
    expect(row!.last_accessed).toBeNull();

    // Simulate access
    db.execute('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE key = ?', [now, 'access-test']);
    const updated = db.fetchone('SELECT access_count, last_accessed FROM memories WHERE key = ?', ['access-test']);
    expect(updated!.access_count).toBe(1);
    expect(updated!.last_accessed).toBe(now);
  });

  // Schema v2: task dependencies
  it('tasks have depends_on, assigned_to, claimed_at', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO tasks (title, depends_on, assigned_to, claimed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['Dep task', '1,2', 'worker-1', now, now, now],
    );
    const row = db.fetchone('SELECT depends_on, assigned_to, claimed_at FROM tasks WHERE title = ?', ['Dep task']);
    expect(row!.depends_on).toBe('1,2');
    expect(row!.assigned_to).toBe('worker-1');
    expect(row!.claimed_at).toBe(now);
  });

  // Schema v2: conversation FTS
  it('conversation FTS syncs on insert', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'deploy the production server', 0, db.now()],
    );
    const results = db.fetchall(
      "SELECT c.message FROM conversations_fts fts JOIN conversations c ON c.id = fts.rowid WHERE conversations_fts MATCH 'production'",
    );
    expect(results.length).toBe(1);
    expect(results[0].message).toContain('production');
  });
});

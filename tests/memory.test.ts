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

function memorySave(key: string, content: string, type = 'general', tags = '', namespace = 'global') {
  const existing = db.fetchone('SELECT id FROM memories WHERE key = ?', [key]);
  const now = db.now();
  if (existing) {
    db.execute('UPDATE memories SET content=?, type=?, tags=?, namespace=?, updated_at=? WHERE key=?', [
      content, type, tags, namespace, now, key,
    ]);
    return 'updated';
  }
  db.execute(
    'INSERT INTO memories (key, content, type, tags, namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [key, content, type, tags, namespace, now, now],
  );
  return 'created';
}

describe('Memory tools', () => {
  it('saves a new memory', () => {
    const result = memorySave('user-name', 'Julian');
    expect(result).toBe('created');
    const row = db.fetchone('SELECT content FROM memories WHERE key = ?', ['user-name']);
    expect(row!.content).toBe('Julian');
  });

  it('updates an existing memory', () => {
    memorySave('user-name', 'Julian');
    const result = memorySave('user-name', 'Julian M.');
    expect(result).toBe('updated');
    const row = db.fetchone('SELECT content FROM memories WHERE key = ?', ['user-name']);
    expect(row!.content).toBe('Julian M.');
  });

  it('searches with FTS5', () => {
    memorySave('project-goal', 'Build an autonomous AI assistant', 'decision');
    memorySave('user-pref', 'Prefers dark mode for all UIs', 'preference');
    const results = db.fetchall(
      "SELECT m.key FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH 'autonomous assistant' ORDER BY rank LIMIT 10",
    );
    expect(results.length).toBe(1);
    expect(results[0].key).toBe('project-goal');
  });

  it('searches by type filter', () => {
    memorySave('fact1', 'The sky is blue', 'fact');
    memorySave('pref1', 'Dark theme', 'preference');
    const rows = db.fetchall('SELECT key FROM memories WHERE type = ?', ['fact']);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('fact1');
  });

  it('searches by tag filter', () => {
    memorySave('tagged', 'Has tags', 'general', 'work,urgent');
    memorySave('untagged', 'No tags', 'general', '');
    const rows = db.fetchall('SELECT key FROM memories WHERE tags LIKE ?', ['%urgent%']);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('tagged');
  });

  it('recalls by exact key', () => {
    memorySave('recall-test', 'Recall this content');
    const row = db.fetchone('SELECT content FROM memories WHERE key = ?', ['recall-test']);
    expect(row!.content).toBe('Recall this content');
  });

  it('forgets a memory and cleans FTS', () => {
    memorySave('forget-me', 'Temporary');
    db.execute('DELETE FROM memories WHERE key = ?', ['forget-me']);
    const row = db.fetchone('SELECT * FROM memories WHERE key = ?', ['forget-me']);
    expect(row).toBeNull();
    const fts = db.fetchall("SELECT * FROM memories_fts WHERE memories_fts MATCH 'Temporary'");
    expect(fts.length).toBe(0);
  });

  it('lists memories ordered by updated_at', () => {
    db.execute(
      'INSERT INTO memories (key, content, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['first', 'First entry', 'general', '', '2026-01-01 00:00:00', '2026-01-01 00:00:00'],
    );
    db.execute(
      'INSERT INTO memories (key, content, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['second', 'Second entry', 'general', '', '2026-01-02 00:00:00', '2026-01-02 00:00:00'],
    );
    const rows = db.fetchall('SELECT key FROM memories ORDER BY updated_at DESC LIMIT 10');
    expect(rows.length).toBe(2);
    expect(rows[0].key).toBe('second');
  });

  // P5: Namespace support
  it('saves with namespace', () => {
    memorySave('scoped-fact', 'Project-specific info', 'fact', '', 'project:myapp');
    const row = db.fetchone('SELECT namespace FROM memories WHERE key = ?', ['scoped-fact']);
    expect(row!.namespace).toBe('project:myapp');
  });

  it('filters by namespace', () => {
    memorySave('global-fact', 'Universal truth', 'fact', '', 'global');
    memorySave('project-fact', 'Project truth', 'fact', '', 'project:myapp');
    const rows = db.fetchall('SELECT key FROM memories WHERE namespace = ?', ['project:myapp']);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('project-fact');
  });

  // P6: Access tracking
  it('tracks access count and last_accessed', () => {
    memorySave('tracked', 'Track me');
    let row = db.fetchone('SELECT access_count, last_accessed FROM memories WHERE key = ?', ['tracked']);
    expect(row!.access_count).toBe(0);
    expect(row!.last_accessed).toBeNull();

    const now = db.now();
    db.execute(
      'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE key = ?',
      [now, 'tracked'],
    );
    row = db.fetchone('SELECT access_count, last_accessed FROM memories WHERE key = ?', ['tracked']);
    expect(row!.access_count).toBe(1);
    expect(row!.last_accessed).toBe(now);
  });

  // P8: Consolidation - expired memories
  it('finds expired memories', () => {
    db.execute(
      'INSERT INTO memories (key, content, type, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['expired', 'Old data', 'context', '2020-01-01 00:00:00', '2020-01-01 00:00:00', '2020-01-01 00:00:00'],
    );
    db.execute(
      'INSERT INTO memories (key, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['valid', 'Still good', 'fact', db.now(), db.now()],
    );
    const expired = db.fetchall(
      'SELECT key FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?',
      [db.now()],
    );
    expect(expired.length).toBe(1);
    expect(expired[0].key).toBe('expired');
  });
});

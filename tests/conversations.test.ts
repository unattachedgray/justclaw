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

describe('Conversation tools', () => {
  it('logs a conversation message', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user1', 'Hello Charlie', 0, db.now()],
    );
    const row = db.fetchone('SELECT * FROM conversations WHERE sender = ?', ['user1']);
    expect(row!.message).toBe('Hello Charlie');
    expect(row!.is_from_charlie).toBe(0);
  });

  it('conversation_history returns in chronological order', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'First', 0, '2026-03-20 10:00:00'],
    );
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'charlie', 'Second', 1, '2026-03-20 10:01:00'],
    );
    const rows = db.fetchall('SELECT message FROM conversations ORDER BY created_at DESC LIMIT 20');
    rows.reverse();
    expect(rows[0].message).toBe('First');
    expect(rows[1].message).toBe('Second');
  });

  it('filters by channel', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'Discord msg', 0, db.now()],
    );
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['telegram', 'user', 'Telegram msg', 0, db.now()],
    );
    const rows = db.fetchall('SELECT message FROM conversations WHERE channel = ?', ['discord']);
    expect(rows.length).toBe(1);
    expect(rows[0].message).toBe('Discord msg');
  });

  it('filters by since timestamp', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'Old', 0, '2020-01-01 00:00:00'],
    );
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'New', 0, '2026-03-20 12:00:00'],
    );
    const rows = db.fetchall('SELECT message FROM conversations WHERE created_at > ?', ['2025-01-01 00:00:00']);
    expect(rows.length).toBe(1);
    expect(rows[0].message).toBe('New');
  });

  it('conversation_summary formats messages', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'Hello', 0, '2026-03-20 10:00:00'],
    );
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'charlie', 'Hi there', 1, '2026-03-20 10:01:00'],
    );
    const rows = db.fetchall(
      'SELECT sender, message, created_at FROM conversations WHERE channel = ? ORDER BY created_at DESC LIMIT 50',
      ['discord'],
    );
    rows.reverse();
    const lines = rows.map((msg) => `[${msg.created_at}] ${msg.sender}: ${msg.message}`);
    const summary = lines.join('\n');
    expect(summary).toContain('[2026-03-20 10:00:00] user: Hello');
    expect(summary).toContain('[2026-03-20 10:01:00] charlie: Hi there');
  });

  // P9: Conversation FTS search
  it('searches conversations with FTS5', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'deploy the production server', 0, db.now()],
    );
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'charlie', 'working on the auth system', 1, db.now()],
    );
    const results = db.fetchall(
      "SELECT c.message FROM conversations_fts fts JOIN conversations c ON c.id = fts.rowid WHERE conversations_fts MATCH 'production' ORDER BY rank LIMIT 10",
    );
    expect(results.length).toBe(1);
    expect(results[0].message).toContain('production');
  });

  it('FTS search with AND operator', () => {
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'deploy the auth service to production', 0, db.now()],
    );
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'user', 'just deploy something', 0, db.now()],
    );
    const results = db.fetchall(
      "SELECT c.message FROM conversations_fts fts JOIN conversations c ON c.id = fts.rowid WHERE conversations_fts MATCH 'deploy AND production' ORDER BY rank LIMIT 10",
    );
    expect(results.length).toBe(1);
    expect(results[0].message).toContain('production');
  });
});

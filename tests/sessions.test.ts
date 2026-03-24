import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DB } from '../src/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildIdentityPreamble,
  buildTaskPreamble,
  buildHandoverPrompt,
  buildFlushReminder,
  shouldRotateSession,
  shouldFlushContext,
  invalidatePreambleCache,
  SESSION_TURN_FLUSH_THRESHOLD,
  SESSION_TURN_ROTATE_THRESHOLD,
  COALESCE_WINDOW_MS,
} from '../src/discord/session-context.js';

let db: DB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'justclaw-session-test-'));
  db = new DB(join(tmpDir, 'test.db'));
  invalidatePreambleCache(); // Clear cache between tests
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Phase 1: Session persistence — DB schema
// ---------------------------------------------------------------------------

describe('Session persistence (Phase 1)', () => {
  it('creates sessions table on init', () => {
    const tables = db
      .fetchall("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toContain('sessions');
  });

  it('schema version is 11', () => {
    const row = db.fetchone("SELECT value FROM schema_meta WHERE key='version'");
    expect(Number(row!.value)).toBe(11);
  });

  it('sessions table has all expected columns', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count, context_hint) VALUES (?, ?, ?, ?, ?, ?)',
      ['chan-1', 'sess-abc', now, now, 5, 'warm'],
    );
    const row = db.fetchone('SELECT * FROM sessions WHERE channel_id = ?', ['chan-1']);
    expect(row).not.toBeNull();
    expect(row!.channel_id).toBe('chan-1');
    expect(row!.session_id).toBe('sess-abc');
    expect(row!.turn_count).toBe(5);
    expect(row!.context_hint).toBe('warm');
  });

  it('channel_id is a primary key (upsert works)', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      ['chan-1', 'sess-1', now, now, 1],
    );
    // Upsert with ON CONFLICT.
    db.execute(
      `INSERT INTO sessions (channel_id, session_id, last_used_at, turn_count, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         session_id = excluded.session_id,
         last_used_at = excluded.last_used_at,
         turn_count = turn_count + ?`,
      ['chan-1', 'sess-2', now, 1, now, 1],
    );
    const row = db.fetchone('SELECT * FROM sessions WHERE channel_id = ?', ['chan-1']);
    expect(row!.session_id).toBe('sess-2');
    expect(row!.turn_count).toBe(2); // 1 + 1
  });

  it('can delete a session (for rotation/stale recovery)', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      ['chan-del', 'sess-del', now, now, 3],
    );
    db.execute('DELETE FROM sessions WHERE channel_id = ?', ['chan-del']);
    const row = db.fetchone('SELECT * FROM sessions WHERE channel_id = ?', ['chan-del']);
    expect(row).toBeNull();
  });

  it('defaults context_hint to fresh', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at) VALUES (?, ?, ?, ?)',
      ['chan-default', 'sess-d', now, now],
    );
    const row = db.fetchone('SELECT context_hint FROM sessions WHERE channel_id = ?', ['chan-default']);
    expect(row!.context_hint).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Identity preamble
// ---------------------------------------------------------------------------

describe('Identity preamble (Phase 2)', () => {
  it('includes system context header', () => {
    const preamble = buildIdentityPreamble(db, 'test-channel');
    expect(preamble).toContain('System context');
    expect(preamble).toContain('Charlie');
  });

  it('includes context snapshot when available', () => {
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, key_facts, created_at) VALUES (?, ?, ?, ?)',
      ['sess-1', 'Working on auth refactor', 'JWT tokens expire in 24h', db.now()],
    );
    const preamble = buildIdentityPreamble(db, 'test-channel');
    expect(preamble).toContain('Working on auth refactor');
    expect(preamble).toContain('JWT tokens expire in 24h');
  });

  it('includes active goals', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['ship-v1', 'Ship justclaw v1.0', 'goal', 'goals', now, now],
    );
    const preamble = buildIdentityPreamble(db, 'test-channel');
    expect(preamble).toContain('ship-v1');
    expect(preamble).toContain('Ship justclaw v1.0');
  });

  it('includes pending tasks', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO tasks (title, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['Deploy auth service', 3, 'pending', now, now],
    );
    const preamble = buildIdentityPreamble(db, 'test-channel');
    expect(preamble).toContain('Deploy auth service');
    expect(preamble).toContain('[P3]');
  });

  it('includes today activity log', () => {
    const now = db.now();
    const today = db.today();
    db.execute(
      'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
      [today, 'Fixed login bug', 'task', now],
    );
    const preamble = buildIdentityPreamble(db, 'test-channel');
    expect(preamble).toContain('Fixed login bug');
  });

  it('includes recent learnings', () => {
    db.execute(
      'INSERT INTO learnings (category, trigger, lesson, area, created_at) VALUES (?, ?, ?, ?, ?)',
      ['error', 'deploy crash', 'Always check disk before deploy', 'ops', db.now()],
    );
    const preamble = buildIdentityPreamble(db, 'test-channel');
    expect(preamble).toContain('Always check disk before deploy');
  });

  it('includes time since last interaction when > 5 min', () => {
    // Use ISO format with Z suffix so Date parsing is unambiguous.
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    // Store in the same format as db.now() but ensure it parses correctly.
    // The preamble uses new Date(str) — SQLite format "YYYY-MM-DD HH:MM:SS" is parsed as UTC-ish.
    // To make the test robust, insert using ISO format.
    const isoTenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      ['chan-time', 'sess-t', isoTenMinAgo, isoTenMinAgo, 5],
    );
    const preamble = buildIdentityPreamble(db, 'chan-time');
    expect(preamble).toContain('Time since last interaction');
    // Should be roughly 10 minutes (allow some fuzz).
    expect(preamble).toMatch(/\d+ minutes/);
  });

  it('omits time info when last interaction was recent', () => {
    const justNow = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      ['chan-recent', 'sess-r', justNow, justNow, 2],
    );
    const preamble = buildIdentityPreamble(db, 'chan-recent');
    expect(preamble).not.toContain('Time since last interaction');
  });

  it('handles empty database gracefully', () => {
    const preamble = buildIdentityPreamble(db, 'empty-channel');
    expect(preamble).toContain('System context');
    // Should not throw or include undefined.
    expect(preamble).not.toContain('undefined');
  });
});

describe('Task preamble (Phase 2)', () => {
  it('is lighter than identity preamble', () => {
    const identity = buildIdentityPreamble(db, 'test');
    const task = buildTaskPreamble(db);
    // Task preamble should be shorter (no tasks list, no daily log, no learnings).
    expect(task.length).toBeLessThanOrEqual(identity.length);
  });

  it('includes goals but not tasks', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO memories (key, content, type, namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['goal-1', 'Improve test coverage', 'goal', 'goals', now, now],
    );
    db.execute(
      'INSERT INTO tasks (title, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['Run tests', 5, 'pending', now, now],
    );
    const preamble = buildTaskPreamble(db);
    expect(preamble).toContain('Improve test coverage');
    expect(preamble).not.toContain('Run tests');
  });

  it('includes scheduled task system context', () => {
    const preamble = buildTaskPreamble(db);
    expect(preamble).toContain('scheduled task');
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Message coalescing
// ---------------------------------------------------------------------------

describe('Message coalescing (Phase 3)', () => {
  it('exports coalesce window constant', () => {
    expect(COALESCE_WINDOW_MS).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Pre-compaction flush
// ---------------------------------------------------------------------------

describe('Pre-compaction flush (Phase 4)', () => {
  it('should not flush when turns are low', () => {
    expect(shouldFlushContext(0)).toBe(false);
    expect(shouldFlushContext(5)).toBe(false);
    expect(shouldFlushContext(10)).toBe(false);
    expect(shouldFlushContext(19)).toBe(false);
  });

  it('should flush at threshold', () => {
    expect(shouldFlushContext(SESSION_TURN_FLUSH_THRESHOLD)).toBe(true);
  });

  it('should flush above threshold', () => {
    expect(shouldFlushContext(25)).toBe(true);
    expect(shouldFlushContext(100)).toBe(true);
  });

  it('flush reminder mentions context_flush', () => {
    const reminder = buildFlushReminder();
    expect(reminder).toContain('context_flush');
    expect(reminder).toContain('safety net');
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Session rotation
// ---------------------------------------------------------------------------

describe('Session rotation (Phase 5)', () => {
  it('should not rotate when fresh', () => {
    const result = shouldRotateSession(null, 0);
    expect(result.rotate).toBe(false);
  });

  it('should not rotate when recent and low turns', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const result = shouldRotateSession(now, 5);
    expect(result.rotate).toBe(false);
  });

  it('should rotate on new day (daily rotation)', () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    const result = shouldRotateSession(yesterday, 3);
    expect(result.rotate).toBe(true);
    expect(result.reason).toBe('daily');
  });

  it('should rotate when turns exceed threshold', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const result = shouldRotateSession(now, SESSION_TURN_ROTATE_THRESHOLD);
    expect(result.rotate).toBe(true);
    expect(result.reason).toBe('turn_limit');
  });

  it('should rotate when turns are well above threshold', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const result = shouldRotateSession(now, 50);
    expect(result.rotate).toBe(true);
    expect(result.reason).toBe('turn_limit');
  });

  it('daily rotation takes priority over turn_limit', () => {
    // Both conditions true — daily should win since it's checked first.
    const yesterday = new Date(Date.now() - 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    const result = shouldRotateSession(yesterday, SESSION_TURN_ROTATE_THRESHOLD + 10);
    expect(result.rotate).toBe(true);
    expect(result.reason).toBe('daily');
  });

  it('handover prompt includes context_flush instruction', () => {
    const prompt = buildHandoverPrompt();
    expect(prompt).toContain('context_flush');
    expect(prompt).toContain('Session rotation');
    expect(prompt).toContain('last turn');
  });

  it('threshold constants are sensible', () => {
    expect(SESSION_TURN_FLUSH_THRESHOLD).toBeLessThan(SESSION_TURN_ROTATE_THRESHOLD);
    expect(SESSION_TURN_FLUSH_THRESHOLD).toBeGreaterThan(0);
    expect(SESSION_TURN_ROTATE_THRESHOLD).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6: Scheduled task sessions
// ---------------------------------------------------------------------------

describe('Scheduled task sessions (Phase 6)', () => {
  it('tasks table has session_id column', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO tasks (title, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ['Test task', 'sess-task-1', now, now],
    );
    const row = db.fetchone('SELECT session_id FROM tasks WHERE title = ?', ['Test task']);
    expect(row!.session_id).toBe('sess-task-1');
  });

  it('session_id defaults to NULL', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO tasks (title, created_at, updated_at) VALUES (?, ?, ?)',
      ['No session task', now, now],
    );
    const row = db.fetchone('SELECT session_id FROM tasks WHERE title = ?', ['No session task']);
    expect(row!.session_id).toBeNull();
  });

  it('session_id can be updated after task run', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO tasks (title, created_at, updated_at) VALUES (?, ?, ?)',
      ['Updatable task', now, now],
    );
    const task = db.fetchone('SELECT id FROM tasks WHERE title = ?', ['Updatable task']);
    db.execute('UPDATE tasks SET session_id = ? WHERE id = ?', ['sess-new', task!.id]);
    const updated = db.fetchone('SELECT session_id FROM tasks WHERE id = ?', [task!.id]);
    expect(updated!.session_id).toBe('sess-new');
  });

  it('session_id propagates to spawned recurrence instances', () => {
    const now = db.now();
    // Create a recurring task with session_id.
    db.execute(
      'INSERT INTO tasks (title, recurrence, session_id, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['Daily briefing', 'daily', 'sess-recurring', now, now, now],
    );
    const parent = db.fetchone('SELECT id FROM tasks WHERE title = ?', ['Daily briefing']);

    // Simulate spawning next recurrence (mimics spawnNextRecurrence in tasks.ts).
    db.execute(
      `INSERT INTO tasks (title, recurrence, recurrence_source_id, session_id, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['Daily briefing', 'daily', parent!.id, 'sess-recurring', now, now, now],
    );

    const child = db.fetchone(
      'SELECT session_id FROM tasks WHERE recurrence_source_id = ?',
      [parent!.id],
    );
    expect(child!.session_id).toBe('sess-recurring');
  });

  it('session_id can be updated across recurrence chain', () => {
    const now = db.now();
    db.execute(
      'INSERT INTO tasks (title, recurrence, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['Chain task', 'daily', 'old-sess', now, now],
    );
    const parent = db.fetchone('SELECT id FROM tasks WHERE title = ?', ['Chain task']);

    // Spawn child.
    db.execute(
      'INSERT INTO tasks (title, recurrence, recurrence_source_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['Chain task', 'daily', parent!.id, 'old-sess', now, now],
    );

    // Update session_id for all tasks in the chain.
    db.execute(
      'UPDATE tasks SET session_id = ? WHERE recurrence_source_id = ? OR id = ?',
      ['new-sess', parent!.id, parent!.id],
    );

    const parentUpdated = db.fetchone('SELECT session_id FROM tasks WHERE id = ?', [parent!.id]);
    expect(parentUpdated!.session_id).toBe('new-sess');

    const childUpdated = db.fetchone('SELECT session_id FROM tasks WHERE recurrence_source_id = ?', [parent!.id]);
    expect(childUpdated!.session_id).toBe('new-sess');
  });
});

// ---------------------------------------------------------------------------
// Integration: full session lifecycle
// ---------------------------------------------------------------------------

describe('Session lifecycle integration', () => {
  it('full lifecycle: create → use → flush threshold → rotate → restart', () => {
    const now = db.now();
    const channelId = 'lifecycle-chan';

    // 1. Create session (first interaction).
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      [channelId, 'sess-lifecycle', now, now, 0],
    );

    // 2. Simulate turns accumulating.
    for (let i = 0; i < SESSION_TURN_FLUSH_THRESHOLD; i++) {
      db.execute(
        `UPDATE sessions SET turn_count = turn_count + 1, last_used_at = ? WHERE channel_id = ?`,
        [now, channelId],
      );
    }

    // 3. Check flush threshold reached.
    const session = db.fetchone('SELECT turn_count FROM sessions WHERE channel_id = ?', [channelId]);
    expect(shouldFlushContext(session!.turn_count as number)).toBe(true);

    // 4. Continue to rotation threshold.
    for (let i = 0; i < (SESSION_TURN_ROTATE_THRESHOLD - SESSION_TURN_FLUSH_THRESHOLD); i++) {
      db.execute(
        `UPDATE sessions SET turn_count = turn_count + 1, last_used_at = ? WHERE channel_id = ?`,
        [now, channelId],
      );
    }

    const session2 = db.fetchone('SELECT turn_count, last_used_at FROM sessions WHERE channel_id = ?', [channelId]);
    const rotation = shouldRotateSession(session2!.last_used_at as string, session2!.turn_count as number);
    expect(rotation.rotate).toBe(true);
    expect(rotation.reason).toBe('turn_limit');

    // 5. Rotate: delete session.
    db.execute('DELETE FROM sessions WHERE channel_id = ?', [channelId]);
    const cleared = db.fetchone('SELECT * FROM sessions WHERE channel_id = ?', [channelId]);
    expect(cleared).toBeNull();

    // 6. Restart: create fresh session (simulates bot restart + first interaction).
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      [channelId, 'sess-fresh', now, now, 0],
    );
    const fresh = db.fetchone('SELECT * FROM sessions WHERE channel_id = ?', [channelId]);
    expect(fresh!.session_id).toBe('sess-fresh');
    expect(fresh!.turn_count).toBe(0);
  });

  it('identity preamble populates from all sources', () => {
    const now = db.now();
    const today = db.today();
    const channelId = 'full-preamble-chan';

    // Seed all data sources.
    db.execute(
      'INSERT INTO context_snapshots (session_id, summary, key_facts, created_at) VALUES (?, ?, ?, ?)',
      ['s1', 'Deployed new auth', 'Rollback plan exists', now],
    );
    db.execute(
      'INSERT INTO memories (key, content, type, namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['improve-tests', 'Reach 90% coverage', 'goal', 'goals', now, now],
    );
    db.execute(
      'INSERT INTO tasks (title, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['Write integration tests', 2, 'active', now, now],
    );
    db.execute(
      'INSERT INTO daily_log (date, entry, category, created_at) VALUES (?, ?, ?, ?)',
      [today, 'Reviewed PR #42', 'task', now],
    );
    db.execute(
      'INSERT INTO learnings (category, trigger, lesson, area, created_at) VALUES (?, ?, ?, ?, ?)',
      ['discovery', 'code review', 'Use parameterized queries', 'security', now],
    );
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    db.execute(
      'INSERT INTO sessions (channel_id, session_id, created_at, last_used_at, turn_count) VALUES (?, ?, ?, ?, ?)',
      [channelId, 'sess-full', tenMinAgo, tenMinAgo, 8],
    );

    const preamble = buildIdentityPreamble(db, channelId);

    expect(preamble).toContain('Deployed new auth');
    expect(preamble).toContain('Rollback plan exists');
    expect(preamble).toContain('improve-tests');
    expect(preamble).toContain('Write integration tests');
    expect(preamble).toContain('Reviewed PR #42');
    expect(preamble).toContain('Use parameterized queries');
    expect(preamble).toMatch(/\d+ minutes/);
  });
});

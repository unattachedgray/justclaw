import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const SCHEMA_VERSION = 6;

const SCHEMA_SQL = `
-- Memories: durable facts, preferences, decisions, context.
CREATE TABLE IF NOT EXISTS memories (
    id            INTEGER PRIMARY KEY,
    key           TEXT    UNIQUE NOT NULL,
    content       TEXT    NOT NULL,
    type          TEXT    NOT NULL DEFAULT 'general',
    tags          TEXT    NOT NULL DEFAULT '',
    namespace     TEXT    NOT NULL DEFAULT 'global',
    access_count  INTEGER NOT NULL DEFAULT 0,
    last_accessed TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT
);

-- FTS5 index for semantic-ish memory search (BM25 ranking).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    key, content, tags,
    content=memories,
    content_rowid=id
);

-- Triggers to keep FTS in sync with memories table.
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, key, content, tags)
    VALUES (new.id, new.key, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, key, content, tags)
    VALUES ('delete', old.id, old.key, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, key, content, tags)
    VALUES ('delete', old.id, old.key, old.content, old.tags);
    INSERT INTO memories_fts(rowid, key, content, tags)
    VALUES (new.id, new.key, new.content, new.tags);
END;

-- Task queue: persistent across sessions.
CREATE TABLE IF NOT EXISTS tasks (
    id            INTEGER PRIMARY KEY,
    title         TEXT    NOT NULL,
    description   TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'pending',
    priority      INTEGER NOT NULL DEFAULT 5,
    tags          TEXT    NOT NULL DEFAULT '',
    result        TEXT    NOT NULL DEFAULT '',
    depends_on    TEXT    NOT NULL DEFAULT '',
    assigned_to   TEXT    NOT NULL DEFAULT '',
    claimed_at    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    due_at        TEXT,
    completed_at  TEXT,
    recurrence    TEXT,
    recurrence_source_id INTEGER
);

-- Context snapshots: saved before compaction or at session end.
CREATE TABLE IF NOT EXISTS context_snapshots (
    id              INTEGER PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    summary         TEXT    NOT NULL,
    key_facts       TEXT    NOT NULL DEFAULT '',
    active_task_ids TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Conversation log: messages from Discord and other channels.
CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY,
    channel         TEXT    NOT NULL DEFAULT 'discord',
    sender          TEXT    NOT NULL,
    message         TEXT    NOT NULL,
    is_from_charlie INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 index for conversation content search.
CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
    sender, message,
    content=conversations,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
    INSERT INTO conversations_fts(rowid, sender, message)
    VALUES (new.id, new.sender, new.message);
END;

CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
    INSERT INTO conversations_fts(conversations_fts, rowid, sender, message)
    VALUES ('delete', old.id, old.sender, old.message);
END;

-- Daily activity log: append-only journal.
CREATE TABLE IF NOT EXISTS daily_log (
    id          INTEGER PRIMARY KEY,
    date        TEXT    NOT NULL,
    entry       TEXT    NOT NULL,
    category    TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Key-value state store for arbitrary persistent state.
CREATE TABLE IF NOT EXISTS state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema version tracking.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

// Migrations from v1 to v2 (applied to existing databases).
const MIGRATIONS: Record<number, string[]> = {
  2: [
    // P5: Memory namespaces
    "ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT 'global'",
    // P6: Memory access tracking
    'ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE memories ADD COLUMN last_accessed TEXT',
    // P3: Task dependencies + agent assignment
    "ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN assigned_to TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE tasks ADD COLUMN claimed_at TEXT',
    // P9: Conversation FTS
    "CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(sender, message, content=conversations, content_rowid=id)",
    `CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
       INSERT INTO conversations_fts(rowid, sender, message) VALUES (new.id, new.sender, new.message);
     END`,
    `CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
       INSERT INTO conversations_fts(conversations_fts, rowid, sender, message) VALUES ('delete', old.id, old.sender, old.message);
     END`,
  ],
  3: [
    // Process registry: tracks all PIDs we spawn or manage.
    // status: 'active' (should be running) or 'retired' (should NOT be running).
    `CREATE TABLE IF NOT EXISTS process_registry (
        id          INTEGER PRIMARY KEY,
        pid         INTEGER NOT NULL,
        role        TEXT    NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'active',
        started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        retired_at  TEXT,
        meta        TEXT    NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_process_registry_status ON process_registry(status)`,
    `CREATE INDEX IF NOT EXISTS idx_process_registry_pid ON process_registry(pid)`,
  ],
  4: [
    // Playbook: learned remediation patterns from LLM escalation.
    // Deterministic checks consult this before escalating to Claude.
    `CREATE TABLE IF NOT EXISTS playbook (
        id               INTEGER PRIMARY KEY,
        goal             TEXT    NOT NULL,
        pattern          TEXT    NOT NULL,
        action           TEXT    NOT NULL,
        confidence       REAL    NOT NULL DEFAULT 0.5,
        source           TEXT    NOT NULL DEFAULT 'learned',
        times_used       INTEGER NOT NULL DEFAULT 0,
        times_succeeded  INTEGER NOT NULL DEFAULT 0,
        learned_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        last_used        TEXT
    )`,
    // Escalation log: tracks LLM escalation calls and their outcomes.
    `CREATE TABLE IF NOT EXISTS escalation_log (
        id              INTEGER PRIMARY KEY,
        goal            TEXT    NOT NULL,
        trigger_detail  TEXT    NOT NULL,
        diagnosis       TEXT,
        action_taken    TEXT,
        recommendation  TEXT,
        outcome         TEXT    NOT NULL DEFAULT 'pending',
        created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT
    )`,
  ],
  5: [
    // Alert management: silences, whitelists, acknowledgments.
    // Patterns: Prometheus silences, PagerDuty acknowledge, Nagios scheduled downtime.
    `CREATE TABLE IF NOT EXISTS alert_silences (
        id          INTEGER PRIMARY KEY,
        matcher     TEXT    NOT NULL,
        reason      TEXT    NOT NULL DEFAULT '',
        type        TEXT    NOT NULL DEFAULT 'silence',
        expires_at  TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,
    // Process whitelist: known-safe processes that should not be flagged.
    // Built-in defaults loaded on first run; user can add via MCP tool.
    `CREATE TABLE IF NOT EXISTS process_whitelist (
        id          INTEGER PRIMARY KEY,
        pattern     TEXT    NOT NULL UNIQUE,
        reason      TEXT    NOT NULL DEFAULT '',
        source      TEXT    NOT NULL DEFAULT 'user',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,
  ],
  6: [
    // Recurring tasks: pattern stored as daily/weekly/monthly/cron:<expr>.
    // recurrence_source_id links spawned instances back to the original template.
    'ALTER TABLE tasks ADD COLUMN recurrence TEXT',
    'ALTER TABLE tasks ADD COLUMN recurrence_source_id INTEGER',
  ],
};

export class DB {
  public conn: Database.Database;
  public dbPath: string;
  private walCheckpointTimer: ReturnType<typeof setInterval> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.conn = new Database(dbPath);
    this.conn.pragma('journal_mode = WAL');
    this.conn.pragma('foreign_keys = ON');
    this.conn.pragma('busy_timeout = 5000');
    this.checkIntegrity();
    this.initSchema();
    this.startMaintenanceTimers();
  }

  /** P1: Check DB integrity on startup. If corrupt, rename and start fresh. */
  private checkIntegrity(): void {
    try {
      const result = this.conn.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (result[0]?.integrity_check !== 'ok') {
        const msg = result.map((r) => r.integrity_check).join(', ');
        console.error(`DB integrity check FAILED: ${msg}. Renaming corrupt DB and starting fresh.`);
        this.conn.close();
        const backupPath = this.dbPath + '.corrupt.' + Date.now();
        require('fs').renameSync(this.dbPath, backupPath);
        this.conn = new Database(this.dbPath);
        this.conn.pragma('journal_mode = WAL');
        this.conn.pragma('foreign_keys = ON');
        this.conn.pragma('busy_timeout = 5000');
      }
    } catch (err) {
      console.error(`DB integrity check error: ${err}`);
    }
  }

  /** Start periodic WAL checkpoint (1h) and backup (6h). */
  private startMaintenanceTimers(): void {
    // WAL checkpoint every hour — keeps WAL file from growing unbounded.
    this.walCheckpointTimer = setInterval(() => {
      try { this.conn.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    }, 60 * 60_000);

    // Backup every 6 hours.
    this.backupTimer = setInterval(() => {
      this.backup();
    }, 6 * 60 * 60_000);
  }

  /** Create a backup of the database. */
  backup(): void {
    try {
      const backupPath = this.dbPath + '.bak';
      this.conn.backup(backupPath).then(() => {
        // backup completed
      }).catch(() => {
        // backup failed — non-critical
      });
    } catch { /* ignore */ }
  }

  private initSchema(): void {
    this.conn.exec(SCHEMA_SQL);

    const existing = this.conn
      .prepare("SELECT value FROM schema_meta WHERE key='version'")
      .get() as { value: string } | undefined;

    const currentVersion = existing ? parseInt(existing.value, 10) : 0;

    if (!existing) {
      this.conn
        .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
        .run('version', String(SCHEMA_VERSION));
    } else if (currentVersion < SCHEMA_VERSION) {
      this.runMigrations(currentVersion);
    }
  }

  private runMigrations(fromVersion: number): void {
    for (let v = fromVersion + 1; v <= SCHEMA_VERSION; v++) {
      const stmts = MIGRATIONS[v];
      if (!stmts) continue;
      for (const sql of stmts) {
        try {
          this.conn.exec(sql);
        } catch (e) {
          // Ignore "duplicate column" or "table already exists" errors during migration
          const msg = String(e);
          if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
            throw e;
          }
        }
      }
    }
    this.conn
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
      .run(String(SCHEMA_VERSION));
  }

  execute(sql: string, params: unknown[] = []): Database.RunResult {
    return this.conn.prepare(sql).run(...params);
  }

  fetchone(sql: string, params: unknown[] = []): Record<string, unknown> | null {
    const row = this.conn.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  fetchall(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    return this.conn.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn)();
  }

  today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  now(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  close(): void {
    if (this.walCheckpointTimer) clearInterval(this.walCheckpointTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.conn.close();
  }
}

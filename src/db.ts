import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from './db-schema.js';

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
    this.conn.pragma('cache_size = -2000'); // 2MB cache (negative = KB), down from default 8MB
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
      try { this.conn.pragma('wal_checkpoint(TRUNCATE)'); } catch (e: unknown) { process.stderr.write(`WAL checkpoint failed: ${e}\n`); }
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
      }).catch((e: unknown) => {
        process.stderr.write(`DB backup failed: ${e}\n`);
      });
    } catch (e: unknown) { process.stderr.write(`DB backup setup failed: ${e}\n`); }
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

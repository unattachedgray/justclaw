# Database Schema (v4)

SQLite with WAL mode, FTS5. Schema defined in `src/db.ts` with automatic migration.

## Tables

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `memories` | key (UNIQUE), content, type, tags, namespace, access_count, last_accessed, expires_at | FTS5 via `memories_fts` with sync triggers |
| `tasks` | title, status, priority, tags, result, depends_on, assigned_to, claimed_at, due_at | Status: pending→active→completed\|failed\|blocked |
| `context_snapshots` | session_id, summary, key_facts, active_task_ids | Pre-compaction state preservation |
| `conversations` | channel, sender, message, is_from_charlie | FTS5 via `conversations_fts` with sync triggers |
| `process_registry` | pid, role, status (active/retired), started_at, retired_at, meta | v3: PID lifecycle tracking |
| `playbook` | goal, pattern, action, confidence, source, times_used | v4: learned remediation patterns |
| `escalation_log` | goal, trigger_detail, diagnosis, action_taken, recommendation, outcome | v4: escalation audit trail |
| `daily_log` | date, entry, category | Append-only activity journal |
| `state` | key (PK), value | KV store + suspicious_pid_* entries |
| `schema_meta` | key (PK), value | Version tracking (currently v4) |

## Self-Healing Features

- `PRAGMA integrity_check` on startup — renames corrupt DB, starts fresh
- `PRAGMA busy_timeout = 5000` — auto-retry on SQLITE_BUSY
- WAL checkpoint every 1 hour (`PRAGMA wal_checkpoint(TRUNCATE)`)
- Backup every 6 hours (SQLite online backup API)

## Migration System

`MIGRATIONS` map in `db.ts`: version number → array of SQL statements. On startup, if `schema_meta.version < SCHEMA_VERSION`, runs statements with duplicate-safe error handling.

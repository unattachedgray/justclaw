# Database Schema (v10)

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
| `learnings` | category, trigger, lesson, area, applied_count | v8: structured self-improvement from errors/corrections |
| `sessions` | channel_id (PK), session_id, turn_count, last_used_at, context_hint | v10: persistent session IDs for `--resume` across restarts |
| `daily_log` | date, entry, category | Append-only activity journal |
| `state` | key (PK), value | KV store + suspicious_pid_* entries |
| `schema_meta` | key (PK), value | Version tracking (currently v10) |

### Sessions Table (v10)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `channel_id` | TEXT | (PK) | Discord channel ID — one session per channel |
| `session_id` | TEXT | NOT NULL | Claude Code session ID for `--resume` |
| `created_at` | TEXT | now | When the session was first established |
| `last_used_at` | TEXT | now | Updated after each successful `callClaude` |
| `turn_count` | INTEGER | 0 | Incremented each turn; drives flush (20) and rotation (30) thresholds |
| `context_hint` | TEXT | 'fresh' | Session state hint: fresh, warm, hot |

### Tasks Extra Columns (v9-v10)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `auto_execute` | INTEGER | 0 | When 1, task can be auto-executed by scheduled task runner |
| `recurrence` | TEXT | NULL | Cron-style recurrence (e.g., `cron:0 8 * * 1-5`) |
| `target_channel` | TEXT | NULL | Discord channel ID for posting scheduled task results. Falls back to heartbeat channel if NULL. Inherited by spawned recurrence instances. |
| `session_id` | TEXT | NULL | v10: Claude Code session ID for scheduled task `--resume`. Inherited by spawned recurrence instances. |

## Self-Healing Features

- `PRAGMA integrity_check` on startup — renames corrupt DB, starts fresh
- `PRAGMA busy_timeout = 5000` — auto-retry on SQLITE_BUSY
- WAL checkpoint every 1 hour (`PRAGMA wal_checkpoint(TRUNCATE)`)
- Backup every 6 hours (SQLite online backup API)

## Migration System

`MIGRATIONS` map in `db.ts`: version number → array of SQL statements. On startup, if `schema_meta.version < SCHEMA_VERSION`, runs statements with duplicate-safe error handling.

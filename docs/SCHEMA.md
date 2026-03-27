# Database Schema (v15)

SQLite with WAL mode, FTS5. Schema defined in `src/db-schema.ts` with automatic migration.

## Tables

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `memories` | key (UNIQUE), content, type, tags, namespace, access_count, last_accessed, expires_at | FTS5 via `memories_fts` with sync triggers |
| `tasks` | title, status, priority, tags, result, depends_on, assigned_to, claimed_at, due_at, max_steps, max_cost_cents | Status: pending→active→delivering→completed\|failed\|blocked |
| `context_snapshots` | session_id, summary, key_facts, active_task_ids | Pre-compaction state preservation |
| `conversations` | channel, sender, message, is_from_charlie | FTS5 via `conversations_fts` with sync triggers |
| `process_registry` | pid, role, status (active/retired), started_at, retired_at, meta | v3: PID lifecycle tracking |
| `playbook` | goal, pattern, action, confidence, source, times_used, success_criteria, guardrails, steps | v15: enhanced remediation patterns |
| `escalation_log` | goal, trigger_detail, diagnosis, action_taken, recommendation, outcome | v4: escalation audit trail |
| `learnings` | category, trigger, lesson, area, applied_count | v8: structured self-improvement from errors/corrections |
| `sessions` | channel_id (PK), session_id, turn_count, last_used_at, context_hint | v10: persistent session IDs for `--resume` across restarts |
| `daily_log` | date, entry, category | Append-only activity journal |
| `state` | key (PK), value | KV store + pending_delivery:*, git_checkpoint:*, template_stats:* |
| `notebooks` | name (UNIQUE), source_path, mode, total_files, total_chunks, total_tokens | v12: named document collections |
| `document_chunks` | notebook_id (FK), file_path, file_name, chunk_index, content, line_start, line_end, token_estimate | v12: source content segments with FTS5 via `chunks_fts` |
| `task_reflections` | task_id, quality_score, error_class, errors_found, learnings_created, playbook_updated, duration_ms | Post-task quality analysis |
| `task_checkpoints` | task_id, step, phase, state_json | v15: resumable intermediate task state |
| `schema_meta` | key (PK), value | Version tracking (currently v15) |

### Sessions Table (v10)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `channel_id` | TEXT | (PK) | Discord channel ID — one session per channel |
| `session_id` | TEXT | NOT NULL | Claude Code session ID for `--resume` |
| `created_at` | TEXT | now | When the session was first established |
| `last_used_at` | TEXT | now | Updated after each successful `callClaude` |
| `turn_count` | INTEGER | 0 | Incremented each turn; drives flush (20) and rotation (30) thresholds |
| `context_hint` | TEXT | 'fresh' | Session state hint: fresh, warm, hot |

### Tasks Extra Columns (v9-v15)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `auto_execute` | INTEGER | 0 | When 1, task can be auto-executed by scheduled task runner |
| `recurrence` | TEXT | NULL | Cron-style recurrence (e.g., `cron:0 8 * * 1-5`) |
| `target_channel` | TEXT | NULL | Discord channel ID for posting scheduled task results. Falls back to heartbeat channel if NULL. Inherited by spawned recurrence instances. |
| `session_id` | TEXT | NULL | v10: Claude Code session ID for scheduled task `--resume`. Inherited by spawned recurrence instances. |
| `max_steps` | INTEGER | NULL | v15: Maximum tool-use steps before task is terminated. Prevents runaway agent loops. |
| `max_cost_cents` | INTEGER | NULL | v15: Maximum estimated cost in cents before task is terminated. |

### Playbook Extra Columns (v15)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `success_criteria` | TEXT | NULL | How to verify the fix worked |
| `guardrails` | TEXT | NULL | What NOT to do when applying this pattern |
| `steps` | TEXT | NULL | JSON array of step-by-step procedure (auto-populated at confidence >= 0.7) |

### Task Checkpoints Table (v15)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | PK | Auto-increment |
| `task_id` | INTEGER | NOT NULL | References tasks.id |
| `step` | INTEGER | NOT NULL | Step number in execution |
| `phase` | TEXT | NOT NULL | Phase name: research, compile, archive, delivery |
| `state_json` | TEXT | NOT NULL | Serialized intermediate state |
| `created_at` | TEXT | now | When checkpoint was created |

### Performance Indexes (v11)
| Index | Columns | Notes |
|-------|---------|-------|
| `idx_conversations_created_at` | conversations(created_at) | Speeds up time-range queries on conversation history |
| `idx_tasks_status_priority` | tasks(status, priority) WHERE status IN ('pending', 'active') | Partial index for task_next and task_list queries |
| `idx_tasks_due_at` | tasks(due_at) WHERE status = 'pending' AND recurrence IS NOT NULL | Partial index for scheduled task due-date lookups |
| `idx_daily_log_date` | daily_log(date) | Speeds up daily log queries (context_today, preamble builder) |

## Self-Healing Features

- `PRAGMA integrity_check` on startup — renames corrupt DB, starts fresh
- `PRAGMA busy_timeout = 5000` — auto-retry on SQLITE_BUSY
- WAL checkpoint every 1 hour (`PRAGMA wal_checkpoint(TRUNCATE)`)
- Backup every 6 hours (SQLite online backup API)

## Migration System

`MIGRATIONS` map in `db.ts`: version number → array of SQL statements. On startup, if `schema_meta.version < SCHEMA_VERSION`, runs statements with duplicate-safe error handling.

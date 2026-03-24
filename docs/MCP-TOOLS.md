# MCP Tools Reference (37 total)

## Memory (6)
| Tool | Description |
|------|-------------|
| `memory_save` | Save/update memory with key, content, type, tags, namespace |
| `memory_search` | FTS5 search with BM25, namespace/type/tag filters, access tracking |
| `memory_recall` | Exact key lookup, increments access_count |
| `memory_forget` | Delete a memory |
| `memory_list` | List with type/namespace filters |
| `memory_consolidate` | Find expired/stale, stats by namespace/type, dry-run mode |

## Tasks (6)
| Tool | Description |
|------|-------------|
| `task_create` | Create with title, description, priority, tags, due_at, depends_on, target_channel |
| `task_update` | Update status/description/priority/result/depends_on/target_channel |
| `task_list` | List with status/priority/tag/assigned_to filters |
| `task_next` | Highest-priority ready task (respects depends_on), auto-marks active |
| `task_claim` | Atomic claim for agent, stale-claim override (>1hr) with force |
| `task_complete` | Complete with result notes, logs to daily_log |

## Context (5)
| Tool | Description |
|------|-------------|
| `context_flush` | Save snapshot before compaction/session end |
| `context_restore` | Restore most recent snapshot (or by session_id) |
| `context_today` | Get today's daily log entries |
| `daily_log_add` | Add entry with category |
| `daily_log_get` | Get log by date |

## Conversations (4)
| Tool | Description |
|------|-------------|
| `conversation_log` | Log message (sender, message, channel, is_from_charlie) |
| `conversation_history` | Recent messages with channel/since filters |
| `conversation_search` | FTS5 search across history |
| `conversation_summary` | Plain-text transcript format |

## State & Status (3)
| Tool | Description |
|------|-------------|
| `state_get` / `state_set` | Persistent key-value store |
| `status` | Quick overview: pending tasks, memory count, today's log |

## Process Management (4)
| Tool | Description |
|------|-------------|
| `process_check` | Find orphaned processes via /proc, optional kill |
| `process_restart_self` | Exit for process manager restart |
| `process_restart_dashboard` | Kill and respawn dashboard |
| `process_ghost_status` | Get adaptive ghost check state |

## Goals (3)
| Tool | Description |
|------|-------------|
| `goal_set` | Create or update a persistent goal with title, description, priority, target_date |
| `goal_list` | List active goals (or archived with `include_archived: true`) |
| `goal_archive` | Archive a goal by title (moves to `goals-archived` namespace) |

Goals are stored in the `memories` table with `type='goal'`, `namespace='goals'`. They drive daily task generation via the `skills/daily-goals/SKILL.md` scheduled skill.

## Learnings (3)
| Tool | Description |
|------|-------------|
| `learning_add` | Record a learning with category (error/correction/discovery/skill), trigger, lesson, area |
| `learning_search` | Search learnings by category/area/keyword with limit |
| `learning_stats` | Get counts by category and area, plus total and recent (7d) counts |

Learnings are stored in the `learnings` table (schema v8). Categories: `error` (something broke), `correction` (user corrected behavior), `discovery` (found a better approach), `skill` (acquired new capability).

## Anticipation (1)
| Tool | Description |
|------|-------------|
| `anticipate_next` | Gather signals (recent work, pending tasks, goals, time patterns, learnings, conversations, velocity) and predict what the user likely needs next. Returns deterministic signals for LLM synthesis. |

Signals gathered: `recent_work` (completed tasks in 48h), `pending_work` (queued tasks), `goals` (active goals), `time_context` (day/hour + historical patterns), `recent_learnings` (latest lessons), `recent_conversations` (last 4h), `velocity` (completion rate vs average).

When run from the heartbeat (every 12th cycle, ~1h), signals are fed to `claude -p` which synthesizes a prediction with confidence level. High-confidence predictions with `create_task` action auto-create tasks tagged `anticipated`.

## System Health (2)
| Tool | Description |
|------|-------------|
| `system_recommendations` | Pending improvement recommendations from escalation |
| `system_escalation_history` | Full escalation audit trail |

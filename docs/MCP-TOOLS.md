# MCP Tools Reference (30 total)

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
| `task_create` | Create with title, description, priority, tags, due_at, depends_on |
| `task_update` | Update status/description/priority/result/depends_on |
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

## System Health (2)
| Tool | Description |
|------|-------------|
| `system_recommendations` | Pending improvement recommendations from escalation |
| `system_escalation_history` | Full escalation audit trail |

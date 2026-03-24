# MCP Tools Reference (49 total)

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

## Notebooks (6)
| Tool | Description |
|------|-------------|
| `notebook_create` | Ingest a directory into a named notebook. Scans 60+ file types (PDF, DOCX, XLSX, PPTX, HTML, EPUB, images, code, config). Chunks content, indexes with FTS5. Direct mode (<100K tokens) loads all into context; chunked mode uses BM25 retrieval. |
| `notebook_query` | Search a notebook for content relevant to a query. Returns source-grounded passages with file paths and line numbers. Cite as [source:filename:lines]. |
| `notebook_sources` | List all source files in a notebook with chunk counts and token estimates. |
| `notebook_list` | List all notebooks with stats (mode, files, chunks, tokens, path). |
| `notebook_overview` | Returns source data for notebook guide synthesis. Produce: overview, key topics, suggested questions, per-source summaries. |
| `notebook_delete` | Delete a notebook and all its indexed chunks. |

Notebooks use a "context-window-first" architecture (like NotebookLM). Small doc sets (<100K tokens) load entirely into Claude's 200K context window. Larger sets use FTS5 BM25 search to retrieve relevant chunks. Supported formats: PDF (unpdf), DOCX (mammoth), XLSX/PPTX/ODP/ODS/ODT/RTF/EPUB (officeparser), HTML (turndown→markdown), SVG (text extraction), images (Claude vision placeholder), plus 40+ text/code/config formats.

Incremental re-indexing tracks file mtimes — only changed files are re-chunked on `notebook_create`. Unsupported formats are logged as learnings for future auto-research.

## Monitors (6)
| Tool | Description |
|------|-------------|
| `monitor_create` | Define a new monitor: source (URL or shell command), extractor (jsonpath/regex/status_code/response_time/body_hash/stdout/exit_code), condition (threshold/change/contains/regex), schedule (cron), notification channel. |
| `monitor_list` | List all monitors with current status, last value, and check time. |
| `monitor_check` | Manually trigger a check on one monitor (by name) or all due monitors. Returns extracted value and condition evaluation. |
| `monitor_history` | View recent check results for a monitor as time-series (value, status, timestamp). |
| `monitor_update` | Update a monitor's configuration (condition, schedule, channel, enabled state). |
| `monitor_delete` | Delete a monitor and all its history. |

Monitors run automatically in the heartbeat loop (every 5 min). Each tick, `checkDueMonitors()` queries enabled monitors whose cron schedule says they're due, fetches the source, extracts the value, evaluates the condition, stores in `monitor_history`, and posts alerts to the configured Discord channel. Alerts escalate from ALERT to CRITICAL after 3 consecutive triggers.

**Example monitors:**
- Bitcoin price: `source_type=url`, `source_config={"url":"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"}`, `extractor_type=jsonpath`, `extractor_config={"path":"$.bitcoin.usd"}`, `condition_type=change_percent`, `condition_config={"percent":5}`
- Website uptime: `source_type=url`, `source_config={"url":"https://example.com"}`, `extractor_type=status_code`, `condition_type=threshold_below`, `condition_config={"value":200}`
- Disk usage: `source_type=command`, `source_config={"command":"df -h / | awk 'NR==2{print $5}' | tr -d '%'"}`, `extractor_type=stdout`, `condition_type=threshold_above`, `condition_config={"value":90}`

## System Health (2)
| Tool | Description |
|------|-------------|
| `system_recommendations` | Pending improvement recommendations from escalation |
| `system_escalation_history` | Full escalation audit trail |

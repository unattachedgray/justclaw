# justclaw — Persistence & automation layer for Claude Code CLI

SQLite-backed MCP server (30 tools) + Discord bot + deterministic heartbeat + self-healing process management. TypeScript, Node.js 20+, Linux.

**Philosophy**: Deterministic code first, LLM only when reasoning is genuinely needed. Claude Code CLI is the brain; justclaw is the long-term memory, task queue, and lifecycle harness.

## System Context

| Property | Value |
|----------|-------|
| **Project name** | justclaw |
| **Project root** | `/home/julian/temp/justclaw` |
| **Repository** | `github.com/unattachedgray/justclaw` |
| **Owner** | Julian (`julian` on this machine, `unattachedgray` on GitHub) |
| **Host** | Lenovo ThinkCentre M725s, AMD Ryzen 5 PRO 2400G, 6.7GB RAM |
| **OS** | Ubuntu 24.04 (Linux 6.8.0, x86_64) |
| **Hostname** | `ubuntu-ThinkCentre-M725s` |
| **Node.js** | v22+ |
| **Discord channel** | Private server, single-user (Julian) |
| **PM2 services** | `justclaw-dashboard` (Hono :8787), `justclaw-discord` (bot + heartbeat) |
| **Database** | `data/charlie.db` (SQLite, WAL, FTS5, schema v12) |
| **Debug mode** | Set `JUSTCLAW_DEBUG=1` in `.env` to suppress LLM escalation |

## Architecture

```
Claude Code CLI → justclaw MCP Server (stdio, 30 tools)
                         ↓
              SQLite (data/charlie.db, WAL, FTS5, schema v12)
                    ↓         ↓              ↓              ↓
              Dashboard   Discord Bot    Heartbeat (deterministic)
              Hono:8787   discord.js     9 checks, <1s, $0/cycle
              read-only   streams claude  + LLM escalation on persist
```

## Build & Run

```bash
npm run build && npm test          # Build + verify
pm2 start ecosystem.config.cjs    # Start dashboard + discord bot (+ heartbeat)
pm2 list                           # Check status
pm2 restart justclaw-discord            # Deploy new code
pm2 save                           # Persist for reboot
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server entry: PID mgmt, signals, stdio transport |
| `src/server.ts` | Registers all 30 MCP tools |
| `src/db.ts` | SQLite schema v14, FTS5, migrations, integrity check, backup |
| `src/process-registry.ts` | PID tracking, safety scoring, suspicious detection, malfunction escalation |
| `src/discord/bot.ts` | Discord bot: streaming progress, per-channel queue, circuit breaker, graceful shutdown |
| `src/email.ts` | SMTP email utility (Gmail app password): sendEmail(), verifySmtp() |
| `src/discord/heartbeat.ts` | Heartbeat orchestrator: deterministic checks, dedup, presence flash, escalation |
| `src/discord/heartbeat-checks.ts` | 9 pure TypeScript health checks |
| `src/discord/escalation.ts` | Goal-driven LLM escalation for persistent issues |
| `src/discord/anticipation.ts` | Predicts what user needs next: signal gathering + LLM synthesis |
| `src/discord/discord-utils.ts` | Shared Discord utilities: code-block-aware message splitting |
| `src/discord/scheduled-tasks.ts` | Executes due recurring tasks via claude -p, per-task channel routing |
| `src/discord/session-context.ts` | Session continuity: identity preamble, rotation logic, flush thresholds |
| `src/claude-spawn.ts` | Shared Claude CLI utilities: findClaudeBin, buildClaudeEnv, buildShellCmd, spawnClaudeP |
| `src/notebooks.ts` | NotebookLM-style document analysis: ingestion, chunking, FTS5 search, source grounding |
| `src/monitors.ts` | Metric monitoring engine: URL/command sources, extractors, condition evaluation |
| `src/monitor-tools.ts` | Monitor MCP tools: create, list, check, history, update, delete |
| `src/extractors.ts` | Multi-format document extraction: PDF, DOCX, XLSX, PPTX, HTML, EPUB, images |
| `scripts/prediction-tracker.ts` | Deterministic investment prediction tracker (CLI, JSON-backed) |
| `ecosystem.config.cjs` | PM2 config: kill_timeout, max_restarts, wait_ready |
| `.mcp.json` | MCP server config — **must include `JUSTCLAW_NO_DASHBOARD: "1"`** |

## MCP Tools (49)

Memory (6): save, search, recall, forget, list, consolidate — FTS5, namespaces, access tracking
Tasks (6): create, update, list, next, claim, complete — dependencies, agent claiming, auto-execute
Context (5): flush, restore, today, daily_log_add/get — compaction lifecycle
Conversations (4): log, history, search, summary — FTS5 across channels
Goals (3): set, list, archive — persistent objectives that drive daily task generation
Learnings (3): add, search, stats — structured self-improvement from errors and corrections
Notebooks (6): create, query, sources, list, overview, delete — NotebookLM-style document analysis
Monitors (6): create, list, check, history, update, delete — metric watching with alerts
Anticipation (1): anticipate_next — predict what user needs next from signals
State/Status (3): get, set, status overview
Process (4): check, restart_self, restart_dashboard, ghost_status
System (2): recommendations, escalation_history

Full reference: @docs/MCP-TOOLS.md

## Available Tools (Discord Bot & Escalation Agent)

When responding via Discord, you have access to all tools below. Use them proactively — don't tell the user to run commands, run them yourself.

### justclaw MCP (`mcp__justclaw__*`)
Use these for all persistence. Every conversation should be logged, decisions saved to memory, work tracked in tasks.
- `memory_save/search/recall/forget/list/consolidate` — persistent knowledge across sessions
- `task_create/update/list/next/claim/complete` — work queue with priorities and dependencies
- `context_flush/restore` — save/restore session state before compaction
- `conversation_log/history/search/summary` — message history across channels
- `goal_set/list/archive` — persistent objectives that drive daily task generation
- `learning_add/search/stats` — structured self-improvement from errors and corrections
- `state_get/set`, `status` — key-value store and system overview
- `process_check/restart_self/restart_dashboard/ghost_status` — process lifecycle
- `system_recommendations/escalation_history` — self-healing audit trail

#### Notebooks (`mcp__justclaw__notebook_*`) — Document Analysis
Point to a folder of documents, query them with source-grounded answers. Like NotebookLM.
- `notebook_create(name, path)` — ingest a directory. Scans for 60+ file types (PDF, DOCX, XLSX, PPTX, HTML, EPUB, images, code, config). Chunks content, indexes with FTS5.
- `notebook_query(notebook, query)` — search for relevant content. Small notebooks load entirely into context; large ones use FTS5 BM25 retrieval. **Always cite sources as [source:filename:lines].**
- `notebook_overview(notebook)` — returns source data for synthesizing: overview, key topics, suggested questions, per-source summaries.
- `notebook_sources(notebook)` — list indexed files with chunk/token counts.
- `notebook_list()` — list all notebooks.
- `notebook_delete(notebook)` — remove a notebook and all chunks.

**When to use:** User shares a folder of docs and wants analysis, Q&A, summaries, or comparisons. User says "read these docs", "what does this codebase do", "summarize these papers". Also useful for ingesting project documentation for grounded answers.

#### Monitors (`mcp__justclaw__monitor_*`) — Metric Watching
Track any metric (prices, uptime, web changes, custom APIs) with automatic alerting.
- `monitor_create(name, source_type, source_config, extractor_type, condition_type, ...)` — define what to watch, how to extract the value, when to alert.
- `monitor_list()` — show all monitors with current status.
- `monitor_check(name?)` — manually trigger a check (or check all due monitors).
- `monitor_history(name, limit?)` — view recent check results as time-series.
- `monitor_update(name, ...)` — change config, enable/disable.
- `monitor_delete(name)` — remove a monitor and its history.

**Source types:** `url` (HTTP GET/POST with headers) or `command` (shell command).
**Extractors:** `jsonpath` (e.g., `$.bitcoin.usd`), `regex`, `status_code`, `response_time`, `body_hash`, `stdout`, `exit_code`.
**Conditions:** `threshold_above/below`, `change_percent`, `change_any`, `contains`, `not_contains`, `regex_match`.

**When to use:** User asks to "watch", "track", "monitor", "alert me when", "notify me if". Examples:
- "Track Bitcoin price and alert me if it drops 5%" → monitor_create with CoinGecko API + jsonpath + change_percent
- "Monitor my website uptime" → monitor_create with url + status_code + threshold_below 200
- "Watch this page for changes" → monitor_create with url + body_hash + change_any
- "Alert me if disk usage goes above 90%" → monitor_create with command `df -h /` + regex + threshold_above

Monitors run automatically in the heartbeat loop (every 5 min). Alerts post to the monitor's configured Discord channel.

### File Operations
Use Read/Glob/Grep for inspection, Edit for targeted changes, Write for new files.
- `Read` — read any file by path
- `Write` — create or overwrite files
- `Edit` — surgical find-and-replace edits (preferred over Write for existing files)
- `Glob` — find files by pattern (`**/*.ts`, `src/**/*.json`)
- `Grep` — search file contents by regex

### Shell Commands (Bash)
All commands run in the project root (`/home/julian/temp/justclaw`) by default.

| Category | Commands | When to use |
|----------|----------|-------------|
| **Dev** | `git`, `npm`, `npx`, `node`, `tsc` | Build, test, commit, run scripts |
| **Python** | `python3`, `pip` | Run Python scripts, install packages |
| **System** | `apt`, `pm2`, `ps`, `df`, `free`, `uname`, `date` | Check system health, manage services |
| **Files** | `ls`, `find`, `cat`, `head`, `tail`, `cp`, `mv`, `mkdir`, `chmod`, `tar`, `unzip` | File management |
| **Text** | `grep`, `sed`, `awk`, `jq`, `sort`, `diff`, `wc` | Parse logs, transform data |
| **Network** | `curl` | API calls, health checks, webhooks |
| **DB** | `sqlite3` | Direct SQLite queries on `data/charlie.db` |

### Web Access
- `WebSearch` — search the web for documentation, solutions, current information
- `WebFetch` — fetch a URL and read its contents

### When to use what
- **User asks a question about the system** → `ps`, `pm2 list`, `df -h`, `free -m`, `status`
- **User asks to build/deploy** → `npm run build`, `npm test`, `pm2 restart`, `git commit`
- **User asks to check logs** → `pm2 logs`, `tail`, `grep` on log files
- **User asks to fix code** → `Read` the file, `Edit` the fix, `npm run build`, `npm test`
- **User asks to install something** → `npm install`, `pip install`, `apt list`
- **User asks to research** → `WebSearch`, `WebFetch`, then summarize
- **User shares a folder of documents** → `notebook_create` to ingest, then `notebook_query` for Q&A, `notebook_overview` for synthesis
- **User asks to watch/track/monitor something** → `monitor_create` with appropriate source + extractor + condition
- **User asks about prices, uptime, metrics** → check if a monitor exists (`monitor_list`), create one if not, or `monitor_check` for immediate result
- **User asks "analyze these docs" or "what do these files say"** → `notebook_create` + `notebook_query` or `notebook_overview`
- **Always after completing work** → `memory_save` key decisions, `task_complete` if applicable, `conversation_log` the exchange

## System Safety — Protecting the Ubuntu Host

This is a shared personal machine (Lenovo ThinkCentre M725s, 6.7GB RAM, HDD). Breaking it means everything stops. Follow these rules strictly.

### Forbidden actions (will break the system)
- **Never run `rm -rf /`** or any recursive delete outside the project directory
- **Never `sudo` anything** without Julian explicitly asking. No `sudo apt remove`, `sudo rm`, `sudo systemctl stop`, `sudo kill`. If something needs sudo, tell Julian and let him decide.
- **Never modify system config** — no editing `/etc/*`, `/boot/*`, `/sys/*`, `/proc/*`, crontab, systemd units outside the project, fstab, grub, network config, firewall rules
- **Never kill processes you didn't start** — only kill PIDs registered in justclaw's `process_registry` or PM2. Never `kill -9` a PID from `ps aux` without verifying it's ours.
- **Never fill the disk** — this machine has limited storage on HDD. Don't download large files (>100MB), don't generate unbounded logs, don't create large temp files without cleanup.
- **Never modify Julian's personal files** — stay within `/home/julian/temp/justclaw` and `/tmp`. Don't touch `~/.bashrc`, `~/.profile`, `~/.ssh`, `~/.config` (except `~/.config/justclaw/`), other projects in `~/temp/`.
- **Never uninstall system packages** — `apt remove` and `apt purge` are off limits. `apt list` and `apt search` are fine.

### Caution required (ask first if unsure)
- **`npm install -g`** — global installs affect the whole system. Prefer local `npm install` in the project.
- **`pip install`** — use `pip install --user` or a venv, never system-wide pip.
- **Large git operations** — `git clone` of big repos fills disk. Check `df -h` first if cloning anything.
- **PM2 operations on other services** — only manage `justclaw-dashboard` and `justclaw-discord`. Don't touch other PM2 processes if any exist.
- **Port binding** — justclaw uses port 8787. Don't bind other services to ports without checking what's already in use (`ss -tlnp`).
- **CPU-intensive tasks** — this is a low-power machine (Ryzen 5 PRO, 6.7GB RAM). Don't run parallel builds, large compiles, or heavy compute. One thing at a time.

### Safe defaults
- **Work within the project**: `/home/julian/temp/justclaw` is your home. All file operations should be relative to here.
- **Read before modifying**: always `Read` a file before `Edit`/`Write`.
- **Test before deploying**: `npm run build && npm test` before `pm2 restart`.
- **Check disk before downloads**: `df -h /home` if doing anything that creates files.
- **Check memory before heavy ops**: `free -m` if spawning processes.
- **Clean up after yourself**: remove temp files, don't leave stale logs growing.

## Never Rules (Code Quality)

- **Never** use `execSync` without a timeout
- **Never** interpolate into SQL — use parameterized queries
- **Never** kill processes based on heuristic grep patterns — verify via /proc/cmdline
- **Never** auto-modify source code from LLM escalation
- **Never** commit `.env`, credentials, or secrets
- **Never** swallow errors silently — `catch {}` must explain why
- **Never** use `any` type — use `unknown` and narrow
- **Never** add a feature without updating docs

## Size Limits

- **500 lines per file**, **50 lines per function** — hard rules, split when exceeded

## Error Handling

Errors are values. Add context at each layer. Fail fast at boundaries. Log structured: `log.error('msg', { key: val })`. Recover deterministically; escalate if unknown.

## Process Management

Conservative kill policy: 3 safety layers (identity + role + grace period). Never kill interactive claude sessions. Suspicious processes tracked with 0-100 safety scores. Malfunction escalation auto-kills safe suspects during crash loops.

Full details: @docs/PROCESS-MANAGEMENT.md

## Discord Bot

Streaming progress display, per-channel queue, circuit breaker (3 failures → cooldown), multi-turn sessions via --resume, graceful shutdown kills process groups.

Full details: @docs/DISCORD-BOT.md

## Session Continuity ("Always-On Agent")

Six-layer system that makes every session feel like the same agent waking up. Works WITH Claude Code's native context compaction, not against it.

| Layer | What it does | File |
|-------|-------------|------|
| **Session persistence** | Session IDs stored in `sessions` table, survive bot restarts. `--resume` works across sessions. | `src/discord/bot.ts`, `src/db.ts` (schema v12) |
| **Identity preamble** | Every `claude -p` prompt is prepended with: last context snapshot, active goals, pending tasks, today's activity, recent learnings, time since last interaction. | `src/discord/session-context.ts` → `buildIdentityPreamble()` |
| **Message coalescing** | Multiple queued messages batched into one prompt after 1s window. Reduces unnecessary turns. | `src/discord/bot.ts` → `coalesceMessages()`, `COALESCE_WINDOW_MS` |
| **Pre-compaction flush** | At 20+ turns, auto-sends a reminder to call `context_flush`. Safety net alongside Claude Code's native compaction. | `src/discord/session-context.ts` → `shouldFlushContext()`, `SESSION_TURN_FLUSH_THRESHOLD` |
| **Session rotation** | At 30+ turns or on a new day, sends handover prompt to flush context, then starts fresh session with full identity preamble. | `src/discord/session-context.ts` → `shouldRotateSession()`, `SESSION_TURN_ROTATE_THRESHOLD` |
| **Scheduled task sessions** | Recurring tasks can use `--resume` via `session_id` column on tasks table. Session inherited across recurrence chain. | `src/discord/scheduled-tasks.ts`, tasks table |

**Design rationale**: Claude Code already handles context compaction well. Our layers add *durable persistence* (to SQLite) and *identity injection* so that even across compaction, restart, or rotation, the agent knows who it is and what it was doing. The flush is a safety net, not a replacement.

## Heartbeat (deterministic, $0)

9 checks every 5min: process audit, stale claude scan, pm2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop, memory usage. Persistent ALERTs escalate to Claude after 3 cycles. Healing verified at 2min.

**Scheduled task executor:** After health checks, the heartbeat queries for recurring tasks past their `due_at`. Due tasks are executed via `claude -p` (`src/discord/scheduled-tasks.ts`), results posted to the task's `target_channel` (falls back to heartbeat channel if not set), and `task_complete` called (which auto-spawns the next recurrence, inheriting `target_channel`). One task at a time to avoid overload. Create recurring tasks with `task_create(recurrence: 'daily', due_at: '...', target_channel: '<discord-channel-id>')`.

## Self-Healing

| Layer | Action |
|-------|--------|
| PM2 | Auto-restart on crash (max 10), memory limit (300MB), wait_ready |
| Heartbeat | Deterministic checks, orphan cleanup, suspicious tracking |
| Escalation | Claude diagnoses persistent issues, recommends system improvements |
| DB | Integrity check on startup, WAL checkpoint hourly, backup every 6h |
| Discord | Error/shard handlers, readiness gate, circuit breaker |
| Shutdown | Process group kills, 5s grace, SIGKILL fallback |

## Env Vars

| Var | Purpose |
|-----|---------|
| `JUSTCLAW_NO_DASHBOARD` | **Must be `1`** in .mcp.json and claude -p spawns |
| `DISCORD_BOT_TOKEN` | Bot token (in .env) |
| `DISCORD_HEARTBEAT_CHANNEL_ID` | Channel for heartbeat alerts |
| `HEARTBEAT_INTERVAL_MS` | Check interval (default 300000) |
| `SMTP_HOST` | SMTP server hostname (e.g., `smtp.gmail.com`) |
| `SMTP_PORT` | SMTP port (default 587) |
| `SMTP_USER` | SMTP login username |
| `SMTP_PASS` | SMTP password or app password |
| `SMTP_FROM` | From address for outgoing emails (defaults to SMTP_USER) |

## Skills

| Skill | Purpose |
|-------|---------|
| `/dev <mode> <desc>` | **Structured dev lifecycle** — 7-phase process (think/plan/build/review/test/ship/reflect). Modes: `new`, `fix`, `refactor`, `debug`. |
| `/dev-think <desc>` | Phase 1 only — investigate and understand the problem before committing to a solution |
| `/dev-plan <desc>` | Phase 2 only — design the solution (file changes, test strategy, risk assessment) |
| `/dev-review [files]` | Phase 4 only — self-review changes using Code Reviewer checklist |
| `/dev-ship [msg]` | Phases 5-7 — test, commit, and reflect on completed work |
| `/improve <topic>` | Research better practices from popular projects, implement |
| `/retrospective` | Review recent work, extract learnings, create ADRs |
| `/audit <area>` | Deep code audit for bugs and architecture issues |
| `/adr <title>` | Create Architecture Decision Record |
| `/review` | Pre-commit quality checklist |
| `/code-review [mode]` | **Multi-agent code review** — 5 specialist agents (style, security, performance, architecture, synthesis). Modes: `full`, `security`, `performance`, `architecture`, `style`. Based on harness-100 #21. |
| `/postmortem [mode]` | **Incident postmortem** — 5-agent team (timeline, root cause, impact, remediation, review). Modes: `full`, `timeline`, `rca`, `remediation`, `review`. Based on harness-100 #25. |
| `/hats <name>` | Apply specialized persona (architect, code-reviewer, debugger, feature-dev, security-reviewer) |
| `/eval [skill]` | Run skill evaluations against test cases, detect regressions |
| `/build [prd]` | PRD-driven autonomous build loop with plan verification and quality gates |
| `/newskill [desc]` | Research popular implementations, security audit, build custom skill |
| `/notebook <cmd> <name>` | **NotebookLM-style document analysis** — ingest folder, query with source citations, generate overviews/FAQs |
| `/monitor <cmd> [name]` | **Metric monitoring** — track prices, uptime, web changes, custom metrics. Alerts via Discord. |
| `/security-audit` | On-demand security audit (secrets, permissions, ports, deps) |

## Compaction Instructions

When compacting, preserve: modified files list, test results, errors and fixes, pending TODOs, key decisions and rationale.

## Detailed Docs

- Database schema: @docs/SCHEMA.md
- MCP tool reference: @docs/MCP-TOOLS.md
- Discord bot internals: @docs/DISCORD-BOT.md
- Process management: @docs/PROCESS-MANAGEMENT.md
- Architecture decisions: @docs/decisions/

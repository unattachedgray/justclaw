---
paths: ["src/discord/**", "src/claude-spawn.ts"]
description: Discord bot internals, session continuity, heartbeat, self-healing, available tools
---

# Available Tools (Discord Bot & Escalation Agent)

When responding via Discord, use tools proactively — don't tell the user to run commands, run them yourself.

- **justclaw MCP** (`mcp__justclaw__*`): all 49 tools — memory, tasks, context, conversations, goals, learnings, notebooks, monitors, anticipation, state, process, system
- **Notebooks**: `notebook_create(name, path)` → ingest 60+ file types, `notebook_query` → source-grounded answers. Use when user shares docs for analysis.
- **Monitors**: `monitor_create` → track prices, uptime, web changes. Sources: `url` or `command`. Extractors: `jsonpath`, `regex`, `status_code`, `response_time`, `body_hash`, `stdout`. Conditions: `threshold_above/below`, `change_percent`, `change_any`, `contains`, `not_contains`, `regex_match`. Run in heartbeat (5 min).
- **Browser**: 70 commands via extension. Queue via `curl -X POST http://localhost:8787/api/extension-commands`. See @docs/BROWSER-BRIDGE.md
- **File ops**: `Read`, `Write`, `Edit`, `Glob`, `Grep`
- **Web**: `WebSearch`, `WebFetch`
- **Bash**: `git`, `npm`, `node`, `pm2`, `curl`, `python3`, `jq`, etc.

**After completing work**: `memory_save` key decisions, `task_complete` if applicable, `conversation_log` the exchange.

# Session Continuity ("Always-On Agent")

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

# Heartbeat (deterministic, $0)

9 checks every 5min: process audit, stale claude scan, pm2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop, memory usage. Persistent ALERTs escalate to Claude after 3 cycles. Healing verified at 2min.

**Scheduled task executor:** After health checks, the heartbeat queries for recurring tasks past their `due_at`. Due tasks are executed via `claude -p` (`src/discord/scheduled-tasks.ts`), results posted to the task's `target_channel` (falls back to heartbeat channel if not set), and `task_complete` called (which auto-spawns the next recurrence, inheriting `target_channel`). One task at a time to avoid overload. Create recurring tasks with `task_create(recurrence: 'daily', due_at: '...', target_channel: '<discord-channel-id>')`.

# Self-Healing

| Layer | Action |
|-------|--------|
| PM2 | Auto-restart on crash (max 10), memory limit (200MB), wait_ready |
| Heartbeat | Deterministic checks, orphan cleanup, suspicious tracking |
| Escalation | Claude diagnoses persistent issues, recommends system improvements |
| DB | Integrity check on startup, WAL checkpoint hourly, backup every 6h |
| Discord | Error/shard handlers, readiness gate, circuit breaker |
| Shutdown | Process group kills, 5s grace, SIGKILL fallback |

# Scheduled Task Creation (Interpreting Informal Requests)

When the user asks to set up a new recurring task, follow this deterministic flow:

1. **List templates**: Call `task_create_from_template(template: "")` to see available templates + output channels
2. **Match intent to template**: Pick the closest template. If none fits, use `task_create` with free-form description.
3. **Fill variables from context**: Infer what you can from the request. Ask only for what's ambiguous.
4. **Set output channels**: Check the suggested channels. If the user mentions a new email/channel, it auto-registers.
5. **Confirm before creating**: Show the user what you're about to create (template, key vars, schedule, outputs).

**Key tools:**
- `task_create_from_template` — new task from template + variables
- `task_duplicate` — clone existing task with overrides ("like the banking one but for X")
- `task_update_var` — change one variable on existing task ("change the email to X")
- `task_update` — change non-template fields (schedule, priority, channel)

**Output channels** (state key `output_channels`): discord channels, email addresses, and GitHub repos used by tasks. General-scope channels are suggested for new tasks. Task-specific repos (like kag-industry-news) are NOT suggested unless the user explicitly requests archiving.

**Template evolution**: If a request pattern repeats and no template fits, consider creating a new template in `data/task-templates/`. Templates should be generic enough for reuse but specific enough to produce consistent results.

# Deterministic Scripts Over LLM Calls

**Core principle**: Every repeated operation in a scheduled task should become a deterministic script, not an LLM prompt. LLM calls are expensive, slow, non-deterministic, and produce inconsistent results across runs. Scripts are free, fast, and identical every time.

**When building or improving scheduled tasks:**

1. **Identify repeated operations** in task execution — email sending, file writing, git archiving, data formatting, API calls, file conversions. If claude-p does the same mechanical operation every run, it should be a script.

2. **Write shell scripts** in `scripts/` for each operation. Examples already exist:
   - `scripts/send-email.sh` — deterministic email with .env loading
   - Templates reference scripts via `bash scripts/send-email.sh --to X --subject Y --body-file /tmp/report.md`

3. **Templates should call scripts for delivery, use LLM only for reasoning**:
   - ✅ LLM: web research, content synthesis, analysis, Korean translation
   - ✅ Script: email sending, git add/commit/push, file formatting, API POST
   - ❌ Never: LLM writing a node script to call sendEmail at runtime

4. **When a task fails due to a mechanical step** (email didn't send, git push failed, wrong file path), fix it by writing or improving a script — not by making the LLM prompt more detailed.

5. **Self-improvement loop**: After each scheduled task run, evaluate whether any step that claude-p performed could be replaced by a deterministic script. If yes, create the script in `scripts/`, update the template, and log a learning. Over time, templates should converge toward: "LLM researches and writes content → scripts handle all delivery."

**Script conventions:**
- Location: `scripts/<action>.sh` (e.g., `scripts/git-archive.sh`, `scripts/send-email.sh`)
- Always `cd /home/julian/temp/justclaw` and load `.env`
- Accept args via `--flag value` pattern
- Exit 0 on success, non-zero on failure with error message to stderr
- Idempotent where possible (safe to retry)

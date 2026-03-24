# Discord Bot (`src/discord/bot.ts`)

Standalone Node.js process managed by pm2 (`justclaw-discord`). Connects via `discord.js`, responds using `claude -p`.

Shared utilities (message splitting, constants) live in `src/discord/discord-utils.ts`.

## Message Flow

1. User sends message → logged to `conversations` table (channel: `discord`)
2. **Session check**: restore persisted session from `sessions` table. Check if rotation needed (new day or 30+ turns).
3. **Message coalescing**: wait 1s (`COALESCE_WINDOW_MS`), then batch all queued messages into one prompt.
4. **Identity preamble**: prepend context snapshot, goals, tasks, activity, learnings, time-since-last-interaction (`buildIdentityPreamble()` from `session-context.ts`).
5. Bot sends progress message, spawns `claude -p --output-format stream-json --verbose --resume <sessionId>`
6. Child PID registered in `process_registry` as `claude-p`
7. Stream events parsed → progress message edited with plan/phase checklist:
   - Completed phases: `✅ Phase 1: Researching codebase (7 steps, 23s)`
   - Active phase: `⏳ WebSearch — "agent autonomy patterns"`
   - Labels derived from Claude's text output between tool calls
8. On completion, progress message replaced with final response (split at 2000 chars)
9. **Session persist**: upsert session_id + turn_count to `sessions` table.
10. **Flush check**: if turn_count >= 20, auto-send flush reminder to persist context to SQLite.
11. Child PID retired, response logged

## Session Continuity

Session IDs are stored in the `sessions` table (schema v11) and survive bot restarts. On first access to a channel, the bot restores the persisted session from DB. Session management is in `src/discord/session-context.ts`.

**Session rotation** triggers on:
- **New day**: if `last_used_at` is a different calendar day, send handover prompt, then start fresh.
- **Turn limit**: if `turn_count >= 30` (`SESSION_TURN_ROTATE_THRESHOLD`), same handover-then-rotate flow.

**Pre-compaction flush** at `turn_count >= 20` (`SESSION_TURN_FLUSH_THRESHOLD`): sends a system message telling the agent to call `context_flush`. This is a safety net — Claude Code's native compaction handles most context management.

**Identity preamble** (`buildIdentityPreamble()`): prepended to every prompt so the agent always knows who it is:
- Last context snapshot (summary, key facts)
- Active goals (from memories table, type=goal)
- Top 5 pending tasks
- Today's daily log (last 5 entries)
- Recent learnings (last 3)
- Time since last interaction

## Per-Channel Queue

One `claude -p` at a time per channel. Additional messages queued with position indicator. LRU eviction at 100 channels.

## Message Coalescing

When the queue has messages waiting, the bot waits `COALESCE_WINDOW_MS` (1 second) before processing to allow additional messages to arrive. All queued messages are then batched into a single prompt (format: `[username]: message` per line). This reduces unnecessary turns and token usage.

## Circuit Breaker (Hystrix half-open pattern)

- Tracks consecutive `claude -p` failures per channel
- After 3 failures: OPEN state, escalating cooldown (5min/10min/30min)
- Messages re-queued during open state (not lost)
- Any success resets to CLOSED

## Adaptive Inactivity Timeout

- 2 minutes base (no stdout activity → kill)
- 5 minutes when sub-agents running (Task/Agent tools detected in stream)
- SIGTERM then SIGKILL after 5s

## Multi-Turn Sessions

Each channel gets `--resume <sessionId>`. Session ID extracted from stream events.

## Self-Healing Features

- `uncaughtException` / `unhandledRejection` handlers (log, don't crash)
- Discord error/shard event handlers (WebSocket failures)
- Readiness gate: `process.send('ready')` after Discord connects, `wait_ready: true` in pm2
- `beforeExit` handler for cleanup on unhandled exits
- Double-shutdown prevention via `shuttingDown` flag

## Graceful Shutdown

1. Stop heartbeat
2. `process.kill(-pid, 'SIGTERM')` for each child process group
3. Wait 5s → SIGKILL survivors
4. Retire all PIDs, close DB, exit

## Tool Permissions

The `claude -p` process spawned for each Discord message has `--allowedTools` granting:

- **justclaw MCP** (`mcp__justclaw__*`): all 49 tools for memory, tasks, goals, learnings, context, conversations, state, process management, and system health
- **File ops**: `Read`, `Write`, `Edit`, `Glob`, `Grep` — full filesystem access
- **Web**: `WebSearch`, `WebFetch` — search and fetch web content
- **Bash**: `git`, `npm`, `npx`, `node`, `python3`, `pip`, `apt`, `pm2`, `curl`, `sqlite3`, `tsc`, `jq`, `sed`, `awk`, plus standard unix utilities (`ls`, `find`, `cat`, `head`, `tail`, `grep`, `cp`, `mv`, `mkdir`, `chmod`, `tar`, `unzip`, `sort`, `diff`, `wc`, `ps`, `df`, `free`, `uname`, `date`, `echo`)

The escalation agent has a similar but slightly reduced set (no Write/Edit, no python3/pip — diagnosis and repair only, not code authoring).

Tool permissions are defined in `src/discord/bot.ts` (line ~390) and `src/discord/escalation.ts` (line ~175). To add or remove tools, edit the `--allowedTools` array in those files and rebuild.

## Critical Config

- `JUSTCLAW_NO_DASHBOARD: '1'` in all `claude -p` spawn env — prevents MCP server from killing pm2 dashboard
- `kill_timeout: 10000` in pm2 — gives 10s for child cleanup
- `max_memory_restart: 300MB` — prevents OOM

# Discord Bot (`src/discord/bot.ts`)

Standalone Node.js process managed by pm2 (`justclaw-discord`). Connects via `discord.js`, responds using `claude -p`.

Shared utilities (message splitting, constants) live in `src/discord/discord-utils.ts`.

## Message Flow

1. User sends message → logged to `conversations` table (channel: `discord`)
2. Bot sends progress message, spawns `claude -p --output-format stream-json --verbose --resume <sessionId>`
3. Child PID registered in `process_registry` as `claude-p`
4. Stream events parsed → progress message edited with plan/phase checklist:
   - Completed phases: `✅ Phase 1: Researching codebase (7 steps, 23s)`
   - Active phase: `⏳ WebSearch — "agent autonomy patterns"`
   - Labels derived from Claude's text output between tool calls
5. On completion, progress message replaced with final response (split at 2000 chars)
6. Child PID retired, response logged

## Per-Channel Queue

One `claude -p` at a time per channel. Additional messages queued with position indicator. LRU eviction at 100 channels.

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

- **justclaw MCP** (`mcp__justclaw__*`): all 36 tools for memory, tasks, goals, learnings, context, conversations, state, process management, and system health
- **File ops**: `Read`, `Write`, `Edit`, `Glob`, `Grep` — full filesystem access
- **Web**: `WebSearch`, `WebFetch` — search and fetch web content
- **Bash**: `git`, `npm`, `npx`, `node`, `python3`, `pip`, `apt`, `pm2`, `curl`, `sqlite3`, `tsc`, `jq`, `sed`, `awk`, plus standard unix utilities (`ls`, `find`, `cat`, `head`, `tail`, `grep`, `cp`, `mv`, `mkdir`, `chmod`, `tar`, `unzip`, `sort`, `diff`, `wc`, `ps`, `df`, `free`, `uname`, `date`, `echo`)

The escalation agent has a similar but slightly reduced set (no Write/Edit, no python3/pip — diagnosis and repair only, not code authoring).

Tool permissions are defined in `src/discord/bot.ts` (line ~390) and `src/discord/escalation.ts` (line ~175). To add or remove tools, edit the `--allowedTools` array in those files and rebuild.

## Critical Config

- `JUSTCLAW_NO_DASHBOARD: '1'` in all `claude -p` spawn env — prevents MCP server from killing pm2 dashboard
- `kill_timeout: 10000` in pm2 — gives 10s for child cleanup
- `max_memory_restart: 300MB` — prevents OOM

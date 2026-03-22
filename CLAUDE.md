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
| **Database** | `data/charlie.db` (SQLite, WAL, FTS5, schema v6) |
| **Debug mode** | Set `JUSTCLAW_DEBUG=1` in `.env` to suppress LLM escalation |

## Architecture

```
Claude Code CLI → justclaw MCP Server (stdio, 30 tools)
                         ↓
              SQLite (data/charlie.db, WAL, FTS5, schema v4)
                    ↓         ↓              ↓
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
| `src/db.ts` | SQLite schema v4, FTS5, migrations, integrity check, backup |
| `src/process-registry.ts` | PID tracking, safety scoring, suspicious detection, malfunction escalation |
| `src/discord/bot.ts` | Discord bot: streaming progress, per-channel queue, circuit breaker, graceful shutdown |
| `src/discord/heartbeat.ts` | Heartbeat orchestrator: deterministic checks, dedup, presence flash, escalation |
| `src/discord/heartbeat-checks.ts` | 9 pure TypeScript health checks |
| `src/discord/escalation.ts` | Goal-driven LLM escalation for persistent issues |
| `ecosystem.config.cjs` | PM2 config: kill_timeout, max_restarts, wait_ready |
| `.mcp.json` | MCP server config — **must include `JUSTCLAW_NO_DASHBOARD: "1"`** |

## MCP Tools (30)

Memory (6): save, search, recall, forget, list, consolidate — FTS5, namespaces, access tracking
Tasks (6): create, update, list, next, claim, complete — dependencies, agent claiming
Context (5): flush, restore, today, daily_log_add/get — compaction lifecycle
Conversations (4): log, history, search, summary — FTS5 across channels
State/Status (3): get, set, status overview
Process (4): check, restart_self, restart_dashboard, ghost_status
System (2): recommendations, escalation_history

Full reference: @docs/MCP-TOOLS.md

## Never Rules

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

## Heartbeat (deterministic, $0)

9 checks every 5min: process audit, stale claude scan, pm2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop, memory usage. Persistent ALERTs escalate to Claude after 3 cycles. Healing verified at 2min.

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

## Skills

| Skill | Purpose |
|-------|---------|
| `/improve <topic>` | Research better practices from popular projects, implement |
| `/retrospective` | Review recent work, extract learnings, create ADRs |
| `/audit <area>` | Deep code audit for bugs and architecture issues |
| `/adr <title>` | Create Architecture Decision Record |
| `/review` | Pre-commit quality checklist |

## Compaction Instructions

When compacting, preserve: modified files list, test results, errors and fixes, pending TODOs, key decisions and rationale.

## Detailed Docs

- Database schema: @docs/SCHEMA.md
- MCP tool reference: @docs/MCP-TOOLS.md
- Discord bot internals: @docs/DISCORD-BOT.md
- Process management: @docs/PROCESS-MANAGEMENT.md
- Architecture decisions: @docs/decisions/

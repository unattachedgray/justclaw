# justclaw

*Open infrastructure for the Claude Code CLI.*

**Make Claude Code autonomous.** justclaw gives Claude Code CLI persistent memory, a task queue, health monitoring, and a Discord interface — turning individual CLI sessions into a continuous, self-managing AI agent. All backed by SQLite, zero cloud dependencies.

## Philosophy

Claude Code CLI is already one of the most capable AI coding agents. But each session starts from scratch — no memory of past conversations, no awareness of pending tasks, no way to monitor itself between sessions.

**justclaw fixes this with minimal code, not by rebuilding Claude Code.**

### Use Claude Code, don't replace it

Most "autonomous agent" projects wrap an LLM in thousands of lines of orchestration code — custom planners, tool routers, memory systems, retry loops. justclaw takes the opposite approach: **Claude Code already has world-class tool use, code generation, and reasoning. We just give it a brain that persists across sessions.**

justclaw is an MCP server. Claude Code connects to it over stdio like any other tool. No wrappers, no middleware, no agent framework. When Claude needs to remember something, it calls `memory_save`. When it needs work to do, it calls `task_next`. The MCP protocol is the only interface.

### Deterministic first, LLM only when reasoning is genuinely needed

Every health check, every process audit, every threshold evaluation is pure TypeScript — SQL queries, `/proc` reads, PID comparisons. No LLM calls. The 9 heartbeat checks run in under 1 second at zero cost.

LLM reasoning is reserved for where it actually matters: diagnosing novel issues that persist after deterministic checks fail (3+ cycles), and responding to humans. This isn't a philosophical preference — the original LLM-based heartbeat cost $14/month and was less reliable than the deterministic replacement.

### Conservative by default

justclaw will never:
- Kill a process it didn't spawn (verified via `/proc/cmdline` + SQLite registry)
- Auto-modify source code from automated troubleshooting
- Silently swallow errors
- Make destructive changes without evidence

Suspicious processes are tracked and scored (0-100) but only reported to the user. Auto-killing only happens during confirmed crash loops, and only for processes scoring 70+ seen across 3+ monitoring cycles.

## What makes justclaw different

[OpenClaw](https://github.com/openclaw/openclaw) is the most popular open-source AI assistant framework — 20+ messaging platforms, vector + BM25 + FTS5 memory, 4-tier self-healing, cron automation, 100+ agent skills, a full dashboard. It's also ~500K lines of code with 70+ dependencies.

**justclaw replicates the same core capabilities in ~4,000 lines by leveraging what Claude Code CLI already provides natively**, instead of rebuilding everything from scratch.

| Capability | OpenClaw (custom code) | justclaw (Claude Code native + thin layer) |
|---|---|---|
| **Memory** | Markdown files + vector embeddings + BM25 + FTS5, multiple embedding providers | SQLite FTS5, namespaces, access tracking, expiry, consolidation — 6 MCP tools. No embedding server needed. |
| **Task queue** | Basic task tracking | Dependencies, agent claiming, priority queue, recurring tasks with cron expressions — 6 MCP tools |
| **Scheduling** | Built-in cron daemon + heartbeat | Claude Code's native scheduled tasks + justclaw's 5-field cron parser for recurring tasks |
| **Messaging** | 20+ platform adapters (custom code per platform) | Discord (native bot) + Claude Code's channel plugins (Discord, Slack, Telegram — zero custom adapter code) |
| **Health monitoring** | 4-tier: preflight → keepalive → watchdog → AI recovery in tmux | 9 deterministic checks ($0/cycle) + PM2 auto-restart + LLM escalation only for persistent issues |
| **Self-healing** | Watchdog with exponential backoff, crash counters decay after 6h | Conservative 3-layer kill policy, PID reuse protection, safety scoring (0-100), stale-counter detection |
| **Budget tracking** | Per-agent cost caps, circuit breakers | Token tracking via stream-json parsing + Claude Code session JSONL parsing (cache hits, per-model costs) |
| **Dashboard** | Full monitoring UI | Hono dashboard with SSE, activity heatmap, Claude Code session stats, quick actions, themes |
| **Agent skills** | 100+ preconfigured skills | Claude Code's native tool use + `/hats` personas + `/newskill` builder + `/build` orchestrator |
| **Context management** | Manual | Auto-flush before compaction via Claude Code hooks (SessionStart, PreCompact, Stop) |
| **Orchestration** | Custom agent runtime, gateway WebSocket, plugin architecture | Claude Code CLI is the runtime. MCP over stdio. No middleware. |
| **Codebase** | ~500K LOC, 70+ deps, 16K commits | ~4K LOC, <15 deps |

The key insight: OpenClaw rebuilds agent orchestration, tool routing, channel adapters, and memory indexing from scratch. justclaw treats all of that as solved by Claude Code CLI and only builds what Claude Code doesn't have — **persistence across sessions, a task queue, lifecycle hooks, and deterministic health monitoring**.

**One SQLite database, one MCP server, one tool namespace.** Memory, tasks, context, conversations, process state, and health metrics all live in the same DB. Claude can query across all of them in a single session.

## What it provides

- **30 MCP tools** — memory (6), tasks (6), context (5), conversations (4), state/status (3), process management (4), system health (2)
- **Discord bot** — stream Claude's responses to Discord with real-time progress display, per-channel queuing, and circuit breaker protection
- **Heartbeat monitor** — 9 pure TypeScript health checks every 5 minutes: process audit, stale process scan, PM2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop, memory usage
- **Goal-driven escalation** — when deterministic checks fail for 3+ cycles, Claude is invoked to diagnose and fix, with recommendations stored for future reference
- **Web dashboard** — live status page with activity heatmap, Claude Code session tracking (tokens, cache hits, costs), quick actions, drag-and-drop layout, theme support
- **10 slash commands** — `/hats` (5 personas), `/build` (PRD-driven build loop), `/newskill` (research + security audit + build), `/eval` (skill testing), `/security-audit`, `/improve`, `/audit`, `/retrospective`, `/review`, `/adr`
- **6 custom agents** — task-worker, research-agent, conversation-reviewer, fast-researcher (Haiku), diagnostician, executor — scoped tools per role
- **Safe deploy** — `npm run deploy` builds, tests, git-tags, restarts, monitors for 60s, and auto-rolls back on crash loop

## Quick Start

```bash
git clone https://github.com/unattachedgray/justclaw.git
cd justclaw
bash scripts/setup.sh
```

The setup script checks prerequisites, installs missing tools, walks you through Discord configuration, and starts services.

### MCP Server Only (no Discord)

If you just want persistent memory and tasks for Claude Code:

```bash
npm install && npm run build
```

Run `claude` from this directory. The `.mcp.json` auto-registers all 30 tools.

### Manual Setup

```bash
npm install
npm run build
cp .env.example .env        # Edit with your Discord bot token
pm2 start ecosystem.config.cjs
```

## Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| Node.js | >= 20 | `node -v` |
| Claude Code CLI | latest | `npm i -g @anthropic-ai/claude-code`, then `claude` to authenticate |
| PM2 | any | `npm i -g pm2` (for Discord bot / dashboard process management) |
| Build tools | any | `build-essential` on Linux, Xcode CLI on macOS (for better-sqlite3 native addon) |

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. **Bot** tab: click **Reset Token**, copy it. Enable **MESSAGE CONTENT** intent.
4. **OAuth2 > URL Generator**: Scopes = `bot`, Permissions = Send Messages, Read Message History, Add Reactions
5. Open the generated URL to add the bot to your server
6. Add the token to `.env` as `DISCORD_BOT_TOKEN`

## Architecture

```
Claude Code CLI ──> justclaw MCP Server (stdio, 30 tools)
                           │
                SQLite (WAL, FTS5, schema v7)
                    │          │              │
              Dashboard    Discord Bot    Heartbeat
              Hono :8787   discord.js     9 checks, <1s, $0
              read-only    claude -p       adaptive thresholds
                           streaming       flap detection
                           circuit breaker LLM escalation
```

**Hook-driven lifecycle:** Claude Code hooks in `.claude/settings.json` inject reminders at critical moments — session start (restore context), pre-compaction (flush state), session end (save progress). This is how justclaw maintains continuity without any custom agent loop.

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | For Discord | — | From Discord Developer Portal |
| `DISCORD_CHANNEL_IDS` | No | all | Channels to respond in |
| `DISCORD_HEARTBEAT_CHANNEL_ID` | No | first channel | Where alerts are posted |
| `HEARTBEAT_INTERVAL_MS` | No | 300000 | Health check interval (ms) |
| `DASHBOARD_PASSWORD` | No | changeme | Dashboard login password |

### Persona (`config/charlie.toml`)

Customize the assistant's name, personality, and defaults.

## Commands

```bash
npm run build            # Compile TypeScript
npm run dev              # Development with hot reload
npm test                 # Run test suite (68 tests)
npm run deploy           # Safe deploy with auto-rollback
npm run setup            # Interactive first-time setup
pm2 list                 # Check service status
pm2 logs justclaw-discord     # View bot logs
```

## Documentation

| Document | Content |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Development guide and architecture |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | All 30 MCP tools |
| [docs/DISCORD-BOT.md](docs/DISCORD-BOT.md) | Discord bot internals |
| [docs/PROCESS-MANAGEMENT.md](docs/PROCESS-MANAGEMENT.md) | Process registry and kill policy |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Database schema |
| [DEVELOPMENT.md](DEVELOPMENT.md) | History, decisions, roadmap |

## License

MIT

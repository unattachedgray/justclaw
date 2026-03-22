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

| Feature | justclaw | Typical memory MCP | Agent frameworks |
|---------|-----|--------------------|-----------------|
| Memory | FTS5 search, namespaces, access tracking, expiry | Basic key-value | Custom vector DB |
| Tasks | Dependencies, agent claiming, priority queue | None | Custom task graphs |
| Context preservation | Auto-flush before compaction via hooks | None | Manual |
| Health monitoring | 9 deterministic checks, $0/cycle | None | LLM-based ($$$) |
| Self-healing | Adaptive thresholds, flap detection, rollback | None | Retry loops |
| Discord interface | Streaming progress, circuit breaker, multi-turn | None | Separate bot |
| Process management | SQLite registry, safety scoring, PID verification | None | Docker/k8s |
| Lines of code | ~4,000 TypeScript | ~500 | ~50,000+ |

**justclaw is one SQLite database, one MCP server, one tool namespace.** Memory, tasks, context, conversations, process state, and health metrics all live in the same DB. Claude can query across all of them in a single session.

## What it provides

- **30 MCP tools** — memory (6), tasks (6), context (5), conversations (4), state/status (3), process management (4), system health (2)
- **Discord bot** — stream Claude's responses to Discord with real-time progress display, per-channel queuing, and circuit breaker protection
- **Heartbeat monitor** — 9 pure TypeScript health checks every 5 minutes: process audit, stale process scan, PM2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop, memory usage
- **Goal-driven escalation** — when deterministic checks fail for 3+ cycles, Claude is invoked to diagnose and fix, with recommendations stored for future reference
- **Safe deploy** — `npm run deploy` builds, tests, git-tags, restarts, monitors for 60s, and auto-rolls back on crash loop
- **Web dashboard** — read-only status page at `localhost:8787`

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
                SQLite (WAL, FTS5, schema v5)
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
npm test                 # Run test suite (55 tests)
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

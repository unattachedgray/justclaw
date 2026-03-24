# justclaw

*Open infrastructure for the Claude Code CLI.*

**Make Claude Code autonomous.** justclaw gives Claude Code CLI persistent memory, a task queue, health monitoring, document analysis, metric watching, and a Discord interface — turning individual CLI sessions into a continuous, self-managing AI agent. All backed by SQLite, zero cloud dependencies.

## Philosophy

Claude Code CLI is already one of the most capable AI coding agents. But each session starts from scratch — no memory of past conversations, no awareness of pending tasks, no way to monitor itself between sessions.

**justclaw fixes this with minimal code, not by rebuilding Claude Code.**

### Use Claude Code, don't replace it

Most "autonomous agent" projects wrap an LLM in thousands of lines of orchestration code — custom planners, tool routers, memory systems, retry loops. justclaw takes the opposite approach: **Claude Code already has world-class tool use, code generation, and reasoning. We just give it a brain that persists across sessions.**

justclaw is an MCP server. Claude Code connects to it over stdio like any other tool. No wrappers, no middleware, no agent framework. When Claude needs to remember something, it calls `memory_save`. When it needs work to do, it calls `task_next`. The MCP protocol is the only interface.

### Deterministic first, LLM only when reasoning is genuinely needed

Every health check, every process audit, every threshold evaluation, every document chunking, every monitor condition is pure TypeScript — SQL queries, `/proc` reads, PID comparisons, FTS5 search. No LLM calls. The 9 heartbeat checks run in under 1 second at zero cost.

LLM reasoning is reserved for where it actually matters: diagnosing novel issues that persist after deterministic checks fail (3+ cycles), synthesizing document analysis, and responding to humans.

### Conservative by default

justclaw will never:
- Kill a process it didn't spawn (verified via `/proc/cmdline` + SQLite registry)
- Auto-modify source code from automated troubleshooting
- Silently swallow errors (all catches have structured logging)
- Make destructive changes without evidence

## What it provides

### Core (49 MCP Tools)

- **Memory (6)** — save, search, recall, forget, list, consolidate. FTS5 full-text search, namespaces, access tracking, expiry.
- **Tasks (6)** — create, update, list, next, claim, complete. Dependencies, agent claiming, recurring tasks with cron, auto-execute, per-task Discord channel routing.
- **Context (5)** — flush, restore, today, daily_log_add/get. Compaction lifecycle with automatic flush reminders.
- **Conversations (4)** — log, history, search, summary. FTS5 across channels.
- **Goals (3)** — set, list, archive. Persistent objectives that drive daily task generation.
- **Learnings (3)** — add, search, stats. Structured self-improvement from errors, corrections, and discoveries.

### Document Analysis (NotebookLM-style)

- **Notebooks (6)** — create, query, sources, list, overview, delete.
- Point to any folder → ingests 60+ file formats (PDF, DOCX, XLSX, PPTX, HTML, EPUB, RTF, images, code, config).
- **Context-window-first**: small doc sets (<100K tokens) load entirely into Claude's 200K context window. Larger sets use FTS5 BM25 chunked retrieval.
- Source-grounded answers with `[source:filename:lines]` citations.
- Paragraph-aware chunking with 150-token overlap. Incremental re-indexing (tracks file mtimes).
- Unsupported format detection → logged as learnings for future auto-research.

### Metric Monitoring (Huginn-style)

- **Monitors (6)** — create, list, check, history, update, delete.
- Track any metric: crypto prices, website uptime, web page changes, API latency, SSL expiry, disk usage, GitHub stars.
- **Sources**: URL (HTTP GET/POST) or shell command.
- **Extractors**: jsonpath, regex, status_code, response_time, body_hash, stdout, exit_code.
- **Conditions**: threshold_above/below, change_percent, change_any, contains, not_contains, regex_match.
- Runs automatically in heartbeat loop (every 5 min). Alerts escalate from ALERT to CRITICAL after 3 consecutive triggers. Per-monitor Discord channel routing.

### Session Continuity ("Always-On Agent")

- **Session persistence** — session IDs stored in SQLite, survive bot restarts. `--resume` works across sessions.
- **Identity preamble** — every prompt prepended with: last context snapshot, active goals, pending tasks, today's activity, recent learnings, time since last interaction.
- **Message coalescing** — multiple queued messages batched into one prompt (1s window).
- **Pre-compaction flush** — auto-reminds agent to save state at 20+ turns.
- **Session rotation** — fresh start at 30+ turns or daily, with structured handover.
- **Scheduled task sessions** — recurring tasks can use `--resume` for continuity across runs.

### Discord Bot

- Stream Claude's responses with real-time plan/phase progress display.
- Per-channel message queue, circuit breaker (3 failures → escalating cooldown).
- Multi-turn sessions via `--resume` per channel.
- Graceful shutdown kills process groups (SIGTERM → wait → SIGKILL).

### Health Monitoring

- **9 deterministic checks** every 5 minutes ($0/cycle): process audit, stale process scan, PM2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop, memory usage.
- **Goal-driven LLM escalation** — when deterministic checks fail for 3+ cycles, Claude diagnoses and recommends fixes. Past diagnoses feed into future escalation prompts.
- **Healing verification** — re-checks at 2 min after escalation claims resolution.

### Development Skills

- `/dev <mode> <desc>` — 7-phase development lifecycle (think/plan/build/review/test/ship/reflect). Modes: `new`, `fix`, `refactor`, `debug`.
- `/notebook <cmd> <name>` — document-grounded analysis.
- `/monitor <cmd> [name]` — metric watching.
- `/build [prd]` — PRD-driven autonomous build loop with quality gates.
- `/hats <name>` — specialized personas (architect, code-reviewer, debugger, feature-dev, security-reviewer).
- `/review` — pre-commit quality checklist.
- `/improve`, `/audit`, `/retrospective`, `/adr`, `/newskill`, `/eval`, `/security-audit`

### Infrastructure

- **Web dashboard** — Hono :8787 with SSE, activity heatmap, Claude Code session stats, quick actions, themes.
- **Safe deploy** — `npm run deploy` builds, tests, git-tags, restarts, monitors for 60s, auto-rolls back on crash loop.
- **Crash watchdog** — cron (2min) detects crash loops, auto-reverts to last stable tag.
- **Process registry** — conservative 3-layer kill policy with PID reuse protection and safety scoring (0-100).

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

Run `claude` from this directory. The `.mcp.json` auto-registers all 49 tools.

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
Claude Code CLI ──> justclaw MCP Server (stdio, 49 tools)
                           │
                SQLite (WAL, FTS5, schema v14)
                    │          │              │
              Dashboard    Discord Bot    Heartbeat
              Hono :8787   discord.js     9 checks + monitors
              read-only    claude -p       adaptive thresholds
                           streaming       flap detection
                           sessions        LLM escalation
                           coalescing      monitor alerts
```

**Session continuity:** Claude Code's native context management handles compaction. justclaw augments it with durable persistence (SQLite) and identity injection so every session feels like the same agent waking up.

**Hook-driven lifecycle:** Claude Code hooks inject reminders at critical moments — session start (restore context), pre-compaction (flush state), session end (save progress).

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | For Discord | — | From Discord Developer Portal |
| `DISCORD_CHANNEL_IDS` | No | all | Channels to respond in |
| `DISCORD_HEARTBEAT_CHANNEL_ID` | No | first channel | Where health alerts are posted |
| `HEARTBEAT_INTERVAL_MS` | No | 300000 | Health check interval (ms) |
| `DASHBOARD_PASSWORD` | No | changeme | Dashboard login password |

### Persona (`config/charlie.toml`)

Customize the assistant's name, personality, and defaults.

## Commands

```bash
npm run build            # Compile TypeScript
npm run dev              # Development with hot reload
npm test                 # Run test suite (193 tests)
npm run deploy           # Safe deploy with auto-rollback
npm run setup            # Interactive first-time setup
pm2 list                 # Check service status
pm2 logs justclaw-discord     # View bot logs
```

## Documentation

| Document | Content |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Development guide, architecture, all 49 tools |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | Complete MCP tool reference |
| [docs/DISCORD-BOT.md](docs/DISCORD-BOT.md) | Discord bot internals, session continuity |
| [docs/PROCESS-MANAGEMENT.md](docs/PROCESS-MANAGEMENT.md) | Process registry and kill policy |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Database schema (v14) |

## License

MIT

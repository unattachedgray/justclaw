<p align="center">
  <img src="docs/assets/banner.svg" alt="justclaw — Autonomous Infrastructure for Claude Code" width="100%"/>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/setup-2_minutes-blue?style=flat-square" alt="Setup time"/></a>
  <a href="https://github.com/unattachedgray/justclaw"><img src="https://img.shields.io/github/stars/unattachedgray/justclaw?style=flat-square&color=yellow" alt="Stars"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"/></a>
  <img src="https://img.shields.io/badge/MCP_tools-57-58a6ff?style=flat-square" alt="57 MCP Tools"/>
  <img src="https://img.shields.io/badge/browser_commands-70-58a6ff?style=flat-square" alt="70 Browser Commands"/>
  <img src="https://img.shields.io/badge/cloud_deps-zero-58a6ff?style=flat-square" alt="Zero Cloud Dependencies"/>
</p>

<p align="center">
  <b>Turn Claude Code into an always-on autonomous agent.</b><br/>
  Persistent memory · Task queue · Health monitoring · Browser automation · Discord interface<br/>
  All backed by SQLite. Zero cloud dependencies. One <code>npm install</code>.
</p>

---

## The Problem

Claude Code is already one of the most capable AI coding agents in the world. But every session starts from scratch — no memory of yesterday's conversations, no awareness of pending tasks, no way to heal itself between sessions, no long-running automation.

**Most agent frameworks try to replace the LLM's reasoning with thousands of lines of orchestration code** — custom planners, tool routers, memory systems, retry loops. They rebuild what Claude Code already does well.

## The justclaw Approach

**Don't replace Claude Code. Extend it.**

justclaw is an [MCP server](https://modelcontextprotocol.io/). Claude Code connects to it over stdio like any other tool. When Claude needs to remember something, it calls `memory_save`. When it needs work to do, it calls `task_next`. When it needs to check on itself, deterministic health checks run in pure TypeScript — no LLM calls, no cost, under 1 second.

The result: Claude Code sessions that **persist across restarts**, **self-heal when things break**, **run scheduled tasks autonomously**, and **learn from their mistakes** — all without a custom agent framework.

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code CLI (the brain — already world-class)          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  justclaw MCP Server (57 tools via stdio)             │  │
│  │  ┌─────────┐ ┌──────┐ ┌────────┐ ┌─────────────────┐│  │
│  │  │ Memory  │ │Tasks │ │Health  │ │ Browser Bridge  ││  │
│  │  │ FTS5    │ │Cron  │ │10checks│ │ 70 commands     ││  │
│  │  │ Dedup   │ │Deps  │ │$0/cycle│ │ Self-healing    ││  │
│  │  └────┬────┘ └──┬───┘ └───┬────┘ │ selectors       ││  │
│  │       │         │         │      └─────────────────┘│  │
│  │  ┌────┴─────────┴─────────┴──────────────────────┐  │  │
│  │  │      SQLite (WAL, FTS5, schema v14)           │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│        │              │              │                       │
│   Dashboard      Discord Bot    Heartbeat                   │
│   Hono :8787     Streaming      Monitors                    │
│   Live metrics   Sessions       Escalation                  │
└─────────────────────────────────────────────────────────────┘
```

## Why justclaw?

<table>
<tr>
<td width="50%">

### Other agent frameworks
- Wrap the LLM in custom orchestration
- Require cloud infrastructure
- Replace Claude's native tool use
- Custom memory that doesn't integrate
- Separate runtime from the IDE

</td>
<td width="50%">

### justclaw
- **Claude Code IS the agent** — justclaw just gives it persistence
- **SQLite only** — runs on a Raspberry Pi, no cloud bills
- **MCP protocol** — native integration, no wrappers
- **Memory that survives restarts** — FTS5 search, namespaces, dedup
- **Lives in your terminal** — same `claude` command you already use

</td>
</tr>
</table>

### What makes it different

**Deterministic first, LLM only when reasoning is genuinely needed.** Every health check, process audit, threshold evaluation, and document chunk is pure TypeScript — SQL queries, `/proc` reads, PID comparisons, FTS5 search. The 10 heartbeat checks run in under 1 second at zero cost. LLM reasoning is reserved for diagnosing novel issues that persist after deterministic checks fail.

**Conservative by default.** justclaw will never kill a process it didn't spawn (verified via `/proc/cmdline` + SQLite registry), never auto-modify source code from automated troubleshooting, never silently swallow errors, and never make destructive changes without evidence.

**Two-phase scheduled tasks.** Reports and recurring work split into preparation (AI research, compile, archive to GitHub) and delivery (deterministic scripts for email/posting at the exact scheduled time). The AI can take 45 minutes to research; the email still sends at 8:40 AM sharp.

## Quick Start

```bash
git clone https://github.com/unattachedgray/justclaw.git
cd justclaw
bash scripts/setup.sh    # Interactive — walks you through everything
```

Or manually:

```bash
npm install && npm run build
cp .env.example .env     # Add your Discord token, SMTP config
pm2 start ecosystem.config.cjs
```

**MCP-only mode** (no Discord, no dashboard — just persistent memory and tasks):

```bash
npm install && npm run build
# Run `claude` from this directory — .mcp.json auto-registers all 57 tools
```

## Features

### 🧠 Persistent Memory (6 tools)

FTS5 full-text search, namespaces, access tracking, expiry, autodream-inspired dedup and consolidation. Claude remembers what happened yesterday, last week, and what it learned from mistakes.

### 📋 Task Queue (9 tools)

Dependencies, agent claiming, recurring tasks with cron expressions, per-task output channel routing. Template system with `{{variable}}` interpolation. Two-phase execution separates AI prep from deterministic delivery.

### 🔍 Health Monitoring (10 checks, $0/cycle)

Process registry audit, stale process scan, PM2 health, unanswered messages, system status, stuck tasks, doc staleness, event loop lag, memory usage, system resources. When deterministic checks fail for 3+ cycles, Claude diagnoses and recommends fixes — and past diagnoses inform future ones.

### 🌐 Browser Bridge (70 commands)

Chrome extension with full browser automation: screenshots, form fill, data extraction, Set-of-Mark visual grounding, natural language element search, self-healing selectors with persistent caching, HAR capture, device emulation, shadow DOM piercing, iframe access, and multi-step workflows.

### 📊 Metric Monitoring (6 tools, Huginn-style)

Track anything: crypto prices, website uptime, API latency, disk usage, web page changes. Sources (URL or shell command) × Extractors (jsonpath, regex, status code, response time) × Conditions (threshold, change, contains, regex). Alerts escalate from ALERT → CRITICAL after 3 consecutive triggers.

### 📚 Document Analysis (6 tools, NotebookLM-style)

Point at any folder → ingests 60+ file formats (PDF, DOCX, XLSX, PPTX, HTML, EPUB, images, code). Small doc sets load entirely into Claude's context window; larger sets use FTS5 BM25 retrieval. Source-grounded answers with `[source:filename:lines]` citations.

### 🎯 Session Continuity ("Always-On Agent")

Session IDs persist in SQLite across bot restarts. Every prompt gets an identity preamble: last context snapshot, active goals, pending tasks, today's activity, recent learnings. Message coalescing, auto-flush at 20 turns, rotation at 30 turns with structured handover. Every session feels like the same agent waking up.

### 🤖 Discord Bot

Stream Claude's responses with real-time progress display. Per-channel message queue with circuit breaker. Multi-turn sessions via `--resume`. Graceful shutdown with process group management.

### 🎨 Gemini AI Integration (5 tools)

Image generation and iterative editing, PDF analysis, vision/OCR, Google Search-grounded answers with citations. Tool descriptions steer Claude to prefer native capabilities over API calls.

### 📅 Two-Phase Scheduled Tasks

```
[due_at - lead_time]              [due_at]
       |                              |
  PREP PHASE                    DELIVERY PHASE
  (claude -p)                  (deterministic)
       |                              |
  research + compile             send-email.sh
  git-archive.sh                 Discord post
  save to /tmp/                  mark complete
```

Templates use a `---DELIVERY---` separator. Everything above is the AI prompt; everything below is shell commands executed deterministically at the scheduled time. Lead time via `lead:N` tag — task starts N minutes early, delivery waits.

### 🛡️ Infrastructure

- **Web dashboard** — Hono :8787 with SSE, live token sparkline, agent throughput, activity heatmap, monitor status grid, system resource charts
- **7 default monitors** — dashboard uptime, disk/RAM, Discord bot health, GitHub repo, Bitcoin, Anthropic API status
- **Safe deploy** — `npm run deploy` builds, tests, git-tags, restarts, monitors 60s, auto-rolls back on crash
- **Crash watchdog** — cron detects crash loops, auto-reverts to last stable tag
- **Process registry** — 3-layer kill policy with PID reuse protection and safety scoring

### 🛠️ Development Skills

| Skill | Purpose |
|-------|---------|
| `/dev <mode>` | 7-phase lifecycle: think → plan → build → review → test → ship → reflect |
| `/build [prd]` | PRD-driven autonomous build loop with quality gates |
| `/notebook <cmd>` | Document-grounded analysis with source citations |
| `/monitor <cmd>` | Configurable metric watchers with alerts |
| `/code-review` | Multi-agent parallel review (style, security, perf, architecture) |
| `/postmortem` | 5-agent incident analysis team |
| `/improve`, `/audit`, `/retrospective` | Continuous self-improvement |

## Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| Node.js | >= 20 | `node -v` |
| Claude Code CLI | latest | `npm i -g @anthropic-ai/claude-code` |
| PM2 | any | `npm i -g pm2` (for Discord bot / dashboard) |
| Build tools | any | `build-essential` (Linux) or Xcode CLI (macOS) |

## Configuration

<details>
<summary><b>Environment Variables (.env)</b></summary>

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | For Discord | — | From Discord Developer Portal |
| `DISCORD_CHANNEL_IDS` | No | all | Channels to respond in |
| `DISCORD_HEARTBEAT_CHANNEL_ID` | No | first channel | Health alert channel |
| `HEARTBEAT_INTERVAL_MS` | No | 300000 | Health check interval (ms) |
| `DASHBOARD_PASSWORD` | No | changeme | Dashboard login |
| `GEMINI_API_KEY` | For images | — | Google Gemini API key |
| `SMTP_HOST` | For email | — | e.g., smtp.gmail.com |
| `SMTP_PORT` | For email | 587 | SMTP port |
| `SMTP_USER` | For email | — | SMTP login |
| `SMTP_PASS` | For email | — | SMTP password / app password |

</details>

<details>
<summary><b>Timezone</b></summary>

All timestamps stored in UTC. Display times converted automatically.

```
state_set(key: "timezone_home", value: "America/New_York")
state_set(key: "timezone_current", value: "Asia/Seoul")       # travel override
state_set(key: "timezone_current", value: "")                 # revert to home
```

When a current timezone is active, displays show both: `2:50 PM KST current / 8:50 AM EDT home`

</details>

<details>
<summary><b>Discord Bot Setup</b></summary>

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create application → **Bot** tab → **Reset Token** → copy. Enable **MESSAGE CONTENT** intent.
3. **OAuth2 > URL Generator**: Scopes = `bot`, Permissions = Send Messages, Read Message History, Add Reactions
4. Open the URL to add the bot to your server
5. Add token to `.env` as `DISCORD_BOT_TOKEN`

</details>

<details>
<summary><b>Chrome Extension (Browser Bridge)</b></summary>

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select `browser-extension/` folder
4. Dashboard must be running (`pm2 list`) — extension communicates via `localhost:8787`

</details>

## Commands

```bash
npm run build            # Compile TypeScript
npm run dev              # Development with hot reload
npm test                 # Run test suite
npm run deploy           # Safe deploy with auto-rollback
pm2 list                 # Check service status
pm2 logs justclaw-discord     # View bot logs
```

## Documentation

| Document | Content |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Development guide, architecture, all tools |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | Complete MCP tool reference (57 tools) |
| [docs/DISCORD-BOT.md](docs/DISCORD-BOT.md) | Discord bot internals, session continuity |
| [docs/BROWSER-BRIDGE.md](docs/BROWSER-BRIDGE.md) | Browser automation (70 commands) |
| [docs/DASHBOARD.md](docs/DASHBOARD.md) | Dashboard API, widgets, monitors |
| [docs/PROCESS-MANAGEMENT.md](docs/PROCESS-MANAGEMENT.md) | Process registry and kill policy |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Database schema (v14) |

## Roadmap

- [ ] Multi-agent coordination (parallel claude -p with shared task queue)
- [ ] Webhook triggers (GitHub, Slack, email → auto-create tasks)
- [ ] Plugin system for custom MCP tool modules
- [ ] Mobile dashboard (PWA)
- [ ] Voice interface via Discord voice channels

## License

MIT — use it, fork it, make Claude Code remember everything.

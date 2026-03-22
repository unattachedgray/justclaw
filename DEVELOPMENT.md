# DEVELOPMENT.md — justclaw Development History & Direction

> **justclaw** — just Claude Code, with a claw.

## Vision

justclaw is a **persistence and automation layer** for Claude Code CLI. It makes Claude Code sessions stateful, autonomous, and resilient — without replacing Claude Code's native capabilities.

**Design philosophy**: Claude Code CLI is the brain. justclaw is the long-term memory, task queue, and lifecycle harness. We never duplicate what Claude Code already does well (Discord, scheduling, agent orchestration, code isolation). We fill the gaps it doesn't cover (persistence across sessions, automated lifecycle hooks, multi-agent task coordination).

**Platform philosophy**: Linux-first TypeScript. Node.js 20+. Process management uses `/proc` for enumeration, `child_process.spawn({detached})` for lifecycle, and systemd for services. No Windows-specific code (`wmic`, `DETACHED_PROCESS`, `.exe` patterns, PowerShell) anywhere in the codebase.

---

## Architecture Decision: Why TypeScript?

1. **Single ecosystem**: MCP SDK, Agent SDK, Chat SDK are all TypeScript-first.
2. **Linux-first**: Clean `/proc`-based process management, `spawn({detached})` for lifecycle.
3. **better-sqlite3**: Synchronous, fast, WAL-mode SQLite with excellent FTS5 support.
4. **Process stability**: Node.js + pm2/systemd is stable for long-running MCP servers.
5. **Tooling**: TypeScript's type system catches bugs at compile time. Vitest is fast.

---

## Current Status (as of 2026-03-21)

### Completed
- [x] Core MCP server with 30 tools (memory, tasks, context, conversations, state, process, system)
- [x] SQLite schema v2 with FTS5 for memories AND conversations
- [x] Memory namespaces (`global`, `project:<name>`, `session:<id>`)
- [x] Memory access tracking (`access_count`, `last_accessed`)
- [x] Memory consolidation tool (`memory_consolidate` with dry-run)
- [x] Task dependencies (`depends_on` — `task_next` respects dependency chains)
- [x] Task agent claiming (`task_claim` with atomic assignment + stale-claim override)
- [x] Conversation FTS search (`conversation_search`)
- [x] Response format parameter (`format: "concise" | "detailed"`) on search/list tools
- [x] Rich tool descriptions (when to use, when not to use, examples, output format hints)
- [x] Hook-based lifecycle automation (SessionStart, PreCompact, Stop)
- [x] 3 custom subagents (task-worker, research-agent, conversation-reviewer)
- [x] Web dashboard with Hono (overview, conversations, processes, logs tabs + SSE)
- [x] PID-based process lifecycle with `/proc` ghost detection
- [x] Schema migration system (v1→v2 auto-upgrade)
- [x] 55 tests (db, memory, tasks, context, conversations)
- [x] systemd service installer
- [x] Linux-first: zero Windows-specific code

- [x] Recurring tasks (`recurrence` field, auto-spawn next instance on complete)
- [x] Dashboard themes (midnight/light/high-contrast with localStorage persistence)
- [x] Dashboard conversation panel (channel filter, real-time SSE updates)
- [x] Memory expiry enforcement (`enforceMemoryExpiry` runs every 12 heartbeat cycles)
- [x] macOS process management (`ps` fallback for `/proc` on darwin)
- [x] Schema v6 migration (recurring task columns)
- [x] 30 MCP tools (added process_ghost_status, system_recommendations)

### Not yet implemented
- [ ] WebSocket terminal in dashboard (was in Python version, skipped for v1)
- [ ] PostToolUse hook for auto-logging Discord replies
- [ ] npm publish as `justclaw`
- [ ] Claude Code plugin marketplace submission

---

## Roadmap (Post-Rewrite)

### Near-term (quality of life)
- ~~**Dashboard improvements**: Add theme selector (light, high-contrast). Add conversation panel with real-time feed.~~ **Done** (2026-03-21)
- ~~**Memory expiry enforcement**: `memory_consolidate` already finds expired entries.~~ **Done** (2026-03-21) — runs every 12 heartbeat cycles via `enforceMemoryExpiry()`
- **PostToolUse hook for Discord**: Auto-call `conversation_log()` after Discord reply tool fires. Requires knowing the exact tool matcher for the Discord plugin.

### Medium-term (new capabilities)
- ~~**Recurring tasks**: Add `recurrence` field to tasks.~~ **Done** (2026-03-21) — `daily`, `weekly`, `monthly`, `cron:...` with auto-spawn on completion
- **WebSocket terminal**: Port the Python dashboard's WS terminal tab. Useful for running diagnostics from the dashboard.
- ~~**Memory consolidation scheduling**~~ **Done** — integrated into heartbeat cycle

### Future considerations
- **Autonomous watcher**: A lightweight Node.js process that monitors Discord when Claude Code isn't running, buffers messages to SQLite. NOT a full agent — just a message queue.
- **Multi-persona**: Config already supports it (`charlie.toml`), but code assumes one persona. Would need namespace isolation and separate MCP server instances.
- **Plugin marketplace**: Generalize persona system into a reusable "persistent memory + task queue for Claude Code" plugin.

---

## Anti-Patterns (Do NOT Build)

| Temptation | Why Not |
|---|---|
| Knowledge graph / edges between memories | Over-engineering; FTS5 handles similarity well enough |
| Agent SDK wrapper (CharlieAgent class) | Claude Code already provides orchestration |
| HTTP transport for MCP server | Stdio is correct for local plugin; HTTP adds auth complexity |
| Conversation encryption at rest | Local SQLite, single user — not worth it |
| Custom scheduler | Claude Code Desktop has native scheduling |
| Custom Discord bot | Claude Code's Discord plugin works; hooks handle logging |
| Dashboard framework (React/Next.js) | Adds build step, bundle complexity; inline HTML is fine for a control plane |
| Windows-specific code | Linux-first. If macOS support needed, `/proc` alternative is `ps aux` — trivial. |

---

## Comparable Projects & Ecosystem

### Claw Family

| Project | Architecture | Size | What We Learn |
|---|---|---|---|
| **OpenClaw** | Node.js monolith, 20+ messaging platforms | ~500K LOC, 70+ deps | Feature-complete but massive; don't go down this road |
| **NanoClaw** | Claude Agent SDK, Docker isolation | 15 source files | Agent SDK works but loses Claude Code native features |
| **openclaw-config** | Markdown + Python scripts on Claude Code | Minimal | 3-tier memory (always-loaded, daily, deep search) influenced our design |

### Claude Code Native Features (our platform)

| Feature | Status | How We Use It |
|---|---|---|
| **Channels** (Discord, Telegram) | Research preview (v2.1.80) | Discord plugin for Charlie's messaging |
| **Scheduled Tasks** | Stable (Desktop) | Morning briefing, task review skills |
| **Agent Teams** | Experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) | task-worker, research-agent, conversation-reviewer subagents |
| **Hooks** (12+ event types) | Stable (v2.1+) | SessionStart, PreCompact, Stop lifecycle automation |
| **Subagents** (`.claude/agents/`) | Stable | 3 specialist agents with scoped tools |
| **Skills** (SKILL.md) | Stable | Persona instructions, scheduled tasks |

### justclaw's Unique Position

Most memory MCP servers do one thing (memory). justclaw bundles **memory + tasks + context snapshots + conversations + daily log + dashboard** into a single self-contained MCP server with **28 tools**. The integration is the differentiator — one SQLite database, one process, one tool namespace, coherent cross-feature queries.

---

## File Structure

```
JUSTCLAW/
  src/
    index.ts              — Entry point: PID management, signals, dashboard spawn, stdio
    server.ts             — MCP server creation, registers all 28 tools
    db.ts                 — SQLite schema v2, FTS5 triggers, migration system
    config.ts             — TOML config loader (smol-toml)
    logger.ts             — JSON-lines logger with 30-day rotation
    memory.ts             — 6 tools: save/search/recall/forget/list/consolidate
    tasks.ts              — 6 tools: create/update/list/next/claim/complete
    context.ts            — 5 tools: flush/restore/today, daily_log add/get
    conversations.ts      — 4 tools: log/history/search/summary
    processes.ts          — 4 tools: check/restart_self/restart_dashboard/ghost_status
    dashboard/
      app.ts              — Hono HTTP server, routes, PID management
      api.ts              — All API handlers (status, tasks, memories, conversations, logs, processes, SSE)
      sse.ts              — Server-Sent Events manager for live refresh
      html.ts             — Dashboard HTML/CSS/JS template
  config/
    charlie.toml          — Persona configuration
  skills/
    charlie-system/       — Core personality and behavior instructions
    context-flush/        — Pre-compaction flush
    morning-briefing/     — Daily briefing scheduled task
    task-review/          — Task work session
  scripts/
    install-service.sh    — systemd user service generator
  .claude/
    settings.json         — Hooks: SessionStart, PreCompact, Stop
    agents/               — Custom subagent definitions
      task-worker.md      — Focused task execution
      research-agent.md   — Read-only research
      conversation-reviewer.md — Audit conversations, create tasks
  .claude-plugin/
    plugin.json           — Claude Code plugin manifest
  .mcp.json               — MCP server config
  data/                   — Runtime data (gitignored)
    charlie.db            — SQLite database
    justclaw.pid               — MCP server PID
    dashboard.pid         — Dashboard PID
    logs/                 — JSON-lines log files
  tests/
    db.test.ts            — 20 tests: schema, FTS5, transactions, v2 columns
    memory.test.ts        — 12 tests: CRUD, FTS5, namespaces, access tracking, expiry
    tasks.test.ts         — 12 tests: CRUD, dependencies, claiming, filters
    context.test.ts       — 6 tests: flush/restore, daily log
    conversations.test.ts — 7 tests: CRUD, filters, FTS5 search
  package.json
  tsconfig.json
  vitest.config.ts
```

---

## Development Workflow

1. **Install**: `npm install`
2. **Build**: `npm run build`
3. **Dev**: `npm run dev` (tsx watch — auto-reloads on save)
4. **Test**: `npm test` (55 tests via vitest)
5. **Format**: `npm run format` (prettier)
6. **Run MCP**: `node dist/index.js` (auto-starts dashboard)
7. **Run dashboard only**: `node dist/dashboard/app.js`
8. **Schema migration**: Automatic on server startup via `db.ts`

---

## Open Questions

### Q1: Should justclaw work without Claude Code running?
**Current answer**: No. Claude Code is the orchestrator.
**Future**: A lightweight Node.js watcher could monitor Discord and buffer messages to SQLite for the next session.

### Q2: Multiple personas?
**Current answer**: Charlie is the only persona. Config supports it but code assumes one.
**Future**: Namespace isolation in DB + separate MCP server instances per persona.

### Q3: macOS support?
**Current answer**: Supported as of 2026-03-21. `process-registry.ts` uses `ps` fallback when `/proc` is unavailable (darwin). `getCmdline()` and `getProcessStartTime()` detect `process.platform === 'darwin'` and use `ps -p <pid>` instead of `/proc` reads. Everything else (SQLite, PID files, signals, Hono) was already cross-platform.

### Q4: Plugin marketplace?
**Current answer**: Not yet. Project is personal/opinionated. If the persona system is generalized, could become a reusable plugin.

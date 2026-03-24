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
- [x] Core MCP server with 49 tools (memory, tasks, context, conversations, goals, learnings, state, process, system, notebooks, monitors, anticipation)
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
- [x] 68 tests (db, memory, tasks, context, conversations, cron)
- [x] systemd service installer
- [x] Linux-first: zero Windows-specific code

- [x] Recurring tasks (`recurrence` field, auto-spawn next instance on complete)
- [x] Dashboard themes (midnight/light/high-contrast with localStorage persistence)
- [x] Dashboard conversation panel (channel filter, real-time SSE updates)
- [x] Memory expiry enforcement (`enforceMemoryExpiry` runs every 12 heartbeat cycles)
- [x] macOS process management (`ps` fallback for `/proc` on darwin)
- [x] Schema v6 migration (recurring task columns)
- [x] 30 MCP tools (added process_ghost_status, system_recommendations)
- [x] 5-field cron expression parser (`src/cron.ts`) for scheduled task recurrence
- [x] Token usage tracking (schema v7, stream-json parsing, `/api/token-usage`)
- [x] Activity heatmap (`/api/heatmap`, 7×24 CSS grid, SQL aggregation)
- [x] Quick actions panel (Restart Dashboard, Run Build, Clear Ghosts, Check Health)
- [x] Webhook endpoint (`POST /api/webhook`, token-authenticated, rate-limited)
- [x] 6 agent definitions (task-worker, research-agent, conversation-reviewer, fast-researcher, diagnostician, executor)
- [x] Security audit skill (`skills/security-audit/SKILL.md`)
- [x] Dashboard heatmap panel + quick actions row
- [x] Hats system — 5 specialized personas (architect, code-reviewer, debugger, feature-dev, security-reviewer) with checklists and output formats
- [x] Eval framework — skill testing with `.evals/` test cases, pattern-based grading, regression detection
- [x] Build skill — PRD-driven autonomous build loop with 5-dimension plan verification and quality gates (ralph+GSD hybrid)
- [x] Newskill skill — 6-phase skill builder: requirements → research → security audit → design → build → register
- [x] SessionStart hook lists all skills and auto-suggests `/newskill` when capabilities are missing
- [x] Goal-driven task generation — `goal_set/list/archive` MCP tools + daily-goals skill
- [x] Awareness heartbeat — proactive checks (overdue tasks, stale goals, recurring errors) every 3rd cycle
- [x] Active hours + daily message budget — suppress proactive messages outside 8am-10pm, max 3/day
- [x] Learnings system — structured self-improvement (`learning_add/search/stats`) from errors and corrections
- [x] Autonomous task execution — `auto_execute` flag on tasks, opt-in via state key, restricted tool set
- [x] Memory consolidation automation — expired memories cleaned every 72 heartbeat cycles (~6h)
- [x] Schema v8 (learnings table, auto_execute column on tasks)
- [x] Claude Code CLI session tracking on dashboard (`/api/claude-sessions`, `/api/claude-usage`)
- [x] False crash-loop detection fix (uptime-based, auto-reset stale PM2 counters)

### Not yet implemented
- [ ] npm publish as `justclaw`
- [ ] Claude Code plugin marketplace submission

---

## Roadmap (2026-03-22)

Informed by OpenClaw feature comparison. All items leverage Claude Code native features or deterministic code — no custom LLM calls unless reasoning is genuinely needed.

### Sprint: Dashboard & Observability
- [x] **Dashboard edit mode**: Drag-and-drop reorder, hide/show, collapse panels (2026-03-22)
- [x] **System metrics**: RAM/disk gauges, agent run stats, sparklines, service health dots (2026-03-22)
- [x] **Scheduled tasks panel**: Separate view for recurring tasks with due times (2026-03-22)
- [x] **Clickable detail views**: Expand work queue, scheduled tasks, memories, daily log items (2026-03-22)
- [x] **Token usage tracking**: Schema v7 adds `input_tokens`/`output_tokens` to `process_registry`. Bot parses `stream-json` result events for usage. `/api/token-usage` endpoint returns today/week totals, 7-day trend, and equivalent API cost (included in Max plan). (2026-03-22)
- [x] **Activity heatmap**: 7×24 CSS grid from SQL aggregation of `conversations` + `process_registry` (30 days). `/api/heatmap` endpoint. Dashboard panel with color-interpolated cells and legend. (2026-03-22)
- [ ] **Memory browser**: Read-only file viewer tab for workspace markdown (CLAUDE.md, docs/*, agents/*). File tree + content display. No editing — that stays in Claude Code.
- [x] **Quick actions panel**: Buttons for "Restart Dashboard", "Run Build", "Clear Ghost PIDs", "Check Health". Confirmation dialogs, toast notifications. `/api/actions/build` endpoint. (2026-03-22)

### Sprint: Automation & Scheduling
- [x] **Cron expression support**: `src/cron.ts` — pure 5-field cron parser (minute, hour, dom, month, dow). Supports `*`, ranges, steps, lists. `tasks.ts` uses `cronNext()` for `cron:` recurrence patterns. 13 tests. (2026-03-22)
- [x] **Webhook endpoint**: `POST /api/webhook` (Bearer token via `JUSTCLAW_WEBHOOK_TOKEN` env). Logs to conversations table, pushes SSE refresh. 1s rate limit, 401/429/503 error codes. (2026-03-22)

### Sprint: Native Claude Code Integration
- [x] **Agent role definitions**: `.claude/agents/` with model-tiered roles (2026-03-22)
  - `fast-researcher.md` — Haiku, read-only tools (Glob, Grep, Read, WebSearch), for quick lookups
  - `diagnostician.md` — inherited model, system tools (Bash, Read, MCP), for health checks
  - `executor.md` — inherited model, full tools, for task execution
- [x] **Native hooks expansion**: `.claude/settings.json` — SessionStart, PreCompact, Stop, PreToolUse (protected files), PostToolUse (auto-format) (2026-03-22)
- [x] **Security audit skill**: `skills/security-audit/SKILL.md` — checks secrets in git, file permissions, PM2 config, exposed ports, dashboard auth, MCP config, SQLite integrity, Node.js version. On-demand via `/security-audit` (2026-03-22)

### Sprint: Skills & Personas (2026-03-21)
- [x] **Hats system**: 5 persona definitions in `hats/` (architect, code-reviewer, debugger, feature-dev, security-reviewer). Each has mindset, checklist, output format, anti-patterns. `/hats <name>` command. Adapted from NanoClaw container hats, rebuilt for justclaw's context. (2026-03-21)
- [x] **Eval framework**: `skills/eval/SKILL.md` — test cases in `.evals/{skill}/` with YAML frontmatter, pattern-based grading (substring, regex, file existence, file contents), regression detection. No LLM grading for speed/reproducibility. `/eval [skill]` command. (2026-03-21)
- [x] **Build skill**: `skills/build/SKILL.md` — PRD-driven autonomous build. Combines ralph's fresh-context-per-story with GSD's 5-dimension plan verification (completeness, feasibility, independence, testability, order). Quality gates per story (build, test, size limits). `/build [prd]` command. (2026-03-21)
- [x] **Newskill builder**: `.claude/commands/newskill.md` — 6-phase research-and-build: requirements gathering (interactive questionnaire or args), web research (5-10 implementations), security audit (5 critical + 3 warning checks), design (combine best patterns), build (SKILL.md + supporting files + test cases), register & document. (2026-03-21)
- [x] **Auto-skill discovery**: SessionStart hook updated to list all available skills and suggest `/newskill` when the task needs capabilities not yet available. (2026-03-21)

### Sprint: Intentional Autonomy (2026-03-22)
Inspired by OpenClaw's proactive architecture (hooks + cron + heartbeat awareness). justclaw replicates the same autonomy using Claude Code native features + minimal custom code.

- [x] **Goal-driven daily tasks**: `src/goals.ts` — 3 MCP tools (`goal_set`, `goal_list`, `goal_archive`). Goals stored in memories table with `namespace='goals'`. `skills/daily-goals/SKILL.md` generates 3-5 tasks per morning from active goals. Tasks tagged `auto-generated`, priority 3 (won't outrank user work). (2026-03-22)
- [x] **Awareness heartbeat**: `src/discord/awareness.ts` — 4 proactive checks beyond health: overdue tasks, stale goals (48h no progress), auto-task results ready for review, recurring error patterns. Runs every 3rd heartbeat cycle (~15min). (2026-03-22)
- [x] **Active hours + message budget**: Config in `charlie.toml` (`active_hours_start/end`, `max_proactive_messages_per_day`). Proactive messages suppressed outside hours. Budget tracked in state table, max 3/day default. (2026-03-22)
- [x] **Learnings system**: `src/learnings.ts` — 3 MCP tools (`learning_add`, `learning_search`, `learning_stats`). Schema v8 adds `learnings` table. Categories: error, correction, discovery, skill. Injected into escalation and task generation prompts. (2026-03-22)
- [x] **Autonomous task execution**: Tasks with `auto_execute=1` flag run without user prompting. Opt-in via `state_set('auto_execute_enabled', 'true')`. Runs in scheduled-tasks.ts when no recurring tasks are due. (2026-03-22)
- [x] **Memory consolidation automation**: Heartbeat cleans expired memories every 72 cycles (~6h). No LLM needed — pure SQL delete. (2026-03-22)

### Future considerations
- **Autonomous watcher**: Lightweight Node.js process that monitors Discord when Claude Code isn't running, buffers messages to SQLite.
- **Multi-persona**: Namespace isolation + separate MCP server instances per persona.
- **Plugin marketplace**: Generalize into reusable "persistent memory + task queue for Claude Code" plugin.

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
    server.ts             — MCP server creation, registers all 49 tools
    cron.ts               — 5-field cron expression parser (minute/hour/dom/month/dow)
    db.ts                 — SQLite schema v2, FTS5 triggers, migration system
    config.ts             — TOML config loader (smol-toml)
    logger.ts             — JSON-lines logger with 30-day rotation
    memory.ts             — 6 tools: save/search/recall/forget/list/consolidate
    tasks.ts              — 6 tools: create/update/list/next/claim/complete
    context.ts            — 5 tools: flush/restore/today, daily_log add/get
    conversations.ts      — 4 tools: log/history/search/summary
    goals.ts              — 3 tools: set/list/archive (persistent user objectives)
    learnings.ts          — 3 tools: add/search/stats (structured self-improvement)
    processes.ts          — 4 tools: check/restart_self/restart_dashboard/ghost_status
    dashboard/
      app.ts              — Hono HTTP server, routes, PID management
      api.ts              — All API handlers + Claude session tracking
      claude-sessions.ts  — Parses ~/.claude/ JSONL for token/cost tracking
      sse.ts              — Server-Sent Events manager for live refresh
      html.ts             — Dashboard HTML/CSS/JS template
      html-extras.ts      — Heatmap + quick actions + Claude sessions panel
    discord/
      awareness.ts        — Proactive checks (overdue tasks, stale goals, recurring errors)
  config/
    charlie.toml          — Persona configuration
  skills/
    charlie-system/       — Core personality and behavior instructions
    context-flush/        — Pre-compaction flush
    morning-briefing/     — Daily briefing scheduled task
    task-review/          — Task work session
    security-audit/       — On-demand security audit (/security-audit)
    daily-goals/          — Goal-driven daily task generation
    hats/                 — Hat system skill (/hats)
    eval/                 — Eval framework skill (/eval)
    build/                — PRD-driven build skill (/build)
  hats/
    architect.md          — System design persona
    code-reviewer.md      — Code review persona
    debugger.md           — Bug investigation persona
    feature-dev.md        — Feature development persona
    security-reviewer.md  — Security audit persona
  .evals/
    hats/                 — Hat skill test cases
  scripts/
    install-service.sh    — systemd user service generator
  .claude/
    settings.json         — Hooks: SessionStart, PreCompact, Stop, PreToolUse, PostToolUse
    commands/             — Slash commands (/hats, /eval, /build, /newskill, /improve, /audit, /retrospective, /review, /adr)
    agents/               — Custom subagent definitions
      task-worker.md      — Focused task execution
      research-agent.md   — Read-only research
      conversation-reviewer.md — Audit conversations, create tasks
      fast-researcher.md  — Haiku, read-only quick lookups
      diagnostician.md    — System health checks and investigation
      executor.md         — Full-capability task execution
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
    cron.test.ts          — 13 tests: field parsing, cron scheduling
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

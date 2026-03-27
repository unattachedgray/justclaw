# justclaw — Persistence & automation layer for Claude Code CLI

SQLite-backed MCP server (52 tools) + Chrome browser bridge (70 commands) + Discord bot + deterministic heartbeat + self-healing process management. TypeScript, Node.js 20+, Linux.

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
| **Database** | `data/charlie.db` (SQLite, WAL, FTS5, schema v14) |
| **Debug mode** | Set `JUSTCLAW_DEBUG=1` in `.env` to suppress LLM escalation |

## Architecture

```
Claude Code CLI → justclaw MCP Server (stdio, 52 tools)
                         ↓
              SQLite (data/charlie.db, WAL, FTS5, schema v14)
                    ↓         ↓              ↓              ↓
              Dashboard   Discord Bot    Heartbeat       Browser Bridge
              Hono:8787   discord.js     9 checks        Chrome extension
              read-only   streams claude  + LLM escal.   70 commands
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
| `src/server.ts` | Registers all 49 MCP tools |
| `src/db.ts` | SQLite schema v14, FTS5, migrations, integrity check, backup |
| `src/process-registry.ts` | PID tracking, safety scoring, suspicious detection, malfunction escalation |
| `src/discord/bot.ts` | Discord bot: streaming progress, per-channel queue, circuit breaker, graceful shutdown |
| `src/email.ts` | SMTP email utility (Gmail app password): sendEmail(), verifySmtp() |
| `src/discord/heartbeat.ts` | Heartbeat orchestrator: deterministic checks, dedup, presence flash, escalation |
| `src/discord/heartbeat-checks.ts` | 9 pure TypeScript health checks |
| `src/discord/escalation.ts` | Goal-driven LLM escalation for persistent issues |
| `src/discord/anticipation.ts` | Predicts what user needs next: signal gathering + LLM synthesis |
| `src/discord/discord-utils.ts` | Shared Discord utilities: code-block-aware message splitting |
| `src/discord/scheduled-tasks.ts` | Executes due recurring tasks via claude -p, per-task channel routing |
| `src/discord/session-context.ts` | Session continuity: identity preamble, rotation logic, flush thresholds |
| `src/claude-spawn.ts` | Shared Claude CLI utilities: findClaudeBin, buildClaudeEnv, buildShellCmd, spawnClaudeP |
| `src/notebooks.ts` | NotebookLM-style document analysis: ingestion, chunking, FTS5 search, source grounding |
| `src/monitors.ts` | Metric monitoring engine: URL/command sources, extractors, condition evaluation |
| `src/monitor-tools.ts` | Monitor MCP tools: create, list, check, history, update, delete |
| `src/extractors.ts` | Multi-format document extraction: PDF, DOCX, XLSX, PPTX, HTML, EPUB, images |
| `src/gemini.ts` | Gemini AI: image gen/edit, PDF analysis, vision, grounded search (5 tools) |
| `src/time-utils.ts` | Shared timezone utilities: formatLocalTime, dual display, state-driven home/current tz |
| `src/task-templates.ts` | Task template resolver: `{{variable}}` interpolation, built-in date vars, template listing |
| `data/task-templates/` | Template files for recurring tasks (e.g., `daily-report.md`) |
| `scripts/prediction-tracker.ts` | Deterministic investment prediction tracker (CLI, JSON-backed) |
| `ecosystem.config.cjs` | PM2 config: kill_timeout, max_restarts, wait_ready |
| `browser-extension/` | Chrome extension: browser bridge with 70 automation commands |
| `.mcp.json` | MCP server config — **must include `JUSTCLAW_NO_DASHBOARD: "1"`** |

## MCP Tools (52)

Memory (6): save, search, recall, forget, list, consolidate — FTS5, namespaces, autodream-style dedup
Tasks (6): create, update, list, next, claim, complete — dependencies, agent claiming, auto-execute
Context (5): flush, restore, today, daily_log_add/get — compaction lifecycle
Conversations (4): log, history, search, summary — FTS5 across channels
Goals (3): set, list, archive — persistent objectives that drive daily task generation
Learnings (3): add, search, stats — structured self-improvement from errors and corrections
Notebooks (6): create, query, sources, list, overview, delete — NotebookLM-style document analysis
Monitors (6): create, list, check, history, update, delete — metric watching with alerts
Anticipation (1): anticipate_next — predict what user needs next from signals
Image (1): image_generate — Gemini AI image generation from text prompts
Alerts (2): alert_silence, alert_whitelist — suppress recurring heartbeat alerts
State/Status (3): get, set, status overview
Process (4): check, restart_self, restart_dashboard, ghost_status
System (2): recommendations, escalation_history

Full reference: @docs/MCP-TOOLS.md

## System Safety — Protecting the Ubuntu Host

This is a shared personal machine (Lenovo ThinkCentre M725s, 6.7GB RAM, HDD). Breaking it means everything stops. Follow these rules strictly.

### Forbidden actions (will break the system)
- **Never run `rm -rf /`** or any recursive delete outside the project directory
- **Never `sudo` anything** without Julian explicitly asking. No `sudo apt remove`, `sudo rm`, `sudo systemctl stop`, `sudo kill`. If something needs sudo, tell Julian and let him decide.
- **Never modify system config** — no editing `/etc/*`, `/boot/*`, `/sys/*`, `/proc/*`, crontab, systemd units outside the project, fstab, grub, network config, firewall rules
- **Never kill processes you didn't start** — only kill PIDs registered in justclaw's `process_registry` or PM2. Never `kill -9` a PID from `ps aux` without verifying it's ours.
- **Never fill the disk** — this machine has limited storage on HDD. Don't download large files (>100MB), don't generate unbounded logs, don't create large temp files without cleanup.
- **Never modify Julian's personal files** — stay within `/home/julian/temp/justclaw` and `/tmp`. Don't touch `~/.bashrc`, `~/.profile`, `~/.ssh`, `~/.config` (except `~/.config/justclaw/`), other projects in `~/temp/`.
- **Never uninstall system packages** — `apt remove` and `apt purge` are off limits. `apt list` and `apt search` are fine.

### Caution required (ask first if unsure)
- **`npm install -g`** — global installs affect the whole system. Prefer local `npm install` in the project.
- **`pip install`** — use `pip install --user` or a venv, never system-wide pip.
- **Large git operations** — `git clone` of big repos fills disk. Check `df -h` first if cloning anything.
- **PM2 operations on other services** — only manage `justclaw-dashboard` and `justclaw-discord`. Don't touch other PM2 processes if any exist.
- **Port binding** — justclaw uses port 8787. Don't bind other services to ports without checking what's already in use (`ss -tlnp`).
- **CPU-intensive tasks** — this is a low-power machine (Ryzen 5 PRO, 6.7GB RAM). Don't run parallel builds, large compiles, or heavy compute. One thing at a time.

### Safe defaults
- **Work within the project**: `/home/julian/temp/justclaw` is your home. All file operations should be relative to here.
- **Read before modifying**: always `Read` a file before `Edit`/`Write`.
- **Test before deploying**: `npm run build && npm test` before `pm2 restart`.
- **Check disk before downloads**: `df -h /home` if doing anything that creates files.
- **Check memory before heavy ops**: `free -m` if spawning processes.
- **Clean up after yourself**: remove temp files, don't leave stale logs growing.

## Never Rules (Code Quality)

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

## Env Vars

| Var | Purpose |
|-----|---------|
| `JUSTCLAW_NO_DASHBOARD` | **Must be `1`** in .mcp.json and claude -p spawns |
| `DISCORD_BOT_TOKEN` | Bot token (in .env) |
| `DISCORD_HEARTBEAT_CHANNEL_ID` | Channel for heartbeat alerts |
| `HEARTBEAT_INTERVAL_MS` | Check interval (default 300000) |
| `SMTP_HOST` | SMTP server hostname (e.g., `smtp.gmail.com`) |
| `SMTP_PORT` | SMTP port (default 587) |
| `SMTP_USER` | SMTP login username |
| `SMTP_PASS` | SMTP password or app password |
| `SMTP_FROM` | From address for outgoing emails (defaults to SMTP_USER) |
| `DASHBOARD_PASSWORD` | Dashboard login password (default `88888888`) |

## Timezone

All timestamps stored in UTC internally. Display converted via `src/time-utils.ts`.

| State key | Purpose | Default |
|-----------|---------|---------|
| `timezone_home` | User's default timezone | `America/New_York` (auto EDT/EST) |
| `timezone_current` | Temporary travel override | _(none — uses home)_ |

Set at runtime via `state_set`. No file edits or restarts needed. When `timezone_current` is set, all displays show dual format: `2:50 PM KST current / 8:50 AM EDT home`. Clear with `state_set("timezone_current", "")`. Both persist across restarts via `state` table.

## Skills

| Skill | Purpose |
|-------|---------|
| `/dev <mode> <desc>` | **Structured dev lifecycle** — 7-phase process (think/plan/build/review/test/ship/reflect). Modes: `new`, `fix`, `refactor`, `debug`. |
| `/dev-think <desc>` | Phase 1 only — investigate and understand the problem before committing to a solution |
| `/dev-plan <desc>` | Phase 2 only — design the solution (file changes, test strategy, risk assessment) |
| `/dev-review [files]` | Phase 4 only — self-review changes using Code Reviewer checklist |
| `/dev-ship [msg]` | Phases 5-7 — test, commit, and reflect on completed work |
| `/improve <topic>` | Research better practices from popular projects, implement |
| `/retrospective` | Review recent work, extract learnings, create ADRs |
| `/audit <area>` | Deep code audit for bugs and architecture issues |
| `/adr <title>` | Create Architecture Decision Record |
| `/review` | Pre-commit quality checklist |
| `/code-review [mode]` | **Multi-agent code review** — 5 specialist agents (style, security, performance, architecture, synthesis). Modes: `full`, `security`, `performance`, `architecture`, `style`. Based on harness-100 #21. |
| `/postmortem [mode]` | **Incident postmortem** — 5-agent team (timeline, root cause, impact, remediation, review). Modes: `full`, `timeline`, `rca`, `remediation`, `review`. Based on harness-100 #25. |
| `/hats <name>` | Apply specialized persona (architect, code-reviewer, debugger, feature-dev, security-reviewer) |
| `/eval [skill]` | Run skill evaluations against test cases, detect regressions |
| `/build [prd]` | PRD-driven autonomous build loop with plan verification and quality gates |
| `/newskill [desc]` | Research popular implementations, security audit, build custom skill |
| `/notebook <cmd> <name>` | **NotebookLM-style document analysis** — ingest folder, query with source citations, generate overviews/FAQs |
| `/monitor <cmd> [name]` | **Metric monitoring** — track prices, uptime, web changes, custom metrics. Alerts via Discord. |
| `/security-audit` | On-demand security audit (secrets, permissions, ports, deps) |

## Compaction Instructions

When compacting, preserve: modified files list, test results, errors and fixes, pending TODOs, key decisions and rationale.

## Detailed Docs

- Database schema: @docs/SCHEMA.md
- MCP tool reference: @docs/MCP-TOOLS.md
- Discord bot internals: @docs/DISCORD-BOT.md
- Process management: @docs/PROCESS-MANAGEMENT.md
- Browser bridge (70 commands): @docs/BROWSER-BRIDGE.md
- Dashboard (API, widgets, monitors): @docs/DASHBOARD.md
- Architecture decisions: @docs/decisions/

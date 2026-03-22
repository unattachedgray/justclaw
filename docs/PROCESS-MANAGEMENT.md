# Process Management System

Detailed documentation for `src/process-registry.ts`, `src/discord/heartbeat-checks.ts`, and related modules.

## Process Registry Table (`process_registry`)

Every process justclaw spawns or manages is registered with:
- `pid`: OS process ID
- `role`: `dashboard`, `discord-bot`, `claude-p`, `mcp-server`, or `heartbeat-claude`
- `status`: `active` (should be running) or `retired` (should NOT be running)
- `started_at`, `retired_at`: lifecycle timestamps
- `meta`: context (e.g., `channel:1234567890` for Discord channel-specific claude -p)

## Conservative Kill Policy

**Principle: only kill what we are 100% certain is ours AND should not be running.**

| Category | Auto-kill? | Conditions |
|----------|-----------|------------|
| Retired `claude-p`, `heartbeat-claude`, `mcp-server` | **Yes** | After 30s grace period + `/proc/cmdline` identity verification + `/proc/stat` start time PID-reuse check |
| Retired `dashboard` | **Nudge pm2** | `pm2 restart justclaw-dashboard` — lets pm2 handle the kill/restart cycle |
| Retired `discord-bot` | **Report only** | Can't restart ourselves from within; pm2 handles it |
| Suspicious (found via `ps`, not in registry) | **No** — tracked and scored | Suggested to user hourly; auto-killed only during malfunction escalation |
| Interactive claude sessions | **Never** | Detected via `--dangerously-skip-permissions` or absence of ` -p ` flag in cmdline |
| PIDs where `/proc/cmdline` doesn't match justclaw | **Never** | Deleted from registry (PID was reused by unrelated process after reboot) |

### Three Safety Layers

1. **Identity check** (`isOurProcess`): reads `/proc/<pid>/cmdline`, must match `justclaw`, `dist/discord`, `dist/dashboard`, or `dist/index`. Excludes interactive claude sessions.
2. **Role check**: only `KILLABLE_ROLES` (`claude-p`, `heartbeat-claude`, `mcp-server`) are auto-killed. PM2-managed roles never auto-killed.
3. **Grace period**: 30 seconds after retirement before killing. Allows processes to complete graceful shutdown.

### PID Reuse Protection

After reboot, PIDs can be reused by unrelated processes. Two protections:
1. `/proc/<pid>/cmdline` must match justclaw patterns
2. `/proc/<pid>/stat` start time must be AFTER the registry entry was created (±60s tolerance)

## Suspicious Process Tracking

Unknown justclaw-related processes discovered via `ps` scan that are NOT in our registry are tracked as "suspicious" in the `state` table (`suspicious_pid_*` keys). Capped at 50 entries, pruned after 24h.

### Safety Score (0-100)

| Criteria | Score change |
|----------|-------------|
| Matches justclaw process patterns in cmdline | +40 |
| Is claude print-mode (` -p ` in cmdline) | +20 |
| Not in pm2's current PID list | +10 |
| Per heartbeat cycle seen (up to 4 cycles) | +5 each |
| Seen 3+ heartbeat cycles | +10 |
| Is interactive claude session | **= 0** (never kill) |

## Malfunction Escalation

- **Triggers**: pm2 restart count > 10, process in `errored` state, 5+ suspicious processes
- **Action**: auto-kill suspicious processes with safety score >= 70 AND seen >= 3 heartbeat cycles
- **Rationale**: when crash-looping, runaway orphans are likely the cause

## Deterministic Heartbeat Checks

9 pure TypeScript checks, <1s, $0 cost:

| # | Check | Auto-heals? |
|---|-------|-------------|
| 1 | Process registry audit | Yes: kills retired orphans |
| 2 | Stale claude -p scan | Report only |
| 3 | PM2 health (restart loops, stopped) | Report only |
| 4 | Unanswered Discord messages (1h window) | Report only |
| 5 | System status (memory, tasks, logs) | Informational |
| 6 | Stuck tasks (active >24h) | Report only |
| 7 | CLAUDE.md staleness (dead file references) | Report only |
| 8 | Event loop lag | Placeholder |
| 9 | Memory usage (warn at 250MB) | PM2 restarts at 300MB |

## Goal-Driven LLM Escalation

When deterministic checks detect an ALERT that persists for 3+ cycles, escalates to Claude (`src/discord/escalation.ts`).

**Guardrails:** max 3/hour/goal, 10min cooldown, circuit breaker after 3 consecutive failures, 120s timeout, no source code edits.

**Learning loop:** Past diagnoses saved to memories table → fed into future escalation prompts → Claude gets smarter each time without modifying code.

**Healing verification:** After escalation claims resolved, re-runs checks at 2min. If issue persists, marks as `false_positive`.

## Graceful Shutdown (Discord bot)

1. Stop heartbeat
2. `process.kill(-pid, 'SIGTERM')` for each active claude -p (negative PID = entire process group)
3. Wait 5s
4. SIGKILL survivors
5. Retire all PIDs, close DB, exit

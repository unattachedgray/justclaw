# ADR-002: Conservative process kill policy with safety scoring

**Status**: accepted
**Date**: 2026-03-21

## Context

Early process management killed any process matching `grep 'claude.*-p'`. This killed the user's interactive Claude Code session because `--dangerously-skip-permissions` contains `-p`. We needed a kill policy that's safe by default and only escalates when confident.

## Decision

Three-tier process tracking with conservative kill policy:
1. **Registry** (SQLite): tracks PIDs we spawned. Auto-kill only retired ephemeral roles (claude-p, heartbeat-claude, mcp-server) after 30s grace + /proc/cmdline identity verification + /proc/stat start time PID-reuse check.
2. **Suspicious** (state table): unknown processes found via ps scan. Tracked with safety scores (0-100). Never auto-killed during normal operation. Auto-killed only during malfunction escalation (score >= 70, seen >= 3 cycles).
3. **Never touch**: interactive claude sessions (detected via cmdline), processes not matching justclaw patterns.

## Consequences

**Positive**: Never killed a legitimate user process since implementing this policy. PID reuse across reboots handled via /proc/stat start time comparison.

**Negative**: Some orphans may linger until the user reviews suspicious process suggestions. Acceptable trade-off — a lingering orphan using a few MB is better than killing the user's active session.

# ADR-001: Deterministic heartbeat over LLM-based checks

**Status**: accepted
**Date**: 2026-03-21

## Context

The original heartbeat spawned `claude -p` every 5 minutes to run health checks. This cost ~$0.05/check ($14/month), took ~15s per check, and introduced fragility: the MCP server startup killed the PM2-managed dashboard, prompt interpretation varied between runs, and permission issues could block checks entirely.

An audit revealed all 6 checks were SQL queries and process comparisons — no LLM reasoning needed.

## Decision

Replace the LLM heartbeat with pure TypeScript functions (`heartbeat-checks.ts`). Each check returns structured data. The heartbeat aggregates results into severity/issue codes/summary deterministically. LLM is only invoked for escalation when deterministic fixes fail after 3 cycles.

## Consequences

**Positive**: $0 cost, <1s execution, 100% reliable, no side effects (no MCP server startup), no permission issues.

**Negative**: Can't detect novel failure modes that don't match coded patterns. Mitigated by the escalation system — when checks detect persistent issues they can't fix, Claude gets invoked.

**Trade-off**: We accept that 5% of failure modes need LLM reasoning. The 95% case runs in deterministic code.

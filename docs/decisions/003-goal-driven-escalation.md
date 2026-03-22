# ADR-003: Goal-driven LLM escalation for persistent issues

**Status**: accepted
**Date**: 2026-03-21

## Context

Deterministic health checks handle 95% of failure modes. The remaining 5% (novel crashes, port conflicts, DB corruption) need reasoning. Options considered:
1. Always alert user (simple but slow — user may not see Discord for hours)
2. Always invoke LLM (expensive at $0.05/call, 288 calls/day)
3. Deterministic first, LLM escalation on persistence (hybrid)

Research found this hybrid pattern is genuinely novel — no existing AI agent framework (AutoGPT, BabyAGI, OpenHands) does "deterministic first, LLM escalation." Most are fully LLM-driven or fully deterministic.

## Decision

Adopt the hybrid pattern. Deterministic checks run every 5 min at $0. When an ALERT persists for 3+ cycles (15 min), escalate to Claude with scoped permissions and budget cap (3/hour). Claude diagnoses, acts if confident, and stores recommendations for system improvement. Recommendations are NOT auto-applied as code — they're reviewed by the developer.

## Consequences

**Positive**: Self-healing for novel failures. Learning loop via memory (past diagnoses inform future escalations). Recommendations drive system improvement over time.

**Negative**: Escalation costs ~$0.05 per call. Circuit breaker prevents cost spirals. A 2025 study showed LLM-generated code improvements increase vulnerabilities by 37.6% — this is why we store recommendations, not auto-apply code.

## Alternatives considered

- **Full LLM heartbeat**: rejected (cost, latency, side effects)
- **Rule-based playbook only**: rejected (can't handle novel failures)
- **Auto-codification of fixes**: rejected (security degradation risk)

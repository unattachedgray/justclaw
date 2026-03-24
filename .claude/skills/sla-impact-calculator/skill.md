# SLA Impact Calculator Reference

Framework for calculating SLA/SLO/SLI impact during incident postmortems. Referenced by the `impact-assessor` agent.

## SLA / SLO / SLI Framework

| Term | Definition | Example |
|------|-----------|---------|
| **SLI** (Service Level Indicator) | A quantitative measure of service behavior | Percentage of requests returning 2xx in 5min window |
| **SLO** (Service Level Objective) | Target value for an SLI | 99.5% availability per month |
| **SLA** (Service Level Agreement) | Business contract with consequences for missing SLO | 99.5% uptime or service credits apply |

For justclaw (single-user system), SLOs are internal quality targets rather than contractual obligations, but the math is the same.

---

## Allowed Downtime by Availability Level

| Availability | Annual Downtime | Monthly Downtime | Weekly Downtime | Daily Downtime |
|-------------|----------------|-----------------|----------------|---------------|
| 99% | 3d 15h 36m | 7h 18m | 1h 41m | 14m 24s |
| 99.5% | 1d 19h 48m | 3h 39m | 50m 24s | 7m 12s |
| 99.9% | 8h 45m 36s | 43m 48s | 10m 5s | 1m 26s |
| 99.95% | 4h 22m 48s | 21m 54s | 5m 2s | 43s |
| 99.99% | 52m 34s | 4m 23s | 1m 0.5s | 8.6s |
| 99.999% | 5m 15s | 26.3s | 6.0s | 0.86s |

### Recommended SLOs for justclaw Components

| Component | Recommended SLO | Rationale |
|-----------|----------------|-----------|
| Discord bot responsiveness | 99.5% monthly | Single user, tolerant of brief outages, PM2 auto-restarts |
| Dashboard availability | 99% monthly | Read-only, informational, not critical path |
| MCP server availability | 99.9% monthly | Directly impacts Claude Code CLI sessions |
| Heartbeat execution | 99.5% monthly | 5-min cycle, missing a few cycles is acceptable |
| Data durability (SQLite) | 99.99% monthly | Data loss is hard to recover; WAL + backups provide this |

---

## Error Budget Calculation

The error budget is the allowed amount of unreliability within the SLO.

### Formula

```
Error Budget (minutes) = Total Period (minutes) x (1 - SLO target)

Error Budget Consumed (%) = Actual Downtime (minutes) / Error Budget (minutes) x 100
```

### Example Calculation

```
Component: Discord bot
SLO: 99.5% monthly availability
Month: March 2026 (31 days = 44,640 minutes)

Error Budget = 44,640 x (1 - 0.995) = 223.2 minutes (3h 43m)

Incident downtime: 45 minutes
Error Budget Consumed = 45 / 223.2 x 100 = 20.2%

Remaining budget: 178.2 minutes (2h 58m)
```

### Budget Status Interpretation

| Budget Consumed | Status | Action |
|----------------|--------|--------|
| 0-25% | Healthy | Normal operations |
| 25-50% | Caution | Review reliability investments |
| 50-75% | Warning | Freeze non-critical changes, prioritize reliability |
| 75-100% | Critical | All hands on reliability, halt feature work |
| >100% | Breached | SLO violated, postmortem required, remediation mandatory |

---

## Business Impact Matrix

### Severity Levels

| Severity | Criteria | justclaw Context |
|----------|----------|-----------------|
| **P1 — Critical** | Complete service outage, data loss, or security breach | All components down, SQLite corrupt, credentials exposed |
| **P2 — Major** | Significant functionality impaired, workarounds exist | Discord bot down but MCP/dashboard work, or vice versa |
| **P3 — Minor** | Limited functionality impaired, most users unaffected | Single feature broken (e.g., heartbeat not running, one monitor failing) |
| **P4 — Low** | Cosmetic or minor inconvenience | Dashboard formatting issue, non-critical log noise |

### User Impact Scope

| Scope | Definition | justclaw Example |
|-------|-----------|-----------------|
| **Full** | All functionality affected for all users | Bot completely unresponsive, MCP server won't start |
| **Partial** | Some functionality affected or degraded | Bot responds but can't access tools, dashboard slow |
| **Minimal** | Edge case or single feature | One monitor failing, session rotation glitchy |

### Revenue/Cost Impact Estimation

For non-commercial projects like justclaw, estimate impact as operational cost:

| Cost Type | How to Estimate |
|-----------|----------------|
| **Time cost** | Hours spent on manual intervention x hourly rate equivalent |
| **Productivity loss** | Tasks delayed or blocked during outage x estimated value |
| **Recovery cost** | Time spent on post-incident cleanup, data recovery, re-processing |
| **Opportunity cost** | Scheduled tasks missed, automations not run, insights not generated |

---

## Financial Impact of SLA Violations

For systems with contractual SLAs (not directly applicable to justclaw, but useful reference):

| SLA Violation Level | Typical Penalty |
|--------------------|----------------|
| SLO missed by <1% | Warning, no penalty |
| SLO missed by 1-5% | 10% service credit |
| SLO missed by 5-10% | 25% service credit |
| SLO missed by >10% | 50% service credit or contract exit clause |

---

## Composite SLA Calculation

When multiple components must work together, the composite availability is lower than any individual component.

### Serial Dependencies (all must work)

```
Composite SLA = SLA_A x SLA_B x SLA_C

Example: Discord bot (99.5%) depends on MCP server (99.9%) depends on SQLite (99.99%)
Composite = 0.995 x 0.999 x 0.9999 = 0.9939 = 99.39%
```

### Parallel/Redundant (any one working is sufficient)

```
Composite SLA = 1 - (1 - SLA_A) x (1 - SLA_B)

Example: Two monitoring paths (heartbeat 99.5% + manual check 95%)
Composite = 1 - (0.005 x 0.05) = 1 - 0.00025 = 99.975%
```

### justclaw Dependency Chain

```
User → Discord → Bot Process → claude -p → MCP Server → SQLite
                      ↓
                   PM2 (restart manager)
                      ↓
                   Heartbeat → Escalation → claude -p (healing)
```

Serial chain availability (worst path):
```
Discord API (99.9%) x Bot (99.5%) x claude CLI (99%) x MCP (99.9%) x SQLite (99.99%)
= 0.999 x 0.995 x 0.99 x 0.999 x 0.9999
= 0.9829 = 98.29%

Monthly downtime budget for end-to-end: ~12.4 hours
```

---

## Impact Report Template

Use this structure in the impact assessment deliverable:

```markdown
## SLA/SLO Impact

### Error Budget Status

| Component | SLO Target | Budget (monthly) | Consumed (this incident) | Remaining |
|-----------|-----------|------------------|--------------------------|-----------|
| Discord bot | 99.5% | 223 min | X min (Y%) | Z min |
| MCP server | 99.9% | 44 min | X min (Y%) | Z min |
| Dashboard | 99.0% | 447 min | X min (Y%) | Z min |
| Data durability | 99.99% | 4.5 min | X min (Y%) | Z min |

### Composite Impact

End-to-end availability during incident period:
- **Target**: 98.29% (composite SLA)
- **Actual**: [calculated]%
- **Delta**: [difference]%

### Severity Classification

| Criterion | Assessment |
|-----------|-----------|
| Severity level | P[1-4] |
| User impact scope | Full/Partial/Minimal |
| Duration | [X hours Y minutes] |
| Data impact | [None/Degraded/Lost] |
| Budget status | [Healthy/Caution/Warning/Critical/Breached] |
```

---

## Quick Reference Formulas

```
Availability % = (Total Time - Downtime) / Total Time x 100

MTTD = Time of Detection - Time of Incident Start

MTTR = Time of Recovery - Time of Detection

MTBF = Total Uptime / Number of Failures

Error Budget = Total Period x (1 - SLO)

Budget Consumed % = Downtime / Error Budget x 100

Composite Serial = Product of all component availabilities

Composite Parallel = 1 - Product of all component unavailabilities
```

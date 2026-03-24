# RCA Methodology Reference

Root Cause Analysis techniques for incident postmortems. Referenced by the `root-cause-investigator` agent.

## Technique Selection Guide

| Incident Type | Recommended Technique | Why |
|--------------|----------------------|-----|
| Simple cause chain (A caused B caused C) | 5 Whys | Fast, linear, good for straightforward incidents |
| Multiple contributing factors | Fishbone / Ishikawa | Categorizes and visualizes diverse factors |
| Complex system with interacting failures | Fault Tree Analysis | Models AND/OR relationships between causes |
| Recent change preceded the incident | Change Analysis | Isolates what changed and its effects |
| Recurring incident | All techniques + pattern analysis | Need to find what previous RCAs missed |

Use multiple techniques for any P1/P2 incident. Single technique is acceptable for P3/P4.

---

## 1. Five Whys Technique

### How to Apply

Start from the observable symptom and repeatedly ask "why" until you reach an actionable root cause.

```
Symptom: Discord bot stopped responding to messages at 14:32 UTC

Why #1: Why did the bot stop responding?
→ The claude -p child process was killed by OOM killer.

Why #2: Why was the process killed by OOM?
→ Memory usage grew to 290MB, exceeding PM2's 300MB limit.

Why #3: Why did memory grow to 290MB?
→ The per-channel session Map accumulated entries without LRU eviction.

Why #4: Why was there no LRU eviction?
→ The Map was implemented without a size limit when per-channel tracking was added.

Why #5: Why was a size limit not included?
→ No code review checklist item for bounded collection sizes.

ROOT CAUSE: Missing bounded-collection review check in development process.
CONTRIBUTING: No memory usage monitor to detect gradual growth before OOM.
```

### Pitfall Avoidance

| Pitfall | How to Detect | How to Fix |
|---------|--------------|-----------|
| **Stopping too early** | Root cause is still a symptom ("because of a bug") | Ask: "Could we have prevented this even if the bug existed?" Keep going. |
| **Going too deep** | Answers become philosophical ("because software has bugs") | Stop when the answer suggests a concrete, implementable change |
| **Single track** | Only one "why" chain explored | At each level, ask: "Is there another reason?" Branch into parallel chains. |
| **Circular logic** | Answer at level N restates answer at level N-2 | You've exhausted this branch. Start a new chain from a different symptom. |
| **Blame framing** | "Why" answers start naming people | Reframe as system/process: "Why did the process allow X?" not "Why did person do X?" |

### Branching Example

```
Why did the bot crash?
├── Branch A: OOM kill (memory)
│   └── Why? → Unbounded Map → Why? → No size limit → Why? → No review check
└── Branch B: No graceful degradation (resilience)
    └── Why? → No memory pressure handler → Why? → Not in design requirements
```

### Quality Criteria for Root Causes

A good root cause is:
- **Specific**: points to a particular code path, config, or process
- **Actionable**: suggests a concrete fix or improvement
- **Systemic**: explains the class of failure, not just this instance
- **Verifiable**: you can test whether fixing it prevents recurrence

---

## 2. Fishbone / Ishikawa Diagram

### 6M Categories for Software Systems

```
                           ┌─── Method ────────────────────┐
                           │  Process gaps                  │
                           │  Missing runbooks              │
                           │  Unclear escalation paths      │
                           │  Deployment process flaws      │
                           │  Testing gaps                  │
                           ├─── Machine ────────────────────┤
                           │  Hardware limits (RAM, CPU)    │
                           │  Disk space / I/O bottlenecks  │
                           │  Network failures              │
                           │  OS/kernel issues              │
                           │  PM2 / process manager bugs    │
     ┌──── INCIDENT ───────├─── Material ────────────────────┤
     │    (Effect)         │  Data corruption (SQLite)      │
     │                     │  Malformed inputs              │
     │                     │  Schema migration issues       │
     │                     │  Stale cache/state             │
     │                     │  External API changes          │
                           ├─── Measurement ────────────────┤
                           │  Missing monitors              │
                           │  Wrong alert thresholds        │
                           │  No metrics for failure mode   │
                           │  Heartbeat check gaps          │
                           │  Insufficient logging          │
                           ├─── Milieu (Environment) ───────┤
                           │  Node.js version               │
                           │  npm dependency updates        │
                           │  OS/system updates             │
                           │  External service outages      │
                           │  Time-based triggers (cron)    │
                           └─── Manpower ───────────────────┤
                               Knowledge gaps               │
                               Single point of failure      │
                               Documentation staleness      │
                               Operational experience       │
                               Review coverage              │
                               └────────────────────────────┘
```

### How to Apply

1. Write the incident (effect) on the left
2. Draw the six category branches
3. For each category, brainstorm contributing factors from evidence
4. Circle factors that are confirmed by evidence
5. Draw connections between factors across categories (interactions)
6. Prioritize: which factors had the largest contribution?

### justclaw-Specific Factors by Category

| Category | Common Factors |
|----------|---------------|
| **Method** | No pre-deploy smoke test, heartbeat escalation too aggressive, no rollback procedure |
| **Machine** | 6.7GB RAM limit, HDD I/O bottleneck, Ryzen 5 PRO thermal throttling |
| **Material** | SQLite WAL corruption, FTS5 index inconsistency, session table schema mismatch |
| **Measurement** | No monitor for WAL file size, no alert for memory growth trend, heartbeat only checks every 5min |
| **Milieu** | Node.js 22 breaking change, discord.js API change, PM2 update side effect |
| **Manpower** | Single developer, no peer review, tribal knowledge not documented |

---

## 3. Fault Tree Analysis (FTA)

### Notation

- **Top event**: the incident (undesirable outcome)
- **AND gate** (all inputs must occur for output): `&`
- **OR gate** (any input causes output): `|`
- **Basic event**: a root cause (leaf node)
- **Undeveloped event**: needs further investigation

### How to Build

1. Start with the top event (the incident)
2. Ask: "What immediate causes could produce this?" → create child nodes
3. For each child, determine if it's AND (all children must occur) or OR (any child suffices)
4. Continue decomposing until you reach basic events (actionable root causes)
5. Estimate probability for basic events if data is available

### Example: Discord Bot Unresponsive

```
                    Bot Unresponsive
                         |
                    ── OR gate ──
                   /      |       \
          Process     Queue        Discord
          Crashed     Deadlock     Disconnect
            |            |             |
       ── OR ──     ── AND ──     ── OR ──
       /       \    /        \    /       \
    OOM      Unhandled  Lock    No     Shard    Rate
    Kill     Exception  Held   Consumer Error   Limited
     |          |        |       |       |        |
  Memory    Missing   SQLite  Circuit  WebSocket API
  Leak      try/catch  Busy   Breaker  Failure   Limit
                              Open               Hit
```

### Probability Estimation

When data is available, estimate probability for basic events:

| Event | Probability | Based On |
|-------|------------|----------|
| OOM Kill | 0.15 | Occurred 3 times in 30 days |
| SQLite Busy | 0.08 | WAL contention seen during concurrent heartbeat+discord writes |
| Shard Error | 0.03 | Discord API stability history |

**Top event probability** = combine using AND (multiply) and OR (1 - product of complements) gates.

---

## 4. Change Analysis

### When to Use

Use when a change (deployment, config update, dependency upgrade, OS update) preceded the incident.

### Process

1. **Identify the change**: what was modified, when, and by whom/what
2. **Compare before/after**: `git diff` for code, config diffs, dependency changes
3. **Map change to failure**: trace how the change could cause the observed symptoms
4. **Verify causation**: would reverting the change fix the issue? (don't actually revert — analyze)

### Change Sources in justclaw

| Change Type | How to Find |
|-------------|------------|
| Code deployment | `git log --oneline --since="24 hours ago"` |
| PM2 config change | `git diff ecosystem.config.cjs` |
| npm dependency update | `git diff package-lock.json` |
| Schema migration | Check `schema_meta` table, `MIGRATIONS` in `db.ts` |
| System update | `journalctl --since="24 hours ago" -u apt-daily*` |
| Environment change | Compare `.env` with last known good state |

---

## 5. Cognitive Bias Prevention Checklist

Run this checklist after completing your analysis to catch common reasoning errors.

| Bias | Question to Ask | If Yes, What to Do |
|------|----------------|-------------------|
| **Hindsight bias** | "Am I only seeing this as obvious because I know what happened?" | Remove outcome knowledge and re-evaluate: would this have been predictable? |
| **Confirmation bias** | "Did I stop looking after finding evidence that supports my first hypothesis?" | Actively seek disconfirming evidence. Check if alternative hypotheses explain the data equally well. |
| **Anchoring** | "Am I fixated on the first cause I identified?" | Set aside your first hypothesis. Start fresh from a different symptom or data source. |
| **Availability bias** | "Am I favoring this cause because I've seen it before?" | Check if the evidence actually supports this cause for THIS incident, not just in general. |
| **Single-cause trap** | "Have I found only one root cause?" | Almost every incident has multiple contributing factors. If you found one, look for at least two more. |
| **Blame attribution** | "Am I describing what a person did wrong rather than what the system allowed?" | Reframe every finding in terms of process, tooling, or design gaps. |
| **Narrative fallacy** | "Am I constructing a clean story that might oversimplify?" | Check if your causal chain skips steps or glosses over uncertainty. Mark gaps explicitly. |
| **Recency bias** | "Am I focusing on the most recent event as the cause?" | Check if earlier events set the stage. The triggering event is often not the root cause. |

---

## Combining Techniques

For a thorough RCA:

1. **Start with 5 Whys** to explore causal chains quickly
2. **Use Fishbone** to ensure you've considered all categories of contributing factors
3. **Build a Fault Tree** for complex incidents with multiple interacting failures
4. **Run Change Analysis** if a deployment or update preceded the incident
5. **Apply the Bias Checklist** to validate your conclusions

Document which techniques you used and why in your RCA deliverable. This helps future postmortems calibrate their approach.

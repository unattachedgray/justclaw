# Development Roadmap — Agent Pattern Analysis

Research across 13 agent projects/frameworks to identify patterns worth adopting in justclaw. Conducted 2026-03-27.

## Projects Analyzed

| Project | Category | Biggest Innovation |
|---------|----------|-------------------|
| **CrewAI** | Multi-agent | Unified memory with composite scoring (semantic + recency + importance) |
| **AutoGen** (Microsoft) | Multi-agent | Hybrid speaker selection (deterministic-first, LLM-fallback) |
| **LangGraph** | Workflow | Three-table checkpoint architecture with time-travel debugging |
| **OpenHands** | Coding agent | Event sourcing as universal abstraction (replay, pause/resume, security) |
| **SWE-Agent** (Princeton) | Coding agent | Constraining the action space improves performance |
| **Aider** | Coding agent | Graph-ranked repo map (tree-sitter + PageRank in 1K tokens) |
| **MetaGPT** | Multi-agent | Structured artifacts as inter-agent communication (not chat) |
| **Devin** (Cognition) | Coding agent | Playbooks — codified learned workflows with success criteria |
| **Cursor** | IDE | Priority-based context assembly ("Preempt" — prompts as UI components) |
| **Cline** | VS Code agent | Git-based checkpoint/rollback with dual restore modes |
| **AutoGPT** | Autonomous | Self-criticism loop (proven fragile — key failure lessons) |
| **Semantic Kernel** | Enterprise | Filter pipeline — composable middleware for every LLM call |
| **BabyAGI** | Autonomous | Minimal viable loop: execute + create tasks + prioritize (3 LLM calls) |

## What justclaw Already Does Well

These patterns are already implemented or handled better than the researched projects:

- **Deterministic prioritization** — SQL-based task ordering vs BabyAGI's LLM-based (expensive, non-deterministic)
- **SQLite FTS5** — better than vector DBs at justclaw's scale, zero dependencies
- **Per-channel queues** — vs Cline's single-task model
- **Deterministic health checks** — 9 checks, <1s, $0/cycle
- **Template-driven task decomposition** — vs runtime decomposition which drifts
- **Two-phase scheduled tasks** — prep (AI) + delivery (deterministic scripts)
- **Conservative kill policy** — 3-layer safety with PID reuse protection
- **Playbook crystallization** — learnings automatically promoted with Bayesian confidence

## Confirmed Anti-Patterns (What NOT to Build)

Lessons from failures across the ecosystem:

| Anti-Pattern | Source | Why It Fails |
|---|---|---|
| Autonomous loops without termination | AutoGPT | Goals requiring >4-5 actions reliably loop forever |
| LLM for mechanical tasks | BabyAGI | Prioritization, formatting, routing — all cheaper deterministically |
| Vector DB at small scale | Multiple | FTS5+SQL scoring works for <100K memories; embedding overhead not justified |
| Dedicated planner layers | Semantic Kernel | Modern LLMs with function calling ARE the planner; separate planners deprecated |
| Multi-agent debate for single-user | AutoGen | Token cost and latency without clear benefit |
| Agent Protocol (REST) | AutoGPT | Eclipsed by MCP as the de facto standard |
| LLM-based task prioritization | BabyAGI | Expensive, non-deterministic, SQL ORDER BY is better |
| Docker sandbox per task | OpenHands | Resource overhead on constrained hardware (6.7GB RAM) |

---

## Recommendations

### Tier 1: Implement Now (high value, low effort)

#### 1. Priority-Based Context Assembly
**Source**: Cursor's "Preempt" system

justclaw's `buildIdentityPreamble()` and `buildTaskPreamble()` currently append everything (goals, tasks, learnings, logs) without prioritization. When context is tight, nothing is dropped.

**Implementation**: Assign each context component a priority score. When the assembled preamble exceeds a token budget, drop lowest-priority items first.

```
Priority 1 (never drop): System context, active task description
Priority 2 (keep if possible): Recent learnings for this area, playbook entries
Priority 3 (drop first): Older daily log entries, lower-priority goals
```

**File**: `src/discord/session-context.ts`
**Effort**: ~50 lines. Token estimation via `content.length / 4`.

#### 2. Context Injection from Past Executions
**Source**: BabyAGI's retrieval pattern, Devin's knowledge system

When a recurring scheduled task runs, inject the last 2-3 results of the **same template** as context. The AI sees what worked and what failed last time.

**Implementation**: Query `task_reflections` + `conversations` table for past runs of the same `recurrence_source_id`. Include score, duration, and any errors in the task preamble.

```sql
SELECT t.result, tr.quality_score, tr.error_class, tr.duration_ms
FROM tasks t
LEFT JOIN task_reflections tr ON tr.task_id = t.id
WHERE t.recurrence_source_id = ? AND t.status = 'completed'
ORDER BY t.completed_at DESC LIMIT 3
```

**File**: `src/discord/session-context.ts` (extend `buildTaskPreamble`)
**Effort**: ~30 lines.

#### 3. Git Checkpoint Before Destructive Tasks
**Source**: Cline's dual-mode checkpoint/rollback

Before scheduled tasks that modify files (git-archive, code generation), create a lightweight git tag or stash. If the task fails, rollback is trivial.

**Implementation**: In `scheduled-tasks.ts`, before spawning `claude -p` for tasks with `git` in their template, run:
```bash
git stash create "pre-task-${taskId}"
```
Store the stash ref in the `state` table. On failure, offer rollback via Discord.

**File**: `src/discord/scheduled-tasks.ts`
**Effort**: ~20 lines.

#### 4. Post-Execution Reflection Loop
**Source**: AutoGPT's self-criticism (simplified), MetaGPT's executable feedback

After each scheduled task, add a one-shot deterministic check: "Did the output match the expected structure?" Currently `reflectOnTaskResult` checks for error patterns and missing sections. Enhance it to also verify:

- Report file exists at expected path (for two-phase tasks)
- Git commit was created (for archive tasks)
- Expected sections have minimum content length

**File**: `src/discord/reflect.ts`, `src/discord/quality-scan.ts`
**Effort**: ~40 lines in quality-scan.ts.

#### 5. Step/Token Budgets on Tasks
**Source**: AutoGPT's cost explosion failures

Add `max_steps` and `max_cost_cents` columns to the tasks table. The scheduled task executor enforces these — if a `claude -p` process exceeds the budget, it's terminated gracefully with a partial result saved.

**Implementation**: Parse `stream-json` events for step counts. Track via a counter in `runClaudeForTask`.

**File**: `src/discord/scheduled-tasks.ts`, `src/db.ts` (migration)
**Effort**: ~40 lines + schema migration.

---

### Tier 2: Implement Soon (high value, moderate effort)

#### 6. Enhanced Playbooks with Success Criteria
**Source**: Devin's playbook system

justclaw's `playbook` table has `goal`, `pattern`, `action`, `confidence`. Devin's playbooks are richer — they include **success criteria** (how to know the fix worked), **guardrails** (what NOT to do), and **step-by-step procedures**.

**Implementation**: Add columns to the playbook table:
```sql
ALTER TABLE playbook ADD COLUMN success_criteria TEXT;
ALTER TABLE playbook ADD COLUMN guardrails TEXT;
ALTER TABLE playbook ADD COLUMN steps TEXT; -- JSON array
```

When a playbook entry reaches confidence >= 0.7 AND has been used 5+ times, auto-populate `steps` from the most recent successful task execution log.

**Files**: `src/playbook.ts`, `src/db.ts`, `src/discord/reflect.ts`
**Effort**: ~80 lines + migration.

#### 7. Filter Pipeline for claude -p Calls
**Source**: Semantic Kernel's middleware pattern

Centralize scattered operational concerns (token metering, cost tracking, timeout enforcement, audit logging) into a composable pipeline that wraps every `claude -p` invocation.

**Implementation**: Create `src/claude-filters.ts` with a filter chain:
```typescript
interface ClaudeFilter {
  name: string;
  before?(ctx: SpawnContext): void;
  after?(ctx: SpawnContext, result: SpawnResult): void;
}

// Filters: TokenMeter, CostTracker, AuditLog, TimeoutEnforcer
```

Wire into `spawnClaudeP()` in `src/claude-spawn.ts`.

**Files**: New `src/claude-filters.ts`, modify `src/claude-spawn.ts`
**Effort**: ~120 lines.

#### 8. Structured Output Schemas Per Task Type
**Source**: MetaGPT's artifact system

Task templates produce free-form text. Define expected output schemas per template so the reflection system can validate structure, not just pattern-match for errors.

**Implementation**: Add a `schema` section to task templates (after `---DELIVERY---`):
```
---SCHEMA---
required_sections: ["Research", "Archive", "Sources"]
min_content_length: 2000
required_links: true
file_output: /tmp/justclaw-report-{{TASK_ID}}.md
```

`quality-scan.ts` reads this schema and validates against it.

**Files**: `src/task-templates.ts`, `src/discord/quality-scan.ts`
**Effort**: ~80 lines.

#### 9. Watch/Subscribe Filtering for Heartbeat
**Source**: MetaGPT's message pool pub-sub

Let each heartbeat check declare which conversation topics and task areas it cares about, filtering noise from the escalation pipeline.

**Implementation**: Each check function returns a `concerns: string[]` array. The escalation engine only fires for checks whose concerns overlap with recent activity.

**File**: `src/discord/heartbeat-checks.ts`, `src/discord/escalation.ts`
**Effort**: ~60 lines.

#### 10. Token-Aware Context Condensation
**Source**: OpenHands' Condenser system

Replace fixed turn-count thresholds (flush at 20, rotate at 30) with token-aware condensation. When the conversation context approaches the limit, automatically summarize older messages while keeping recent ones and system prompts.

**Implementation**: Estimate tokens from `buildIdentityPreamble()` output length. When `estimatedTokens > maxBudget * 0.8`, trigger early flush. The `keep_first` parameter ensures system context is never dropped.

**File**: `src/discord/session-context.ts`
**Effort**: ~50 lines.

---

### Tier 3: Consider Later (moderate value, higher effort)

#### 11. Resumable Task Checkpoints
**Source**: LangGraph's three-table checkpoint model

Add a `task_checkpoints` table that saves intermediate state during multi-step task execution. Enables resume-from-checkpoint when tasks fail mid-execution instead of restarting from scratch.

```sql
CREATE TABLE task_checkpoints (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  step INTEGER NOT NULL,
  phase TEXT NOT NULL,        -- 'research', 'compile', 'archive', 'delivery'
  state_json TEXT NOT NULL,   -- serialized intermediate state
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Files**: `src/db.ts`, `src/discord/scheduled-tasks.ts`
**Effort**: ~150 lines + migration.

#### 12. Hybrid Speaker Routing for Discord
**Source**: AutoGen's SelectorGroupChat

Before spawning `claude -p` for a Discord message, run a deterministic classifier (regex/keyword) to route to specialized system prompts or tool sets. Only fall back to the general-purpose prompt for ambiguous requests.

```typescript
function classifyMessage(text: string): 'status' | 'task' | 'report' | 'general' {
  if (/status|how.*going|check/i.test(text)) return 'status';
  if (/create.*task|schedule|set up/i.test(text)) return 'task';
  if (/report|run.*report|generate/i.test(text)) return 'report';
  return 'general';
}
```

Each classification maps to a lighter, focused system prompt that reduces token usage.

**File**: `src/discord/bot.ts`
**Effort**: ~100 lines.

#### 13. Trigger-Based Skill Injection
**Source**: OpenHands' SKILL.md system, Cursor's subagent YAML

Instead of loading all skills into every prompt, detect keywords in user messages and only inject relevant skills. Show skill summaries by default, load full content on demand.

**File**: `src/discord/session-context.ts`, skill definition files
**Effort**: ~80 lines.

#### 14. Shadow Validation for Code Changes
**Source**: Cursor's shadow workspace

Before applying code changes from scheduled tasks or escalation, run `npm run build` (or `tsc --noEmit`) in a temporary context to validate changes compile cleanly. Only commit if validation passes.

**File**: `src/discord/scheduled-tasks.ts`
**Effort**: ~40 lines.

#### 15. Multi-Step Workflow Chaining
**Source**: MetaGPT's SOPs, CrewAI's Flows

New workflow type that chains multiple tasks with structured handoffs. Each step's output becomes the next step's input, validated against a schema.

```
workflow:daily-reports
steps:
  - template: daily-report (kag)
  - template: daily-report (banking)
  - template: rtx4090-hobby-report
parallel: false
on_failure: continue  # or abort
```

**Files**: New `src/workflows.ts`, `src/discord/scheduled-tasks.ts`
**Effort**: ~200 lines.

---

## Implementation Priority Matrix

```
                    HIGH VALUE
                        |
   [1] Context Assembly |  [6] Enhanced Playbooks
   [2] Past Executions  |  [7] Filter Pipeline
   [3] Git Checkpoint   |  [8] Output Schemas
   [4] Reflection Loop  | [11] Checkpoints
   [5] Task Budgets     | [15] Workflow Chains
                        |
  LOW EFFORT -----------+------------ HIGH EFFORT
                        |
  [10] Token Condense   |  [12] Speaker Routing
   [9] Watch/Subscribe  |  [13] Skill Injection
                        |  [14] Shadow Validation
                        |
                    LOW VALUE
```

## Sources

### Multi-Agent Frameworks
- [CrewAI docs](https://docs.crewai.com/) — Memory, Flows, Agents
- [AutoGen docs](https://microsoft.github.io/autogen/) — SelectorGroupChat, Code Executors, Human-in-the-Loop
- [LangGraph docs](https://docs.langchain.com/oss/python/langgraph/) — Checkpointing, Interrupts, Persistence
- [MetaGPT paper (ICLR 2024)](https://arxiv.org/html/2308.00352v6) — SOPs, structured artifacts
- [Semantic Kernel docs](https://learn.microsoft.com/en-us/semantic-kernel/) — Filter pipeline, Process Framework
- [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/) — AutoGen + SK convergence

### Coding Agents
- [OpenHands SDK paper](https://arxiv.org/html/2511.03690v1) — Event sourcing, Condenser, Skills
- [SWE-Agent paper (NeurIPS 2024)](https://arxiv.org/abs/2405.15793) — ACI design, edit-time linting
- [Aider repo map blog](https://aider.chat/2023/10/22/repomap.html) — tree-sitter + PageRank
- [Devin performance review 2025](https://cognition.ai/blog/devin-annual-performance-review-2025) — Playbooks, session analysis
- [Cursor indexing deep dive](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/) — Merkle trees, Preempt

### Autonomous Agents
- [Cline GitHub](https://github.com/cline/cline) — Checkpoint/rollback, auto-compact
- [AutoGPT GitHub](https://github.com/Significant-Gravitas/AutoGPT) — Self-criticism loop, Agent Protocol
- [BabyAGI](https://github.com/yoheinakajima/babyagi) — Minimal viable loop

---

*Last updated: 2026-03-27*

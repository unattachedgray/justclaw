# /postmortem — Incident postmortem multi-agent harness

Run a structured, blameless incident postmortem using specialized agents for each phase.

## Arguments

$ARGUMENTS — incident description, time range, or mode override (e.g., "Discord bot crash loop 2026-03-24 14:00-16:00", "timeline-only", "rca-only")

## Modes

| Mode | What runs | Use when |
|------|-----------|----------|
| **full** (default) | All 5 agents in sequence | Complete postmortem for a resolved incident |
| **timeline-only** | Timeline reconstructor only | Quick timeline for an ongoing or just-resolved incident |
| **rca-only** | Root cause investigator only | Timeline exists, need deeper analysis |
| **remediation-only** | Remediation planner only | RCA exists, need action plan |
| **review-only** | Postmortem reviewer only | All deliverables exist, need cross-validation and final report |

## Workflow

### Phase 1: Preparation

1. Create `_workspace/` directory if it doesn't exist
2. Parse the incident description from arguments
3. Determine mode (full pipeline or single-agent)
4. Check for existing deliverables in `_workspace/` (resume support)

### Phase 2: Agent Execution

**Full pipeline** runs agents in this order, respecting dependencies:

```
Step 1: timeline-reconstructor (no dependencies)
           ↓
Step 2: root-cause-investigator + impact-assessor (parallel, both need timeline)
           ↓
Step 3: remediation-planner (needs RCA + impact)
           ↓
Step 4: postmortem-reviewer (needs all four)
```

#### Step 1 — Timeline Reconstruction
Spawn the `timeline-reconstructor` agent with SendMessage:

> Reconstruct the incident timeline for: [incident description].
> Time range: [start] to [end] (or "determine from available data").
> Write your deliverable to `_workspace/01_timeline.md`.
> Consult all available data sources: PM2 logs, escalation history, monitor history, process registry, git log, conversation history, daily log, and system metrics.

Wait for completion. Verify `_workspace/01_timeline.md` exists.

#### Step 2 — Root Cause Analysis + Impact Assessment (parallel)
Spawn both agents simultaneously with SendMessage:

**To `root-cause-investigator`:**
> Analyze the root cause of this incident: [incident description].
> Read `_workspace/01_timeline.md` first.
> Apply 5 Whys, Fishbone analysis, and Fault Tree Analysis as appropriate.
> Reference `skills/rca-methodology/skill.md` for technique guidance.
> Write your deliverable to `_workspace/02_root_cause.md`.

**To `impact-assessor`:**
> Assess the quantitative impact of this incident: [incident description].
> Read `_workspace/01_timeline.md` first for duration and affected systems.
> Reference `skills/sla-impact-calculator/skill.md` for SLA/SLO calculations.
> Write your deliverable to `_workspace/03_impact_assessment.md`.

Wait for both to complete. Verify both deliverables exist.

#### Step 3 — Remediation Planning
Spawn the `remediation-planner` agent with SendMessage:

> Create a remediation plan for this incident: [incident description].
> Read these deliverables first:
> - `_workspace/01_timeline.md`
> - `_workspace/02_root_cause.md`
> - `_workspace/03_impact_assessment.md`
> Design remediations across all four Defense in Depth layers (prevention, detection, response, recovery).
> Create justclaw tasks for short-term action items.
> Write your deliverable to `_workspace/04_remediation_plan.md`.

Wait for completion. Verify deliverable exists.

#### Step 4 — Review and Integration
Spawn the `postmortem-reviewer` agent with SendMessage:

> Review and cross-validate the postmortem deliverables for this incident: [incident description].
> Read all deliverables in `_workspace/` (01 through 04).
> Run the verification checklist, cross-validate consistency, check blameless culture.
> Write your review to `_workspace/05_review_report.md`.
> Generate the integrated final report to `_workspace/postmortem_report.md`.

Wait for completion. Verify both deliverables exist.

### Phase 3: Final Report

1. Read `_workspace/postmortem_report.md`
2. Read `_workspace/05_review_report.md` for any RED findings
3. Present the executive summary to the user
4. List any RED findings that need attention
5. Save the postmortem to memory: `memory_save(key: "postmortem-<date>-<slug>")`
6. Log completion: `daily_log_add(category: "postmortem")`

## Resume Support

If `_workspace/` already contains deliverables from a previous run:
- Skip agents whose deliverables already exist (unless user says "re-run" or "fresh")
- Start from the first missing deliverable
- This allows resuming after a failure or running individual phases

## Error Handling

- If an agent fails, report the error and continue with remaining agents where possible
- If the timeline agent fails, stop the full pipeline (everything depends on it)
- If RCA or impact fail, remediation can still run with available data (note the gap)
- If review finds RED items, report them but still generate the integrated report as draft

## Example Usage

```
/postmortem Discord bot crash loop, 2026-03-24 14:00-16:00 UTC
/postmortem PM2 restart storm after SQLite migration
/postmortem timeline-only heartbeat escalation cascade this morning
/postmortem rca-only (assumes _workspace/01_timeline.md exists)
/postmortem review-only (assumes all 01-04 deliverables exist)
/postmortem full fresh — re-run everything from scratch
```

## Output

Present the final postmortem summary with:
- Incident title and severity
- Duration and key metrics (MTTD, MTTR)
- Root cause (one sentence)
- Top 3 action items
- Link to full report: `_workspace/postmortem_report.md`
- Any RED review findings that need human attention

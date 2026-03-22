# /build — Autonomous build orchestration

PRD-driven build loop with plan verification and quality gates. Combines ralph's fresh-context-per-story approach with GSD's structured plan verification.

## Arguments

$ARGUMENTS — path to a PRD file (markdown), or inline description of what to build. If empty, ask what to build.

## Phase 1: Parse Requirements

If given a PRD file, read it and extract:
- **Stories**: Each `## Story` or `## Task` section becomes a work item
- **Acceptance criteria**: Bullet points under each story
- **Dependencies**: Stories that must complete before others

If given an inline description, create a minimal PRD:
- Break into 1-5 stories based on logical boundaries
- Each story gets clear acceptance criteria
- Order by dependencies

Output the parsed plan for user approval before proceeding.

## Phase 2: Plan Verification (inspired by GSD)

Before executing, verify the plan against 5 dimensions:

| Dimension | Check |
|-----------|-------|
| **Completeness** | Does every acceptance criterion map to at least one story? |
| **Feasibility** | Can each story be done with available tools and within file size limits? |
| **Independence** | Can stories be worked on without conflicting file edits? |
| **Testability** | Does each story have a concrete way to verify completion? |
| **Order** | Are dependencies correctly sequenced? |

If any dimension fails, revise the plan and re-verify.

## Phase 3: Execute Stories

For each story, in dependency order:

1. **Start fresh**: Read only the files relevant to this story (not the whole codebase)
2. **Implement**: Follow the feature-dev hat process (test first, match patterns, size limits)
3. **Quality gate**: Before moving to next story:
   - `npm run build` passes
   - `npm test` passes
   - New/changed files are within size limits (500 lines/file, 50 lines/function)
   - Acceptance criteria are met
4. **Record**: Log completion with what was done, files changed, tests added

If a story fails its quality gate:
- Retry once with a different approach
- If still failing, pause and report to user with the specific failure

## Phase 4: Integration Check

After all stories complete:
1. Full build: `npm run build`
2. Full test suite: `npm test`
3. Size audit: Check all modified files are within limits
4. Doc check: Update DEVELOPMENT.md and CLAUDE.md if needed

## Phase 5: Report

```
## Build Report

### Stories Completed
| # | Story | Status | Files Changed | Tests Added |
|---|-------|--------|--------------|-------------|

### Quality Gates
- Build: PASS/FAIL
- Tests: {passed}/{total}
- Size limits: PASS/FAIL
- Docs updated: YES/NO

### Learnings
- {what went well}
- {what was harder than expected}
- {what to do differently next time}
```

## Guidelines

- **One story at a time** — don't parallelize unless stories are truly independent
- **Fresh context per story** — re-read files at the start of each story, don't rely on stale state
- **Fail fast** — if a story is blocked, stop and ask rather than guessing
- **No heroics** — if a story is taking more than 3 attempts, escalate to user
- **Size discipline** — the 500/50 limits are hard. Split files proactively.

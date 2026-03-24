# /dev — Structured development lifecycle

Seven-phase development process inspired by Garry Tan's gstack methodology, adapted for Claude Code with justclaw persistence. Each phase has a distinct role and output that feeds the next.

**Core principle**: Process enables speed. Skipping phases creates rework. Following them lets you ship faster by catching issues early instead of debugging them late.

## Arguments

$ARGUMENTS — `<mode> <description>`

**Modes:**
| Mode | When to Use | Phase Emphasis |
|------|-------------|----------------|
| `new <description>` | Building new functionality from scratch | Full 7-phase cycle, heavy on Think+Plan |
| `fix <bug description>` | Fixing a specific bug | Think=Investigate, Plan=Hypothesis, Build=Minimal fix |
| `refactor <area>` | Restructuring without behavior change | Think=Understand current, Plan=Design target, Test=Verify equivalence |
| `debug <symptom>` | Investigating unknown issues | Think=Reproduce+Isolate, Plan=Root cause, Build=Fix |

If no mode specified, infer from context. If ambiguous, ask.

## Phase 1: THINK (Role: Product Analyst)

**Goal**: Understand the problem deeply before writing any code. The most common failure mode is solving the wrong problem.

### For `new`:
1. **Challenge assumptions** — Ask 3 forcing questions:
   - "What's the simplest version that delivers value?" (scope check)
   - "Who uses this and how do they discover it?" (user journey)
   - "What breaks if we DON'T build this?" (priority check)
2. **Search for prior art** — Check if something similar exists in the codebase:
   - `Grep` for related patterns, function names, feature flags
   - Read existing code in the area — what patterns does it follow?
3. **Identify constraints** — System limits that shape the solution:
   - 500 lines/file, 50 lines/function
   - 6.7GB RAM, HDD storage, single-user
   - Existing patterns and conventions in the codebase

### For `fix` / `debug`:
1. **Reproduce** — Get the exact error. Read logs, check stack traces, run the failing case.
   - `git log --oneline -10` for recent changes that might have caused it
   - Check DB state if relevant (`sqlite3 data/charlie.db`)
2. **Isolate** — Narrow to the smallest reproducing case. Which file? Function? Input?
3. **Gather evidence** — Read the actual code paths involved, not just the error message.

### For `refactor`:
1. **Map the current state** — Read all files in the refactor area. Document:
   - What each module does (one sentence)
   - Data flow between modules
   - Pain points (what makes this hard to work with?)
2. **Identify the target state** — What should this look like after refactoring?
3. **Define equivalence** — What existing tests prove the behavior is unchanged?

**Output**: A `## Think` summary block posted before proceeding. Wait for user confirmation on `new` mode. Proceed automatically for `fix`/`debug`/`refactor`.

---

## Phase 2: PLAN (Role: Architect)

**Goal**: Design the solution before touching code. Plans are cheap; rewrites are expensive.

Wear the **Architect** hat mindset (think in boundaries, interfaces, data flow).

### For all modes:
1. **File change list** — Every file that will be created, modified, or deleted:
   ```
   | File | Action | What Changes |
   |------|--------|-------------|
   | src/foo.ts | Modify | Add bar() function (~20 lines) |
   | tests/foo.test.ts | Create | Tests for bar() (3 cases) |
   ```

2. **Test strategy** — What tests verify this works:
   - New tests to write (with descriptions)
   - Existing tests that must still pass
   - Edge cases to cover

3. **Risk assessment** — What could go wrong:
   - Breaking changes to existing behavior?
   - Performance impact?
   - Files approaching size limits?

### For `fix` / `debug`:
4. **Root cause hypothesis** — Write down exactly one theory about the cause and how to verify it.

### For `new`:
4. **Alternatives considered** — At least one other approach and why it was rejected.

**Output**: A `## Plan` block. For `new` and `refactor`, wait for user approval. For `fix`/`debug`, proceed unless the plan involves >5 files.

---

## Phase 3: BUILD (Role: Feature Developer)

**Goal**: Implement the plan. Follow existing patterns. One change at a time.

Wear the **Feature Dev** hat mindset (read before write, match patterns, test first).

### Process:
1. **Test first** (for `new` and `refactor`):
   - Write a failing test that captures the expected behavior
   - Run it to confirm it fails for the right reason

2. **Implement**:
   - Follow the file change list from Phase 2 in order
   - Match existing code style and patterns exactly
   - Keep functions <50 lines, files <500 lines
   - Add comments only for WHY, never WHAT

3. **Incremental verification**:
   - After each file change: `npx tsc --noEmit` (type check)
   - After logical group of changes: `npm test` (regression check)

4. **For `fix`/`debug`**:
   - Make the MINIMAL change that fixes the root cause
   - Add a regression test that would have caught this bug
   - Do NOT refactor surrounding code — that's a separate `/dev refactor`

**Output**: Working code with passing type checks. Log what was built.

---

## Phase 4: REVIEW (Role: Code Reviewer)

**Goal**: Catch bugs before they ship. Every bug you miss costs 10x to fix later.

Wear the **Code Reviewer** hat mindset (read line by line, assume edge cases were missed).

### Self-review checklist:
Run through every change from Phase 3:

- [ ] **Correctness**: Does it do what it claims? Edge cases handled?
- [ ] **Safety**: No SQL interpolation, no command injection, no `any` types?
- [ ] **Error handling**: Errors caught, contextualized, and surfaced?
- [ ] **Size limits**: Functions <50, files <500?
- [ ] **Tests**: New code paths tested? Existing tests still pass?
- [ ] **Performance**: No O(n^2) loops, no unbounded queries?
- [ ] **Secrets**: No hardcoded tokens or credentials?

### Fix issues found:
- **Must Fix**: Correctness bugs, safety issues — fix NOW before proceeding.
- **Should Fix**: Error handling, edge cases — fix NOW, they compound.
- **Nits**: Style, naming — only fix if trivial (<1 min).

**Output**: A `## Review` block with findings and any fixes applied. If Must Fix issues were found and fixed, re-run the review.

---

## Phase 5: TEST (Role: QA Engineer)

**Goal**: Verify everything works. Trust tests, not vibes.

### Process:
1. **Full build**: `npm run build` — must pass clean.
2. **Full test suite**: `npm test` — must pass with 0 failures.
3. **New test coverage**: Verify tests from Phase 3 are passing.
4. **Manual verification** (where applicable):
   - For Discord bot changes: describe how to manually verify
   - For MCP tools: test via the tool directly
   - For scheduled tasks: describe expected behavior
5. **Regression check**: Run any tests related to the area of change.

### If tests fail:
- Read the error carefully — is it in your new code or existing code?
- Fix the root cause, don't just make the test pass.
- If an existing test fails due to intentional behavior change, update the test AND document why.
- Go back to Phase 3 (Build) if significant changes needed.

**Output**: Test results summary:
```
Build: PASS/FAIL
Tests: {passed}/{total} passing
New tests: {count} added
Coverage: {areas covered}
```

---

## Phase 6: SHIP (Role: Release Engineer)

**Goal**: Get the change committed cleanly.

### Process:
1. **Stage changes**: Stage only the files from the plan. Don't accidentally include unrelated changes.
   ```
   git add src/specific-file.ts tests/specific-file.test.ts
   ```
2. **Final diff review**: `git diff --cached` — read every line one more time.
3. **Commit message**: Follow the project convention:
   - Imperative mood: "Add session persistence" not "Added session persistence"
   - First line <70 chars: what and why
   - Body (if needed): context, rationale, what alternatives were considered
4. **Post-commit**: Verify the commit looks right with `git log -1 --stat`.

### DON'T do automatically:
- `git push` — wait for user to request
- `pm2 restart` — wait for user to request
- Any destructive operation — always confirm

**Output**: Commit SHA and summary of what shipped.

---

## Phase 7: REFLECT (Role: Engineering Lead)

**Goal**: Learn from the work. Future sessions should be smarter because of this one.

### Process:
1. **Log the work**: `mcp__justclaw__daily_log_add` with a summary of what was done.
2. **Save learnings**: If anything was surprising, non-obvious, or went wrong:
   - `mcp__justclaw__learning_add` with category, trigger, lesson, area
3. **Update docs**: If behavior changed, update the relevant docs:
   - `CLAUDE.md` for behavior/architecture changes
   - `docs/SCHEMA.md` for database changes
   - `docs/DISCORD-BOT.md` for bot behavior changes
4. **Create follow-up tasks**: If you noticed things that need attention but aren't part of this change:
   - `mcp__justclaw__task_create` with clear description

### Report:
```
## Dev Report

### What was done
{1-3 sentence summary}

### Files changed
| File | Change |
|------|--------|
| ... | ... |

### Tests
{passed}/{total} — {new tests added}

### Learnings
- {what went well}
- {what was harder than expected}
- {what to do differently}

### Follow-up
- {any tasks created for later}
```

---

## Phase Flow by Mode

### `/dev new <feature>`
```
THINK ──[user confirms]──> PLAN ──[user confirms]──> BUILD ──> REVIEW ──> TEST ──> SHIP ──> REFLECT
```

### `/dev fix <bug>`
```
THINK(investigate) ──> PLAN(hypothesis) ──> BUILD(minimal fix) ──> REVIEW ──> TEST ──> SHIP ──> REFLECT
```
Auto-proceeds between phases unless plan involves >5 files.

### `/dev debug <symptom>`
```
THINK(reproduce+isolate) ──> PLAN(root cause) ──> BUILD(fix) ──> REVIEW ──> TEST ──> SHIP ──> REFLECT
```
Same as fix but Think phase is more exploratory. May loop back from Plan to Think if hypothesis is disproven.

### `/dev refactor <area>`
```
THINK(map current) ──[user confirms]──> PLAN(design target) ──[user confirms]──> BUILD ──> REVIEW ──> TEST(equivalence) ──> SHIP ──> REFLECT
```
Extra confirmation gates because refactors have high blast radius.

## Guidelines

- **Never skip phases** — Even for "simple" changes. A 30-second Think phase has saved hours of debugging.
- **Phase output is the checkpoint** — If context is lost (compaction, restart), the last phase output tells you where to resume.
- **One `/dev` cycle per logical change** — Don't batch unrelated work into one cycle.
- **Escalate, don't thrash** — If Build fails 3 times, go back to Plan. If Plan fails, go back to Think. If Think fails, ask the user.
- **The plan is a living document** — If Build reveals something Plan missed, update the plan, don't ignore it.
- **Deterministic first** — If verification can be a script or test, don't rely on manual checking.

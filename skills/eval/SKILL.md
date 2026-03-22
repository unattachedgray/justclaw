# /eval — Run skill evaluations

Test skills against predefined cases to catch regressions and verify quality.

## Arguments

$ARGUMENTS — skill name to evaluate (e.g., `security-audit`, `hats`). If empty, run all evals.

## How It Works

1. **Find test cases**: Look in `.evals/{skill-name}/` for `*.eval.md` files.
2. **Run each case**: Execute the skill with the test input.
3. **Grade results**: Check output against expected patterns.
4. **Report**: Summary table with pass/fail per case.

## Test Case Format

Each `.eval.md` file:

```markdown
---
name: descriptive-test-name
skill: skill-name
input: "the input or arguments to pass to the skill"
timeout: 30
---

## Expected

- [ ] Output contains: "specific phrase or pattern"
- [ ] Output matches regex: /pattern/
- [ ] File created: path/to/expected/file
- [ ] File contains: "content that should be in the file"
- [ ] No errors in output
- [ ] Exit code: 0

## Context

Why this test exists and what regression it guards against.
```

## Grading

| Check Type | How It's Verified |
|-----------|-------------------|
| `Output contains` | Substring match in skill output |
| `Output matches regex` | Regex test against output |
| `File created` | `Glob` for the path |
| `File contains` | `Read` + substring match |
| `No errors` | No "Error", "FAIL", "Exception" in output |
| `Exit code` | Process exit code check |

## Output

```
## Eval Results: {skill-name}

| Test | Result | Details |
|------|--------|---------|
| {name} | PASS/FAIL | {which checks passed/failed} |

Summary: {passed}/{total} passing
Regressions: {list of tests that previously passed but now fail}
```

## Creating Evals for a New Skill

1. Create `.evals/{skill-name}/` directory
2. Add at least 3 test cases:
   - **happy-path.eval.md** — normal usage with expected output
   - **edge-case.eval.md** — unusual input, boundary conditions
   - **error-handling.eval.md** — invalid input, missing dependencies
3. Run `/eval {skill-name}` to verify tests pass
4. Commit the eval files alongside the skill

## Notes

- Evals run in the current working directory — they can read/write files
- Timeout default is 60 seconds per test case
- Tests that depend on external services (web, APIs) should be tagged `# requires: network`
- Grading is deterministic (pattern matching) — no LLM grading to keep evals fast and reproducible

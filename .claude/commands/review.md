# /review — Pre-commit self-review checklist

Run through a quality checklist before committing changes. Catches common issues that slip through during rapid development.

## Checklist (check each item)

### Size limits
- [ ] No file exceeds 500 lines
- [ ] No function exceeds 50 lines
- [ ] Each module does one thing (describable in one sentence)

### Safety
- [ ] No SQL interpolation (all queries parameterized)
- [ ] No `execSync` without timeout
- [ ] No silent error swallowing (`catch {}` has explanatory comment)
- [ ] No secrets in committed files
- [ ] No `any` types

### Error handling
- [ ] Errors have context added at each layer
- [ ] Boundary validation on external input (Discord messages, MCP tool args)
- [ ] Structured logging for errors (`log.error('msg', { key: value })`)

### Process management
- [ ] New PIDs registered in process_registry
- [ ] PIDs retired on process exit
- [ ] No heuristic process killing (grep patterns)
- [ ] Kill operations have identity verification

### Documentation
- [ ] CLAUDE.md updated if behavior changed
- [ ] New files have architecture comment at top
- [ ] Comments explain WHY, not WHAT
- [ ] TODOs have dates

### Testing
- [ ] Existing tests still pass (`npm test`)
- [ ] New functionality has at least basic coverage
- [ ] Edge cases considered (null/undefined, empty arrays, concurrent access)

## Process

1. Read `git diff --cached` (or `git diff` if not staged yet)
2. Check each item in the list above
3. Report any violations found
4. Fix CRITICAL violations before committing
5. Log MEDIUM/LOW violations as tasks for later

## Output

```
✅ Size limits: OK
✅ Safety: OK
⚠️ Error handling: catch on line 45 of bot.ts swallows error silently
✅ Process management: OK
⚠️ Documentation: CLAUDE.md not updated for new feature
✅ Testing: 55/55 pass
```

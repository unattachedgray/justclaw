---
name: happy-path-fix
skill: dev
input: "fix the coalesceMessages function doesn't handle empty message arrays"
timeout: 120
---

## Expected

- [ ] Output contains: "## Think"
- [ ] Output contains: "Reproduce"
- [ ] Output contains: "## Plan"
- [ ] Output matches regex: /root cause|hypothesis|cause/i
- [ ] No errors in output

## Context

Verifies /dev fix mode emphasizes investigation in Think phase and forms a hypothesis in Plan. Fix mode should auto-proceed without user confirmation.

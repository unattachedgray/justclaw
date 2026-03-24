---
name: phase-commands
skill: dev-think
input: "the heartbeat check for stale processes sometimes misses processes that started between checks"
timeout: 60
---

## Expected

- [ ] Output contains: "Think"
- [ ] Output matches regex: /reproduce|isolat|evidence|constraint/i
- [ ] Output does not contain: "## Plan"
- [ ] Output does not contain: "## Build"
- [ ] No errors in output

## Context

Verifies /dev-think runs ONLY Phase 1 and stops. Should not proceed to Plan or Build phases.

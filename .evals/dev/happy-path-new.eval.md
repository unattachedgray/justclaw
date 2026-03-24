---
name: happy-path-new
skill: dev
input: "new add a health check endpoint to the dashboard that returns JSON with uptime and version"
timeout: 120
---

## Expected

- [ ] Output contains: "## Think"
- [ ] Output contains: "## Plan"
- [ ] Output contains: "File"
- [ ] Output contains: "Test"
- [ ] Output matches regex: /Phase [1-7]/
- [ ] No errors in output

## Context

Verifies the full /dev new flow produces Think and Plan phases with file change lists and test strategy. The skill should pause for confirmation after Think and Plan phases.

---
name: invalid-hat-name
skill: hats
input: "nonexistent-hat"
timeout: 30
---

## Expected

- [ ] Output contains: "not found"
- [ ] Output contains: "available"
- [ ] No errors in output

## Context

Invalid hat name should show error and list available options.

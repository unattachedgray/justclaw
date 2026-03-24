---
name: no-args
skill: dev
input: ""
timeout: 30
---

## Expected

- [ ] Output matches regex: /mode|what.*build|what.*fix|describe|what would you like/i
- [ ] No errors in output

## Context

When /dev is invoked with no arguments, it should ask what mode/task the user wants. Should NOT crash or proceed with empty input.

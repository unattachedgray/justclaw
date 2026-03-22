# /newskill — Research, audit, and build a new skill

Build a new skill by researching how popular projects and Claude Code plugins handle the same problem, auditing them for security, then synthesizing the best patterns into a custom justclaw skill.

## Arguments

$ARGUMENTS — optional description of the skill needed (e.g., "database migration manager", "PR review automation", "deployment pipeline"). If empty, start the interactive questionnaire.

## Phase 1: Requirements Gathering

If no arguments provided, ask these questions (2-3 at a time, don't dump all at once):

1. **What problem does this skill solve?** — What task do you find yourself doing repeatedly or wishing was automated?
2. **What triggers it?** — Slash command only? Automatic on certain events? Scheduled?
3. **What tools does it need?** — File operations? Web access? Bash commands? MCP tools? External APIs?
4. **What's the output?** — Files created? Messages sent? Tasks created? Reports generated?
5. **Any existing tools or scripts you've seen that do something similar?** — URLs, project names, npm packages?

Synthesize answers into a one-paragraph skill brief before proceeding.

## Phase 2: Research — Find Popular Implementations

Search for 5-10 existing implementations across these sources:

```
WebSearch: "{skill topic} claude code skill"
WebSearch: "{skill topic} MCP server plugin"
WebSearch: "{skill topic} automation tool github stars:>100"
WebSearch: "{skill topic} CLI tool best 2025 2026"
WebSearch: "awesome {skill topic} github"
```

For each promising result:
1. `WebFetch` the README to understand the approach
2. Note: architecture, key features, dependencies, popularity (stars/downloads)
3. If it's a Claude Code skill or MCP server, fetch the main skill/tool definition

Compile a **research table**:

| # | Project | Stars | Approach | Key Features | Dependencies | Security Risk |
|---|---------|-------|----------|--------------|-------------|---------------|

## Phase 3: Security Audit

For each candidate implementation, check for:

### Critical (auto-reject if found)
- **Command injection**: Does it interpolate user input into shell commands without sanitization?
- **Credential exposure**: Does it log, store, or transmit API keys/tokens insecurely?
- **Arbitrary code execution**: Does it `eval()`, `Function()`, or `vm.runInNewContext()` with user input?
- **Supply chain risk**: Does it depend on packages with <100 weekly downloads or no maintainer?
- **Network exfiltration**: Does it send data to external servers without user consent?

### Warning (note but don't reject)
- **Excessive permissions**: Does it request more tool access than needed?
- **No input validation**: Does it trust all inputs without checking?
- **Unbounded operations**: Can it fill disk, spawn unlimited processes, or run forever?
- **Stale dependencies**: Are dependencies outdated with known CVEs?

### Output a security report:

```
## Security Audit: {project name}
- Command injection: PASS/FAIL — {detail}
- Credential handling: PASS/FAIL — {detail}
- Code execution: PASS/FAIL — {detail}
- Supply chain: PASS/WARN — {detail}
- Network safety: PASS/FAIL — {detail}
- Permission scope: OK/EXCESSIVE — {detail}
- Input validation: OK/MISSING — {detail}
- Resource bounds: OK/UNBOUNDED — {detail}
Overall: SAFE / CAUTION / REJECT
```

## Phase 4: Design — Combine Best Patterns

From the safe implementations, extract the best patterns:

1. **What do the top 3 projects have in common?** — These are proven patterns, adopt them.
2. **What unique feature does the #1 project have?** — Consider adopting if it fits justclaw.
3. **What's missing from all of them?** — This is our differentiation opportunity.
4. **What security improvements can we add?** — Input validation, resource limits, permission scoping.

Design the skill with:
- **Minimal dependencies**: Prefer built-in Node.js/Claude Code capabilities over npm packages
- **Scoped permissions**: Only request the tools the skill actually needs
- **Bounded operations**: Timeouts, size limits, rate limits where applicable
- **justclaw integration**: Use MCP tools (memory_save, task_create, daily_log_add) for persistence
- **Deterministic first**: If it can be a script, don't use an LLM call

## Phase 5: Build

Create the skill files:

1. **`skills/{skill-name}/SKILL.md`** — The skill definition with:
   - YAML frontmatter (name, description, triggers)
   - Clear step-by-step instructions
   - Input/output specification
   - Error handling guidance
   - Examples

2. **Supporting files** (if needed):
   - Scripts in `scripts/` for deterministic operations
   - Agent definitions in `.claude/agents/` for specialized agents
   - Hat definitions in `hats/` for focused personas

3. **Test cases** (if the skill is complex):
   - Create `.evals/{skill-name}/` with test cases
   - At minimum: happy path, edge case, error handling

## Phase 6: Register & Document

1. Add the skill to `CLAUDE.md` skills table
2. Add to `DEVELOPMENT.md` completed items
3. Save a memory with `memory_save(key: "skill-{name}-design", type: "architecture")` documenting the design decisions
4. Log with `daily_log_add(category: "skill", entry: "Created {skill-name} skill: {brief description}")`
5. Report to user: what was built, what was adopted from research, what security measures were added

## Guidelines

- **Don't blindly copy**: Extract patterns and rebuild from scratch. Our code, our style, our security model.
- **Audit everything**: No external code enters justclaw without security review.
- **Stay lean**: A 50-line skill that works beats a 500-line framework that might work.
- **Document rationale**: Future sessions need to know WHY we built it this way and what alternatives were considered.
- **Test before shipping**: Run the skill at least once before declaring it done.

# /adr — Create an Architecture Decision Record

Create a new ADR in `docs/decisions/` documenting a significant architectural decision.

## Arguments

$ARGUMENTS — brief title of the decision (e.g., "use SQLite over Postgres", "deterministic heartbeat")

## Process

1. Find the next ADR number: `ls docs/decisions/ | sort -n | tail -1`
2. Create `docs/decisions/NNN-<slug>.md` with this template:

```markdown
# ADR-NNN: <title>

**Status**: proposed | accepted | deprecated | superseded by ADR-XXX
**Date**: <today>

## Context
What is the situation? What forces are at play? What problem are we solving?

## Decision
What did we decide? Be specific about the approach chosen.

## Consequences
**Positive**: what's better now?
**Negative**: what's the trade-off?

## Alternatives considered
What other approaches did we evaluate and why did we reject them?
```

3. Fill in the template based on the current conversation context.
4. Git commit the ADR.
5. If the decision affects CLAUDE.md, update the relevant section.

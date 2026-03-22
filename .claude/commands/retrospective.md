# /retrospective — Analyze recent work and extract learnings

Review recent git history, escalation logs, heartbeat results, and conversation history to identify patterns, recurring issues, and improvement opportunities.

## Process

1. **Review recent changes** — `git log --oneline -20` + `git diff HEAD~5` to see what was built/changed recently.

2. **Check escalation history** — call `system_escalation_history` MCP tool. Are there recurring issues? Failed escalations? Recommendations not yet implemented?

3. **Check system_recommendations** — call `system_recommendations` MCP tool. What improvements have been suggested but not done?

4. **Check task list** — call `task_list` for pending/stuck tasks. Anything overdue?

5. **Analyze patterns**:
   - What problems keep recurring? (indicates missing deterministic check)
   - What escalations succeeded? (can we make them deterministic?)
   - What escalations failed? (do we need a different approach?)
   - What was the biggest time sink? (can we automate it?)

6. **Generate ADR** (Architecture Decision Record) for any significant decisions made:
   ```
   ## ADR-NNN: <title>
   **Status**: accepted
   **Context**: what was the situation?
   **Decision**: what did we decide?
   **Consequences**: what are the trade-offs?
   ```

7. **Update philosophy** — if new principles emerged from this work, add them to the development philosophy in CLAUDE.md and auto-memory.

8. **Create tasks** — add improvement opportunities to the task list with appropriate priorities.

## Output

- Summary of what was accomplished
- Recurring patterns identified
- ADRs for significant decisions
- New tasks created for improvements
- Updated philosophy if applicable

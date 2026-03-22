---
name: context-flush
description: Pre-compaction memory flush. Saves current context state to SQLite before context window compacts.
user-invocable: true
allowed-tools: justclaw
---

Perform a context flush NOW. This preserves your current state before context compaction.

1. Summarize what you were working on, what decisions were made, and what needs to happen next
2. List any key facts or discoveries from this session
3. Note which task IDs are currently active
4. Call `context_flush()` with all of this information
5. Call `daily_log_add()` with a brief summary

Use session ID: `${CLAUDE_SESSION_ID}`

Do NOT skip any of these steps. The next session depends on this snapshot to maintain coherence.

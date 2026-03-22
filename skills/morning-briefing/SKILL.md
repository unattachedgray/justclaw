---
name: morning-briefing
description: Daily morning briefing. Reviews pending tasks, recent conversations, and plans the day.
user-invocable: true
allowed-tools: justclaw
---

Run Charlie's morning briefing:

1. Call `context_restore()` — what was happening last session?
2. Call `task_list()` — what's pending?
3. Call `conversation_history(limit: 20)` — any unanswered messages?
4. Call `daily_log_get()` for yesterday's date — what happened yesterday?
5. Call `memory_search(query: "urgent OR important OR deadline")` — any time-sensitive memories?

Compile this into a concise briefing:
- **Yesterday summary**: Key accomplishments and unfinished items
- **Pending tasks**: Ordered by priority, with any that are overdue highlighted
- **Unread messages**: Any Discord messages that need a response
- **Today's focus**: Recommend 1-3 things to prioritize

Log the briefing with `daily_log_add(entry: <briefing summary>, category: "briefing")`.

If there are unanswered Discord messages, respond to them now.

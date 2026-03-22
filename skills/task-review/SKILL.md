---
name: task-review
description: Review and work on pending tasks. Pick the highest-priority task and make progress.
user-invocable: true
allowed-tools: justclaw
---

Run a task work session:

1. Call `context_restore()` — resume prior context
2. Call `task_next()` — get highest-priority pending task (auto-marks it active)
3. If no tasks: call `daily_log_add("No pending tasks", "task")` and stop
4. Work on the task. Use all available tools and context.
5. When done: call `task_complete(id, result)` with a summary of what was accomplished
6. If blocked: call `task_update(id, status: "blocked", result: <explanation>)` and try the next task
7. Call `context_flush()` with session summary before finishing

Repeat steps 2-6 until you run out of tasks or time.

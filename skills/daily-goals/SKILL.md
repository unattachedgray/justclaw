# Daily Goal-Driven Task Generation

Scheduled skill that generates actionable tasks from user goals each morning.

## When It Runs

Automatically via recurring task (`cron:0 8 * * 1-5` — weekday mornings at 8am).
Can also be triggered manually.

## Process

1. **Read goals**: Call `goal_list()` to get all active goals.
2. **Check recent activity**: Call `task_list(status: 'completed')` for tasks completed in last 48h.
3. **Check pending work**: Call `task_list()` for existing pending/active tasks.
4. **Read recent learnings**: Call `learning_search(limit: 5)` for recent lessons to avoid repeating mistakes.
5. **Generate 3-5 tasks**: For each active goal without recent progress, generate 1-2 concrete tasks that advance it.

## Task Generation Rules

- **Concrete**: Each task must have a clear, verifiable outcome. "Review code" is bad. "Review and fix the 3 TypeScript errors in heartbeat-checks.ts" is good.
- **Appropriately sized**: Each task should be completable in 15-60 minutes.
- **Priority-aligned**: Task priority matches goal priority. P1 goals get P2 tasks, P3 goals get P3 tasks.
- **Non-duplicate**: Don't create tasks that overlap with existing pending tasks.
- **Tagged**: All auto-generated tasks get `tags: 'auto-generated'`.
- **Medium priority**: Default `priority: 3` so they don't outrank user-created work.
- **Max 5 per day**: Never generate more than 5 tasks per cycle.

## Output

Post a brief summary to Discord:

```
📋 Daily Goals Check
- Goal "ship-v1": Created task "Write npm publish script" (P2)
- Goal "improve-docs": No new tasks — 2 pending tasks already exist
- Goal "learn-rust": Created task "Complete chapter 4 exercises" (P3)
3 new tasks created. 6 total pending.
```

## Setup

To enable daily task generation, create the recurring task:

```
task_create(
  title: "Daily goal review",
  description: "Read and follow skills/daily-goals/SKILL.md",
  recurrence: "cron:0 8 * * 1-5",
  due_at: "2026-03-23 08:00:00",
  priority: 2
)
```

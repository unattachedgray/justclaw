---
paths: ["src/dashboard/**", "ecosystem.config.cjs"]
description: Dashboard web control plane — API endpoints, monitors, auth, widgets
---

# Dashboard

Web control plane at `http://localhost:8787` (password: `DASHBOARD_PASSWORD`, default `88888888`). Sessions survive restarts. Tab bar shows token sparkline, agent throughput, Claude Code stats. Overview: work queue, heatmap (EDT), monitor status grid, agent intelligence (learnings/goals/memory), sessions, system resources graph. 7 default monitors: dashboard uptime, disk, RAM, Discord bot, GitHub, Bitcoin, Anthropic status.

Full reference (API endpoints, monitors, auth): @docs/DASHBOARD.md

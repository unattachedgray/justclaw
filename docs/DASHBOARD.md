# Dashboard

Web control plane at `http://localhost:8787`. Password-protected with sessions that survive restarts.

## Tab Bar Stats (always visible)

- Token usage sparkline (7d)
- Agent throughput: runs today, avg duration, success %
- Claude Code stats: sessions (7d), total tokens, cache hit %, API equivalent cost

## Overview Panels

- **Work Queue** — pending/active tasks with priority
- **Scheduled Tasks** — recurring tasks with cron schedules
- **Memories** — searchable memory list (FTS5)
- **Recent Conversations** — latest messages across channels
- **Recent Alerts** — heartbeat escalation alerts
- **Daily Log** — activity journal entries
- **Activity Heatmap** — 7-day hour-by-hour grid (EDT, log scale)
- **Monitor Status** — colored pills per monitor (ok/alert/critical/unknown)
- **Agent Intelligence** — learnings feed + goals progress + memory namespace distribution
- **Claude Code Sessions** — recent sessions with tokens/cache/cost

## API Endpoints

Auth-required unless noted.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/status` | GET | Quick overview: pending tasks, counts, last snapshot |
| `/api/tasks` | GET | Task list with status/priority filters |
| `/api/scheduled-tasks` | GET | Recurring tasks only |
| `/api/memories` | GET | Memory search (FTS5) with optional query param |
| `/api/conversations` | GET | Chat history (filterable by channel) |
| `/api/daily-log` | GET | Activity log for a date |
| `/api/metrics` | GET | System resources, agent runs, trends, services |
| `/api/heatmap` | GET | Activity heatmap data (EDT-adjusted) |
| `/api/token-usage` | GET | Token counts and trends (7d) |
| `/api/agent-throughput` | GET | Runs today, avg duration, success/fail |
| `/api/monitors-status` | GET | All monitors with current status |
| `/api/learnings` | GET | Recent learnings with category stats |
| `/api/goals` | GET | Active goals with task progress |
| `/api/memory-breakdown` | GET | Memory distribution by namespace/type |
| `/api/claude-sessions` | GET | Claude Code CLI sessions with usage |
| `/api/claude-usage` | GET | Token usage by day |
| `/api/conversations/send` | POST | Send message via claude -p |
| `/api/processes` | GET | PID status (MCP server, dashboard) |
| `/api/processes/kill` | POST | Kill a PID (SIGTERM) |
| `/api/actions/build` | POST | Run `npm run build` |
| `/api/webhook` | POST | Accept external webhook messages |
| `/api/events` | GET | Server-Sent Events (SSE) for live updates |
| `/api/extension-*` | * | Browser extension bridge (auth-free) |
| `/api/usage-calibration` | * | Claude usage data from extension (auth-free) |
| `/api/extension-status` | GET | Extension connection check (auth-free) |

## Default Monitors

Created on setup, checked by heartbeat every 5 min.

| Monitor | Source | Alert condition |
|---------|--------|-----------------|
| `dashboard-uptime` | HTTP localhost:8787 | Status != 200 |
| `disk-usage` | `df /` | > 85% |
| `memory-usage` | `free` | > 85% |
| `discord-bot` | PM2 status | Not "online" |
| `github-repo` | GitHub API | Status > 299 |
| `bitcoin-price` | CoinGecko BTC/USD | > 5% change |
| `claude-ai-status` | Anthropic status page | Incident active |

## Authentication

- Password: env var `DASHBOARD_PASSWORD` (default `88888888`)
- Sessions: HMAC-SHA256 signed, 7-day expiry, survive restarts
- Cookie: `justclaw_session`, HttpOnly, SameSite=Lax

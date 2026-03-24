# /monitor — Configurable metric watchers with alerts

Create monitors that periodically check URLs or run shell commands, extract values, evaluate conditions, and alert you on Discord when something changes or crosses a threshold. All checks run automatically during heartbeat cycles at zero LLM cost.

## Arguments

$ARGUMENTS — `<command> [args]`

**Commands:**

| Command | Usage | What it does |
|---------|-------|-------------|
| `create` | `/monitor create <name> ...` | Create a new monitor (interactive) |
| `list` | `/monitor list` | Show all monitors with status |
| `check` | `/monitor check [name]` | Manually run a check (one or all) |
| `history` | `/monitor history <name> [limit]` | View recent check results |
| `update` | `/monitor update <name> ...` | Modify a monitor's config |
| `delete` | `/monitor delete <name>` | Remove a monitor and its history |

## How Monitors Work

### 1. Source — Where to get data

| `source_type` | `source_config` JSON | Description |
|---------------|---------------------|-------------|
| `url` | `{ "url": "https://...", "method": "GET", "headers": {}, "body": "" }` | HTTP request. Supports GET/POST/PUT. Custom headers for auth. |
| `command` | `{ "command": "df -h / | tail -1 | awk '{print $5}'", "timeout_ms": 10000 }` | Shell command. Output is stdout. Timeout prevents hangs. |

### 2. Extractor — What value to pull out

| `extractor_type` | `extractor_config` JSON | Description |
|-------------------|------------------------|-------------|
| `json_path` | `{ "path": "$.data.price" }` | Extract a field from JSON response using dot-path notation |
| `regex` | `{ "pattern": "Price: \\$(\\d+)", "group": 1 }` | Regex match against body/stdout, returns capture group |
| `css_selector` | `{ "selector": "h1.price", "attribute": "textContent" }` | Extract from HTML using CSS selector |
| `xpath` | `{ "expression": "//span[@class='price']/text()" }` | XPath for XML/HTML extraction |
| `stdout` | `{}` | Raw stdout/body as-is (default) |
| `status_code` | `{}` | HTTP status code (200, 404, etc.) |
| `response_time` | `{}` | Request duration in milliseconds |
| `hash` | `{}` | SHA-256 hash of entire response body — detects any change |

### 3. Condition — When to alert

| `condition_type` | `condition_config` JSON | Triggers when... |
|------------------|------------------------|-----------------|
| `threshold_above` | `{ "value": 100000 }` | Extracted value > threshold |
| `threshold_below` | `{ "value": 50 }` | Extracted value < threshold |
| `change_any` | `{}` | Value differs from last check |
| `change_percent` | `{ "percent": 5 }` | Value changed by more than N% |
| `contains` | `{ "text": "error" }` | Value contains text |
| `not_contains` | `{ "text": "healthy" }` | Value does NOT contain text |
| `regex_match` | `{ "pattern": "ERROR|FAIL" }` | Value matches regex |
| `always` | `{}` | Always alert (useful for logging) |

### 4. Interval — How often to check

Standard cron expressions in `interval_cron`:
- `*/5 * * * *` — every 5 minutes
- `*/15 * * * *` — every 15 minutes (default)
- `0 * * * *` — every hour
- `0 */6 * * *` — every 6 hours
- `0 9 * * *` — daily at 9 AM
- `0 9 * * 1-5` — weekdays at 9 AM

### 5. Heartbeat Integration

Monitors are checked automatically during heartbeat cycles. The heartbeat:
1. Queries all enabled monitors where `last_checked_at` is past the cron schedule
2. Runs source fetch, extraction, and condition evaluation
3. Records results in `monitor_history` table
4. If condition triggers: posts alert to `notify_channel` (or heartbeat channel)
5. Tracks `consecutive_alerts` for escalation awareness

## Example Monitors

### Bitcoin Price Alert
```
/monitor create btc-price
```
Then use the MCP tool:
- `name`: btc-price
- `description`: Alert when BTC crosses $100k
- `source_type`: url
- `source_config`: `{ "url": "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd" }`
- `extractor_type`: json_path
- `extractor_config`: `{ "path": "bitcoin.usd" }`
- `condition_type`: threshold_above
- `condition_config`: `{ "value": 100000 }`
- `interval_cron`: `*/15 * * * *`

### Website Uptime Check
- `name`: my-site-up
- `source_type`: url
- `source_config`: `{ "url": "https://example.com/health" }`
- `extractor_type`: status_code
- `condition_type`: threshold_above
- `condition_config`: `{ "value": 399 }`
- `interval_cron`: `*/5 * * * *`

Alerts when status code is 400+.

### Web Page Change Detection
- `name`: docs-changes
- `source_type`: url
- `source_config`: `{ "url": "https://docs.example.com/api/changelog" }`
- `extractor_type`: hash
- `condition_type`: change_any
- `interval_cron`: `0 */6 * * *`

Alerts whenever the page content changes (detected via SHA-256 hash).

### Product Price Tracking
- `name`: laptop-price
- `source_type`: url
- `source_config`: `{ "url": "https://api.example.com/products/12345" }`
- `extractor_type`: json_path
- `extractor_config`: `{ "path": "price.current" }`
- `condition_type`: threshold_below
- `condition_config`: `{ "value": 999 }`
- `interval_cron`: `0 */2 * * *`

### SSL Certificate Expiry
- `name`: ssl-expiry
- `source_type`: command
- `source_config`: `{ "command": "echo | openssl s_client -servername example.com -connect example.com:443 2>/dev/null | openssl x509 -noout -dates | grep notAfter | cut -d= -f2", "timeout_ms": 15000 }`
- `extractor_type`: stdout
- `condition_type`: contains
- `condition_config`: `{ "text": "Mar" }`
- `interval_cron`: `0 9 * * 1`

Check weekly, alert when the expiry date is in the current month.

### Custom API Metric
- `name`: api-latency
- `source_type`: url
- `source_config`: `{ "url": "https://api.example.com/health" }`
- `extractor_type`: response_time
- `condition_type`: threshold_above
- `condition_config`: `{ "value": 2000 }`
- `interval_cron`: `*/10 * * * *`

Alert when API response time exceeds 2 seconds.

### Disk Usage Alert (Shell Command)
- `name`: disk-usage
- `source_type`: command
- `source_config`: `{ "command": "df -h / | tail -1 | awk '{print $5}' | tr -d '%'", "timeout_ms": 5000 }`
- `extractor_type`: stdout
- `condition_type`: threshold_above
- `condition_config`: `{ "value": 85 }`
- `interval_cron`: `0 */4 * * *`

Alert when root partition is over 85% full.

### GitHub Stars Tracking
- `name`: repo-stars
- `source_type`: url
- `source_config`: `{ "url": "https://api.github.com/repos/owner/repo", "headers": { "Accept": "application/vnd.github.v3+json" } }`
- `extractor_type`: json_path
- `extractor_config`: `{ "path": "stargazers_count" }`
- `condition_type`: change_any
- `interval_cron`: `0 9 * * *`

Daily check, alert on any star count change.

## Data Flow

```
Heartbeat cycle
  → Query: SELECT * FROM monitors WHERE enabled=1 AND due
  → For each monitor:
      1. Fetch source (HTTP or shell command)
      2. Extract value (json_path, regex, hash, etc.)
      3. Compare against condition + last_value
      4. INSERT into monitor_history
      5. UPDATE monitor: last_value, last_status, last_checked_at, consecutive_alerts
      6. If ALERT: post to notify_channel via Discord
```

## Database Tables

### `monitors`
Stores monitor configuration and current state. Key columns: `name` (unique), `source_type`, `source_config`, `extractor_type`, `extractor_config`, `condition_type`, `condition_config`, `interval_cron`, `enabled`, `last_value`, `last_status`, `last_checked_at`, `consecutive_alerts`.

### `monitor_history`
Time-series of check results. Columns: `monitor_id` (FK), `value`, `status` (ok/alert/error), `message`, `checked_at`. Indexed on `(monitor_id, checked_at)` for efficient queries.

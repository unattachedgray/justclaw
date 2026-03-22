# Security Audit

Run a security audit of the justclaw installation and report findings.

## Checks

Run all of the following checks and report results:

### 1. Secrets in Git
```bash
git ls-files | xargs grep -l -E '(DISCORD_BOT_TOKEN|API_KEY|SECRET|PASSWORD|TOKEN)=' 2>/dev/null || echo "PASS: No secrets in tracked files"
```
Verify `.env` is in `.gitignore`. Check for hardcoded tokens in source.

### 2. File Permissions on data/
```bash
ls -la data/ 2>/dev/null
stat -c '%a %U:%G %n' data/charlie.db data/*.pid 2>/dev/null
```
Database and PID files should be 600 or 644, owned by the current user. Directory should be 700 or 755.

### 3. PM2 Configuration
```bash
cat ecosystem.config.cjs
pm2 jlist 2>/dev/null | jq '.[].pm2_env | {name, exec_mode, max_memory_restart, kill_timeout, instances}'
```
Verify: `kill_timeout >= 10000`, `max_memory_restart` set, `wait_ready: true`.

### 4. Exposed Ports
```bash
ss -tlnp 2>/dev/null | grep -E '(8787|3000|4000|5000)'
```
Only port 8787 (dashboard) should be bound. Flag unexpected listeners.

### 5. Dashboard Authentication
Check if `DASHBOARD_AUTH_PASSWORD` is set in `.env`. If not, dashboard is unauthenticated — flag as warning (acceptable for local-only, risky if exposed).

### 6. JUSTCLAW_NO_DASHBOARD in MCP Config
```bash
cat .mcp.json | jq '.mcpServers.justclaw.env.JUSTCLAW_NO_DASHBOARD'
```
Must be `"1"` — prevents MCP server from interfering with PM2 dashboard.

### 7. SQLite Integrity
```bash
sqlite3 data/charlie.db "PRAGMA integrity_check; PRAGMA journal_mode;"
```
Must return `ok` and `wal`.

### 8. Node.js Version
```bash
node --version
```
Must be 20+.

## Output Format

For each check, report:
- **Status**: PASS, WARN, or FAIL
- **Detail**: What was found
- **Recommendation**: How to fix (for WARN/FAIL only)

Save the audit results to memory with `memory_save(key: "security-audit-<date>", type: "audit", tags: "security,audit")` and log with `daily_log_add(category: "audit")`.

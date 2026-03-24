# OWASP Top 10 — A06-A10 and Audit Checklist

Continuation of the OWASP testing guide. See [skill.md](skill.md) for A01-A05 and overview.

## A06: Vulnerable and Outdated Components

### What to Test

- Known vulnerabilities in npm dependencies
- Outdated packages with security patches available
- Unused dependencies increasing attack surface
- Transitive dependency vulnerabilities

### Test Procedures

```bash
npm audit                                     # built-in audit
npm audit --omit=dev                          # production only
npm outdated                                  # check for updates
npm ls --depth=0                              # list top-level deps
npm ls better-sqlite3 discord.js hono         # check high-risk packages
```

### High-Risk Dependencies for justclaw

| Package | Risk Area | What to Check |
|---------|-----------|---------------|
| `better-sqlite3` | Native addon, SQL | CVEs, buffer overflows, SQL bypass |
| `discord.js` | WebSocket, API | Token exposure, gateway exploits |
| `hono` | HTTP framework | Request smuggling, header injection |
| `officeparser` | File parsing | Path traversal, ZIP bombs, XXE |
| `mammoth` | DOCX parsing | XXE, malicious document exploits |
| `unpdf` | PDF parsing | Buffer overflow, malicious PDF |
| `turndown` | HTML conversion | XSS passthrough, ReDoS |

### Remediation

- Run `npm audit` in CI/CD and block on high/critical
- Set up Dependabot or Renovate for automatic dependency updates
- Remove unused dependencies (`npx depcheck`)
- Pin major versions in package.json
- Audit native addons (better-sqlite3) for memory safety issues

---

## A07: Identification and Authentication Failures

### What to Test

- Discord bot token security and rotation
- Session management in the sessions table
- Claude CLI session hijacking via --resume
- Session fixation and prediction

### Test Procedures

**1. Token security**
```bash
grep -rn "DISCORD_BOT_TOKEN\|Bot \|Bearer " dist/ src/ --include="*.ts" --include="*.js"
ps aux | grep -i discord | grep -v grep       # token visible in args?
grep -rn "token:" src/discord/ --include="*.ts"
```

**2. Session management**
```sql
SELECT channel_id, session_id, turn_count, last_used_at FROM sessions;
SELECT * FROM sessions WHERE last_used_at < datetime('now', '-7 days');
```

**3. Session hijacking via --resume**
```
Test: Can an attacker guess or enumerate session IDs?
Test: Is there validation that --resume IDs belong to the requesting channel?
Test: Can a crafted session_id in the tasks table lead to session hijacking?
```

### MFA and Password Policy (for web-facing components)

If the dashboard adds authentication:
- Enforce minimum 12-character passwords
- Implement account lockout after 5 failed attempts
- Use bcrypt/scrypt/argon2 for password hashing (never MD5/SHA1)
- Implement secure session tokens (min 128 bits of entropy)

### Remediation

- Rotate Discord bot token periodically
- Implement session expiration (auto-delete sessions older than 7 days)
- Validate session ownership: session_id must match requesting channel_id
- Never log tokens or secrets at any log level
- Use constant-time comparison for any token validation

---

## A08: Software and Data Integrity Failures

### What to Test

- Deserialization of untrusted data (JSON.parse of user input)
- npm supply chain (dependency integrity)
- Code/data integrity verification
- Prototype pollution

### Test Procedures

**1. Unsafe deserialization**
```typescript
// VULNERABLE:
const data = JSON.parse(userInput);
db.prepare('INSERT INTO memories VALUES (?)').run(data.key);

// SAFE: validate schema after parsing
const data = JSON.parse(userInput);
const validated = memorySchema.parse(data); // zod validation
```

**2. npm supply chain**
```bash
npm ci                                        # verify lock file integrity
grep -r "postinstall\|preinstall" node_modules/*/package.json | grep -v "node_modules/.*node_modules" | head -20
npm run build && git diff dist/               # verify no tampering
```

**3. SQLite data integrity**
```bash
sqlite3 data/charlie.db "PRAGMA integrity_check;"
sqlite3 data/charlie.db "PRAGMA foreign_key_check;"
```

**4. Prototype pollution**
```
Test payloads for any JSON input:
{"__proto__": {"isAdmin": true}}
{"constructor": {"prototype": {"isAdmin": true}}}
```

### Remediation

- Validate all JSON input with schema validation (zod) before processing
- Use `npm ci` in deployment (not `npm install`)
- Run `PRAGMA integrity_check` on database startup (already done)
- Freeze prototypes where possible: `Object.freeze(Object.prototype)`

---

## A09: Security Logging and Monitoring Failures

### What to Test

- Are security events (auth, authz, validation failures) logged?
- Do logs contain sufficient detail for forensics?
- Are logs protected from tampering and injection?
- Is there alerting on suspicious patterns?

### Test Procedures

**1. Audit logging coverage**
```
Check: Are failed MCP tool calls logged with caller context?
Check: Are process_check kill actions logged to escalation_log?
Check: Are session rotation events logged?
```

**2. Log injection**
```
Test: Send log entries with newlines to forge log entries
daily_log_add(entry: "Normal entry\n2026-03-24 CRITICAL: System compromised")
conversation_log(message: "hello\x00null byte injection")
```

**3. Sensitive data in logs**
```bash
pm2 logs justclaw-discord --lines 100 --nostream 2>/dev/null | grep -iE "token|password|secret|key=" | head -10
pm2 logs justclaw-discord --lines 100 --nostream 2>/dev/null | grep -E "at .*/home/" | head -10
```

**4. Log retention and protection**
```bash
ls -la ~/.pm2/logs/justclaw-*
du -sh ~/.pm2/logs/
```

### Remediation

- Log all security-relevant events: auth, authz, input validation, process management
- Sanitize log inputs: strip control characters, limit length
- Never log secrets, tokens, or full SQL queries with parameters
- Implement structured logging (JSON format) for machine parsing
- Set up log rotation to prevent disk filling

---

## A10: Server-Side Request Forgery (SSRF)

### What to Test

- Monitor URL source fetching user-controlled URLs
- Notebook creation scanning user-controlled paths
- Internal service access via crafted URLs

### Test Procedures

**SSRF via monitor_create**
```
monitor_create(source_type: "url", source_config: { url: "http://localhost:8787/admin" })
monitor_create(source_type: "url", source_config: { url: "http://169.254.169.254/latest/meta-data/" })
monitor_create(source_type: "url", source_config: { url: "http://127.0.0.1:9229/json" })
monitor_create(source_type: "url", source_config: { url: "file:///etc/passwd" })
monitor_create(source_type: "url", source_config: { url: "http://[::1]:8787/" })
```

**SSRF via redirects**
```
Test: URL that 302-redirects to http://localhost:8787
```

**Path traversal via notebook_create**
```
notebook_create(name: "evil", path: "/etc")
notebook_create(name: "evil", path: "/proc/self")
notebook_create(name: "evil", path: "/home/julian/.ssh")
```

### SSRF Bypass Techniques

| Technique | Example | Resolves To |
|-----------|---------|-------------|
| Decimal IP | `http://2130706433/` | 127.0.0.1 |
| Hex IP | `http://0x7f000001/` | 127.0.0.1 |
| Octal IP | `http://0177.0.0.1/` | 127.0.0.1 |
| IPv6 | `http://[::1]/` | 127.0.0.1 |
| URL encoding | `http://%31%32%37%2e%30%2e%30%2e%31/` | 127.0.0.1 |
| DNS rebinding | Attacker DNS resolves to internal IP | Bypasses hostname checks |
| Redirect | External URL 302s to internal | Bypasses URL allowlist |

### Remediation

- Block private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1)
- Block non-HTTP(S) protocols (file://, gopher://, dict://)
- Disable HTTP redirects or re-validate after each redirect
- Restrict notebook_create paths to an allowlist of directories
- Set timeouts on all outbound requests
- Log all outbound requests for audit

---

## Audit Checklist

Use this checklist when performing a full OWASP audit:

```
[ ] A01: Authorization checks on all MCP tools
[ ] A01: Path traversal protection in file operations
[ ] A01: Channel isolation in multi-tenant data
[ ] A02: No hardcoded secrets in source
[ ] A02: Secrets loaded from env, not stored in DB
[ ] A02: Crypto uses node:crypto, not Math.random
[ ] A03: All SQL uses parameterized queries
[ ] A03: Dashboard outputs are HTML-escaped
[ ] A03: No shell interpolation with user input
[ ] A04: Input validation schemas on tool parameters
[ ] A04: Resource quotas (memory, tasks, chunks)
[ ] A04: Error messages don't leak internals
[ ] A05: Security headers on dashboard
[ ] A05: File permissions restricted on .env and DB
[ ] A05: Debug mode disabled in production
[ ] A06: npm audit clean (no high/critical)
[ ] A06: Dependencies up to date
[ ] A07: Bot token secure and rotatable
[ ] A07: Sessions expire and validate ownership
[ ] A08: JSON input validated with schemas
[ ] A08: npm supply chain verified
[ ] A09: Security events logged
[ ] A09: No sensitive data in logs
[ ] A09: Log rotation configured
[ ] A10: SSRF protections on URL fetching
[ ] A10: Path restrictions on notebook creation
[ ] A10: Private IP ranges blocked for outbound requests
```

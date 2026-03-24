---
name: threat-modeling
description: "Threat modeling with STRIDE classification, DREAD risk scoring, Attack Trees, and attack surface analysis. Use for security architecture reviews and threat assessments."
---

# Threat Modeling Methodology

Reference skill for conducting threat modeling using STRIDE, DREAD, Attack Trees, and attack surface analysis. Tailored for Node.js/TypeScript applications including MCP servers, Discord bots, SQLite databases, and CLI tools.

## STRIDE Threat Classification

STRIDE categorizes threats by their nature. Apply each category systematically to every component in the system.

| Category | Threat | Property Violated | Question to Ask |
|----------|--------|-------------------|-----------------|
| **S** - Spoofing | Pretending to be someone/something else | Authentication | Can an attacker impersonate a legitimate user, service, or component? |
| **T** - Tampering | Modifying data or code | Integrity | Can an attacker modify data in transit, at rest, or in processing? |
| **R** - Repudiation | Denying having performed an action | Non-repudiation | Can a user deny performing an action without the system being able to prove otherwise? |
| **I** - Information Disclosure | Exposing data to unauthorized parties | Confidentiality | Can an attacker access data they should not see? |
| **D** - Denial of Service | Making the system unavailable | Availability | Can an attacker prevent legitimate users from accessing the system? |
| **E** - Elevation of Privilege | Gaining unauthorized capabilities | Authorization | Can an attacker perform actions beyond their allowed permissions? |

### STRIDE Applied to justclaw Components

#### MCP Server (stdio transport)

| Threat | Category | Risk | Mitigation |
|--------|----------|------|------------|
| Malicious MCP client sends crafted tool calls | S, T | High | Validate all tool inputs with schemas |
| Tool call injects SQL into SQLite queries | T, E | Critical | Parameterized queries only |
| Error responses leak file paths or schema details | I | Medium | Sanitize error messages |
| Unbounded tool calls exhaust memory/CPU | D | Medium | Rate limiting, input size limits |
| MCP client bypasses tool permissions | E | High | Server-side authorization checks |

#### Discord Bot

| Threat | Category | Risk | Mitigation |
|--------|----------|------|------------|
| Attacker obtains Discord bot token | S | Critical | Env var only, rotate periodically |
| User crafts message to inject into claude -p prompt | T | High | Input sanitization, prompt boundaries |
| Bot actions not attributed to requesting user | R | Medium | Log all commands with user ID and channel |
| Bot leaks memory/task content from other channels | I | High | Channel-scoped data isolation |
| Flood of messages overloads claude -p queue | D | Medium | Per-channel queue, circuit breaker |
| User tricks bot into running privileged commands | E | Critical | Allowlisted tools only, no arbitrary shell |

#### SQLite Database

| Threat | Category | Risk | Mitigation |
|--------|----------|------|------------|
| Direct database file access by another process | S, I | Medium | File permissions (chmod 600) |
| SQL injection modifies or deletes records | T | Critical | Parameterized queries |
| No audit trail for data modifications | R | Medium | Append-only audit log table |
| Database file exposed via path traversal | I | High | Restrict file access paths |
| Large queries or FTS5 abuse slows system | D | Medium | Query timeouts, result limits |
| WAL file contains sensitive data fragments | I | Low | Restrict WAL file permissions |

#### Dashboard (Hono :8787)

| Threat | Category | Risk | Mitigation |
|--------|----------|------|------------|
| Attacker accesses dashboard from network | S, I | Medium | Bind to localhost only, or add auth |
| XSS via stored data rendered in HTML | T, E | High | HTML escaping, CSP headers |
| Dashboard actions not logged | R | Medium | Access logging middleware |
| Response headers leak server info | I | Low | Remove X-Powered-By, Server headers |
| Request flood overwhelms Hono server | D | Medium | Rate limiting middleware |

#### Heartbeat and Process Management

| Threat | Category | Risk | Mitigation |
|--------|----------|------|------------|
| Attacker registers a fake process in registry | S, T | High | Validate PID ownership via /proc |
| Process kill targets wrong PID (PID reuse) | T | High | Start-time verification, cmdline check |
| Escalation agent modifies source code | T, E | Critical | No Write/Edit tools for escalation |
| Heartbeat logs expose system internals | I | Low | Sanitize heartbeat output |
| Runaway heartbeat consumes resources | D | Medium | Timeout on each check, memory limits |

---

## STRIDE-Based Analysis with Data Flow Diagrams

### How to Build a Data Flow Diagram (DFD)

1. **Identify external entities** (users, external services)
2. **Identify processes** (MCP server, Discord bot, heartbeat, dashboard)
3. **Identify data stores** (SQLite DB, file system, .env)
4. **Identify data flows** (arrows between components)
5. **Identify trust boundaries** (where privilege levels change)

### justclaw Data Flow Diagram (text representation)

```
Trust Boundary: External
+---------------------------+
| Discord Users             |
| (untrusted input)         |
+---------------------------+
          |
          | Discord API (WebSocket)
          v
Trust Boundary: Application
+---------------------------+     +-----------------------+
| Discord Bot               |---->| claude -p             |
| (discord.js, queue,       |     | (child process,       |
|  circuit breaker)         |<----| --resume, stream)     |
+---------------------------+     +-----------------------+
          |                              |
          | stdio                        | MCP stdio
          v                              v
+---------------------------+     +-----------------------+
| PM2 Process Manager       |     | MCP Server            |
| (lifecycle, restart)      |     | (30 tools, validation)|
+---------------------------+     +-----------------------+
                                         |
                                         | SQL (parameterized)
                                         v
Trust Boundary: Data
+---------------------------+     +-----------------------+
| SQLite Database           |     | File System           |
| (WAL, FTS5, schema v12)  |     | (.env, notebooks,     |
| data/charlie.db           |     |  project files)       |
+---------------------------+     +-----------------------+

Trust Boundary: External Services
+---------------------------+
| Monitor URLs              |
| (HTTP fetch, untrusted)   |
+---------------------------+
```

### Applying STRIDE to Data Flows

For each data flow (arrow) in the DFD, ask all six STRIDE questions:

| Data Flow | S | T | R | I | D | E |
|-----------|---|---|---|---|---|---|
| Discord -> Bot | Can attacker impersonate user? | Can message be modified in transit? | Can user deny sending message? | Can message content leak? | Can flood crash the bot? | Can user gain bot privileges? |
| Bot -> claude -p | Can process be spoofed? | Can prompt be injected? | Are actions logged? | Can output leak to wrong channel? | Can long-running process block others? | Can it escape allowed tools? |
| MCP Server -> SQLite | Can connection be hijacked? | Can queries be tampered (SQLi)? | Are writes audited? | Can data leak via errors? | Can queries lock the DB? | Can queries access other tables? |
| Bot -> Monitor URLs | Can response be spoofed? | Can redirect lead to internal URL? | Are checks logged? | Can internal data leak via SSRF? | Can slow response block heartbeat? | Can response trigger privileged action? |

---

## DREAD Risk Evaluation Framework

DREAD scores each threat on five dimensions, each rated 1-10.

### Dimensions

| Dimension | Score 1 (Low) | Score 5 (Medium) | Score 10 (High) |
|-----------|--------------|-------------------|-----------------|
| **D**amage | Minor inconvenience | Data loss, partial outage | Full system compromise, data breach |
| **R**eproducibility | Difficult, requires specific conditions | Reproducible with some effort | Trivially reproducible every time |
| **E**xploitability | Requires deep expertise and custom tools | Requires some skill, tools available | Script kiddie level, automated tools exist |
| **A**ffected Users | Single user, edge case | Subset of users | All users, entire system |
| **D**iscoverability | Requires source code review | Found by active security testing | Publicly known, easily found |

### Severity Calculation

```
DREAD Score = (Damage + Reproducibility + Exploitability + Affected Users + Discoverability) / 5
```

| Average Score | Severity | Action |
|--------------|----------|--------|
| 8.0-10.0 | Critical | Immediate fix, consider taking offline |
| 6.0-7.9 | High | Fix this sprint |
| 4.0-5.9 | Medium | Fix this quarter |
| 1.0-3.9 | Low | Accept risk or fix at convenience |

### DREAD Applied to justclaw Threats

**Threat: SQL Injection in memory_search**
```
Damage:          9  (full DB read/write, data exfiltration)
Reproducibility: 8  (send crafted search query via MCP)
Exploitability:  7  (SQLi is well-documented, tools exist)
Affected Users:  8  (all data in single DB compromised)
Discoverability: 6  (requires knowing MCP tool interface)

DREAD Score: (9+8+7+8+6) / 5 = 7.6 -> HIGH
```

**Threat: Discord bot token exposure**
```
Damage:          10 (full bot impersonation, channel access)
Reproducibility: 10 (use token = instant access)
Exploitability:  10 (paste token into discord.js = done)
Affected Users:  10 (entire Discord server)
Discoverability: 4  (must find .env or logs)

DREAD Score: (10+10+10+10+4) / 5 = 8.8 -> CRITICAL
```

**Threat: SSRF via monitor URL**
```
Damage:          7  (access internal services, metadata)
Reproducibility: 9  (just create a monitor with internal URL)
Exploitability:  8  (SSRF is straightforward)
Affected Users:  6  (server-side only, no direct user impact)
Discoverability: 5  (requires knowing monitor_create tool)

DREAD Score: (7+9+8+6+5) / 5 = 7.0 -> HIGH
```

**Threat: ReDoS in FTS5 search query**
```
Damage:          4  (temporary DoS, no data loss)
Reproducibility: 6  (crafted regex needed)
Exploitability:  5  (requires knowledge of FTS5 syntax)
Affected Users:  7  (blocks all DB operations during hang)
Discoverability: 3  (requires code review)

DREAD Score: (4+6+5+7+3) / 5 = 5.0 -> MEDIUM
```

---

## Attack Tree Methodology

Attack trees decompose high-level attack goals into sub-goals using AND/OR logic. The root node is the attacker's objective; leaf nodes are specific actions.

### Notation

- **OR node**: attacker needs to achieve ANY child to succeed (default)
- **AND node**: attacker needs to achieve ALL children to succeed
- **Leaf node**: concrete attack action with cost/difficulty estimate

### Attack Tree: Compromise justclaw Data

```
[ROOT] Compromise justclaw data (memories, tasks, goals)
|
+-- [OR] Direct database access
|   |
|   +-- [OR] File system access
|   |   +-- [LEAF] Exploit path traversal in notebook_create (Medium)
|   |   +-- [LEAF] Exploit file read in MCP tool (Medium)
|   |   +-- [LEAF] Physical access to machine (Low probability)
|   |
|   +-- [OR] SQL injection
|       +-- [LEAF] Inject via memory_search query (High if not parameterized)
|       +-- [LEAF] Inject via conversation_search (High if not parameterized)
|       +-- [LEAF] Inject via task_list tag filter (Medium)
|
+-- [OR] Application-level access
|   |
|   +-- [OR] Discord bot compromise
|   |   +-- [AND] Token theft
|   |   |   +-- [LEAF] Extract from .env file (requires filesystem access)
|   |   |   +-- [LEAF] Extract from process environment (requires local access)
|   |   |   +-- [LEAF] Extract from PM2 logs (if logged)
|   |   |
|   |   +-- [LEAF] Prompt injection via Discord message (Medium)
|   |
|   +-- [OR] MCP server exploitation
|   |   +-- [LEAF] Craft malicious tool call to dump data (Medium)
|   |   +-- [LEAF] Exploit tool to write/modify unauthorized records (Medium)
|   |
|   +-- [OR] Dashboard exploitation
|       +-- [LEAF] Access unprotected dashboard endpoint (Low if localhost-only)
|       +-- [LEAF] XSS to exfiltrate rendered data (Medium)
|
+-- [OR] Side-channel access
    +-- [LEAF] Read WAL file for recent writes (Low, requires FS access)
    +-- [LEAF] Read backup files (Low, requires knowing backup location)
    +-- [LEAF] Monitor network traffic for unencrypted data (Low for stdio)
```

### Attack Tree: Denial of Service on justclaw

```
[ROOT] Make justclaw unavailable
|
+-- [OR] Resource exhaustion
|   +-- [LEAF] Flood Discord bot with messages (per-channel queue mitigates)
|   +-- [LEAF] Create thousands of tasks/memories (no quota = possible)
|   +-- [LEAF] Trigger long-running claude -p processes (timeout mitigates)
|   +-- [LEAF] Fill disk with monitor history / notebook chunks (possible)
|
+-- [OR] Process crash
|   +-- [LEAF] Trigger unhandled exception in MCP server (Medium)
|   +-- [LEAF] Corrupt SQLite database file (requires FS access)
|   +-- [LEAF] Exhaust memory to trigger PM2 restart loop (possible)
|
+-- [OR] Dependency failure
    +-- [LEAF] Discord API outage (external, uncontrollable)
    +-- [LEAF] SQLite file lock contention (multiple writers)
    +-- [AND] Supply chain attack
        +-- [LEAF] Compromise npm dependency (Low probability, high impact)
        +-- [LEAF] Dependency update pulled automatically (if not pinned)
```

### Using Attack Trees for Prioritization

1. Calculate the cost of each leaf node (effort, skill, access required)
2. For OR nodes: cheapest child determines the cost (attacker picks easiest path)
3. For AND nodes: most expensive child determines the cost (all needed)
4. Prioritize mitigation for the cheapest attack paths to the root goal

---

## Attack Surface Analysis

The attack surface is every point where an attacker can interact with the system. Reducing the attack surface reduces overall risk.

### External APIs

| Endpoint | Protocol | Auth | Exposure | Risk |
|----------|----------|------|----------|------|
| MCP Server | stdio (local) | None (trusted transport) | Local only | Medium - relies on client trust |
| Dashboard :8787 | HTTP | None | localhost (or network if misconfigured) | High if exposed |
| Discord WebSocket | WSS | Bot token | Internet via Discord API | Medium - Discord handles transport |
| Monitor URL fetches | HTTP/HTTPS | N/A (outbound) | Internet | High - SSRF vector |
| Claude CLI spawn | Process spawn | N/A (local) | Local only | Medium - prompt injection vector |

### Authentication Points

| Component | Auth Mechanism | Strength | Improvement |
|-----------|---------------|----------|-------------|
| MCP Server | None (stdio implies trust) | Weak | Add caller identity validation |
| Dashboard | None | None | Add basic auth or API key |
| Discord Bot | Discord's user system | Strong | Verify user roles for sensitive commands |
| Process Registry | PID + /proc verification | Medium | Already good with 3-layer safety |
| SQLite | File system permissions | Medium | Restrict to owner-only (chmod 600) |

### Data Flows Across Trust Boundaries

| Flow | Source Trust | Dest Trust | Crosses Boundary | Controls |
|------|------------|------------|-------------------|----------|
| Discord message -> Bot | Untrusted | Application | Yes | Input validation, queue limiting |
| Bot -> claude -p prompt | Application | Subprocess | Yes | Allowlisted tools, timeout |
| claude -p -> MCP tool call | Subprocess | Application | No | Tool parameter validation |
| MCP tool -> SQLite query | Application | Data | Yes | Parameterized queries |
| Monitor -> External URL | Application | Untrusted | Yes | URL validation, SSRF protection |
| Heartbeat -> Escalation LLM | Application | External | Yes | Guardrails, no code modification |
| Dashboard -> Browser | Application | Untrusted | Yes | HTML escaping, security headers |

### Integration Points

| Integration | Risk | What Could Go Wrong |
|-------------|------|-------------------|
| Discord.js WebSocket | Medium | Shard failures, reconnection loops, rate limiting |
| Claude CLI (--resume) | Medium | Session hijacking, prompt injection, hung processes |
| better-sqlite3 | Low | Native addon vulnerabilities, memory corruption |
| PM2 process manager | Low | Config exposure, unintended restarts |
| npm package registry | Medium | Supply chain attacks, malicious updates |
| Monitor HTTP fetches | High | SSRF, redirect following, response parsing |
| Notebook file scanning | Medium | Path traversal, malicious file content, ZIP bombs |

### Admin Interfaces

| Interface | Access Method | Risk if Compromised |
|-----------|-------------|-------------------|
| PM2 CLI | Local shell | Can stop/restart/delete all services |
| SQLite CLI | Local shell | Full database read/write |
| .env file | File system | All secrets exposed |
| MCP tools | stdio from Claude | Full data access, process management |
| Dashboard | HTTP :8787 | Read access to system state |

### Data Storage

| Store | Contains | Encryption | Backup | Risk |
|-------|----------|-----------|--------|------|
| SQLite (charlie.db) | Memories, tasks, goals, conversations, sessions | None (plaintext) | Every 6h | High if accessed |
| SQLite WAL | Recent writes | None | Checkpointed hourly | Medium (fragments) |
| .env | Bot token, API keys | None (plaintext) | Not backed up | Critical if leaked |
| PM2 logs | stdout/stderr output | None | Log rotation | Medium (may contain secrets) |
| File system (notebooks) | Ingested documents | None | None | Depends on content |

---

## Threat Model Report Template

```markdown
# Threat Model Report

**System:** [name and version]
**Date:** [YYYY-MM-DD]
**Author:** [name]
**Scope:** [components covered]
**Methodology:** STRIDE + DREAD

## System Description

[Brief description of what the system does, its components, and deployment environment]

## Data Flow Diagram

[Text or image representation of the DFD with trust boundaries marked]

## Trust Boundaries

| # | Boundary | Between | Controls |
|---|----------|---------|----------|
| TB1 | Network boundary | External users <-> Application | TLS, authentication |
| TB2 | Process boundary | Application <-> Database | Parameterized queries |

## Threat Inventory

| # | Component | STRIDE | Threat | DREAD Score | Severity | Mitigation | Status |
|---|-----------|--------|--------|-------------|----------|------------|--------|
| T1 | MCP Server | T (Tampering) | SQL injection via tool params | 7.6 | High | Parameterized queries | Mitigated |
| T2 | Discord Bot | S (Spoofing) | Token theft | 8.8 | Critical | Env var, rotation | Partial |
| T3 | Monitor | I (Info Disc) | SSRF to internal services | 7.0 | High | URL validation | Open |

## Attack Trees

[Include attack trees for top 3 threat scenarios]

## Attack Surface Summary

| Category | Count | High Risk | Notes |
|----------|-------|-----------|-------|
| External APIs | [N] | [N] | [summary] |
| Auth points | [N] | [N] | [summary] |
| Data stores | [N] | [N] | [summary] |
| Integration points | [N] | [N] | [summary] |

## Risk Matrix

| | Low Impact | Medium Impact | High Impact | Critical Impact |
|---|-----------|--------------|-------------|-----------------|
| **Likely** | Medium | High | Critical | Critical |
| **Possible** | Low | Medium | High | Critical |
| **Unlikely** | Low | Low | Medium | High |
| **Rare** | Low | Low | Low | Medium |

## Recommendations

### Immediate (P0-P1)
1. [Critical and high severity mitigations]

### Short-term (P2)
1. [Medium severity mitigations, architectural improvements]

### Long-term (P3-P4)
1. [Low severity, defense-in-depth, process improvements]

## Residual Risk

[After mitigations, what risk remains and why it is accepted]

## Review Schedule

- Next review: [date, typically quarterly]
- Trigger for ad-hoc review: [new components, security incidents, major version changes]
```

---

## Quick Reference: When to Use Each Method

| Method | Best For | Output |
|--------|---------|--------|
| **STRIDE** | Systematic threat identification per component | Categorized threat list |
| **DREAD** | Prioritizing which threats to fix first | Scored and ranked threats |
| **Attack Trees** | Understanding complex multi-step attacks | Visual attack paths |
| **Attack Surface** | Reducing exposure by identifying all entry points | Inventory of touchpoints |
| **DFD + Trust Boundaries** | Identifying where controls are needed | Architectural security view |

### Recommended Flow

1. Draw the **Data Flow Diagram** with trust boundaries
2. Apply **STRIDE** to each component and data flow
3. Build **Attack Trees** for the top 5 most concerning threats
4. Score all threats with **DREAD**
5. Map the **Attack Surface** to identify reduction opportunities
6. Prioritize mitigations by DREAD score and attack tree analysis
7. Document in the **Threat Model Report**
8. Review quarterly or on significant architecture changes

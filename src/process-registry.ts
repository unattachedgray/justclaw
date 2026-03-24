/**
 * Process Registry — persistent PID tracking in SQLite.
 *
 * Statuses:
 *   - 'active':     should be running right now
 *   - 'retired':    should NOT be running — auto-kill if ephemeral role + grace period passed
 *   - 'suspicious': detected via ps scan, NOT in our registry — tracked but never auto-killed
 *
 * Kill policy (conservative):
 *   AUTO-KILL:  Only retired PIDs with killable roles (claude-p, heartbeat-claude, mcp-server)
 *               + verified via /proc/cmdline + 30s grace period after retirement.
 *   REPORT:     Suspicious processes, retired pm2-managed roles (dashboard, discord-bot).
 *   NEVER:      Interactive claude sessions, processes not matching justclaw patterns.
 *
 * Escalation (on malfunction):
 *   Normal:     suspicious processes are reported only.
 *   Malfunction detected (crash loops, DB errors): suspicious processes that pass
 *               safety scoring are auto-killed to restore clean state.
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import type { DB } from './db.js';
import { getLogger } from './logger.js';
import { isPidAlive } from './processes.js';

const log = getLogger('process-registry');

export type ProcessRole = 'dashboard' | 'discord-bot' | 'claude-p' | 'mcp-server' | 'heartbeat-claude';

interface RegisteredProcess {
  id: number;
  pid: number;
  role: string;
  status: string;
  started_at: string;
  retired_at: string | null;
  meta: string;
}

export interface SuspiciousProcess {
  pid: number;
  cmdline: string;
  firstSeen: string;
  timesSeen: number;
  safetyScore: number;     // 0-100: higher = safer to kill
  safetyReason: string;
}

export interface AuditResult {
  deadActive: RegisteredProcess[];
  aliveRetired: RegisteredProcess[];
  killed: number[];
  suspicious: SuspiciousProcess[];
}

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

export function registerProcess(db: DB, pid: number, role: ProcessRole, meta = ''): void {
  if (role !== 'claude-p' && role !== 'heartbeat-claude') {
    db.execute(
      "UPDATE process_registry SET status = 'retired', retired_at = datetime('now') WHERE role = ? AND status = 'active'",
      [role],
    );
  }
  db.execute(
    'INSERT INTO process_registry (pid, role, status, meta) VALUES (?, ?, ?, ?)',
    [pid, role, 'active', meta],
  );
  log.info('Registered process', { pid, role, meta });
}

export function retireProcess(db: DB, pid: number, tokens?: { input: number; output: number }): void {
  if (tokens) {
    db.execute(
      "UPDATE process_registry SET status = 'retired', retired_at = datetime('now'), input_tokens = ?, output_tokens = ? WHERE pid = ? AND status = 'active'",
      [tokens.input, tokens.output, pid],
    );
  } else {
    db.execute(
      "UPDATE process_registry SET status = 'retired', retired_at = datetime('now') WHERE pid = ? AND status = 'active'",
      [pid],
    );
  }
  log.info('Retired process', { pid, ...(tokens || {}) });
}

export function getActiveProcesses(db: DB): RegisteredProcess[] {
  return db.fetchall(
    "SELECT * FROM process_registry WHERE status = 'active' ORDER BY started_at DESC",
  ) as unknown as RegisteredProcess[];
}

export function getRetiredProcesses(db: DB): RegisteredProcess[] {
  return db.fetchall(
    "SELECT * FROM process_registry WHERE status = 'retired' AND retired_at > datetime('now', '-24 hours') ORDER BY retired_at DESC",
  ) as unknown as RegisteredProcess[];
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

function getCmdline(pid: number): string | null {
  try {
    // Linux: fast, no subprocess spawn.
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    // macOS fallback: /proc doesn't exist, use ps.
    if (process.platform === 'darwin') {
      try {
        return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', timeout: 5000 }).trim() || null;
      } catch { /* process doesn't exist */ }
    }
    return null;
  }
}

/**
 * Get process start time from /proc/<pid>/stat (field 22, in clock ticks since boot).
 * Returns epoch ms or null if unavailable. Used to detect PID reuse across reboots.
 * Falls back to `ps -p <pid> -o lstart=` on macOS.
 */
function getProcessStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Field 22 (1-indexed) is starttime in clock ticks since boot.
    // We need to parse carefully — field 2 (comm) can contain spaces/parens.
    const afterComm = stat.indexOf(') ');
    if (afterComm === -1) return null;
    const fields = stat.slice(afterComm + 2).split(' ');
    // After comm, field index 0 = stat field 3. Field 22 = index 19.
    const startTicks = parseInt(fields[19], 10);
    if (isNaN(startTicks)) return null;

    // Convert to epoch: boot time + ticks / clock_hz.
    const uptimeStr = readFileSync('/proc/uptime', 'utf-8').split(' ')[0];
    const uptimeSecs = parseFloat(uptimeStr);
    const bootEpochMs = Date.now() - uptimeSecs * 1000;
    const clkTck = 100; // Almost always 100 on Linux (sysconf(_SC_CLK_TCK))
    return bootEpochMs + (startTicks / clkTck) * 1000;
  } catch {
    // macOS fallback: parse `ps -p <pid> -o lstart=` (e.g. "Mon Mar 21 14:30:00 2026").
    if (process.platform === 'darwin') {
      try {
        const lstart = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 5000 }).trim();
        if (!lstart) return null;
        const parsed = new Date(lstart).getTime();
        return isNaN(parsed) ? null : parsed;
      } catch { /* process doesn't exist */ }
    }
    return null;
  }
}

/** True if cmdline matches justclaw-managed processes (NOT interactive claude sessions). */
function isJustclawProcess(cmdline: string): boolean {
  return cmdline.includes('justclaw') ||
    cmdline.includes('dist/discord') ||
    cmdline.includes('dist/dashboard') ||
    cmdline.includes('dist/index');
}

/** True if this looks like an interactive Claude session (user-owned, never touch). */
function isInteractiveClaudeSession(cmdline: string): boolean {
  // Interactive sessions use --dangerously-skip-permissions or just `claude` without -p
  if (cmdline.includes('--dangerously-skip-permissions')) return true;
  // Has claude but no ` -p ` flag = interactive
  if (cmdline.includes('claude') && !/ -p /.test(cmdline)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Suspicious process tracking (SQLite state table)
// ---------------------------------------------------------------------------

function getSuspiciousKey(pid: number): string {
  return `suspicious_pid_${pid}`;
}

function trackSuspicious(db: DB, pid: number, cmdline: string): SuspiciousProcess {
  const key = getSuspiciousKey(pid);
  const existing = db.fetchone("SELECT value FROM state WHERE key = ?", [key]);

  let record: SuspiciousProcess;
  if (existing) {
    record = JSON.parse(existing.value as string);
    record.timesSeen++;
    record.safetyScore = computeSafetyScore(pid, cmdline, record.timesSeen);
    record.safetyReason = computeSafetyReason(pid, cmdline, record.timesSeen);
    db.execute("UPDATE state SET value = ?, updated_at = datetime('now') WHERE key = ?",
      [JSON.stringify(record), key]);
  } else {
    record = {
      pid,
      cmdline: cmdline.slice(0, 200),
      firstSeen: new Date().toISOString(),
      timesSeen: 1,
      safetyScore: computeSafetyScore(pid, cmdline, 1),
      safetyReason: computeSafetyReason(pid, cmdline, 1),
    };
    db.execute("INSERT INTO state (key, value) VALUES (?, ?)",
      [key, JSON.stringify(record)]);
  }

  return record;
}

function clearSuspicious(db: DB, pid: number): void {
  db.execute("DELETE FROM state WHERE key = ?", [getSuspiciousKey(pid)]);
}

const MAX_SUSPICIOUS_ENTRIES = 50;

export function getSuspiciousProcesses(db: DB): SuspiciousProcess[] {
  const rows = db.fetchall("SELECT key, value FROM state WHERE key LIKE 'suspicious_pid_%'");
  const result: SuspiciousProcess[] = [];
  for (const row of rows) {
    try {
      const proc = JSON.parse(row.value as string) as SuspiciousProcess;
      // Prune dead ones.
      if (!isPidAlive(proc.pid)) {
        clearSuspicious(db, proc.pid);
        continue;
      }
      // Prune entries older than 24h.
      const age = Date.now() - new Date(proc.firstSeen).getTime();
      if (age > 24 * 3_600_000) {
        clearSuspicious(db, proc.pid);
        continue;
      }
      result.push(proc);
    } catch {
      // Corrupt entry — clean it up.
      db.execute("DELETE FROM state WHERE key = ?", [row.key]);
    }
  }

  // Cap: if too many, remove oldest.
  if (result.length > MAX_SUSPICIOUS_ENTRIES) {
    result.sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime());
    const excess = result.splice(0, result.length - MAX_SUSPICIOUS_ENTRIES);
    for (const proc of excess) {
      clearSuspicious(db, proc.pid);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Safety scoring — deterministic criteria for "is it safe to kill?"
// ---------------------------------------------------------------------------

/**
 * Score 0-100: how safe is it to kill this process?
 *
 *   90-100: Almost certainly safe (justclaw child process, not in pm2, seen many times)
 *   60-89:  Probably safe (matches justclaw patterns, not interactive)
 *   30-59:  Uncertain (could be related, needs user confirmation)
 *   0-29:   Not safe (interactive session, unknown process, or very new)
 */
function computeSafetyScore(pid: number, cmdline: string, timesSeen: number): number {
  let score = 0;

  // +40: matches justclaw process patterns
  if (isJustclawProcess(cmdline)) score += 40;

  // +20: contains ` -p ` (print mode claude, not interactive)
  if (/ -p /.test(cmdline)) score += 20;

  // -50: interactive claude session — never kill
  if (isInteractiveClaudeSession(cmdline)) return 0;

  // +10: not in pm2's current PID list
  if (!isInPm2(pid)) score += 10;

  // +5 per heartbeat cycle seen (up to +20): the longer it lingers, the more likely orphan
  score += Math.min(timesSeen * 5, 20);

  // +10: process has been seen for 3+ cycles
  if (timesSeen >= 3) score += 10;

  return Math.min(score, 100);
}

function computeSafetyReason(pid: number, cmdline: string, timesSeen: number): string {
  const parts: string[] = [];

  if (isInteractiveClaudeSession(cmdline)) return 'Interactive claude session — never auto-kill';

  if (isJustclawProcess(cmdline)) parts.push('matches justclaw patterns');
  if (/ -p /.test(cmdline)) parts.push('claude print-mode');
  if (!isInPm2(pid)) parts.push('not managed by pm2');
  if (timesSeen >= 3) parts.push(`seen ${timesSeen} cycles`);
  if (timesSeen < 3) parts.push(`only seen ${timesSeen} cycle(s) — too new`);

  return parts.join(', ') || 'unknown process';
}

/** Cached pm2 PID set — populated once per audit cycle via `loadPm2Pids()`. */
let _pm2PidCache: Set<number> = new Set();

/** Load pm2 PIDs once per audit cycle. Call at the start of `auditProcesses()`. */
function loadPm2Pids(): Set<number> {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const apps = JSON.parse(output) as Array<{ pid: number; name: string; pm2_env: { restart_time: number; status: string } }>;
    _pm2PidCache = new Set(apps.filter((a) => a.pid > 0).map((a) => a.pid));
    return _pm2PidCache;
  } catch {
    _pm2PidCache = new Set();
    return _pm2PidCache;
  }
}

function isInPm2(pid: number): boolean {
  return _pm2PidCache.has(pid);
}

// ---------------------------------------------------------------------------
// Scan for unknown justclaw processes not in our registry
// ---------------------------------------------------------------------------

function scanForUnknownProcesses(db: DB): SuspiciousProcess[] {
  const suspicious: SuspiciousProcess[] = [];

  // Get all known PIDs: registry + pm2 managed + self.
  // CRITICAL: include pm2 PIDs to prevent flagging pm2-managed processes as suspicious.
  // The dashboard is managed by pm2 but NOT registered in our process_registry.
  const knownPids = new Set<number>();
  for (const p of getActiveProcesses(db)) knownPids.add(p.pid);
  for (const p of getRetiredProcesses(db)) knownPids.add(p.pid);
  for (const pid of _pm2PidCache) knownPids.add(pid);
  knownPids.add(process.pid);
  knownPids.add(process.ppid);

  // Scan /proc for justclaw-related processes.
  try {
    const output = execSync(
      "ps -eo pid,cmd 2>/dev/null | grep -E 'node.*(justclaw|dist/(index|dashboard|discord|bot))' | grep -v grep",
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    if (!output) return suspicious;

    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (isNaN(pid) || knownPids.has(pid)) continue;

      const cmdline = getCmdline(pid);
      if (!cmdline) continue;
      if (isInteractiveClaudeSession(cmdline)) continue;

      const record = trackSuspicious(db, pid, cmdline);
      suspicious.push(record);
    }
  } catch { /* no matches */ }

  return suspicious;
}

// ---------------------------------------------------------------------------
// Malfunction detection
// ---------------------------------------------------------------------------

export interface MalfunctionState {
  detected: boolean;
  reasons: string[];
}

export function detectMalfunction(db: DB): MalfunctionState {
  const reasons: string[] = [];

  // Check pm2 crash loops — uses cached pm2 data from loadPm2Pids().
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const apps = JSON.parse(output) as Array<{ name: string; pm2_env: { restart_time: number; status: string } }>;
    for (const app of apps) {
      if (app.pm2_env.restart_time > 10) {
        reasons.push(`${app.name} crash-looping (${app.pm2_env.restart_time} restarts)`);
      }
      if (app.pm2_env.status === 'errored') {
        reasons.push(`${app.name} in error state`);
      }
    }
  } catch { /* ignore */ }

  // Check for many suspicious processes (sign of process leak).
  const suspicious = getSuspiciousProcesses(db);
  if (suspicious.length >= 5) {
    reasons.push(`${suspicious.length} suspicious processes detected`);
  }

  return { detected: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export function auditProcesses(db: DB): AuditResult {
  // Cache pm2 PIDs once for this entire audit cycle (fixes N+1 execSync calls).
  loadPm2Pids();

  const deadActive: RegisteredProcess[] = [];
  const aliveRetired: RegisteredProcess[] = [];
  const killed: number[] = [];

  // Check 1: active PIDs should be alive.
  const active = getActiveProcesses(db);
  for (const proc of active) {
    if (!isPidAlive(proc.pid)) {
      deadActive.push(proc);
      retireProcess(db, proc.pid);
      log.warn('Active process found dead', { pid: proc.pid, role: proc.role });
    }
  }

  // Check 2: retired PIDs — conservative kill policy.
  const KILLABLE_ROLES = new Set(['claude-p', 'heartbeat-claude', 'mcp-server']);
  const GRACE_PERIOD_MS = 30_000;

  const retired = getRetiredProcesses(db);
  for (const proc of retired) {
    if (!isPidAlive(proc.pid)) continue;

    const cmdline = getCmdline(proc.pid);
    if (!cmdline || !isJustclawProcess(cmdline)) {
      log.info('Retired PID reused by unrelated process, cleaning registry', { pid: proc.pid });
      db.execute("DELETE FROM process_registry WHERE id = ?", [proc.id]);
      continue;
    }

    // PID reuse protection: verify process started AFTER registry entry was created.
    // If the process started before our registry entry, it's a different process that
    // reused the PID (common after reboot).
    const procStartMs = getProcessStartTime(proc.pid);
    const registeredAtMs = new Date(proc.started_at + 'Z').getTime();
    if (procStartMs !== null && procStartMs < registeredAtMs - 60_000) {
      log.info('Retired PID reused (start time predates registry entry)', {
        pid: proc.pid, procStart: procStartMs, registered: registeredAtMs,
      });
      db.execute("DELETE FROM process_registry WHERE id = ?", [proc.id]);
      continue;
    }

    if (!KILLABLE_ROLES.has(proc.role)) {
      aliveRetired.push(proc);
      continue;
    }

    if (proc.retired_at) {
      const retiredAtMs = new Date(proc.retired_at + 'Z').getTime();
      if (Date.now() - retiredAtMs < GRACE_PERIOD_MS) continue;
    }

    aliveRetired.push(proc);
    try {
      process.kill(proc.pid, 'SIGTERM');
      killed.push(proc.pid);
      log.warn('Killed orphaned retired process', { pid: proc.pid, role: proc.role });
    } catch { /* already dead */ }
  }

  // Check 3: scan for unknown justclaw processes not in our registry.
  const suspicious = scanForUnknownProcesses(db);
  if (suspicious.length > 0) {
    log.info('Suspicious processes detected', {
      count: suspicious.length,
      processes: suspicious.map((s) => ({ pid: s.pid, score: s.safetyScore, seen: s.timesSeen })),
    });
  }

  // Check 4: if malfunctioning, escalate — kill safe suspicious processes.
  // Skip in debug mode — allows manual repair without auto-kill interference.
  const malfunction = detectMalfunction(db);
  if (malfunction.detected && process.env.JUSTCLAW_DEBUG !== '1') {
    log.warn('Malfunction detected, escalating suspicious process cleanup', { reasons: malfunction.reasons });
    const ESCALATION_SAFETY_THRESHOLD = 70;

    for (const proc of suspicious) {
      if (proc.safetyScore >= ESCALATION_SAFETY_THRESHOLD && proc.timesSeen >= 3) {
        try {
          process.kill(proc.pid, 'SIGTERM');
          killed.push(proc.pid);
          clearSuspicious(db, proc.pid);
          log.warn('Escalation: killed suspicious process', {
            pid: proc.pid,
            score: proc.safetyScore,
            reason: proc.safetyReason,
          });
        } catch { /* already dead */ }
      }
    }
  }

  // Prune old entries.
  db.execute("DELETE FROM process_registry WHERE status = 'retired' AND retired_at < datetime('now', '-7 days')");

  return { deadActive, aliveRetired, killed, suspicious };
}

/**
 * Nudge pm2 to restart stale processes found in the audit.
 * Called separately from audit (not inside it) to keep audit side-effect free.
 * Only nudges dashboard — never restarts discord-bot from within itself.
 */
export function nudgePm2ForStaleProcesses(audit: AuditResult): void {
  for (const proc of audit.aliveRetired) {
    if (proc.role === 'dashboard') {
      try {
        execSync('pm2 restart justclaw-dashboard 2>/dev/null', { timeout: 5000 });
        log.info('Nudged pm2 to restart stale dashboard', { pid: proc.pid });
      } catch { /* pm2 not available */ }
    }
  }
}

// ---------------------------------------------------------------------------
// User-facing suggestions
// ---------------------------------------------------------------------------

/**
 * Generate suggestions for the user about suspicious processes.
 * Returns human-readable text suitable for Discord.
 */
export function getSuggestions(db: DB): string | null {
  const suspicious = getSuspiciousProcesses(db);
  if (suspicious.length === 0) return null;

  const safe = suspicious.filter((s) => s.safetyScore >= 70);
  const uncertain = suspicious.filter((s) => s.safetyScore >= 30 && s.safetyScore < 70);
  const unsafe = suspicious.filter((s) => s.safetyScore < 30);

  const lines: string[] = [];

  if (safe.length > 0) {
    lines.push(`**Safe to kill** (score >= 70):`);
    for (const s of safe) {
      lines.push(`  PID ${s.pid} — score ${s.safetyScore} — ${s.safetyReason}`);
      lines.push(`  \`kill ${s.pid}\``);
    }
  }

  if (uncertain.length > 0) {
    lines.push(`**Uncertain** (score 30-69) — verify before killing:`);
    for (const s of uncertain) {
      lines.push(`  PID ${s.pid} — score ${s.safetyScore} — ${s.safetyReason}`);
      lines.push(`  cmdline: \`${s.cmdline.slice(0, 100)}\``);
    }
  }

  if (unsafe.length > 0) {
    lines.push(`**Do not kill** (score < 30):`);
    for (const s of unsafe) {
      lines.push(`  PID ${s.pid} — ${s.safetyReason}`);
    }
  }

  return lines.join('\n');
}

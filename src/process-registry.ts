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

// Re-export everything from suspicious-tracker so existing imports still work.
export {
  type SuspiciousProcess,
  type MalfunctionState,
  getSuspiciousProcesses,
  getSuggestions,
  detectMalfunction,
  trackSuspicious,
  clearSuspicious,
} from './suspicious-tracker.js';

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

export interface AuditResult {
  deadActive: RegisteredProcess[];
  aliveRetired: RegisteredProcess[];
  killed: number[];
  suspicious: import('./suspicious-tracker.js').SuspiciousProcess[];
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
// Process identity — exported for use by suspicious-tracker
// ---------------------------------------------------------------------------

function getCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch (e: unknown) {
    if (process.platform === 'darwin') {
      try {
        return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', timeout: 5000 }).trim() || null;
      } catch { /* process doesn't exist */ }
    }
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug('getCmdline failed', { pid, error: String(e) });
    }
    return null;
  }
}

/**
 * Get process start time from /proc/<pid>/stat (field 22, in clock ticks since boot).
 * Used to detect PID reuse across reboots.
 */
function getProcessStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const afterComm = stat.indexOf(') ');
    if (afterComm === -1) return null;
    const fields = stat.slice(afterComm + 2).split(' ');
    // After comm, field index 0 = stat field 3. Field 22 = index 19.
    const startTicks = parseInt(fields[19], 10);
    if (isNaN(startTicks)) return null;

    const uptimeStr = readFileSync('/proc/uptime', 'utf-8').split(' ')[0];
    const uptimeSecs = parseFloat(uptimeStr);
    const bootEpochMs = Date.now() - uptimeSecs * 1000;
    const clkTck = 100; // Almost always 100 on Linux (sysconf(_SC_CLK_TCK))
    return bootEpochMs + (startTicks / clkTck) * 1000;
  } catch (e: unknown) {
    if (process.platform === 'darwin') {
      try {
        const lstart = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 5000 }).trim();
        if (!lstart) return null;
        const parsed = new Date(lstart).getTime();
        return isNaN(parsed) ? null : parsed;
      } catch { /* process doesn't exist */ }
    }
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug('getProcessStartTime failed', { pid, error: String(e) });
    }
    return null;
  }
}

/** True if cmdline matches justclaw-managed processes (NOT interactive claude sessions). */
export function isJustclawProcess(cmdline: string): boolean {
  return cmdline.includes('justclaw') ||
    cmdline.includes('dist/discord') ||
    cmdline.includes('dist/dashboard') ||
    cmdline.includes('dist/index');
}

/** True if this looks like an interactive Claude session (user-owned, never touch). */
export function isInteractiveClaudeSession(cmdline: string): boolean {
  if (cmdline.includes('--dangerously-skip-permissions')) return true;
  if (cmdline.includes('claude') && !/ -p /.test(cmdline)) return true;
  return false;
}

/** Cached pm2 PID set — populated once per audit cycle via `loadPm2Pids()`. */
let _pm2PidCache: Set<number> = new Set();

/** Load pm2 PIDs once per audit cycle. */
function loadPm2Pids(): Set<number> {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const apps = JSON.parse(output) as Array<{ pid: number; name: string; pm2_env: { restart_time: number; status: string } }>;
    _pm2PidCache = new Set(apps.filter((a) => a.pid > 0).map((a) => a.pid));
    return _pm2PidCache;
  } catch (e: unknown) {
    log.debug('pm2 jlist failed', { error: String(e) });
    _pm2PidCache = new Set();
    return _pm2PidCache;
  }
}

export function isInPm2(pid: number): boolean {
  return _pm2PidCache.has(pid);
}

export function getSuspiciousKey(pid: number): string {
  return `suspicious_pid_${pid}`;
}

// ---------------------------------------------------------------------------
// Scan for unknown justclaw processes not in our registry
// ---------------------------------------------------------------------------

function scanForUnknownProcesses(db: DB): import('./suspicious-tracker.js').SuspiciousProcess[] {
  // Lazy import to avoid circular dependency at module load time
  const { trackSuspicious } = require('./suspicious-tracker.js') as typeof import('./suspicious-tracker.js');
  const suspicious: import('./suspicious-tracker.js').SuspiciousProcess[] = [];

  // Include pm2 PIDs to prevent flagging pm2-managed processes as suspicious.
  const knownPids = new Set<number>();
  for (const p of getActiveProcesses(db)) knownPids.add(p.pid);
  for (const p of getRetiredProcesses(db)) knownPids.add(p.pid);
  for (const pid of _pm2PidCache) knownPids.add(pid);
  knownPids.add(process.pid);
  knownPids.add(process.ppid);

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
  } catch (e: unknown) {
    if ((e as { status?: number }).status !== 1) {
      log.debug('pgrep scan failed', { error: String(e) });
    }
  }

  return suspicious;
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export function auditProcesses(db: DB): AuditResult {
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
  handleRetiredProcesses(db, aliveRetired, killed);

  // Check 3: scan for unknown justclaw processes not in our registry.
  const suspicious = scanForUnknownProcesses(db);
  if (suspicious.length > 0) {
    log.info('Suspicious processes detected', {
      count: suspicious.length,
      processes: suspicious.map((s) => ({ pid: s.pid, score: s.safetyScore, seen: s.timesSeen })),
    });
  }

  // Check 4: if malfunctioning, escalate — kill safe suspicious processes.
  escalateIfMalfunctioning(db, suspicious, killed);

  // Prune old entries.
  db.execute("DELETE FROM process_registry WHERE status = 'retired' AND retired_at < datetime('now', '-7 days')");

  return { deadActive, aliveRetired, killed, suspicious };
}

/** Kill retired orphan processes that pass safety checks. */
function handleRetiredProcesses(
  db: DB, aliveRetired: RegisteredProcess[], killed: number[],
): void {
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

    // PID reuse protection: verify process started AFTER registry entry.
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
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        log.warn('Kill orphan failed', { pid: proc.pid, error: String(e) });
      }
    }
  }
}

/** During malfunction, kill suspicious processes with high safety scores. */
function escalateIfMalfunctioning(
  db: DB,
  suspicious: import('./suspicious-tracker.js').SuspiciousProcess[],
  killed: number[],
): void {
  // Lazy import to avoid circular dependency at module load time
  const { detectMalfunction, clearSuspicious } = require('./suspicious-tracker.js') as typeof import('./suspicious-tracker.js');

  const malfunction = detectMalfunction(db);
  if (!malfunction.detected || process.env.JUSTCLAW_DEBUG === '1') return;

  log.warn('Malfunction detected, escalating suspicious process cleanup', { reasons: malfunction.reasons });
  const ESCALATION_SAFETY_THRESHOLD = 70;

  for (const proc of suspicious) {
    if (proc.safetyScore >= ESCALATION_SAFETY_THRESHOLD && proc.timesSeen >= 3) {
      try {
        process.kill(proc.pid, 'SIGTERM');
        killed.push(proc.pid);
        clearSuspicious(db, proc.pid);
        log.warn('Escalation: killed suspicious process', {
          pid: proc.pid, score: proc.safetyScore, reason: proc.safetyReason,
        });
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          log.warn('Kill suspicious failed', { pid: proc.pid, error: String(e) });
        }
      }
    }
  }
}

/**
 * Nudge pm2 to restart stale processes found in the audit.
 * Only nudges dashboard — never restarts discord-bot from within itself.
 */
export function nudgePm2ForStaleProcesses(audit: AuditResult): void {
  for (const proc of audit.aliveRetired) {
    if (proc.role === 'dashboard') {
      try {
        execSync('pm2 restart justclaw-dashboard 2>/dev/null', { timeout: 5000 });
        log.info('Nudged pm2 to restart stale dashboard', { pid: proc.pid });
      } catch (e: unknown) {
        log.warn('pm2 restart dashboard failed', { pid: proc.pid, error: String(e) });
      }
    }
  }
}

/**
 * Suspicious process tracking — safety scoring, suggestion generation,
 * and malfunction escalation logic.
 * Extracted from process-registry.ts to keep each file under 500 lines.
 */

import { execSync } from 'child_process';
import type { DB } from './db.js';
import { getLogger } from './logger.js';
import { isPidAlive } from './processes.js';
import {
  isJustclawProcess,
  isInteractiveClaudeSession,
  isInPm2,
  getSuspiciousKey,
} from './process-registry.js';

const log = getLogger('suspicious-tracker');

export interface SuspiciousProcess {
  pid: number;
  cmdline: string;
  firstSeen: string;
  timesSeen: number;
  safetyScore: number;     // 0-100: higher = safer to kill
  safetyReason: string;
}

export interface MalfunctionState {
  detected: boolean;
  reasons: string[];
}

const MAX_SUSPICIOUS_ENTRIES = 50;

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
export function computeSafetyScore(pid: number, cmdline: string, timesSeen: number): number {
  let score = 0;

  if (isJustclawProcess(cmdline)) score += 40;
  if (/ -p /.test(cmdline)) score += 20;
  if (isInteractiveClaudeSession(cmdline)) return 0;
  if (!isInPm2(pid)) score += 10;

  // +5 per heartbeat cycle seen (up to +20): the longer it lingers, the more likely orphan
  score += Math.min(timesSeen * 5, 20);
  if (timesSeen >= 3) score += 10;

  return Math.min(score, 100);
}

export function computeSafetyReason(pid: number, cmdline: string, timesSeen: number): string {
  const parts: string[] = [];

  if (isInteractiveClaudeSession(cmdline)) return 'Interactive claude session — never auto-kill';

  if (isJustclawProcess(cmdline)) parts.push('matches justclaw patterns');
  if (/ -p /.test(cmdline)) parts.push('claude print-mode');
  if (!isInPm2(pid)) parts.push('not managed by pm2');
  if (timesSeen >= 3) parts.push(`seen ${timesSeen} cycles`);
  if (timesSeen < 3) parts.push(`only seen ${timesSeen} cycle(s) — too new`);

  return parts.join(', ') || 'unknown process';
}

// ---------------------------------------------------------------------------
// Suspicious process tracking (SQLite state table)
// ---------------------------------------------------------------------------

export function trackSuspicious(db: DB, pid: number, cmdline: string): SuspiciousProcess {
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

export function clearSuspicious(db: DB, pid: number): void {
  db.execute("DELETE FROM state WHERE key = ?", [getSuspiciousKey(pid)]);
}

export function getSuspiciousProcesses(db: DB): SuspiciousProcess[] {
  const rows = db.fetchall("SELECT key, value FROM state WHERE key LIKE 'suspicious_pid_%'");
  const result: SuspiciousProcess[] = [];
  for (const row of rows) {
    try {
      const proc = JSON.parse(row.value as string) as SuspiciousProcess;
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
    } catch (e: unknown) {
      log.debug('Corrupt suspicious entry, removing', { key: row.key, error: String(e) });
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
// Malfunction detection
// ---------------------------------------------------------------------------

export function detectMalfunction(db: DB): MalfunctionState {
  const reasons: string[] = [];

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
  } catch (e: unknown) { log.debug('Malfunction pm2 check failed', { error: String(e) }); }

  const suspicious = getSuspiciousProcesses(db);
  if (suspicious.length >= 5) {
    reasons.push(`${suspicious.length} suspicious processes detected`);
  }

  return { detected: reasons.length > 0, reasons };
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

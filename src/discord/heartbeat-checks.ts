/**
 * Deterministic heartbeat checks — pure TypeScript, no LLM.
 *
 * Each check returns structured data. The heartbeat aggregates results
 * into severity + issue codes + human-readable summary.
 * Cost: ~0ms (SQL + /proc scan). Replaces ~$0.05/check LLM call.
 */

import { execSync } from 'child_process';
import type { DB } from '../db.js';
import { auditProcesses, nudgePm2ForStaleProcesses, getSuggestions } from '../process-registry.js';
import { isSilenced } from '../alert-manager.js';
import { enforceMemoryExpiry } from '../memory.js';
import { getLogger } from '../logger.js';
import {
  checkStuckTasks, checkDocStaleness, checkEventLoopLag,
  checkMemoryUsage, checkSystemResources, getCycleCount,
} from './heartbeat-checks-extra.js';

const log = getLogger('heartbeat-checks');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  code: string;         // Issue code: GHOSTS, CRASH_LOOP, etc.
  detail: string;       // Human-readable detail
  actions: string[];    // Actions taken (e.g., "Killed PID 1234")
}

export interface HeartbeatReport {
  severity: 'OK' | 'WARN' | 'ALERT';
  issueCodes: string;
  summary: string;
  suggestions: string | null;  // User-facing suggestions for suspicious processes
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Check 1: Process registry audit — kill retired orphans, flag dead active, track suspicious. */
export function checkProcessRegistry(db: DB): CheckResult & { suggestions: string | null } {
  const audit = auditProcesses(db);
  // Nudge pm2 for stale processes (separate from audit to keep audit side-effect free).
  nudgePm2ForStaleProcesses(audit);
  const actions: string[] = [];
  const details: string[] = [];

  if (audit.killed.length > 0) {
    actions.push(`Killed ${audit.killed.length} orphaned process(es): PIDs ${audit.killed.join(', ')}`);
  }
  if (audit.deadActive.length > 0) {
    details.push(`${audit.deadActive.length} active process(es) found dead: ${audit.deadActive.map((p) => `${p.pid}(${p.role})`).join(', ')}`);
  }
  if (audit.suspicious.length > 0) {
    details.push(`${audit.suspicious.length} suspicious process(es) tracked`);
  }

  const hasIssue = audit.killed.length > 0 || audit.deadActive.length > 0;
  const suggestions = getSuggestions(db);

  return {
    ok: !hasIssue,
    code: audit.killed.length > 0 ? 'ORPHANS_KILLED' : audit.deadActive.length > 0 ? 'PROCESS_DOWN' : '',
    detail: details.length > 0 ? details.join('. ') : 'Registry clean',
    actions,
    suggestions,
  };
}

/**
 * Check 2: Stale claude -p processes (running > threshold).
 *
 * CONSERVATIVE POLICY: Only REPORT stale processes found via ps scan.
 * Never auto-kill from ps scan — only the registry audit (Check 1) kills,
 * because it only targets PIDs we explicitly spawned and retired.
 * This prevents accidentally killing user's interactive sessions or
 * processes spawned by other tools.
 */
export function checkStaleClaudeProcesses(maxAgeSeconds = 600): CheckResult {
  try {
    // Match only `claude -p` (print mode), not --dangerously-skip-permissions etc.
    const output = execSync("ps -eo pid,etimes,cmd 2>/dev/null | grep 'claude.*[[:space:]]-p[[:space:]]' | grep -v grep", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!output) return { ok: true, code: '', detail: 'No claude -p processes', actions: [] };

    const stale: Array<{ pid: number; ageMin: number }> = [];
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      const elapsed = parseInt(parts[1], 10);
      if (!isNaN(pid) && !isNaN(elapsed) && elapsed > maxAgeSeconds) {
        if (pid === process.pid || pid === process.ppid) continue;
        stale.push({ pid, ageMin: Math.round(elapsed / 60) });
      }
    }

    if (stale.length === 0) {
      return { ok: true, code: '', detail: 'No stale claude -p', actions: [] };
    }

    // Report only — do NOT kill. The registry audit handles killing.
    const detail = `${stale.length} stale claude -p: ${stale.map((s) => `PID ${s.pid} (${s.ageMin}m)`).join(', ')}`;
    log.warn('Stale claude -p processes detected (report only)', { stale });

    return {
      ok: false,
      code: 'STALE_CLAUDE',
      detail,
      actions: [], // No actions taken — report only
    };
  } catch (e: unknown) {
    // pgrep exits 1 when no matches — only log unexpected errors
    if ((e as { status?: number }).status !== 1) {
      log.debug('Stale claude check failed', { error: String(e) });
    }
    return { ok: true, code: '', detail: 'No claude -p processes', actions: [] };
  }
}

/** Check 3: PM2 health — restart loops and stopped processes.
 * Distinguishes active crash loops from stale restart counters (e.g. dev restarts).
 * A process is only crash-looping if restart_time > threshold AND uptime < 60s.
 * High restart count with stable uptime = stale counter from development. */
export function checkPm2Health(restartThreshold = 5): CheckResult {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const apps = JSON.parse(output) as Array<{
      name: string;
      pid: number;
      pm2_env: { restart_time: number; status: string; pm_uptime: number };
    }>;

    const crashLooping: string[] = [];
    const stopped: string[] = [];
    const staleCounters: string[] = [];
    const STABLE_UPTIME_MS = 60_000; // 60s — if up this long, it's not crash-looping

    for (const app of apps) {
      if (app.pm2_env.status === 'stopped' || app.pm2_env.status === 'errored') {
        stopped.push(`${app.name} (${app.pm2_env.status})`);
      } else if (app.pm2_env.restart_time > restartThreshold) {
        const uptimeMs = Date.now() - (app.pm2_env.pm_uptime || 0);
        if (uptimeMs < STABLE_UPTIME_MS) {
          crashLooping.push(`${app.name} (${app.pm2_env.restart_time} restarts, uptime ${Math.round(uptimeMs / 1000)}s)`);
        } else {
          // Stale counter from dev restarts — auto-reset it
          staleCounters.push(app.name);
          try {
            execSync(`pm2 reset ${app.name} 2>/dev/null`, { timeout: 3000 });
          } catch (e: unknown) { log.debug('pm2 reset failed', { app: app.name, error: String(e) }); }
        }
      }
    }

    const hasIssue = crashLooping.length > 0 || stopped.length > 0;
    const details: string[] = [];
    if (crashLooping.length > 0) details.push(`Crash-looping: ${crashLooping.join(', ')}`);
    if (stopped.length > 0) details.push(`Stopped: ${stopped.join(', ')}`);
    if (staleCounters.length > 0) details.push(`Reset stale counters: ${staleCounters.join(', ')}`);

    const okDetail = staleCounters.length > 0
      ? `${apps.length} processes healthy (reset ${staleCounters.join(', ')} counters)`
      : `${apps.length} processes healthy`;

    return {
      ok: !hasIssue,
      code: stopped.length > 0 ? 'PROCESS_DOWN' : crashLooping.length > 0 ? 'CRASH_LOOP' : '',
      detail: hasIssue ? details.join('. ') : okDetail,
      actions: [],
    };
  } catch (err) {
    return { ok: false, code: 'PROCESS_DOWN', detail: `pm2 query failed: ${String(err).slice(0, 100)}`, actions: [] };
  }
}

/** Check 4: Unanswered Discord messages in the last hour. */
export function checkUnansweredMessages(db: DB, windowMinutes = 60): CheckResult {
  // Find user messages in the window that have no Charlie response after them.
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);

  const unanswered = db.fetchall(
    `SELECT id, sender, substr(message, 1, 80) as msg, created_at
     FROM conversations
     WHERE channel = 'discord' AND is_from_charlie = 0 AND created_at > ?
     AND id > COALESCE((SELECT MAX(id) FROM conversations WHERE channel = 'discord' AND is_from_charlie = 1), 0)
     ORDER BY created_at DESC`,
    [cutoff],
  );

  if (unanswered.length === 0) {
    return { ok: true, code: '', detail: 'No unanswered messages', actions: [] };
  }

  const detail = `${unanswered.length} unanswered message(s) from ${(unanswered[0] as { sender: string }).sender}`;
  return {
    ok: false,
    code: 'UNANSWERED_MSG',
    detail,
    actions: [],
  };
}

/** Check 5: System status — memory count, tasks, daily log. Enforces memory expiry every 12 cycles. */
export function checkSystemStatus(db: DB): CheckResult {
  const actions: string[] = [];

  // Enforce memory expiry every 12 cycles (~1 hour), same cadence as system resources check.
  // getCycleCount() is incremented in checkSystemResources (runs after this check),
  // so use getCycleCount() % 12 === 0 to align with the same hourly cadence.
  if (getCycleCount() % 12 === 0) {
    const expiredCount = enforceMemoryExpiry(db);
    if (expiredCount > 0) {
      log.info('Cleaned expired memories', { count: expiredCount });
      actions.push(`Cleaned ${expiredCount} expired memory/memories`);
    }
  }

  const memCount = (db.fetchone('SELECT COUNT(*) as c FROM memories') as { c: number })?.c || 0;
  const pendingTasks = (db.fetchone("SELECT COUNT(*) as c FROM tasks WHERE status IN ('pending','active')") as { c: number })?.c || 0;
  const todayLogs = (db.fetchone("SELECT COUNT(*) as c FROM daily_log WHERE date = date('now')") as { c: number })?.c || 0;
  const totalConvos = (db.fetchone("SELECT COUNT(*) as c FROM conversations WHERE created_at > datetime('now', '-24 hours')") as { c: number })?.c || 0;

  // Only flag empty memory if system has been up a while (check first conversation timestamp).
  const firstMsg = db.fetchone('SELECT MIN(created_at) as t FROM conversations') as { t: string } | null;
  let systemAgeHours = 0;
  if (firstMsg?.t) {
    systemAgeHours = (Date.now() - new Date(firstMsg.t + 'Z').getTime()) / 3_600_000;
  }

  const emptyAndOld = memCount === 0 && pendingTasks === 0 && systemAgeHours > 24;

  return {
    ok: !emptyAndOld,
    code: emptyAndOld ? 'EMPTY_MEMORY' : '',
    detail: `${memCount} memories, ${pendingTasks} pending tasks, ${todayLogs} log entries, ${totalConvos} messages (24h)`,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** Run all checks and produce a structured report. */
export function runAllChecks(db: DB): HeartbeatReport {
  const checks = [
    checkProcessRegistry(db),
    checkStaleClaudeProcesses(),
    checkPm2Health(),
    checkUnansweredMessages(db),
    checkSystemStatus(db),
    checkStuckTasks(db),
    checkDocStaleness(db),
    checkMemoryUsage(db),
    checkSystemResources(db),
  ];

  // Filter out silenced alerts.
  for (const check of checks) {
    if (!check.ok && check.code && isSilenced(db, check.code)) {
      check.ok = true; // Suppress — treat as OK
      check.detail = `[silenced] ${check.detail}`;
      check.code = '';
    }
  }

  // Collect issue codes and actions.
  const issueCodes = checks
    .filter((c) => !c.ok && c.code)
    .map((c) => c.code);
  const allActions = checks.flatMap((c) => c.actions);

  // Determine severity.
  const hasAlert = checks.some((c) =>
    !c.ok && ['PROCESS_DOWN', 'CRASH_LOOP', 'ORPHANS_KILLED', 'STALE_CLAUDE', 'HIGH_MEMORY'].includes(c.code),
  );
  const hasWarn = checks.some((c) =>
    !c.ok && ['UNANSWERED_MSG', 'STUCK_TASKS', 'EMPTY_MEMORY', 'SYSTEM_RESOURCES'].includes(c.code),
  );

  const severity: 'OK' | 'WARN' | 'ALERT' = hasAlert ? 'ALERT' : hasWarn ? 'WARN' : 'OK';

  // Build summary.
  const lines: string[] = [];
  if (allActions.length > 0) {
    lines.push(`**Actions taken:** ${allActions.join('; ')}`);
  }
  for (const check of checks) {
    if (!check.ok) {
      lines.push(check.detail);
    }
  }
  // Always include the status line.
  const statusCheck = checks.find((c) => c.code === '' && c.detail.includes('memories'));
  if (statusCheck) {
    lines.push(statusCheck.detail);
  }
  const pm2Check = checks.find((c) => c.detail.includes('processes healthy'));
  if (pm2Check && pm2Check.ok) {
    lines.push(pm2Check.detail);
  }

  const summary = lines.join('\n') || 'All systems healthy.';

  // Get suspicious process suggestions from the registry check.
  const registryCheck = checks[0] as CheckResult & { suggestions?: string | null };
  const suggestions = registryCheck.suggestions || null;

  return {
    severity,
    issueCodes: issueCodes.length > 0 ? issueCodes.join(', ') : 'NONE',
    summary,
    suggestions,
    checks,
  };
}

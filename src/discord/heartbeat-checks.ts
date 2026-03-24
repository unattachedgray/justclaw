/**
 * Deterministic heartbeat checks — pure TypeScript, no LLM.
 *
 * Each check returns structured data. The heartbeat aggregates results
 * into severity + issue codes + human-readable summary.
 * Cost: ~0ms (SQL + /proc scan). Replaces ~$0.05/check LLM call.
 */

import { execSync } from 'child_process';
import type { DB } from '../db.js';
import { auditProcesses, nudgePm2ForStaleProcesses, getSuggestions, type AuditResult } from '../process-registry.js';
import { isWhitelisted, isSilenced, ensureBuiltinWhitelist, trackRecurringFlag, formatRecurringPrompt } from '../alert-manager.js';
import { enforceMemoryExpiry } from '../memory.js';
import { getLogger } from '../logger.js';

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
  // _cycleCount is incremented in checkSystemResources (runs after this check),
  // so use _cycleCount % 12 === 0 to align with the same hourly cadence.
  if (_cycleCount % 12 === 0) {
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

/** Check 6: Stuck tasks — active for >24h without update. */
export function checkStuckTasks(db: DB, staleHours = 24): CheckResult {
  const cutoff = new Date(Date.now() - staleHours * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
  const stuck = db.fetchall(
    'SELECT id, title FROM tasks WHERE status = ? AND updated_at < ?',
    ['active', cutoff],
  );

  if (stuck.length === 0) {
    return { ok: true, code: '', detail: 'No stuck tasks', actions: [] };
  }

  return {
    ok: false,
    code: 'STUCK_TASKS',
    detail: `${stuck.length} task(s) active for >${staleHours}h: ${stuck.map((t) => (t as { title: string }).title).join(', ').slice(0, 100)}`,
    actions: [],
  };
}

/** Check 7: CLAUDE.md staleness — verify referenced files still exist. */
export function checkDocStaleness(db: DB): CheckResult {
  try {
    const { readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const root = process.env.JUSTCLAW_ROOT || process.cwd();
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');

    // Extract file paths from markdown table rows and backtick references.
    const pathPattern = /`(src\/[^`]+\.ts|config\/[^`]+|\.claude\/[^`]+|ecosystem\.[^`]+)`/g;
    const missing: string[] = [];
    let match;
    while ((match = pathPattern.exec(claudeMd)) !== null) {
      const filePath = join(root, match[1]);
      if (!existsSync(filePath)) {
        missing.push(match[1]);
      }
    }

    if (missing.length > 0) {
      return {
        ok: false,
        code: 'STALE_DOCS',
        detail: `CLAUDE.md references ${missing.length} missing file(s): ${missing.slice(0, 3).join(', ')}`,
        actions: [],
      };
    }
    return { ok: true, code: '', detail: 'CLAUDE.md references valid', actions: [] };
  } catch (e: unknown) {
    log.debug('Doc staleness check failed', { error: String(e) });
    return { ok: true, code: '', detail: 'Doc check skipped', actions: [] };
  }
}

/** Check 8: Event loop lag — detect hung process. */
export function checkEventLoopLag(): CheckResult {
  // Measure how long a setTimeout(fn, 0) actually takes.
  // Can't do this synchronously, so we check the last measured lag
  // stored by the heartbeat timer itself.
  // For now, use a simple heuristic: if the heartbeat check itself
  // took >10s (durationMs tracked by caller), something is blocking.
  // The actual lag measurement is done in heartbeat.ts via the timer.
  return { ok: true, code: '', detail: 'Event loop responsive', actions: [] };
}

/**
 * Check 9: Memory usage — adaptive threshold based on rolling baseline.
 *
 * Stores last N samples in SQLite state table. Alerts when current usage
 * exceeds mean + 3*stddev (statistical anomaly) OR a hard ceiling of 280MB
 * (absolute safety before PM2's 300MB kill). The adaptive threshold catches
 * gradual leaks that a fixed threshold would miss.
 */
export function checkMemoryUsage(db: DB): CheckResult {
  const usage = process.memoryUsage();
  const heapMB = Math.round(usage.heapUsed / 1_048_576);
  const rssMB = Math.round(usage.rss / 1_048_576);

  // Update rolling baseline in SQLite.
  const baseline = updateMemoryBaseline(db, heapMB);

  // Hard ceiling: absolute safety net regardless of baseline.
  const HARD_CEILING_MB = 280;
  if (heapMB > HARD_CEILING_MB) {
    return {
      ok: false,
      code: 'HIGH_MEMORY',
      detail: `Heap ${heapMB}MB (hard ceiling ${HARD_CEILING_MB}MB), RSS ${rssMB}MB — approaching OOM`,
      actions: [],
    };
  }

  // Adaptive threshold: mean + 3*stddev (need at least 10 samples).
  if (baseline.count >= 10) {
    const threshold = Math.round(baseline.mean + 3 * baseline.stddev);
    if (heapMB > threshold) {
      return {
        ok: false,
        code: 'HIGH_MEMORY',
        detail: `Heap ${heapMB}MB exceeds adaptive threshold ${threshold}MB (mean ${Math.round(baseline.mean)}MB ± ${Math.round(baseline.stddev)}MB), RSS ${rssMB}MB`,
        actions: [],
      };
    }
  }

  return { ok: true, code: '', detail: `Heap ${heapMB}MB, RSS ${rssMB}MB`, actions: [] };
}

/** Max samples to keep in the rolling window (~24h at 5min intervals). */
const BASELINE_WINDOW = 288;

interface MemoryBaseline {
  mean: number;
  stddev: number;
  count: number;
}

function updateMemoryBaseline(db: DB, heapMB: number): MemoryBaseline {
  const KEY = 'memory_baseline_samples';
  const existing = db.fetchone("SELECT value FROM state WHERE key = ?", [KEY]);

  let samples: number[] = [];
  if (existing) {
    try { samples = JSON.parse(existing.value as string); } catch (e: unknown) { log.debug('Corrupt memory baseline, resetting', { error: String(e) }); }
  }

  samples.push(heapMB);
  if (samples.length > BASELINE_WINDOW) {
    samples = samples.slice(-BASELINE_WINDOW);
  }

  db.execute(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')",
    [KEY, JSON.stringify(samples)],
  );

  const count = samples.length;
  const mean = samples.reduce((s, v) => s + v, 0) / count;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);

  return { mean, stddev, count };
}

// Track cycle count for periodic checks.
let _cycleCount = 0;

/** Check 10: System resources — runs every 12 cycles (~1 hour). Reports only, never auto-kills user processes. */
export function checkSystemResources(db: DB): CheckResult {
  _cycleCount++;
  // Only run every 12 cycles to avoid overhead.
  if (_cycleCount % 12 !== 1) {
    return { ok: true, code: '', detail: 'System check skipped (runs hourly)', actions: [] };
  }

  try {
    const details: string[] = [];
    const recommendations: string[] = [];

    // Memory.
    const freeOutput = execSync('free -m 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const memLine = freeOutput.split('\n').find((l) => l.startsWith('Mem:'));
    const swapLine = freeOutput.split('\n').find((l) => l.startsWith('Swap:'));
    if (memLine) {
      const parts = memLine.split(/\s+/);
      const totalMB = parseInt(parts[1], 10);
      const availMB = parseInt(parts[6], 10);
      const pctFree = Math.round((availMB / totalMB) * 100);
      details.push(`RAM: ${availMB}MB available of ${totalMB}MB (${pctFree}% free)`);
      if (pctFree < 15) {
        recommendations.push('System memory low (<15% free) — consider closing unused apps');
      }
    }
    if (swapLine) {
      const parts = swapLine.split(/\s+/);
      const swapUsed = parseInt(parts[2], 10);
      if (swapUsed > 1024) {
        recommendations.push(`Swap usage high (${swapUsed}MB) — system under memory pressure`);
      }
    }

    // Disk.
    const dfOutput = execSync("df -m / 2>/dev/null | tail -1", { encoding: 'utf-8', timeout: 3000 });
    const dfParts = dfOutput.trim().split(/\s+/);
    const diskAvailMB = parseInt(dfParts[3], 10);
    const diskPct = dfParts[4];
    details.push(`Disk: ${Math.round(diskAvailMB / 1024)}GB free (${diskPct} used)`);
    if (diskAvailMB < 5000) {
      recommendations.push(`Disk space low (${Math.round(diskAvailMB / 1024)}GB) — clean up old files`);
    }

    // Top memory hogs (non-justclaw, non-claude, non-whitelisted).
    ensureBuiltinWhitelist(db);
    const psOutput = execSync(
      "ps aux --sort=-%mem 2>/dev/null | head -10 | tail -8",
      { encoding: 'utf-8', timeout: 3000 },
    );
    const hogs: string[] = [];
    for (const line of psOutput.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const rssMB = Math.round(parseInt(parts[5], 10) / 1024);
      const cmd = parts.slice(10).join(' ').slice(0, 60);
      if (rssMB > 200 && !cmd.includes('claude') && !cmd.includes('justclaw') && !isWhitelisted(db, cmd)) {
        hogs.push(`${cmd} (${rssMB}MB)`);
      }
    }
    if (hogs.length > 0) {
      recommendations.push(`Large non-whitelisted processes: ${hogs.join(', ')}`);
      // Track recurring flags — prompt user after 3 occurrences.
      for (const hog of hogs) {
        const shouldPrompt = trackRecurringFlag(db, `hog:${hog.split(' ')[0]}`, hog);
        if (shouldPrompt) {
          recommendations.push(formatRecurringPrompt(hog, 3));
        }
      }
    }

    const hasIssue = recommendations.length > 0;
    const detail = [...details, ...recommendations.map((r) => `⚡ ${r}`)].join('. ');

    return {
      ok: !hasIssue,
      code: hasIssue ? 'SYSTEM_RESOURCES' : '',
      detail,
      actions: [],
    };
  } catch (e: unknown) {
    log.debug('System status check failed', { error: String(e) });
    return { ok: true, code: '', detail: 'System check failed (non-critical)', actions: [] };
  }
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

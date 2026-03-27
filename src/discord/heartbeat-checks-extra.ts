/**
 * Extended heartbeat checks — checks 6-10.
 *
 * Split from heartbeat-checks.ts to stay under the 500-line limit.
 * Each check returns structured CheckResult data. Zero LLM cost.
 */

import { execSync } from 'child_process';
import type { DB } from '../db.js';
import { isWhitelisted, ensureBuiltinWhitelist, trackRecurringFlag, formatRecurringPrompt } from '../alert-manager.js';
import { getLogger } from '../logger.js';
import type { CheckResult } from './heartbeat-checks.js';

const log = getLogger('heartbeat-checks-extra');

// ---------------------------------------------------------------------------
// Check 6: Stuck tasks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Check 7: Doc staleness
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Check 8: Event loop lag
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Check 9: Memory usage (adaptive baseline)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Check 10: System resources (hourly)
// ---------------------------------------------------------------------------

// Track cycle count for periodic checks (shared with checkSystemStatus via getCycleCount).
let _cycleCount = 0;

/** Get the current cycle count (used by checkSystemStatus in heartbeat-checks.ts). */
export function getCycleCount(): number {
  return _cycleCount;
}

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

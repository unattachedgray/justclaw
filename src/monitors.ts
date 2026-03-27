/**
 * Monitor engine — fetch sources, extract values, evaluate conditions, record history.
 *
 * All functions are deterministic and pure where possible. The only side effects
 * are in checkMonitor (writes to DB) and the source fetchers (network/shell).
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import type { DB } from './db.js';
import { cronNext } from './cron.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UrlConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface CommandConfig {
  command: string;
  timeout?: number;
}

export interface UrlResult {
  statusCode: number;
  body: string;
  responseTimeMs: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type SourceResult = UrlResult | CommandResult;

export interface ConditionResult {
  triggered: boolean;
  message: string;
}

export interface CheckResult {
  status: 'ok' | 'alert' | 'error';
  value: string;
  message: string;
}

interface MonitorRow {
  id: number;
  name: string;
  description: string;
  source_type: string;
  source_config: string;
  extractor_type: string;
  extractor_config: string;
  condition_type: string;
  condition_config: string;
  interval_cron: string;
  notify_channel: string | null;
  enabled: number;
  last_value: string | null;
  last_status: string;
  last_checked_at: string | null;
  consecutive_alerts: number;
}

// ---------------------------------------------------------------------------
// Source fetching
// ---------------------------------------------------------------------------

/** Fetch a URL with configurable method, headers, and body. 10s timeout. */
export async function fetchUrl(config: UrlConfig): Promise<UrlResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const resp = await fetch(config.url, {
      method: config.method ?? 'GET',
      headers: config.headers,
      body: config.body,
      signal: controller.signal,
    });
    const body = await resp.text();
    return {
      statusCode: resp.status,
      body,
      responseTimeMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Only allow known-safe commands to prevent injection
const ALLOWED_CMD_PREFIXES = /^(df|free|uptime|curl|pm2|cat|wc|du|echo|date|uname|ss|ps|head|tail|awk|grep|sqlite3)\b/;

/** Execute a shell command with timeout (default 10s). */
export function runCommand(config: CommandConfig): CommandResult {
  if (!ALLOWED_CMD_PREFIXES.test(config.command.trim())) {
    return { stdout: '', stderr: `Command not in allowlist: ${config.command.split(' ')[0]}`, exitCode: 1 };
  }
  const timeout = config.timeout ?? 10_000;
  try {
    const stdout = execSync(config.command, {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: e.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

/** Traverse a simple dot-notation path on a parsed JSON object. */
function dotGet(obj: unknown, path: string): unknown {
  // Strip leading "$." if present (jsonpath convention)
  const clean = path.startsWith('$.') ? path.slice(2) : path;
  let current: unknown = obj;
  for (const key of clean.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Extract a single value from a source result using the configured extractor. */
export function extractValue(
  raw: SourceResult,
  extractorType: string,
  extractorConfig: string,
): string {
  const config = extractorConfig ? JSON.parse(extractorConfig) as Record<string, unknown> : {};

  switch (extractorType) {
    case 'jsonpath': {
      const body = 'body' in raw ? raw.body : '';
      const parsed: unknown = JSON.parse(body);
      const val = dotGet(parsed, String(config.path ?? '$'));
      return val === undefined ? '' : String(val);
    }

    case 'css':
      // TODO(2026-03-24): CSS extraction requires cheerio — not available in pure Node.
      // Falls through to regex as documented.
      return extractValue(raw, 'regex', extractorConfig);

    case 'regex': {
      const body = 'body' in raw ? raw.body : 'stdout' in raw ? raw.stdout : '';
      const match = new RegExp(String(config.pattern ?? '.*')).exec(body);
      return match ? (match[1] ?? match[0]) : '';
    }

    case 'status_code':
      return 'statusCode' in raw ? String(raw.statusCode) : '';

    case 'response_time':
      return 'responseTimeMs' in raw ? String(raw.responseTimeMs) : '';

    case 'body_hash': {
      const body = 'body' in raw ? raw.body : '';
      return createHash('md5').update(body).digest('hex');
    }

    case 'stdout':
      return 'stdout' in raw ? raw.stdout : '';

    case 'exit_code':
      return 'exitCode' in raw ? String(raw.exitCode) : '';

    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/** Evaluate whether a condition is triggered given current and previous values. */
export function evaluateCondition(
  currentValue: string,
  lastValue: string | null,
  conditionType: string,
  conditionConfig: string,
): ConditionResult {
  const config = conditionConfig ? JSON.parse(conditionConfig) as Record<string, unknown> : {};
  const current = parseFloat(currentValue);

  switch (conditionType) {
    case 'threshold_above': {
      const threshold = Number(config.value);
      const triggered = current > threshold;
      return { triggered, message: triggered ? `${current} > ${threshold}` : `${current} <= ${threshold}` };
    }

    case 'threshold_below': {
      const threshold = Number(config.value);
      const triggered = current < threshold;
      return { triggered, message: triggered ? `${current} < ${threshold}` : `${current} >= ${threshold}` };
    }

    case 'change_percent': {
      if (lastValue == null) return { triggered: false, message: 'no previous value' };
      const last = parseFloat(lastValue);
      if (last === 0) return { triggered: true, message: 'previous value was 0' };
      const pct = Math.abs((current - last) / last * 100);
      const threshold = Number(config.percent);
      const triggered = pct > threshold;
      return { triggered, message: triggered ? `changed ${pct.toFixed(1)}% > ${threshold}%` : `changed ${pct.toFixed(1)}% <= ${threshold}%` };
    }

    case 'change_any': {
      if (lastValue == null) return { triggered: false, message: 'no previous value' };
      const triggered = currentValue !== lastValue;
      return { triggered, message: triggered ? `value changed` : `value unchanged` };
    }

    case 'contains': {
      const text = String(config.text ?? '');
      const triggered = currentValue.includes(text);
      return { triggered, message: triggered ? `contains "${text}"` : `missing "${text}"` };
    }

    case 'not_contains': {
      const text = String(config.text ?? '');
      const triggered = !currentValue.includes(text);
      return { triggered, message: triggered ? `missing "${text}"` : `contains "${text}"` };
    }

    case 'regex_match': {
      const pattern = String(config.pattern ?? '.*');
      const triggered = new RegExp(pattern).test(currentValue);
      return { triggered, message: triggered ? `matches /${pattern}/` : `no match /${pattern}/` };
    }

    default:
      return { triggered: false, message: `unknown condition: ${conditionType}` };
  }
}

// ---------------------------------------------------------------------------
// Check orchestrator
// ---------------------------------------------------------------------------

/** Run a single monitor check: fetch -> extract -> evaluate -> persist. */
export async function checkMonitor(db: DB, monitor: MonitorRow | Record<string, unknown>): Promise<CheckResult> {
  // Accept Record<string, unknown> from db.fetchone — cast to typed row
  const mon = monitor as MonitorRow;
  const now = db.now();

  try {
    const sourceConfig = JSON.parse(mon.source_config) as Record<string, unknown>;
    let raw: SourceResult;

    if (mon.source_type === 'url') {
      raw = await fetchUrl(sourceConfig as unknown as UrlConfig);
    } else if (mon.source_type === 'command') {
      raw = runCommand(sourceConfig as unknown as CommandConfig);
    } else {
      return recordResult(db, mon, now, 'error', '', `unknown source_type: ${mon.source_type}`);
    }

    const value = extractValue(raw, mon.extractor_type, mon.extractor_config);
    const condition = evaluateCondition(value, mon.last_value, mon.condition_type, mon.condition_config);

    const status = condition.triggered ? 'alert' : 'ok';
    return recordResult(db, mon, now, status, value, condition.message);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return recordResult(db, mon, now, 'error', '', msg);
  }
}

/** Persist a check result to monitor_history and update the monitor row. */
function recordResult(
  db: DB,
  monitor: MonitorRow,
  now: string,
  status: 'ok' | 'alert' | 'error',
  value: string,
  message: string,
): CheckResult {
  db.execute(
    `INSERT INTO monitor_history (monitor_id, value, status, message, checked_at) VALUES (?, ?, ?, ?, ?)`,
    [monitor.id, value, status, message, now],
  );

  const consecutive = status === 'alert' ? monitor.consecutive_alerts + 1 : 0;
  db.execute(
    `UPDATE monitors SET last_value = ?, last_status = ?, last_checked_at = ?, consecutive_alerts = ?, updated_at = ? WHERE id = ?`,
    [value, status, now, consecutive, now, monitor.id],
  );

  return { status, value, message };
}

/** Query and run all enabled monitors that are due according to their cron schedule. */
export async function checkDueMonitors(db: DB): Promise<Array<CheckResult & { monitorId: number; name: string }>> {
  const monitors = db.fetchall(
    `SELECT * FROM monitors WHERE enabled = 1`,
  ) as unknown as MonitorRow[];

  const now = new Date();
  const results: Array<CheckResult & { monitorId: number; name: string }> = [];

  for (const mon of monitors) {
    if (mon.last_checked_at) {
      const lastChecked = new Date(mon.last_checked_at.replace(' ', 'T') + 'Z');
      const nextDue = cronNext(mon.interval_cron, lastChecked);
      if (nextDue > now) continue;
    }

    const result = await checkMonitor(db, mon);
    results.push({ ...result, monitorId: mon.id, name: mon.name });
  }

  return results;
}

// ---------------------------------------------------------------------------
// History & formatting
// ---------------------------------------------------------------------------

/** Fetch recent history rows for a monitor. */
export function getMonitorHistory(
  db: DB,
  monitorId: number,
  limit: number = 20,
): Record<string, unknown>[] {
  return db.fetchall(
    `SELECT * FROM monitor_history WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?`,
    [monitorId, limit],
  );
}

/** Format a Discord-friendly alert message for a triggered monitor. */
export function formatMonitorAlert(
  monitor: { name: string; description: string; consecutive_alerts: number },
  result: CheckResult,
): string {
  const severity = monitor.consecutive_alerts >= 3 ? 'CRITICAL' : 'ALERT';
  const streak = monitor.consecutive_alerts > 1 ? ` (${monitor.consecutive_alerts}x consecutive)` : '';
  const lines = [
    `**[${severity}] ${monitor.name}**${streak}`,
    monitor.description ? `> ${monitor.description}` : '',
    `Status: \`${result.status}\` | Value: \`${result.value || '(empty)'}\``,
    result.message,
  ];
  return lines.filter(Boolean).join('\n');
}

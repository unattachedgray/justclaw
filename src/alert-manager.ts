/**
 * Alert Manager — silence, acknowledge, and whitelist patterns.
 *
 * Three mechanisms (inspired by Prometheus/PagerDuty/Nagios):
 *
 * 1. SILENCE: suppress a specific alert code for a duration or forever.
 *    Example: "silence SYSTEM_RESOURCES for 24h" — stops Discord posts.
 *
 * 2. PROCESS WHITELIST: known-safe processes that should never be flagged.
 *    Built-in defaults (mysql, tailscale, etc.) + user-added entries.
 *    Checked by system resource monitor before flagging memory hogs.
 *
 * 3. ACKNOWLEDGE: "I see it" — suppresses re-alerting until state changes.
 *    Handled by the existing dedup hash in heartbeat.ts.
 *
 * When the same item is flagged 3+ times, the heartbeat asks the user:
 * "MySQL keeps being flagged (354MB). Reply: !whitelist mysql,
 * !silence SYSTEM_RESOURCES 24h, or !dismiss"
 */

import type { DB } from './db.js';
import { getLogger } from './logger.js';

const log = getLogger('alert-manager');

// ---------------------------------------------------------------------------
// Built-in process whitelist (loaded on first run)
// ---------------------------------------------------------------------------

const BUILTIN_WHITELIST = [
  { pattern: 'mysqld', reason: 'Database server — expected to use significant memory' },
  { pattern: 'postgres', reason: 'Database server' },
  { pattern: 'mongod', reason: 'Database server' },
  { pattern: 'redis-server', reason: 'Cache/message broker' },
  { pattern: 'tailscaled', reason: 'VPN daemon' },
  { pattern: 'docker', reason: 'Container runtime' },
  { pattern: 'containerd', reason: 'Container runtime' },
  { pattern: 'code-server', reason: 'VS Code server' },
  { pattern: 'Xorg', reason: 'Display server' },
  { pattern: 'gnome-shell', reason: 'Desktop environment' },
  { pattern: 'xfwm4', reason: 'Window manager' },
  { pattern: 'snapd', reason: 'Package manager daemon' },
];

/** Load built-in whitelist entries (idempotent — skips existing). */
export function ensureBuiltinWhitelist(db: DB): void {
  for (const entry of BUILTIN_WHITELIST) {
    try {
      db.execute(
        "INSERT OR IGNORE INTO process_whitelist (pattern, reason, source) VALUES (?, ?, 'builtin')",
        [entry.pattern, entry.reason],
      );
    } catch { /* table may not exist yet on first migration */ }
  }
}

// ---------------------------------------------------------------------------
// Process whitelist
// ---------------------------------------------------------------------------

/** Check if a process name/cmdline matches the whitelist. */
export function isWhitelisted(db: DB, cmdline: string): boolean {
  try {
    const entries = db.fetchall('SELECT pattern FROM process_whitelist');
    for (const entry of entries) {
      if (cmdline.includes(entry.pattern as string)) return true;
    }
  } catch { /* table may not exist */ }
  return false;
}

/** Add a process pattern to the whitelist. */
export function addToWhitelist(db: DB, pattern: string, reason = ''): void {
  db.execute(
    "INSERT OR IGNORE INTO process_whitelist (pattern, reason, source) VALUES (?, ?, 'user')",
    [pattern, reason],
  );
  log.info('Added to process whitelist', { pattern, reason });
}

/** Remove from whitelist. */
export function removeFromWhitelist(db: DB, pattern: string): void {
  db.execute('DELETE FROM process_whitelist WHERE pattern = ?', [pattern]);
  log.info('Removed from process whitelist', { pattern });
}

/** Get all whitelist entries. */
export function getWhitelist(db: DB): Array<{ pattern: string; reason: string; source: string }> {
  try {
    return db.fetchall('SELECT pattern, reason, source FROM process_whitelist ORDER BY source, pattern') as
      unknown as Array<{ pattern: string; reason: string; source: string }>;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Alert silences
// ---------------------------------------------------------------------------

/**
 * Silence an alert code.
 * @param matcher — alert code to silence (e.g., 'SYSTEM_RESOURCES', 'UNANSWERED_MSG')
 * @param durationMinutes — how long to silence. 0 = forever.
 */
export function silenceAlert(db: DB, matcher: string, durationMinutes = 0, reason = ''): void {
  const expiresAt = durationMinutes > 0
    ? new Date(Date.now() + durationMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    : null;
  db.execute(
    'INSERT INTO alert_silences (matcher, reason, type, expires_at) VALUES (?, ?, ?, ?)',
    [matcher, reason, 'silence', expiresAt],
  );
  log.info('Alert silenced', { matcher, durationMinutes, reason });
}

/** Check if an alert code is currently silenced. */
export function isSilenced(db: DB, code: string): boolean {
  try {
    // Check for active (non-expired) silence matching this code.
    const row = db.fetchone(
      "SELECT id FROM alert_silences WHERE matcher = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
      [code],
    );
    return row !== null;
  } catch {
    return false;
  }
}

/** Remove a silence. */
export function unsilenceAlert(db: DB, matcher: string): void {
  db.execute('DELETE FROM alert_silences WHERE matcher = ?', [matcher]);
  log.info('Alert unsilenced', { matcher });
}

/** Get all active silences. */
export function getActiveSilences(db: DB): Array<{ matcher: string; reason: string; expires_at: string | null }> {
  try {
    return db.fetchall(
      "SELECT matcher, reason, expires_at FROM alert_silences WHERE expires_at IS NULL OR expires_at > datetime('now')",
    ) as unknown as Array<{ matcher: string; reason: string; expires_at: string | null }>;
  } catch {
    return [];
  }
}

/** Prune expired silences. */
export function pruneExpiredSilences(db: DB): void {
  db.execute("DELETE FROM alert_silences WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
}

// ---------------------------------------------------------------------------
// Recurring flag tracking — ask user to decide after N repeats
// ---------------------------------------------------------------------------

const RECURRING_THRESHOLD = 3; // Ask user after this many flags

interface RecurringFlag {
  key: string;
  count: number;
  lastSeen: string;
  detail: string;
}

/** Track a recurring flag. Returns true if the threshold is reached and user should be prompted. */
export function trackRecurringFlag(db: DB, key: string, detail: string): boolean {
  const stateKey = `recurring_flag_${key}`;
  const existing = db.fetchone('SELECT value FROM state WHERE key = ?', [stateKey]);

  let flag: RecurringFlag;
  if (existing) {
    flag = JSON.parse(existing.value as string);
    flag.count++;
    flag.lastSeen = new Date().toISOString();
    flag.detail = detail;
    db.execute("UPDATE state SET value = ?, updated_at = datetime('now') WHERE key = ?",
      [JSON.stringify(flag), stateKey]);
  } else {
    flag = { key, count: 1, lastSeen: new Date().toISOString(), detail };
    db.execute('INSERT INTO state (key, value) VALUES (?, ?)',
      [stateKey, JSON.stringify(flag)]);
  }

  return flag.count >= RECURRING_THRESHOLD && flag.count % RECURRING_THRESHOLD === 0;
}

/** Clear a recurring flag (user decided). */
export function clearRecurringFlag(db: DB, key: string): void {
  db.execute("DELETE FROM state WHERE key = ?", [`recurring_flag_${key}`]);
}

/** Format a prompt asking user to decide about a recurring flag. */
export function formatRecurringPrompt(detail: string, count: number): string {
  return `🔄 **Recurring alert** (flagged ${count}x):\n${detail}\n\nReply in Discord:\n• \`!whitelist <process>\` — never flag this process again\n• \`!silence <code> <hours>\` — suppress this alert for N hours\n• \`!dismiss\` — ignore for now`;
}

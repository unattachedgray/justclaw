/**
 * Shared timezone utilities for user-facing time display.
 *
 * All internal storage remains UTC. These helpers convert UTC timestamps
 * to the display timezone for user-facing output.
 *
 * Two runtime-settable timezones (both persisted in `state` table):
 *   - **home** (`timezone_home`): the user's default timezone.
 *     Falls back to config.timezone, then America/New_York.
 *   - **current** (`timezone_current`): temporary travel override.
 *     When set, all displays show both: "2:50 PM KST current / 8:50 AM EDT home"
 *     Clear it to revert to home-only display.
 *
 * Usage via MCP:
 *   state_set(key: "timezone_home", value: "America/New_York")
 *   state_set(key: "timezone_current", value: "Asia/Seoul")
 *   state_set(key: "timezone_current", value: "")  ← revert to home
 */

import { loadConfig } from './config.js';

/** Runtime home timezone. Overrides config when set via state_set. */
let homeTimezone: string | null = null;

/** Runtime current timezone (travel override). */
let currentTimezone: string | null = null;

/** Set the home timezone at runtime. Persisted via state key `timezone_home`. */
export function setHomeTimezone(tz: string | null): void {
  homeTimezone = tz || null;
}

/** Set a temporary current timezone. Persisted via state key `timezone_current`. */
export function setCurrentTimezone(tz: string | null): void {
  currentTimezone = tz || null;
}

/** Get the effective home timezone. */
export function getHomeTimezone(): string {
  return homeTimezone || loadConfig().timezone || 'America/New_York';
}

/** Get the current timezone override (null if using home). */
export function getCurrentTimezone(): string | null {
  return currentTimezone;
}

/**
 * Initialize timezone state from DB. Call on boot.
 * Reads `timezone_home` and `timezone_current` from the state table.
 */
export function loadTimezoneState(db: { fetchone: (sql: string, params?: unknown[]) => Record<string, unknown> | null }): void {
  const home = db.fetchone("SELECT value FROM state WHERE key = 'timezone_home'");
  if (home?.value) homeTimezone = home.value as string;

  const current = db.fetchone("SELECT value FROM state WHERE key = 'timezone_current'");
  if (current?.value) currentTimezone = current.value as string;
}

/**
 * Handle a state_set call that might be timezone-related.
 * Returns true if the key was handled, false otherwise.
 */
export function handleTimezoneStateSet(key: string, value: string): boolean {
  if (key === 'timezone_home') {
    setHomeTimezone(value || null);
    return true;
  }
  if (key === 'timezone_current') {
    setCurrentTimezone(value || null);
    return true;
  }
  // Legacy key — map to current for backwards compatibility.
  if (key === 'timezone_override') {
    setCurrentTimezone(value || null);
    return true;
  }
  return false;
}

/** The effective display timezone (current if set, otherwise home). */
function getTz(): string {
  return currentTimezone || getHomeTimezone();
}

/**
 * Format a UTC timestamp string (from SQLite) for user display.
 * Input: "2026-03-27 12:50:00" (UTC, from DB)
 * Output: "8:50 AM EDT" or "Mar 27, 8:50 AM EDT" (with date)
 *
 * When a current timezone override is active, shows both:
 *   "2:50 PM KST current / 8:50 AM EDT home"
 */
export function formatLocalTime(
  utcTimestamp: string,
  opts?: { includeDate?: boolean },
): string {
  const tz = getTz();
  const date = new Date(utcTimestamp.replace(' ', 'T') + 'Z');
  if (isNaN(date.getTime())) return utcTimestamp;

  const timeParts: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
    timeZoneName: 'short',
  };

  if (opts?.includeDate) {
    timeParts.month = 'short';
    timeParts.day = 'numeric';
  }

  const formatted = new Intl.DateTimeFormat('en-US', timeParts).format(date);

  // When current timezone differs from home, show both.
  if (currentTimezone) {
    const homeTz = getHomeTimezone();
    const homeOpts: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: homeTz,
      timeZoneName: 'short',
    };
    const homeFormatted = new Intl.DateTimeFormat('en-US', homeOpts).format(date);
    return `${formatted} current / ${homeFormatted} home`;
  }

  return formatted;
}

/**
 * Format current time for display (e.g., heartbeat presence).
 * Output: "08:50" (24h format in display timezone)
 */
export function formatLocalTimeNow24h(): string {
  const tz = getTz();
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  }).format(new Date());
}

/**
 * Get the current display timezone abbreviation (e.g., "EDT" or "EST").
 */
export function getTimezoneAbbr(): string {
  const tz = getTz();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  }).formatToParts(new Date());
  return parts.find((p) => p.type === 'timeZoneName')?.value || tz;
}

/**
 * Get the SQLite offset string for the display timezone.
 * Returns e.g., "-4 hours" for EDT or "-5 hours" for EST.
 */
export function getSqliteUtcOffset(): string {
  const tz = getTz();
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const localStr = now.toLocaleString('en-US', { timeZone: tz });
  const diffMs = new Date(localStr).getTime() - new Date(utcStr).getTime();
  const diffHours = Math.round(diffMs / 3_600_000);
  return `${diffHours} hours`;
}

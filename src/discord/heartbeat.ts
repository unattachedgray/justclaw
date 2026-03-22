/**
 * Heartbeat module — deterministic health checks, no LLM.
 *
 * Runs inside the Discord bot process on a setInterval.
 * All checks are pure TypeScript: SQL queries, /proc scans,
 * pm2 JSON parsing, PID comparison. Zero LLM cost.
 *
 * Results posted to Discord only when there's something new.
 * OK status shown via bot presence flash (no channel spam).
 */

import { ActivityType, PresenceUpdateStatus, type Client, type TextChannel } from 'discord.js';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { runAllChecks, type HeartbeatReport } from './heartbeat-checks.js';
import { markIssueSeen, markIssueResolved, shouldEscalate, escalate, formatRecommendations } from './escalation.js';

const log = getLogger('heartbeat');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface HeartbeatOpts {
  db: DB;
  client: Client;
  channelId: string;
  intervalMs?: number;
}

/** Number of recent cycles to track for flap detection. */
const FLAP_WINDOW_SIZE = 6;
/** Transitions within the window that trigger flap suppression. */
const FLAP_TRANSITION_THRESHOLD = 4;

interface HeartbeatState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastRunAt: number;
  totalChecks: number;
  consecutiveOks: number;
  consecutiveErrors: number;
  lastAlertHash: string;
  sameAlertCount: number;
  lastSuggestionAt: number;
  /** Sliding window of recent severity values for flap detection. */
  recentSeverities: string[];
  /** Whether we're currently in a flapping state. */
  flapping: boolean;
  /** Timestamp of last flap notification (to avoid spamming). */
  lastFlapNotifyAt: number;
}

export function startHeartbeat(opts: HeartbeatOpts): { stop: () => void; runNow: () => Promise<void> } {
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;

  const state: HeartbeatState = {
    timer: null,
    running: false,
    lastRunAt: 0,
    totalChecks: 0,
    consecutiveOks: 0,
    consecutiveErrors: 0,
    lastAlertHash: '',
    sameAlertCount: 0,
    lastSuggestionAt: 0,
    recentSeverities: [],
    flapping: false,
    lastFlapNotifyAt: 0,
  };

  let presenceTimer: ReturnType<typeof setTimeout> | null = null;

  function flashPresence(severity: string) {
    const icon = severity === 'OK' ? '✅' : severity === 'WARN' ? '⚠️' : '🚨';
    const status: PresenceUpdateStatus = severity === 'OK' ? PresenceUpdateStatus.Online
      : severity === 'WARN' ? PresenceUpdateStatus.Idle
      : PresenceUpdateStatus.DoNotDisturb;
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    opts.client.user?.setPresence({
      status,
      activities: [{ name: `${icon} Heartbeat ${severity} — ${timeStr}`, type: ActivityType.Custom }],
    });

    if (presenceTimer) clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      opts.client.user?.setPresence({
        status: PresenceUpdateStatus.Online,
        activities: [{ name: 'Listening for messages', type: ActivityType.Custom }],
      });
    }, 15_000);
  }

  async function postToDiscord(content: string) {
    try {
      const channel = await opts.client.channels.fetch(opts.channelId);
      if (channel && 'send' in channel) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      log.error('Failed to post heartbeat to Discord', { error: String(err) });
    }
  }

  /** Count state transitions in the sliding window. */
  function detectFlapping(severity: string): boolean {
    state.recentSeverities.push(severity);
    if (state.recentSeverities.length > FLAP_WINDOW_SIZE) {
      state.recentSeverities.shift();
    }
    if (state.recentSeverities.length < 3) return false;

    let transitions = 0;
    for (let i = 1; i < state.recentSeverities.length; i++) {
      if (state.recentSeverities[i] !== state.recentSeverities[i - 1]) {
        transitions++;
      }
    }
    return transitions >= FLAP_TRANSITION_THRESHOLD;
  }

  async function tick() {
    if (state.running) {
      log.info('Heartbeat check already running, skipping');
      return;
    }

    state.running = true;
    state.lastRunAt = Date.now();
    state.totalChecks++;
    const startMs = Date.now();

    try {
      // Run all deterministic checks.
      const report: HeartbeatReport = runAllChecks(opts.db);
      const durationMs = Date.now() - startMs;

      log.info('Heartbeat result', {
        severity: report.severity,
        issueCodes: report.issueCodes,
        durationMs,
      });

      // Log to conversations table.
      opts.db.execute(
        'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
        ['heartbeat', 'charlie', `[${report.severity}] ${report.summary}`, opts.db.now()],
      );

      // Flash presence.
      flashPresence(report.severity);

      // Flap detection: suppress rapid state toggling.
      const wasFlapping = state.flapping;
      state.flapping = detectFlapping(report.severity);

      if (state.flapping) {
        // Notify once when flapping starts, then suppress until stable.
        const FLAP_NOTIFY_INTERVAL_MS = 30 * 60_000;
        if (!wasFlapping || Date.now() - state.lastFlapNotifyAt > FLAP_NOTIFY_INTERVAL_MS) {
          const window = state.recentSeverities.join(' → ');
          await postToDiscord(
            `🔄 **Flapping detected** — alert state toggling rapidly, suppressing notifications until stable.\nRecent: ${window}`,
          );
          state.lastFlapNotifyAt = Date.now();
        }
        log.info('Heartbeat flapping — suppressing', { recentSeverities: state.recentSeverities });
      } else {
        // Normal dedup: same issue codes = same alert = suppress from Discord.
        const alertHash = `${report.severity}:${report.issueCodes}`;

        if (alertHash === state.lastAlertHash) {
          state.sameAlertCount++;
          log.info('Heartbeat dedup — same issue', { severity: report.severity, sameAlertCount: state.sameAlertCount });

          // Re-post ALERTs every 6 cycles (~30min).
          if (report.severity === 'ALERT' && state.sameAlertCount % 6 === 0) {
            await postToDiscord(`🚨 **Heartbeat Alert** _(repeated ${state.sameAlertCount}x)_\n${report.summary}`);
          }
        } else {
          // Exiting flap state — post a recovery notice.
          if (wasFlapping) {
            await postToDiscord(`✅ **Flapping resolved** — alert state stabilized at ${report.severity}.`);
          }

          state.lastAlertHash = alertHash;
          state.sameAlertCount = 1;

          if (report.severity === 'ALERT') {
            await postToDiscord(`🚨 **Heartbeat Alert**\n${report.summary}`);
            state.consecutiveOks = 0;
          } else if (report.severity === 'WARN') {
            await postToDiscord(`⚠️ **Heartbeat Warning**\n${report.summary}`);
            state.consecutiveOks = 0;
          } else {
            state.consecutiveOks++;
          }
        }
      }

      // Post suspicious process suggestions at most once per hour.
      const SUGGESTION_INTERVAL_MS = 60 * 60_000;
      if (report.suggestions && Date.now() - state.lastSuggestionAt > SUGGESTION_INTERVAL_MS) {
        await postToDiscord(`🔍 **Suspicious processes detected:**\n${report.suggestions}`);
        state.lastSuggestionAt = Date.now();
      }

      // Goal-driven escalation: if ALERTs persist, invoke Claude to troubleshoot.
      // Skip escalation during flapping — the issue isn't stable enough to diagnose.
      // Skip escalation in debug mode — allows editing without repair agent interference.
      const debugMode = process.env.JUSTCLAW_DEBUG === '1';
      if (debugMode && report.severity === 'ALERT') {
        log.info('Debug mode active — skipping LLM escalation', { issueCodes: report.issueCodes });
        await postToDiscord(`🔧 **Debug mode** — skipping auto-troubleshooting for: ${report.issueCodes}`);
      } else if (report.severity === 'ALERT' && !state.flapping) {
        // Track each failing issue code.
        for (const code of report.issueCodes.split(', ')) {
          markIssueSeen(`heartbeat:${code}`);
          const esc = shouldEscalate(`heartbeat:${code}`);
          if (esc.should) {
            log.info('Escalating persistent issue to Claude', { code, reason: esc.reason });
            await postToDiscord(`🔧 **Auto-troubleshooting** ${code} — invoking Claude to diagnose...`);
            const result = await escalate(
              opts.db,
              `heartbeat:${code}`,
              report.summary,
              `Issue codes: ${report.issueCodes}\nChecks: ${report.checks.map((c) => `${c.code || 'OK'}: ${c.detail}`).join('\n')}`,
            );
            if (result.diagnosis) {
              const statusIcon = result.resolved ? '✅' : '⚠️';
              let msg = `${statusIcon} **Escalation result** (${code}):\n${result.diagnosis}`;
              if (result.actionTaken) msg += `\n**Action:** ${result.actionTaken}`;
              if (result.recommendation) msg += `\n**Recommendation for next update:** ${result.recommendation}`;
              await postToDiscord(msg);

              // P1: Healing verification — re-run checks after 2min to verify fix actually worked.
              if (result.resolved) {
                setTimeout(async () => {
                  log.info('Healing verification — re-running checks', { code });
                  const verifyReport = runAllChecks(opts.db);
                  if (verifyReport.severity === 'ALERT' && verifyReport.issueCodes.includes(code)) {
                    log.warn('Healing verification FAILED — issue persists after escalation', { code });
                    await postToDiscord(`⚠️ **Healing verification failed** for ${code} — issue persists after escalation fix.`);
                    // Update escalation log to mark as false positive.
                    opts.db.execute(
                      "UPDATE escalation_log SET outcome = 'false_positive' WHERE goal = ? AND outcome = 'resolved' ORDER BY created_at DESC LIMIT 1",
                      [`heartbeat:${code}`],
                    );
                  } else {
                    log.info('Healing verification passed', { code, newSeverity: verifyReport.severity });
                  }
                }, 2 * 60_000); // 2 minutes
              }
            }
          }
        }
      } else {
        // Issue resolved — reset escalation tracking for all goals.
        markIssueResolved('heartbeat:CRASH_LOOP');
        markIssueResolved('heartbeat:PROCESS_DOWN');
        markIssueResolved('heartbeat:ORPHANS_KILLED');
        markIssueResolved('heartbeat:STALE_CLAUDE');
      }

      state.consecutiveErrors = 0;
    } catch (err) {
      state.consecutiveErrors++;
      log.error('Heartbeat check failed', {
        error: String(err),
        consecutiveErrors: state.consecutiveErrors,
      });

      if (state.consecutiveErrors >= 3) {
        await postToDiscord(
          `🚨 **Heartbeat Error** — ${state.consecutiveErrors} consecutive failures\nLast error: ${String(err).slice(0, 200)}`
        );
      }
    } finally {
      state.running = false;
    }
  }

  // Start the interval.
  state.timer = setInterval(tick, intervalMs);
  log.info('Heartbeat started', { intervalMs, channelId: opts.channelId, mode: 'deterministic' });

  // Run first check after a short delay.
  setTimeout(tick, 10_000);

  return {
    stop: () => {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      log.info('Heartbeat stopped');
    },
    runNow: tick,
  };
}

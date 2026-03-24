# Google Chat Bot — Draft Implementation

This document preserves a draft Google Chat bot implementation that was built and then removed from the codebase. It is saved here for future use if justclaw needs to support Google Chat alongside or instead of Discord.

The code was extracted from commit `d3f6e3c`.

## Architecture

- **HTTP webhook via Hono** — Google Chat pushes events to a `/webhook` endpoint; the bot responds asynchronously via the Chat REST API.
- **Per-space queue** — one `claude -p` process at a time per Chat space, with LRU eviction at 50 spaces. Same pattern as the Discord per-channel queue.
- **Cards v2 progress display** — progress messages are updated via PATCH every 5 seconds, staying within Google Chat's 1 write/sec/space rate limit.
- **JWT auth** — service account JSON key is used to mint JWTs, exchanged for access tokens via Google's OAuth2 endpoint. Tokens are cached and auto-refreshed.
- **Standalone from Discord bot** — no imports from `src/discord/`. Reuses shared modules (`claude-spawn.ts`, `session-context.ts`, `db.ts`) but runs as its own pm2 process.
- **Session continuity** — uses the same `sessions` table as the Discord bot for `--resume` support, session rotation, and pre-compaction flush.

## Prerequisites

1. **Google Workspace account** with access to Google Chat
2. **GCP project** with the Google Chat API enabled
3. **Service account** with a JSON key file, granted the `Chat Bots` role
4. **Public HTTPS endpoint** — either a publicly routable server or a Cloudflare Tunnel pointing to the bot's port
5. **Environment variables**:
   - `GCHAT_SERVICE_ACCOUNT_KEY` — path to the service account JSON key file
   - `GCHAT_PORT` — HTTP port for the webhook server (default: `8788`)

## PM2 Config

This snippet was part of `ecosystem.config.cjs`:

```javascript
{
  name: 'justclaw-gchat',
  script: 'dist/gchat/bot.js',
  cwd: ROOT,
  kill_timeout: 10000,
  max_restarts: 10,
  min_uptime: 5000,
  max_memory_restart: '300M',
  wait_ready: true,
  listen_timeout: 15000,
  env: {
    JUSTCLAW_ROOT: ROOT,
    JUSTCLAW_CONFIG: join(ROOT, 'config/charlie.toml'),
    GCHAT_SERVICE_ACCOUNT_KEY: dotenv.GCHAT_SERVICE_ACCOUNT_KEY || '',
    GCHAT_PORT: dotenv.GCHAT_PORT || '8788',
    PATH: process.env.PATH,
  },
},
```

## Source Files

### `src/gchat/bot.ts` — Main entry point

HTTP server (Hono) that receives webhook events from Google Chat. Handles `ADDED_TO_SPACE`, `REMOVED_FROM_SPACE`, and `MESSAGE` events. Manages per-space queues, session persistence, message coalescing, circuit breaker, and graceful shutdown.

```typescript
#!/usr/bin/env node
/**
 * justclaw Google Chat bot — standalone process managed by pm2.
 *
 * Receives messages via HTTP webhook (Google Chat pushes events to us),
 * spawns `claude -p --output-format stream-json --verbose` for processing,
 * and updates a progress message via the Chat API every 5 seconds.
 *
 * Architecture:
 *   - HTTP server (Hono) receives webhook POSTs from Google Chat
 *   - Async processing: respond immediately, then use Chat API for updates
 *   - Reuses shared modules: claude-spawn.ts, session-context.ts, db.ts
 *   - Self-contained: does NOT touch or import from src/discord/
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { resolve } from 'path';
import { DB } from '../db.js';
import { loadConfig, resolveDbPath } from '../config.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import {
  buildIdentityPreamble,
  buildHandoverPrompt,
  buildFlushReminder,
  shouldRotateSession,
  shouldFlushContext,
  invalidatePreambleCache,
  COALESCE_WINDOW_MS,
} from '../discord/session-context.js';
import { toGChatMarkdown, splitGChatMessage } from './formatter.js';
import { GChatClient } from './gchat-client.js';
import { callClaude, activeClaudePids } from './stream.js';
import type { ClaudeResult } from './stream.js';

const log = getLogger('gchat');

const GCHAT_PORT = parseInt(process.env.GCHAT_PORT || '8788', 10);

// ---------------------------------------------------------------------------
// Session persistence (same DB schema as Discord — sessions table)
// ---------------------------------------------------------------------------

function loadSession(db: DB, channelId: string): { sessionId: string; turnCount: number; lastUsedAt: string } | null {
  const row = db.fetchone(
    'SELECT session_id, turn_count, last_used_at FROM sessions WHERE channel_id = ?',
    [channelId],
  );
  if (!row) return null;
  return { sessionId: row.session_id as string, turnCount: row.turn_count as number, lastUsedAt: row.last_used_at as string };
}

function saveSession(db: DB, channelId: string, sessionId: string, turnIncrement: number): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.execute(
    `INSERT INTO sessions (channel_id, session_id, last_used_at, turn_count, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       session_id = excluded.session_id,
       last_used_at = excluded.last_used_at,
       turn_count = turn_count + ?`,
    [channelId, sessionId, now, turnIncrement, now, turnIncrement],
  );
}

function clearSession(db: DB, channelId: string): void {
  db.execute('DELETE FROM sessions WHERE channel_id = ?', [channelId]);
}

function getSessionTurnCount(db: DB, channelId: string): number {
  const row = db.fetchone('SELECT turn_count FROM sessions WHERE channel_id = ?', [channelId]);
  return row ? (row.turn_count as number) : 0;
}

// ---------------------------------------------------------------------------
// Per-space queue
// ---------------------------------------------------------------------------

interface QueuedMessage {
  spaceName: string;
  senderName: string;
  text: string;
  threadKey: string;
}

interface SpaceState {
  sessionId: string | null;
  busy: boolean;
  queue: QueuedMessage[];
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastActiveAt: number;
}

const MAX_SPACE_STATES = 50;
const spaceStates = new Map<string, SpaceState>();
let _botDb: DB | null = null;

function getSpaceState(spaceId: string): SpaceState {
  let state = spaceStates.get(spaceId);
  if (!state) {
    if (spaceStates.size >= MAX_SPACE_STATES) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, s] of spaceStates) {
        if (!s.busy && s.queue.length === 0 && s.lastActiveAt < oldestTime) {
          oldestTime = s.lastActiveAt;
          oldestId = id;
        }
      }
      if (oldestId) spaceStates.delete(oldestId);
    }

    let restoredSessionId: string | null = null;
    if (_botDb) {
      const persisted = loadSession(_botDb, spaceId);
      if (persisted) {
        restoredSessionId = persisted.sessionId;
        log.info('Restored session from DB', { spaceId, sessionId: persisted.sessionId });
      }
    }

    state = {
      sessionId: restoredSessionId, busy: false, queue: [],
      consecutiveFailures: 0, circuitOpenUntil: 0, lastActiveAt: Date.now(),
    };
    spaceStates.set(spaceId, state);
  }
  state.lastActiveAt = Date.now();
  return state;
}

function coalesceMessages(messages: QueuedMessage[]): string {
  if (messages.length === 1) return messages[0].text;
  return messages.map((m) => `[${m.senderName}]: ${m.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// Queue execution
// ---------------------------------------------------------------------------

async function executeQueuedMessages(
  messages: QueuedMessage[],
  spaceId: string,
  state: SpaceState,
  gchat: GChatClient,
  db: DB,
): Promise<void> {
  const primary = messages[0];

  // Session rotation check.
  const persisted = loadSession(db, spaceId);
  const rotationCheck = shouldRotateSession(persisted?.lastUsedAt ?? null, persisted?.turnCount ?? 0);
  if (rotationCheck.rotate && state.sessionId) {
    log.info('Session rotation triggered', { spaceId, reason: rotationCheck.reason });
    try {
      await callClaude(buildHandoverPrompt(), spaceId, state.sessionId, null, gchat, db);
    } catch (err) {
      log.warn('Handover failed, rotating anyway', { error: String(err) });
    }
    state.sessionId = null;
    clearSession(db, spaceId);
    invalidatePreambleCache(spaceId);
  }

  const userContent = coalesceMessages(messages);
  const preamble = buildIdentityPreamble(db, spaceId);
  const fullPrompt = preamble + '\n---\n' + userContent;

  // Send initial progress message.
  let progressMsgName: string | null = null;
  try {
    progressMsgName = await gchat.sendMessage(
      primary.spaceName, '⏳ *Working on your request*\nThinking…', primary.threadKey,
    );
  } catch (err) {
    log.warn('Failed to send progress message', { error: String(err) });
  }

  // Call claude with stale-session retry.
  let result: ClaudeResult;
  try {
    result = await callClaude(fullPrompt, spaceId, state.sessionId, progressMsgName, gchat, db);
  } catch (firstErr) {
    if (state.sessionId) {
      log.warn('Retrying without session (stale session recovery)', { spaceId });
      state.sessionId = null;
      clearSession(db, spaceId);
      invalidatePreambleCache(spaceId);
      result = await callClaude(fullPrompt, spaceId, null, progressMsgName, gchat, db);
    } else {
      throw firstErr;
    }
  }

  state.sessionId = result.sessionId;
  if (result.sessionId) saveSession(db, spaceId, result.sessionId, 1);
  state.consecutiveFailures = 0;

  // Log to conversations.
  db.execute(
    'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
    ['gchat', 'charlie', result.reply, db.now()],
  );

  // Send final response — replace progress message.
  const replyText = result.reply.trim() || '*(completed with no text output)*';
  const gchatText = toGChatMarkdown(replyText);
  const chunks = splitGChatMessage(gchatText);

  if (progressMsgName) {
    try {
      await gchat.updateMessage(progressMsgName, chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await gchat.sendMessage(primary.spaceName, chunks[i], primary.threadKey);
      }
    } catch {
      for (const chunk of chunks) {
        await gchat.sendMessage(primary.spaceName, chunk, primary.threadKey);
      }
    }
  } else {
    for (const chunk of chunks) {
      await gchat.sendMessage(primary.spaceName, chunk, primary.threadKey);
    }
  }

  // Pre-compaction flush check.
  if (result.sessionId) {
    const turnCount = getSessionTurnCount(db, spaceId);
    if (shouldFlushContext(turnCount)) {
      log.info('Triggering pre-compaction flush', { spaceId, turnCount });
      try {
        const flushResult = await callClaude(buildFlushReminder(), spaceId, result.sessionId, null, gchat, db);
        if (flushResult.sessionId) {
          saveSession(db, spaceId, flushResult.sessionId, 1);
          state.sessionId = flushResult.sessionId;
        }
      } catch (err) {
        log.warn('Pre-compaction flush failed', { error: String(err) });
      }
    }
  }
}

async function processQueue(spaceId: string, gchat: GChatClient, db: DB): Promise<void> {
  const state = getSpaceState(spaceId);
  if (state.busy) return;
  if (Date.now() < state.circuitOpenUntil) return;

  if (state.queue.length > 1) {
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS));
  }

  const messages = state.queue.splice(0, state.queue.length);
  if (messages.length === 0) return;

  state.busy = true;
  try {
    await executeQueuedMessages(messages, spaceId, state, gchat, db);
  } catch (err) {
    log.error('Failed to process queue', { error: String(err), spaceId });
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= 3) {
      const cooldownMin = Math.min(5 * Math.pow(2, state.consecutiveFailures - 3), 30);
      state.circuitOpenUntil = Date.now() + cooldownMin * 60_000;
      log.warn('Circuit breaker OPEN', { spaceId, cooldownMin });
      try {
        await gchat.sendMessage(
          messages[0].spaceName,
          `⏸️ Claude has failed ${state.consecutiveFailures} times. Pausing for ${cooldownMin}min.`,
          messages[0].threadKey,
        );
      } catch { /* best effort */ }
    }
  } finally {
    state.busy = false;
    if (state.queue.length > 0) {
      processQueue(spaceId, gchat, db).catch((e) => log.error('Queue error', { error: String(e) }));
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook event types
// ---------------------------------------------------------------------------

interface GChatEvent {
  type: string;
  eventTime: string;
  space: { name: string; type: string; displayName?: string };
  user: { name: string; displayName: string; email?: string };
  message?: {
    name: string;
    text: string;
    thread?: { name: string; threadKey?: string };
    argumentText?: string;
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function createApp(gchat: GChatClient, db: DB): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', service: 'justclaw-gchat' }));

  app.post('/webhook', async (c) => {
    const event = await c.req.json<GChatEvent>();
    log.info('Webhook event', { type: event.type, space: event.space.name, user: event.user.displayName });

    if (event.type === 'ADDED_TO_SPACE') {
      return c.json({ text: 'Hello! I\'m Charlie, your AI agent powered by justclaw. Send me a message and I\'ll help.' });
    }

    if (event.type === 'REMOVED_FROM_SPACE') {
      log.info('Removed from space', { space: event.space.name });
      return c.json({});
    }

    if (event.type === 'MESSAGE' && event.message) {
      const text = (event.message.argumentText || event.message.text || '').trim();
      if (!text) return c.json({ text: 'I didn\'t catch that. Could you try again?' });

      db.execute(
        'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
        ['gchat', event.user.displayName, text, db.now()],
      );

      const spaceId = event.space.name;
      const threadKey = event.message.thread?.threadKey || `jc-${Date.now()}`;
      const state = getSpaceState(spaceId);
      state.queue.push({ spaceName: spaceId, senderName: event.user.displayName, text, threadKey });

      if (state.busy) {
        return c.json({ text: `📥 Queued (position ${state.queue.length}) — I'll get to this next.` });
      }

      processQueue(spaceId, gchat, db).catch((e) => log.error('Queue error', { error: String(e) }));
      return c.json({ text: '⏳ *Working on your request…*' });
    }

    return c.json({});
  });

  return app;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function shutdownChildren(db: DB): Promise<void> {
  for (const pid of activeClaudePids) {
    try { process.kill(-pid, 'SIGTERM'); retireProcess(db, pid); } catch { /* dead */ }
  }
  if (activeClaudePids.size > 0) {
    await new Promise((r) => setTimeout(r, 5_000));
    for (const pid of activeClaudePids) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* dead */ }
    }
  }
}

async function main(): Promise<void> {
  const keyPath = process.env.GCHAT_SERVICE_ACCOUNT_KEY || null;
  if (!keyPath) {
    console.error('\n  ERROR: GCHAT_SERVICE_ACCOUNT_KEY not set');
    console.error('  Set it to the path of your Google Chat service account JSON key file.\n');
    process.exit(1);
  }

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: String(err), stack: err.stack?.slice(0, 500) });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { error: String(reason) });
  });

  const projectRoot = process.env.JUSTCLAW_ROOT || resolve(process.cwd());
  const config = loadConfig(process.env.JUSTCLAW_CONFIG);
  const dbPath = resolveDbPath(config, projectRoot);
  const db = new DB(dbPath);
  _botDb = db;

  registerProcess(db, process.pid, 'discord-bot'); // Reuse role for process registry compat.

  const gchat = new GChatClient(keyPath);
  const app = createApp(gchat, db);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Google Chat bot shutting down');
    await shutdownChildren(db);
    retireProcess(db, process.pid);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  serve({ fetch: app.fetch, port: GCHAT_PORT }, () => {
    log.info('Google Chat bot started', { port: GCHAT_PORT, pid: process.pid });
    console.log(`Google Chat bot listening on port ${GCHAT_PORT}`);
    if (typeof process.send === 'function') process.send('ready');
  });
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
```

### `src/gchat/formatter.ts` — Markdown translation and progress rendering

Translates Discord-flavored markdown to Google Chat's dialect (bold `**` to `*`, links `[text](url)` to `<url|text>`, strips code fence language hints). Splits messages at the 32KB limit. Renders progress phases as both plain text and Cards v2 JSON.

```typescript
/**
 * Google Chat message formatting — markdown dialect translation and Cards v2 builder.
 *
 * Google Chat uses a different markdown dialect than Discord:
 *   - Bold: *text* (not **text**)
 *   - Links: <url|label> (not [label](url))
 *   - Code blocks: ```code``` (no language hints in text messages)
 *   - No typing indicator available
 *   - 32KB message limit (vs Discord's 2000 chars)
 *
 * Cards v2 provide rich structured content for progress display.
 */

/** Google Chat max message size in bytes. */
export const GCHAT_MAX_BYTES = 32_000;

// ---------------------------------------------------------------------------
// Markdown dialect translation
// ---------------------------------------------------------------------------

/**
 * Convert Discord-flavored markdown to Google Chat text format.
 *
 * Handles: bold (**→*), links ([text](url)→<url|text>),
 * strips language hints from code fences.
 */
export function toGChatMarkdown(discord: string): string {
  let text = discord;

  // Bold: **text** → *text* (but avoid converting *** which is bold+italic).
  // Replace ** that aren't part of *** sequences.
  text = text.replace(/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/g, '*$1*');

  // Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Code blocks: ```lang\n → ```\n (strip language hints — GChat ignores them in text).
  text = text.replace(/```\w+\n/g, '```\n');

  return text;
}

/**
 * Split a long message into Google Chat-safe chunks.
 *
 * Much simpler than Discord splitting — 32KB is generous.
 * Only needed for truly massive responses (rare).
 */
export function splitGChatMessage(text: string): string[] {
  // Measure in bytes, not chars (32KB limit is byte-based).
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= GCHAT_MAX_BYTES) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (encoder.encode(remaining).length <= GCHAT_MAX_BYTES) {
      chunks.push(remaining);
      break;
    }

    // Estimate char count for ~30KB (leave margin).
    const targetChars = Math.min(remaining.length, 28_000);
    const window = remaining.slice(0, targetChars);

    // Split on paragraph boundary, then line, then space.
    let splitIdx = window.lastIndexOf('\n\n');
    if (splitIdx <= 0) splitIdx = window.lastIndexOf('\n');
    if (splitIdx <= 0) splitIdx = window.lastIndexOf(' ');
    if (splitIdx <= 0) splitIdx = targetChars;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Cards v2 progress display
// ---------------------------------------------------------------------------

interface ProgressStep {
  tool: string;
  detail: string;
  done: boolean;
}

interface ProgressPhase {
  label: string;
  steps: ProgressStep[];
  done: boolean;
  startedAt: number;
  durationMs: number;
}

interface ProgressData {
  phases: ProgressPhase[];
  startedAt: number;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function elapsed(startMs: number): string {
  return fmtDuration(Date.now() - startMs);
}

/** Short label for a tool name. */
function toolShort(name: string): string {
  if (name.startsWith('mcp__justclaw__')) return `justclaw:${name.slice(15)}`;
  const map: Record<string, string> = {
    Read: 'Read', Edit: 'Edit', Write: 'Write', Bash: 'Bash',
    Glob: 'Glob', Grep: 'Grep', WebSearch: 'WebSearch', WebFetch: 'WebFetch',
    Task: 'Agent', Agent: 'Agent', TaskOutput: 'AgentOutput',
    SendMessage: 'AgentMsg', TodoWrite: 'Todo', ToolSearch: 'ToolSearch',
    NotebookEdit: 'Notebook',
  };
  return map[name] || name;
}

/**
 * Render progress as a plain-text string for Google Chat messages.
 *
 * Uses the same emoji-based format as Discord but without the 2000-char
 * truncation constraint. Updated via message PATCH every 5 seconds.
 */
export function renderProgressText(data: ProgressData): string {
  const lines: string[] = [];
  lines.push(`*Working on your request* _(${elapsed(data.startedAt)})_\n`);

  for (let i = 0; i < data.phases.length; i++) {
    const phase = data.phases[i];
    const num = i + 1;

    if (phase.done) {
      const stepCount = phase.steps.length;
      const dur = fmtDuration(phase.durationMs);
      const summary = stepCount > 0 ? ` _(${stepCount} steps, ${dur})_` : ` _(${dur})_`;
      lines.push(`✅ *Phase ${num}:* ${phase.label}${summary}`);
    } else {
      lines.push(`⏳ *Phase ${num}:* ${phase.label}`);

      const steps = phase.steps;
      const showFrom = Math.max(0, steps.length - 8);
      if (showFrom > 0) {
        lines.push(`   _…${showFrom} earlier steps_`);
      }
      for (let j = showFrom; j < steps.length; j++) {
        const step = steps[j];
        const icon = step.done ? '✅' : '⏳';
        const detail = step.detail ? ` — ${step.detail}` : '';
        lines.push(`   ${icon} ${toolShort(step.tool)}${detail}`);
      }

      lines.push(`   ⏱️ _${elapsed(phase.startedAt)} on this phase_`);
    }
  }

  if (data.phases.length === 0) {
    lines.push('⏳ Thinking…');
  }

  return lines.join('\n');
}

/**
 * Build a Cards v2 JSON structure for progress display.
 *
 * Cards provide richer formatting than plain text and are better suited
 * for structured progress updates. Used as the message body when creating
 * or updating the progress message via the Chat API.
 */
export function renderProgressCard(data: ProgressData): Record<string, unknown> {
  const sections: Record<string, unknown>[] = [];

  for (let i = 0; i < data.phases.length; i++) {
    const phase = data.phases[i];
    const num = i + 1;
    let text: string;

    if (phase.done) {
      const dur = fmtDuration(phase.durationMs);
      const stepCount = phase.steps.length;
      text = `✅ Phase ${num}: ${phase.label} (${stepCount} steps, ${dur})`;
    } else {
      const stepLines: string[] = [];
      const steps = phase.steps;
      const showFrom = Math.max(0, steps.length - 8);
      if (showFrom > 0) stepLines.push(`<i>…${showFrom} earlier steps</i>`);
      for (let j = showFrom; j < steps.length; j++) {
        const s = steps[j];
        const icon = s.done ? '✅' : '⏳';
        const detail = s.detail ? ` — ${s.detail}` : '';
        stepLines.push(`${icon} ${toolShort(s.tool)}${detail}`);
      }
      stepLines.push(`⏱️ <i>${elapsed(phase.startedAt)} on this phase</i>`);
      text = `⏳ Phase ${num}: ${phase.label}\n${stepLines.join('\n')}`;
    }

    sections.push({
      widgets: [{ textParagraph: { text } }],
    });
  }

  if (data.phases.length === 0) {
    sections.push({
      widgets: [{ textParagraph: { text: '⏳ Thinking…' } }],
    });
  }

  return {
    cardsV2: [{
      cardId: 'progress',
      card: {
        header: {
          title: 'Working on your request',
          subtitle: elapsed(data.startedAt),
          imageUrl: '',
          imageType: 'CIRCLE',
        },
        sections,
      },
    }],
  };
}
```

### `src/gchat/gchat-client.ts` — Google Chat API client

REST client for the Google Chat API. Handles JWT-based service account authentication with automatic token refresh. Provides `sendMessage`, `updateMessage`, and `deleteMessage` methods.

```typescript
/**
 * Google Chat API client — service account auth + REST API calls.
 *
 * Uses the Chat API directly to avoid heavy SDK dependencies.
 * Auth flow: service account JSON key → JWT → access token (auto-refreshed).
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';
import { getLogger } from '../logger.js';

const log = getLogger('gchat-client');

export class GChatClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private serviceAccount: {
    client_email: string;
    private_key: string;
    project_id: string;
  } | null = null;

  constructor(private keyPath: string | null) {
    if (keyPath) {
      try {
        this.serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));
        log.info('Service account loaded', { email: this.serviceAccount!.client_email });
      } catch (err) {
        log.error('Failed to load service account key', { path: keyPath, error: String(err) });
      }
    }
  }

  /** Get a valid access token, refreshing if needed. */
  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    if (!this.serviceAccount) {
      throw new Error('No service account configured — set GCHAT_SERVICE_ACCOUNT_KEY');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: this.serviceAccount.client_email,
      sub: this.serviceAccount.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/chat.bot',
    })).toString('base64url');

    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(this.serviceAccount.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${body}`);
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    log.info('Access token refreshed', { expiresIn: data.expires_in });
    return this.accessToken;
  }

  /** Send a text message to a space. Returns the message resource name. */
  async sendMessage(spaceName: string, text: string, threadKey?: string): Promise<string> {
    const token = await this.getToken();
    const body: Record<string, unknown> = { text };
    if (threadKey) {
      body.thread = { threadKey };
    }

    let url = `https://chat.googleapis.com/v1/${spaceName}/messages`;
    if (threadKey) {
      url += '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`sendMessage failed: ${resp.status} ${errBody}`);
    }

    const msg = await resp.json() as { name: string };
    return msg.name;
  }

  /** Update an existing message (for progress display). */
  async updateMessage(messageName: string, text: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(
      `https://chat.googleapis.com/v1/${messageName}?updateMask=text`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      log.warn('updateMessage failed', { status: resp.status, error: errBody.slice(0, 200) });
    }
  }

  /** Delete a message. */
  async deleteMessage(messageName: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(
      `https://chat.googleapis.com/v1/${messageName}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
    );
    if (!resp.ok) {
      log.warn('deleteMessage failed', { status: resp.status });
    }
  }
}
```

### `src/gchat/stream.ts` — Claude CLI streaming and progress tracking

Spawns `claude -p` with `--output-format stream-json --verbose`, parses stream events into progress phases/steps, updates the Google Chat progress message every 5 seconds, and handles inactivity timeouts. Same streaming logic as the Discord bot but standalone.

```typescript
/**
 * Stream event processing for Google Chat bot.
 *
 * Parses Claude's stream-json output into progress phases and steps.
 * Same logic as Discord bot but standalone — no Discord imports.
 */

import { spawn as spawnChild } from 'child_process';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import { findClaudeBin, buildClaudeEnv, buildShellCmd } from '../claude-spawn.js';
import { renderProgressText } from './formatter.js';
import type { GChatClient } from './gchat-client.js';

const log = getLogger('gchat-stream');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Step {
  tool: string;
  detail: string;
  done: boolean;
}

export interface Phase {
  label: string;
  steps: Step[];
  done: boolean;
  startedAt: number;
  durationMs: number;
}

export interface ProgressState {
  phases: Phase[];
  turns: number;
  startedAt: number;
  dirty: boolean;
  hasActiveAgent: boolean;
  pendingText: string;
}

export interface ClaudeResult {
  reply: string;
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_INACTIVITY_MS = 120_000;
const AGENT_INACTIVITY_MS = 300_000;
const PROGRESS_EDIT_INTERVAL_MS = 5_000;

export const activeClaudePids = new Set<number>();

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function isAgentTool(name: string): boolean {
  return ['Task', 'Agent', 'TaskOutput', 'SendMessage'].includes(name);
}

function extractDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (typeof input.file_path === 'string') return (input.file_path as string).split('/').slice(-2).join('/');
  if (typeof input.pattern === 'string') return `"${(input.pattern as string).slice(0, 40)}"`;
  if (typeof input.query === 'string') return `"${(input.query as string).slice(0, 40)}"`;
  if (typeof input.command === 'string') return `\`${(input.command as string).slice(0, 50)}\``;
  if (typeof input.prompt === 'string') return (input.prompt as string).slice(0, 50);
  if (typeof input.description === 'string') return (input.description as string).slice(0, 50);
  return '';
}

function derivePhaseLabel(text: string): string {
  const cleaned = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Working';
  const sentenceMatch = cleaned.match(/^(.+?[.!])\s/);
  const raw = sentenceMatch ? sentenceMatch[1] : cleaned;
  if (raw.length <= 80) return raw;
  const cutoff = raw.lastIndexOf(' ', 80);
  return raw.slice(0, cutoff > 20 ? cutoff : 80) + '…';
}

// ---------------------------------------------------------------------------
// Stream event processing
// ---------------------------------------------------------------------------

function getCurrentPhase(progress: ProgressState): Phase | null {
  const last = progress.phases[progress.phases.length - 1];
  return last && !last.done ? last : null;
}

function ensureActivePhase(progress: ProgressState): Phase {
  let current = getCurrentPhase(progress);
  if (!current) {
    const label = derivePhaseLabel(progress.pendingText);
    progress.pendingText = '';
    current = { label, steps: [], done: false, startedAt: Date.now(), durationMs: 0 };
    progress.phases.push(current);
    progress.dirty = true;
  }
  return current;
}

function closeCurrentPhase(progress: ProgressState): void {
  const current = getCurrentPhase(progress);
  if (current) {
    current.done = true;
    current.durationMs = Date.now() - current.startedAt;
    for (const step of current.steps) step.done = true;
    progress.dirty = true;
  }
}

function processStreamEvent(event: Record<string, unknown>, progress: ProgressState): void {
  const type = event.type as string;

  if (type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;
    progress.turns = Math.max(progress.turns, 1);

    for (const block of content) {
      if (block.type === 'text') {
        const text = (block.text as string) || '';
        if (text.trim()) {
          const current = getCurrentPhase(progress);
          if (current && current.steps.length > 0) closeCurrentPhase(progress);
          progress.pendingText += ' ' + text;
        }
      } else if (block.type === 'tool_use') {
        const toolName = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        const phase = ensureActivePhase(progress);
        const lastStep = phase.steps[phase.steps.length - 1];
        if (lastStep && !lastStep.done) lastStep.done = true;
        phase.steps.push({ tool: toolName, detail: extractDetail(input), done: false });
        progress.dirty = true;
        if (isAgentTool(toolName)) progress.hasActiveAgent = true;
      }
    }
  } else if (type === 'user') {
    const current = getCurrentPhase(progress);
    if (current) {
      const lastStep = current.steps[current.steps.length - 1];
      if (lastStep && !lastStep.done) {
        lastStep.done = true;
        progress.dirty = true;
        if (isAgentTool(lastStep.tool)) progress.hasActiveAgent = false;
      }
    }
    progress.turns++;
  } else if (type === 'result') {
    closeCurrentPhase(progress);
    progress.hasActiveAgent = false;
    progress.dirty = true;
  }
}

function extractResultFromEvent(
  event: Record<string, unknown>,
  state: { finalResult: string; sessionId: string | null; inputTokens: number; outputTokens: number },
): void {
  if (event.type !== 'result') return;
  state.finalResult = (event.result as string) || '';
  const sid = event.session_id as string | undefined;
  if (sid) state.sessionId = sid;
  const usage = event.usage as Record<string, number> | undefined;
  if (usage) {
    state.inputTokens += usage.input_tokens || 0;
    state.outputTokens += usage.output_tokens || 0;
  }
}

// ---------------------------------------------------------------------------
// Claude invocation with streaming + progress updates
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = [
  'mcp__justclaw__*',
  'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
  'Bash(python3:*)', 'Bash(pip:*)', 'Bash(apt:*)', 'Bash(pm2:*)',
  'Bash(curl:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)',
  'Bash(find:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
  'Bash(df:*)', 'Bash(free:*)', 'Bash(ps:*)', 'Bash(uname:*)',
  'Bash(date:*)', 'Bash(echo:*)', 'Bash(mkdir:*)', 'Bash(cp:*)',
  'Bash(mv:*)', 'Bash(chmod:*)', 'Bash(tar:*)', 'Bash(unzip:*)',
  'Bash(jq:*)', 'Bash(sed:*)', 'Bash(awk:*)', 'Bash(sort:*)',
  'Bash(diff:*)', 'Bash(tsc:*)', 'Bash(sqlite3:*)',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
].join(' ');

export function callClaude(
  message: string,
  spaceId: string,
  sessionId: string | null,
  progressMsgName: string | null,
  gchat: GChatClient,
  db: DB,
): Promise<ClaudeResult> {
  const claudeBin = findClaudeBin();
  const args = [
    claudeBin, '-p', message,
    '--output-format', 'stream-json', '--verbose',
    '--allowedTools', ALLOWED_TOOLS,
  ];
  if (sessionId) args.push('--resume', sessionId);

  const shellCmd = buildShellCmd(args);
  log.info('Calling claude (streaming)', { bin: claudeBin, spaceId, hasSession: !!sessionId });

  return new Promise<ClaudeResult>((resolvePromise, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClaudeEnv(spaceId),
    });

    if (child.pid == null) {
      reject(new Error('Failed to spawn claude -p (no PID)'));
      return;
    }
    activeClaudePids.add(child.pid);
    registerProcess(db, child.pid, 'claude-p', `gchat:${spaceId}`);
    log.info('claude -p spawned', { pid: child.pid, spaceId });

    let buffer = '';
    let stderrBuf = '';
    let settled = false;
    const resultState = { finalResult: '', sessionId, inputTokens: 0, outputTokens: 0 };
    const progress: ProgressState = {
      phases: [], turns: 0, startedAt: Date.now(),
      dirty: false, hasActiveAgent: false, pendingText: '',
    };
    const lastActivity = { value: Date.now() };

    // Progress edit timer — 5s interval (within GChat's 1 write/sec/space limit).
    let lastEditAt = 0;
    const progressTimer = setInterval(() => {
      if (!progressMsgName) return;
      const timeSinceEdit = Date.now() - lastEditAt;
      if (!progress.dirty && timeSinceEdit < 15_000) return;
      if (timeSinceEdit < PROGRESS_EDIT_INTERVAL_MS) return;
      progress.dirty = false;
      lastEditAt = Date.now();
      gchat.updateMessage(progressMsgName, renderProgressText(progress)).catch((err) =>
        log.warn('Progress update failed', { error: String(err) }),
      );
    }, PROGRESS_EDIT_INTERVAL_MS);

    // Inactivity watchdog.
    const inactivityTimer = setInterval(() => {
      const timeout = progress.hasActiveAgent ? AGENT_INACTIVITY_MS : BASE_INACTIVITY_MS;
      if (Date.now() - lastActivity.value > timeout) {
        log.warn('Inactivity timeout — killing claude', { spaceId, elapsed: elapsed(progress.startedAt) });
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5_000);
      }
    }, 10_000);

    const cleanup = () => {
      clearInterval(progressTimer);
      clearInterval(inactivityTimer);
      if (child.pid) {
        activeClaudePids.delete(child.pid);
        const tokens = (resultState.inputTokens || resultState.outputTokens)
          ? { input: resultState.inputTokens, output: resultState.outputTokens }
          : undefined;
        retireProcess(db, child.pid, tokens);
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      lastActivity.value = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processStreamEvent(event, progress);
          extractResultFromEvent(event, resultState);
        } catch { log.debug('Stream JSON parse failed', { line: line.slice(0, 120) }); }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      lastActivity.value = Date.now();
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(String(err)));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>;
          processStreamEvent(event, progress);
          extractResultFromEvent(event, resultState);
        } catch { /* skip */ }
      }
      if (code !== 0 && !resultState.finalResult) {
        log.error('claude -p exited non-zero', { code, stderr: stderrBuf.slice(-500) });
        reject(new Error(`claude exited with code ${code}`));
      } else {
        log.info('claude -p completed', {
          spaceId, elapsed: elapsed(progress.startedAt),
          turns: progress.turns, phases: progress.phases.length,
        });
        resolvePromise({ reply: resultState.finalResult, sessionId: resultState.sessionId });
      }
    });
  });
}
```

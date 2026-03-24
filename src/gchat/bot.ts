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

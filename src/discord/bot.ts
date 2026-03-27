#!/usr/bin/env node
/**
 * justclaw Discord bot — standalone process managed by pm2.
 * Per-channel message queue, multi-turn sessions via --resume,
 * streaming progress display, circuit breaker, graceful shutdown.
 */

import {
  Client, Events, GatewayIntentBits,
  type Message,
} from 'discord.js';
import { resolve } from 'path';
import { DB } from '../db.js';
import { loadConfig, resolveDbPath } from '../config.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import { startHeartbeat } from './heartbeat.js';
import {
  buildIdentityPreamble, buildHandoverPrompt, buildFlushReminder,
  shouldRotateSession, shouldFlushContext, invalidatePreambleCache,
  COALESCE_WINDOW_MS,
} from './session-context.js';
import {
  activeClaudePids, callClaude, callClaudeWithRetry, sendFinalResponse,
} from './claude-invoker.js';
import { loadTimezoneState } from '../time-utils.js';
import { classifyMessage, getIntentGuidance } from './message-router.js';

export { activeClaudePids };

const log = getLogger('discord');

// Session persistence helpers

function loadSession(
  db: DB, channelId: string,
): { sessionId: string; turnCount: number; lastUsedAt: string } | null {
  const row = db.fetchone(
    'SELECT session_id, turn_count, last_used_at FROM sessions WHERE channel_id = ?',
    [channelId],
  );
  if (!row) return null;
  return {
    sessionId: row.session_id as string,
    turnCount: row.turn_count as number,
    lastUsedAt: row.last_used_at as string,
  };
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

// Types

interface ChannelState {
  sessionId: string | null;
  busy: boolean;
  queue: Message[];
  consecutiveFailures: number;
  circuitOpenUntil: number;
}

// Per-channel queue

const MAX_CHANNEL_STATES = 100;
const channelStates = new Map<string, ChannelState & { lastActiveAt: number }>();
let _botDb: DB | null = null;

function evictOldestChannelIfNeeded(): void {
  if (channelStates.size < MAX_CHANNEL_STATES) return;
  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, s] of channelStates) {
    if (!s.busy && s.queue.length === 0 && s.lastActiveAt < oldestTime) {
      oldestTime = s.lastActiveAt;
      oldestId = id;
    }
  }
  if (oldestId) channelStates.delete(oldestId);
}

function getChannelState(channelId: string): ChannelState & { lastActiveAt: number } {
  let state = channelStates.get(channelId);
  if (!state) {
    evictOldestChannelIfNeeded();
    let restoredSessionId: string | null = null;
    if (_botDb) {
      const persisted = loadSession(_botDb, channelId);
      if (persisted) {
        restoredSessionId = persisted.sessionId;
        log.info('Restored session from DB', {
          channelId, sessionId: persisted.sessionId, turnCount: persisted.turnCount,
        });
      }
    }
    state = {
      sessionId: restoredSessionId, busy: false, queue: [],
      lastActiveAt: Date.now(), consecutiveFailures: 0, circuitOpenUntil: 0,
    };
    channelStates.set(channelId, state);
  }
  state.lastActiveAt = Date.now();
  return state;
}

function coalesceMessages(messages: Message[]): string {
  if (messages.length === 1) return messages[0].content.trim();
  return messages.map((m) => `[${m.author.username}]: ${m.content.trim()}`).join('\n');
}

// Circuit breaker

async function checkCircuitBreaker(state: ChannelState): Promise<boolean> {
  if (Date.now() >= state.circuitOpenUntil) return false;
  const remaining = Math.ceil((state.circuitOpenUntil - Date.now()) / 60_000);
  const msg = state.queue.shift();
  if (msg) {
    try {
      await msg.reply(`⏸️ Claude API appears to be down. Pausing for ${remaining}min. Your message is saved.`);
    } catch (e: unknown) { log.warn('Discord reply failed (circuit breaker)', { error: String(e) }); }
    state.queue.unshift(msg);
  }
  return true;
}

// Session rotation and flush

async function maybeRotateSession(
  state: ChannelState & { lastActiveAt: number },
  channelId: string, primaryMsg: Message, db: DB,
): Promise<void> {
  const persisted = loadSession(db, channelId);
  const rotationCheck = shouldRotateSession(
    persisted?.lastUsedAt ?? null, persisted?.turnCount ?? 0,
  );
  if (!rotationCheck.rotate || !state.sessionId) return;

  log.info('Session rotation triggered', {
    channelId, reason: rotationCheck.reason, turnCount: persisted?.turnCount,
  });
  try {
    const handoverResult = await callClaude(
      buildHandoverPrompt(), channelId, state.sessionId, null, primaryMsg, db,
    );
    if (handoverResult.reply) {
      db.execute(
        'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
        ['discord', 'charlie', `[handover] ${handoverResult.reply.slice(0, 500)}`, db.now()],
      );
    }
  } catch (err) {
    log.warn('Handover prompt failed, rotating anyway', { error: String(err) });
  }
  state.sessionId = null;
  clearSession(db, channelId);
  invalidatePreambleCache(channelId);
}

async function maybeFlushContext(
  channelId: string, state: ChannelState,
  sessionId: string | null, primaryMsg: Message, db: DB,
): Promise<void> {
  if (!sessionId) return;
  const currentTurnCount = getSessionTurnCount(db, channelId);
  if (!shouldFlushContext(currentTurnCount, db, channelId)) return;

  log.info('Triggering pre-compaction flush', { channelId, turnCount: currentTurnCount });
  try {
    const flushResult = await callClaude(
      buildFlushReminder(), channelId, sessionId, null, primaryMsg, db,
    );
    if (flushResult.sessionId) {
      saveSession(db, channelId, flushResult.sessionId, 1);
      state.sessionId = flushResult.sessionId;
    }
  } catch (err) {
    log.warn('Pre-compaction flush failed', { error: String(err) });
  }
}

// Queue error handling

async function handleQueueError(
  err: unknown, channelId: string, state: ChannelState, primaryMsg: Message,
): Promise<void> {
  log.error('Failed to get Claude response', { error: String(err), channelId });
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= 3) {
    const cooldownMin = Math.min(5 * Math.pow(2, state.consecutiveFailures - 3), 30);
    state.circuitOpenUntil = Date.now() + cooldownMin * 60_000;
    log.warn('Circuit breaker OPEN', { channelId, failures: state.consecutiveFailures, cooldownMin });
    try {
      await primaryMsg.reply(
        `⏸️ Claude has failed ${state.consecutiveFailures} times in a row. Pausing for ${cooldownMin}min.`,
      );
    } catch (e: unknown) { log.warn('Discord reply failed (circuit open)', { error: String(e) }); }
  } else {
    try {
      await primaryMsg.reply(`⚠️ Error: ${String(err).slice(0, 150)}`);
    } catch (e: unknown) { log.warn('Discord reply failed (error notification)', { error: String(e) }); }
  }
}

// Queue execution

async function executeQueuedMessages(
  messages: Message[], channelId: string,
  state: ChannelState & { lastActiveAt: number }, db: DB,
): Promise<void> {
  const primaryMsg = messages[0];
  if (messages.length > 1) {
    log.info('Coalesced messages', { channelId, count: messages.length });
  }

  await maybeRotateSession(state, channelId, primaryMsg, db);

  const userContent = coalesceMessages(messages);
  const preamble = buildIdentityPreamble(db, channelId);

  // Deterministic intent classification — appends focused guidance for known patterns
  const intent = classifyMessage(userContent);
  const guidance = getIntentGuidance(intent);
  const guidanceSuffix = guidance ? `\n[Intent: ${intent}] ${guidance}` : '';
  if (intent !== 'general') {
    log.info('Message classified', { channelId, intent });
  }

  const fullPrompt = preamble + '\n---\n' + userContent + guidanceSuffix;

  let progressMsg: Message | null = null;
  try {
    progressMsg = await primaryMsg.reply('📋 **Working on your request**\n⏳ Thinking…');
  } catch (e: unknown) { log.warn('Failed to send progress message', { error: String(e) }); }

  const result = await callClaudeWithRetry(
    fullPrompt, channelId, state.sessionId, progressMsg, primaryMsg, db, clearSession,
  );
  state.sessionId = result.sessionId;
  if (result.sessionId) saveSession(db, channelId, result.sessionId, 1);
  state.consecutiveFailures = 0;

  db.execute(
    'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
    ['discord', 'charlie', result.reply, db.now()],
  );

  await sendFinalResponse(result.reply, progressMsg, primaryMsg);
  await maybeFlushContext(channelId, state, result.sessionId, primaryMsg, db);
}

async function processQueue(channelId: string, db: DB): Promise<void> {
  const state = getChannelState(channelId);
  if (state.busy) return;
  if (await checkCircuitBreaker(state)) { state.busy = false; return; }

  // Wait briefly for additional messages to coalesce.
  if (state.queue.length > 1) {
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS));
  }
  const messages = state.queue.splice(0, state.queue.length);
  if (messages.length === 0) return;

  state.busy = true;
  try {
    await executeQueuedMessages(messages, channelId, state, db);
  } catch (err) {
    await handleQueueError(err, channelId, state, messages[0]);
  } finally {
    state.busy = false;
    if (state.queue.length > 0) {
      processQueue(channelId, db).catch((e) => log.error('Queue processing error', { error: String(e) }));
    }
  }
}

// Message handling

async function handleInboundMessage(
  message: Message, allowedChannels: string[], db: DB, ready: boolean,
): Promise<void> {
  if (!ready || message.author.bot) return;
  if (allowedChannels.length > 0 && !allowedChannels.includes(message.channelId)) return;
  const content = message.content.trim();
  if (!content) return;

  log.info('Inbound message', {
    sender: message.author.username, channelId: message.channelId, length: content.length,
  });
  db.execute(
    'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
    ['discord', message.author.username, content, db.now()],
  );

  const state = getChannelState(message.channelId);
  state.queue.push(message);

  if (state.busy) {
    try {
      await message.reply(`📥 Queued (position ${state.queue.length}) — I'll get to this next.`);
    } catch (e: unknown) { log.warn('Discord reply failed (queue notification)', { error: String(e) }); }
  } else {
    processQueue(message.channelId, db).catch((e) => log.error('Queue processing error', { error: String(e) }));
  }
}

// Shutdown

async function shutdownChildren(db: DB): Promise<void> {
  for (const pid of activeClaudePids) {
    try {
      process.kill(-pid, 'SIGTERM');
      retireProcess(db, pid);
      log.info('Sent SIGTERM to process group', { pid });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
        log.warn('Shutdown SIGTERM failed', { pid, error: String(e) });
    }
  }
  if (activeClaudePids.size > 0) {
    await new Promise((r) => setTimeout(r, 5000));
    for (const pid of activeClaudePids) {
      try {
        process.kill(-pid, 'SIGKILL');
        log.info('Sent SIGKILL to process group', { pid });
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
          log.warn('Shutdown SIGKILL failed', { pid, error: String(e) });
      }
    }
  }
}

function setupShutdownHandlers(
  db: DB, client: Client, heartbeat: ReturnType<typeof startHeartbeat> | null,
): void {
  let shuttingDown = false;
  const shutdown = async () => {
    log.info('Discord bot shutting down', { activeChildren: activeClaudePids.size });
    if (heartbeat) heartbeat.stop();
    await shutdownChildren(db);
    retireProcess(db, process.pid);
    client.destroy();
    db.close();
    process.exit(0);
  };
  const handleShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown().catch((err) => { log.error('Shutdown error', { error: String(err) }); process.exit(1); });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  process.on('beforeExit', handleShutdown);
}

// Error handlers

function setupGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception (not crashing)', { error: String(err), stack: err.stack?.slice(0, 500) });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection (not crashing)', { error: String(reason) });
  });
}

function setupDiscordErrorHandlers(client: Client): void {
  client.on('error', (err) => log.error('Discord client error', { error: String(err) }));
  client.on('shardError', (err, shardId) => log.error('Discord shard error', { error: String(err), shardId }));
  client.on('shardReconnecting', (shardId) => log.info('Discord shard reconnecting', { shardId }));
  client.on('shardResume', (shardId, replayedEvents) => log.info('Discord shard resumed', { shardId, replayedEvents }));
  client.on('shardDisconnect', (event, shardId) => log.warn('Discord shard disconnected', { shardId, code: event.code }));
}

// Main

function initBotServices(): { token: string; allowedChannels: string[]; db: DB } {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('\n  ERROR: DISCORD_BOT_TOKEN not set in .env\n');
    log.error('DISCORD_BOT_TOKEN not set');
    process.exit(1);
  }
  const allowedChannels = (process.env.DISCORD_CHANNEL_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const projectRoot = process.env.JUSTCLAW_ROOT || resolve(process.cwd());
  const config = loadConfig(process.env.JUSTCLAW_CONFIG);
  const dbPath = resolveDbPath(config, projectRoot);
  const db = new DB(dbPath);
  _botDb = db;
  // Restore timezone settings from persistent state.
  loadTimezoneState(db);
  registerProcess(db, process.pid, 'discord-bot');
  log.info('Discord bot starting', {
    projectRoot, dbPath, pid: process.pid,
    allowedChannels: allowedChannels.length || 'all',
  });
  return { token, allowedChannels, db };
}

function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
    ],
  });
  setupDiscordErrorHandlers(client);
  return client;
}

async function main(): Promise<void> {
  const { token, allowedChannels, db } = initBotServices();
  setupGlobalErrorHandlers();

  let ready = false;
  const client = createDiscordClient();
  const heartbeatChannelId =
    process.env.DISCORD_HEARTBEAT_CHANNEL_ID || process.env.DISCORD_CHANNEL_IDS?.split(',')[0]?.trim() || '';
  const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

  client.once(Events.ClientReady, (c) => {
    log.info('Discord bot connected', { user: c.user.tag });
    console.log(`Discord bot connected as ${c.user.tag}`);
    ready = true;
    if (typeof process.send === 'function') process.send('ready');
    if (heartbeatChannelId) {
      heartbeat = startHeartbeat({ db, client, channelId: heartbeatChannelId, intervalMs: heartbeatIntervalMs });
      log.info('Heartbeat enabled', { channelId: heartbeatChannelId, intervalMs: heartbeatIntervalMs });
    } else {
      log.warn('Heartbeat disabled — no DISCORD_HEARTBEAT_CHANNEL_ID or DISCORD_CHANNEL_IDS set');
    }
  });

  client.on(Events.MessageCreate, (message: Message) => {
    handleInboundMessage(message, allowedChannels, db, ready).catch((e) =>
      log.error('Message handler error', { error: String(e) }),
    );
  });

  setupShutdownHandlers(db, client, heartbeat);
  await client.login(token);
}

main().catch((err) => { log.error('Fatal error', { error: String(err) }); process.exit(1); });

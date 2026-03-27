/**
 * Claude process spawning for interactive Discord messages.
 *
 * Handles streaming progress display, child process lifecycle,
 * inactivity timeouts, and result extraction.
 */

import { spawn as spawnChild } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { AttachmentBuilder, type Message, type TextChannel } from 'discord.js';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import { splitMessage } from './discord-utils.js';
import { findClaudeBin, buildClaudeEnv, buildShellCmd } from '../claude-spawn.js';
import { invalidatePreambleCache } from './session-context.js';
import {
  type ProgressState,
  elapsed,
  getCurrentPhase,
  processStreamEvent,
  renderProgress,
} from './stream-parser.js';

const log = getLogger('discord');

const BASE_INACTIVITY_MS = 120_000;
const AGENT_INACTIVITY_MS = 300_000;
const TYPING_INTERVAL_MS = 8_000;
const PROGRESS_EDIT_INTERVAL_MS = 3_000;

/** Active claude -p child PIDs — tracked so heartbeat can distinguish legitimate from orphan. */
export const activeClaudePids = new Set<number>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeResult {
  reply: string;
  sessionId: string | null;
}

/** Shared mutable state for a single claude -p invocation. */
interface ClaudeStreamState {
  buffer: string;
  stderrBuf: string;
  settled: boolean;
  resultState: ResultState;
  progress: ProgressState;
  lastActivityRef: { value: number };
}

interface ResultState {
  finalResult: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Allowed tools
// ---------------------------------------------------------------------------

/** All tools granted to the Discord bot's claude -p process. */
export const ALLOWED_TOOLS = [
  'mcp__justclaw__*',
  'Bash(git:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(python3:*)',
  'Bash(pip:*)',
  'Bash(apt:*)',
  'Bash(pm2:*)',
  'Bash(curl:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(df:*)',
  'Bash(free:*)',
  'Bash(ps:*)',
  'Bash(uname:*)',
  'Bash(date:*)',
  'Bash(echo:*)',
  'Bash(mkdir:*)',
  'Bash(cp:*)',
  'Bash(mv:*)',
  'Bash(chmod:*)',
  'Bash(tar:*)',
  'Bash(unzip:*)',
  'Bash(jq:*)',
  'Bash(sed:*)',
  'Bash(awk:*)',
  'Bash(sort:*)',
  'Bash(diff:*)',
  'Bash(tsc:*)',
  'Bash(sqlite3:*)',
  'Read', 'Write', 'Edit',
  'Glob', 'Grep',
  'WebSearch', 'WebFetch',
].join(' ');

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

/** Build the argument list for claude -p invocation. */
function buildClaudeArgs(message: string, sessionId: string | null): string[] {
  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', ALLOWED_TOOLS,
  ];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Timer setup
// ---------------------------------------------------------------------------

/** Start typing indicator that keeps Discord showing "bot is typing". */
function startTypingTimer(sourceMsg: Message): NodeJS.Timeout {
  return setInterval(() => {
    if ('sendTyping' in sourceMsg.channel) {
      (sourceMsg.channel as TextChannel).sendTyping().catch(() => {});
    }
  }, TYPING_INTERVAL_MS);
}

/** Start progress message editor that periodically updates the Discord message. */
function startProgressTimer(
  progressMsg: Message | null,
  progress: ProgressState,
): { timer: NodeJS.Timeout; lastEditRef: { value: number } } {
  const lastEditRef = { value: 0 };
  const timer = setInterval(() => {
    const timeSinceEdit = Date.now() - lastEditRef.value;
    if (!progressMsg) return;
    if (!progress.dirty && timeSinceEdit < 10_000) return;
    if (timeSinceEdit < PROGRESS_EDIT_INTERVAL_MS) return;

    progress.dirty = false;
    lastEditRef.value = Date.now();
    const text = renderProgress(progress);
    progressMsg.edit(text).catch(() => {});
  }, PROGRESS_EDIT_INTERVAL_MS);
  return { timer, lastEditRef };
}

/** Start inactivity watchdog that kills stalled claude processes. */
function startInactivityTimer(
  progress: ProgressState,
  channelId: string,
  child: { kill: (signal?: number | NodeJS.Signals) => boolean; pid?: number },
  lastActivityRef: { value: number },
): NodeJS.Timeout {
  return setInterval(() => {
    const timeout = progress.hasActiveAgent ? AGENT_INACTIVITY_MS : BASE_INACTIVITY_MS;
    const idleMs = Date.now() - lastActivityRef.value;

    if (idleMs > timeout) {
      log.warn('Inactivity timeout — killing claude', {
        channelId,
        elapsed: elapsed(progress.startedAt),
        idleMs, timeout,
        hasActiveAgent: progress.hasActiveAgent,
        lastPhase: getCurrentPhase(progress)?.label,
      });
      killChildGracefully(child);
    }
  }, 10_000);
}

/** Send SIGTERM then SIGKILL after 5s. */
function killChildGracefully(
  child: { kill: (signal?: number | NodeJS.Signals) => boolean; pid?: number },
): void {
  try {
    child.kill('SIGTERM');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
      log.warn('SIGTERM failed', { pid: child.pid, error: String(e) });
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
        log.warn('SIGKILL failed', { pid: child.pid, error: String(e) });
    }
  }, 5_000);
}

/** Start all timers and return a cleanup function that stops them. */
function setupClaudeTimers(
  sourceMsg: Message,
  progressMsg: Message | null,
  progress: ProgressState,
  channelId: string,
  child: { kill: (signal?: number | NodeJS.Signals) => boolean; pid?: number },
  lastActivityRef: { value: number },
): () => void {
  const typingTimer = startTypingTimer(sourceMsg);
  const { timer: progressTimer } = startProgressTimer(progressMsg, progress);
  const inactivityTimer = startInactivityTimer(progress, channelId, child, lastActivityRef);

  return () => {
    clearInterval(typingTimer);
    clearInterval(progressTimer);
    clearInterval(inactivityTimer);
  };
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

/** Extract result fields (text, session_id, usage) from a stream event. */
function extractResultFromEvent(
  event: Record<string, unknown>,
  state: ResultState,
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
// Child process wiring
// ---------------------------------------------------------------------------

/** Handle stdout data: parse stream JSON lines and process events. */
function handleStdout(
  chunk: Buffer,
  state: ClaudeStreamState,
): void {
  state.lastActivityRef.value = Date.now();
  state.buffer += chunk.toString();
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      processStreamEvent(event, state.progress);
      extractResultFromEvent(event, state.resultState);
    } catch (e: unknown) {
      log.debug('Stream JSON parse failed', { error: String(e), line: line.slice(0, 120) });
    }
  }
}

/** Handle the child process close event: drain buffer, resolve or reject. */
function handleChildClose(
  code: number | null,
  state: ClaudeStreamState,
  channelId: string,
  resolvePromise: (val: ClaudeResult) => void,
  reject: (err: Error) => void,
): void {
  if (state.buffer.trim()) {
    try {
      const event = JSON.parse(state.buffer) as Record<string, unknown>;
      processStreamEvent(event, state.progress);
      extractResultFromEvent(event, state.resultState);
    } catch (e: unknown) {
      log.debug('Remaining buffer JSON parse failed', { error: String(e) });
    }
  }

  if (code !== 0 && !state.resultState.finalResult) {
    log.error('claude -p exited non-zero', { code, stderr: state.stderrBuf.trim().slice(-500) });
    reject(new Error(`claude exited with code ${code}`));
  } else {
    log.info('claude -p completed', {
      channelId,
      elapsed: elapsed(state.progress.startedAt),
      turns: state.progress.turns,
      phases: state.progress.phases.length,
    });
    resolvePromise({
      reply: state.resultState.finalResult,
      sessionId: state.resultState.sessionId,
    });
  }
}

/** Wire stdout/stderr/error/close handlers onto a spawned claude child process. */
function wireChildHandlers(
  child: ReturnType<typeof spawnChild>,
  state: ClaudeStreamState,
  channelId: string,
  cleanup: () => void,
  resolvePromise: (val: ClaudeResult) => void,
  reject: (err: Error) => void,
): void {
  child.stdout!.on('data', (chunk: Buffer) => handleStdout(chunk, state));

  child.stderr!.on('data', (chunk: Buffer) => {
    state.lastActivityRef.value = Date.now();
    state.stderrBuf += chunk.toString();
    if (state.stderrBuf.length > 2048) state.stderrBuf = state.stderrBuf.slice(-2048);
  });

  child.on('error', (err) => {
    if (state.settled) return;
    state.settled = true;
    cleanup();
    log.error('claude spawn error', { error: String(err) });
    reject(new Error(String(err)));
  });

  child.on('close', (code) => {
    if (state.settled) return;
    state.settled = true;
    cleanup();
    handleChildClose(code, state, channelId, resolvePromise, reject);
  });
}

// ---------------------------------------------------------------------------
// Main callClaude
// ---------------------------------------------------------------------------

/** Build cleanup function that retires the PID and clears timers. */
function buildCleanup(
  clearTimers: () => void,
  child: ReturnType<typeof spawnChild>,
  resultState: ResultState,
  db: DB,
): () => void {
  return () => {
    clearTimers();
    if (child.pid) {
      activeClaudePids.delete(child.pid);
      const tokens = (resultState.inputTokens || resultState.outputTokens)
        ? { input: resultState.inputTokens, output: resultState.outputTokens }
        : undefined;
      retireProcess(db, child.pid, tokens);
    }
  };
}

/** Create initial stream state for a claude -p invocation. */
function createStreamState(sessionId: string | null): ClaudeStreamState {
  const now = Date.now();
  return {
    buffer: '', stderrBuf: '', settled: false,
    resultState: { finalResult: '', sessionId, inputTokens: 0, outputTokens: 0 },
    progress: { phases: [], turns: 0, startedAt: now, dirty: false, hasActiveAgent: false, pendingText: '' },
    lastActivityRef: { value: now },
  };
}

export async function callClaude(
  message: string, channelId: string, sessionId: string | null,
  progressMsg: Message | null, sourceMsg: Message, db: DB,
): Promise<ClaudeResult> {
  const claudeBin = findClaudeBin();
  const args = buildClaudeArgs(message, sessionId);
  log.info('Calling claude (streaming)', { bin: claudeBin, channelId, hasSession: !!sessionId });
  const shellCmd = buildShellCmd([claudeBin, ...args]);

  return new Promise<ClaudeResult>((resolvePromise, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'], env: buildClaudeEnv(channelId),
    });
    if (child.pid == null) { reject(new Error('Failed to spawn claude -p (no PID)')); return; }
    activeClaudePids.add(child.pid);
    registerProcess(db, child.pid, 'claude-p', `channel:${channelId}`);
    log.info('claude -p spawned', { pid: child.pid, channelId });

    const state = createStreamState(sessionId);
    const clearTimers = setupClaudeTimers(
      sourceMsg, progressMsg, state.progress, channelId, child, state.lastActivityRef,
    );
    const cleanup = buildCleanup(clearTimers, child, state.resultState, db);
    wireChildHandlers(child, state, channelId, cleanup, resolvePromise, reject);
  });
}

// ---------------------------------------------------------------------------
// Retry and response helpers
// ---------------------------------------------------------------------------

/** Call claude with stale-session retry: if first call fails with a session, retry without it. */
export async function callClaudeWithRetry(
  fullPrompt: string,
  channelId: string,
  sessionId: string | null,
  progressMsg: Message | null,
  primaryMsg: Message,
  db: DB,
  clearSessionFn: (db: DB, channelId: string) => void,
): Promise<ClaudeResult> {
  try {
    return await callClaude(fullPrompt, channelId, sessionId, progressMsg, primaryMsg, db);
  } catch (firstErr) {
    if (sessionId) {
      log.warn('Retrying without session (stale session recovery)', { channelId });
      clearSessionFn(db, channelId);
      invalidatePreambleCache(channelId);
      return await callClaude(fullPrompt, channelId, null, progressMsg, primaryMsg, db);
    }
    throw firstErr;
  }
}

/** Extract image file paths from response text, return cleaned text + attachments. */
function extractImages(text: string): { cleanText: string; files: AttachmentBuilder[] } {
  // Match both absolute and relative paths to data/images/
  const imagePathRegex = /(?:"|`)?(((?:\/[^\s"`,]+)?\/?)data\/images\/([^\s"`,]+\.(?:png|jpg|jpeg|webp)))(?:"|`)?/gi;
  const files: AttachmentBuilder[] = [];
  const seen = new Set<string>();
  const root = process.env.JUSTCLAW_ROOT || process.cwd();

  for (const match of text.matchAll(imagePathRegex)) {
    const fullMatch = match[0];
    const filename = match[3];
    const absPath = join(root, 'data', 'images', filename);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    try {
      if (existsSync(absPath)) {
        files.push(new AttachmentBuilder(absPath));
      }
    } catch { /* file inaccessible, skip */ }
  }

  // Remove JSON blocks that are just the image tool output
  let cleanText = text.replace(/```json\s*\{[^}]*"image_path"[^}]*\}\s*```/g, '').trim();
  // Remove lines that are just about the saved file path
  cleanText = cleanText.replace(/^.*(?:saved|Saved|path)[^\n]*data\/images\/\S+\.(png|jpg|jpeg|webp)[^\n]*$/gm, '').trim();
  // Collapse multiple blank lines
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, files };
}

/** Replace progress message with final response chunks + image attachments. */
export async function sendFinalResponse(
  replyText: string,
  progressMsg: Message | null,
  primaryMsg: Message,
): Promise<void> {
  const { cleanText, files } = extractImages(replyText);
  const text = cleanText || (files.length > 0 ? '' : '*(completed with no text output)*');
  const chunks = text ? splitMessage(text) : [];
  const channel = primaryMsg.channel as TextChannel;

  if (progressMsg) {
    try {
      await progressMsg.edit(chunks[0] || '*(image generated)*');
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i]);
      }
    } catch (e: unknown) {
      log.warn('Progress message edit failed, sending as new messages', { error: String(e) });
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
  } else {
    for (const chunk of chunks) {
      await primaryMsg.reply(chunk);
    }
  }

  // Send images as attachments
  if (files.length > 0) {
    await channel.send({ files });
  }
}

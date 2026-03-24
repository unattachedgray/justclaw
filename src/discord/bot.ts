#!/usr/bin/env node
/**
 * justclaw Discord bot — standalone process managed by pm2.
 *
 * Features:
 *   - Streams `claude -p --output-format stream-json --verbose` for real-time progress
 *   - Plan/phase-based progress display: groups tool calls under phases derived
 *     from Claude's text output. Completed phases collapse to one-line summaries.
 *     Current phase shows live step-by-step detail.
 *   - Per-channel message queue (one request at a time per channel)
 *   - Adaptive inactivity timeout: extends when sub-agents are spawned
 *   - Recurring typing indicator while processing
 *   - Multi-turn sessions via --resume per channel
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import { spawn as spawnChild } from 'child_process';
import { resolve } from 'path';
import { DB } from '../db.js';
import { loadConfig, resolveDbPath } from '../config.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import { startHeartbeat } from './heartbeat.js';
import { DISCORD_MAX_LENGTH, splitMessage } from './discord-utils.js';
import { findClaudeBin, buildClaudeEnv, buildShellCmd } from '../claude-spawn.js';
import {
  buildIdentityPreamble,
  buildHandoverPrompt,
  buildFlushReminder,
  shouldRotateSession,
  shouldFlushContext,
  invalidatePreambleCache,
  COALESCE_WINDOW_MS,
} from './session-context.js';

const log = getLogger('discord');

/** Active claude -p child PIDs — tracked so heartbeat can distinguish legitimate from orphan. */
export const activeClaudePids = new Set<number>();
const BASE_INACTIVITY_MS = 120_000;    // 2 min base inactivity timeout
const AGENT_INACTIVITY_MS = 300_000;   // 5 min when sub-agents are running
const TYPING_INTERVAL_MS = 8_000;
const PROGRESS_EDIT_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// Session persistence helpers
// ---------------------------------------------------------------------------

/** Load persisted session from DB. */
function loadSession(db: DB, channelId: string): { sessionId: string; turnCount: number; lastUsedAt: string } | null {
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

/** Upsert session after a successful claude -p call. */
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

/** Clear session from DB (on rotation or stale-session retry). */
function clearSession(db: DB, channelId: string): void {
  db.execute('DELETE FROM sessions WHERE channel_id = ?', [channelId]);
}

/** Get session turn count from DB. */
function getSessionTurnCount(db: DB, channelId: string): number {
  const row = db.fetchone('SELECT turn_count FROM sessions WHERE channel_id = ?', [channelId]);
  return row ? (row.turn_count as number) : 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Step {
  tool: string;
  detail: string; // e.g. file path or search query
  done: boolean;
}

interface Phase {
  label: string;      // Derived from Claude's text before tool calls
  steps: Step[];
  done: boolean;
  startedAt: number;
  durationMs: number; // Set when phase completes
}

interface ProgressState {
  phases: Phase[];
  turns: number;
  startedAt: number;
  dirty: boolean;
  hasActiveAgent: boolean; // True when Task/Agent tool is in-flight
  pendingText: string;     // Accumulates assistant text for next phase label
}

interface ChannelState {
  sessionId: string | null;
  busy: boolean;
  queue: Message[];
  // Circuit breaker for claude -p failures (Hystrix half-open pattern).
  consecutiveFailures: number;
  circuitOpenUntil: number;  // Epoch ms — if Date.now() < this, circuit is open (don't spawn)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Short label for a tool. */
function toolShort(name: string): string {
  if (name.startsWith('mcp__justclaw__')) return `justclaw:${name.slice(15)}`;
  const map: Record<string, string> = {
    Read: 'Read',
    Edit: 'Edit',
    Write: 'Write',
    Bash: 'Bash',
    Glob: 'Glob',
    Grep: 'Grep',
    WebSearch: 'WebSearch',
    WebFetch: 'WebFetch',
    Task: 'Agent',
    Agent: 'Agent',
    TaskOutput: 'AgentOutput',
    SendMessage: 'AgentMsg',
    TodoWrite: 'Todo',
    ToolSearch: 'ToolSearch',
    NotebookEdit: 'Notebook',
  };
  return map[name] || name;
}

/** True if this tool represents a sub-agent that can run for a long time. */
function isAgentTool(name: string): boolean {
  return ['Task', 'Agent', 'TaskOutput', 'SendMessage'].includes(name);
}

/** Extract a short detail from tool input (file path, query, etc.) */
function extractDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  // File tools
  if (typeof input.file_path === 'string') {
    const p = input.file_path as string;
    // Show last 2 path segments
    const parts = p.split('/');
    return parts.slice(-2).join('/');
  }
  // Search tools
  if (typeof input.pattern === 'string') return `"${(input.pattern as string).slice(0, 40)}"`;
  if (typeof input.query === 'string') return `"${(input.query as string).slice(0, 40)}"`;
  // Bash
  if (typeof input.command === 'string') {
    const cmd = (input.command as string).slice(0, 50);
    return `\`${cmd}\``;
  }
  // Agent
  if (typeof input.prompt === 'string') return (input.prompt as string).slice(0, 50);
  if (typeof input.description === 'string') return (input.description as string).slice(0, 50);
  return '';
}

/** Derive a phase label from accumulated assistant text. */
function derivePhaseLabel(text: string): string {
  // Take the first meaningful sentence or line.
  const cleaned = text
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'Working';

  // Try to get first sentence.
  const sentenceMatch = cleaned.match(/^(.+?[.!])\s/);
  const raw = sentenceMatch ? sentenceMatch[1] : cleaned;

  // Truncate to reasonable length.
  if (raw.length <= 80) return raw;
  const cutoff = raw.lastIndexOf(' ', 80);
  return raw.slice(0, cutoff > 20 ? cutoff : 80) + '…';
}

// ---------------------------------------------------------------------------
// Progress rendering — plan/phase style
// ---------------------------------------------------------------------------

function renderProgress(state: ProgressState): string {
  const lines: string[] = [];
  const header = `📋 **Working on your request** _(${elapsed(state.startedAt)})_\n`;
  lines.push(header);

  for (let i = 0; i < state.phases.length; i++) {
    const phase = state.phases[i];
    const isLast = i === state.phases.length - 1;
    const phaseNum = i + 1;

    if (phase.done) {
      // Completed phase: one-line summary with step count and duration.
      const stepCount = phase.steps.length;
      const dur = fmtDuration(phase.durationMs);
      const stepSummary = stepCount > 0 ? ` _(${stepCount} steps, ${dur})_` : ` _(${dur})_`;
      lines.push(`✅ **Phase ${phaseNum}:** ${phase.label}${stepSummary}`);
    } else {
      // Active phase: show label + live steps.
      lines.push(`⏳ **Phase ${phaseNum}:** ${phase.label}`);

      // Show steps — last 6 for the active phase to keep message manageable.
      const steps = phase.steps;
      const showFrom = Math.max(0, steps.length - 6);
      if (showFrom > 0) {
        lines.push(`   _…${showFrom} earlier steps_`);
      }
      for (let j = showFrom; j < steps.length; j++) {
        const step = steps[j];
        const icon = step.done ? '✅' : '⏳';
        const detail = step.detail ? ` — ${step.detail}` : '';
        lines.push(`   ${icon} ${toolShort(step.tool)}${detail}`);
      }

      // Show elapsed time on current phase.
      lines.push(`   ⏱️ _${elapsed(phase.startedAt)} on this phase_`);
    }
  }

  if (state.phases.length === 0) {
    lines.push('⏳ Thinking…');
  }

  // Truncate to fit Discord's 2000 char limit.
  let result = lines.join('\n');
  if (result.length > DISCORD_MAX_LENGTH - 50) {
    // Drop older completed phase details to fit.
    result = result.slice(0, DISCORD_MAX_LENGTH - 50) + '\n_…truncated_';
  }
  return result;
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
    current = {
      label,
      steps: [],
      done: false,
      startedAt: Date.now(),
      durationMs: 0,
    };
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
    // Mark any in-progress steps as done.
    for (const step of current.steps) {
      step.done = true;
    }
    progress.dirty = true;
  }
}

/** Process an assistant-type stream event: handle text blocks and tool_use blocks. */
function processAssistantEvent(
  content: Array<Record<string, unknown>>,
  progress: ProgressState,
): void {
  for (const block of content) {
    if (block.type === 'text') {
      const text = (block.text as string) || '';
      if (text.trim()) {
        // Text before tools becomes the next phase label.
        // If we already have an active phase with steps, close it first —
        // new text means Claude is transitioning to a new phase.
        const current = getCurrentPhase(progress);
        if (current && current.steps.length > 0) {
          closeCurrentPhase(progress);
        }
        progress.pendingText += ' ' + text;
      }
    } else if (block.type === 'tool_use') {
      const toolName = block.name as string;
      const input = block.input as Record<string, unknown> | undefined;
      const detail = extractDetail(input);

      const phase = ensureActivePhase(progress);

      const lastStep = phase.steps[phase.steps.length - 1];
      if (lastStep && !lastStep.done) {
        lastStep.done = true;
      }

      phase.steps.push({ tool: toolName, detail, done: false });
      progress.dirty = true;

      if (isAgentTool(toolName)) {
        progress.hasActiveAgent = true;
      }
    }
  }
}

/** Process a user-type stream event (tool result): mark last step done. */
function processUserEvent(progress: ProgressState): void {
  const current = getCurrentPhase(progress);
  if (current) {
    const lastStep = current.steps[current.steps.length - 1];
    if (lastStep && !lastStep.done) {
      lastStep.done = true;
      progress.dirty = true;

      if (isAgentTool(lastStep.tool)) {
        progress.hasActiveAgent = false;
      }
    }
  }
  progress.turns++;
}

function processStreamEvent(
  event: Record<string, unknown>,
  progress: ProgressState,
): void {
  const type = event.type as string;

  if (type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;
    progress.turns = Math.max(progress.turns, 1);
    processAssistantEvent(content, progress);
  } else if (type === 'user') {
    processUserEvent(progress);
  } else if (type === 'result') {
    closeCurrentPhase(progress);
    progress.hasActiveAgent = false;
    progress.dirty = true;
  }
}

// ---------------------------------------------------------------------------
// Claude invocation with streaming
// ---------------------------------------------------------------------------

interface ClaudeResult {
  reply: string;
  sessionId: string | null;
}

/** All tools granted to the Discord bot's claude -p process. */
const ALLOWED_TOOLS = [
  'mcp__justclaw__*',       // All justclaw MCP tools (memory, tasks, context, etc.)
  'Bash(git:*)',            // Git operations
  'Bash(npm:*)',            // npm install, run, etc.
  'Bash(npx:*)',            // npx commands
  'Bash(node:*)',           // Run Node.js scripts
  'Bash(python3:*)',        // Python scripts
  'Bash(pip:*)',            // Python packages
  'Bash(apt:*)',            // System packages (apt list, apt search — install needs sudo)
  'Bash(pm2:*)',            // Process management
  'Bash(curl:*)',           // HTTP requests
  'Bash(ls:*)',             // Directory listing
  'Bash(cat:*)',            // Read files
  'Bash(grep:*)',           // Search files
  'Bash(find:*)',           // Find files
  'Bash(head:*)',           // File preview
  'Bash(tail:*)',           // Log tailing
  'Bash(wc:*)',             // Word/line count
  'Bash(df:*)',             // Disk usage
  'Bash(free:*)',           // Memory usage
  'Bash(ps:*)',             // Process listing
  'Bash(uname:*)',          // System info
  'Bash(date:*)',           // Date/time
  'Bash(echo:*)',           // Output
  'Bash(mkdir:*)',          // Create directories
  'Bash(cp:*)',             // Copy files
  'Bash(mv:*)',             // Move files
  'Bash(chmod:*)',          // File permissions
  'Bash(tar:*)',            // Archives
  'Bash(unzip:*)',          // Unzip
  'Bash(jq:*)',             // JSON processing
  'Bash(sed:*)',            // Stream editing
  'Bash(awk:*)',            // Text processing
  'Bash(sort:*)',           // Sorting
  'Bash(diff:*)',           // File diffs
  'Bash(tsc:*)',            // TypeScript compiler
  'Bash(sqlite3:*)',        // Direct SQLite queries
  'Read', 'Write', 'Edit', // File operations
  'Glob', 'Grep',          // Search tools
  'WebSearch', 'WebFetch',  // Web access
].join(' ');

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

/** Start typing indicator, progress editor, and inactivity watchdog. Returns cleanup function. */
function setupClaudeTimers(
  sourceMsg: Message,
  progressMsg: Message | null,
  progress: ProgressState,
  channelId: string,
  child: { kill: (signal?: number | NodeJS.Signals) => boolean; pid?: number | undefined },
  lastActivityRef: { value: number },
): () => void {
  const typingTimer = setInterval(() => {
    if ('sendTyping' in sourceMsg.channel) {
      (sourceMsg.channel as TextChannel).sendTyping().catch(() => {});
    }
  }, TYPING_INTERVAL_MS);

  let lastEditAt = 0;
  const progressTimer = setInterval(() => {
    const timeSinceEdit = Date.now() - lastEditAt;
    if (!progressMsg) return;
    if (!progress.dirty && timeSinceEdit < 10_000) return;
    if (timeSinceEdit < PROGRESS_EDIT_INTERVAL_MS) return;

    progress.dirty = false;
    lastEditAt = Date.now();
    const text = renderProgress(progress);
    progressMsg.edit(text).catch(() => {});
  }, PROGRESS_EDIT_INTERVAL_MS);

  const inactivityTimer = setInterval(() => {
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
      try { child.kill('SIGTERM'); } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('SIGTERM failed', { pid: child.pid, error: String(e) }); }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('SIGKILL failed', { pid: child.pid, error: String(e) }); }
      }, 5_000);
    }
  }, 10_000);

  return () => {
    clearInterval(typingTimer);
    clearInterval(progressTimer);
    clearInterval(inactivityTimer);
  };
}

/** Extract result fields (text, session_id, usage) from a stream event. */
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

/** Shared mutable state for a single claude -p invocation. */
interface ClaudeStreamState {
  buffer: string;
  stderrBuf: string;
  settled: boolean;
  resultState: { finalResult: string; sessionId: string | null; inputTokens: number; outputTokens: number };
  progress: ProgressState;
  lastActivityRef: { value: number };
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
  child.stdout!.on('data', (chunk: Buffer) => {
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
  });

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
    resolvePromise({ reply: state.resultState.finalResult, sessionId: state.resultState.sessionId });
  }
}

async function callClaude(
  message: string,
  channelId: string,
  sessionId: string | null,
  progressMsg: Message | null,
  sourceMsg: Message,
  db: DB,
): Promise<ClaudeResult> {
  const claudeBin = findClaudeBin();
  const args = buildClaudeArgs(message, sessionId);
  log.info('Calling claude (streaming)', { bin: claudeBin, channelId, hasSession: !!sessionId });
  const shellCmd = buildShellCmd([claudeBin, ...args]);

  return new Promise<ClaudeResult>((resolvePromise, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClaudeEnv(channelId),
    });

    if (child.pid == null) {
      reject(new Error('Failed to spawn claude -p (no PID)'));
      return;
    }
    activeClaudePids.add(child.pid);
    registerProcess(db, child.pid, 'claude-p', `channel:${channelId}`);
    log.info('claude -p spawned', { pid: child.pid, channelId });

    const state: ClaudeStreamState = {
      buffer: '', stderrBuf: '', settled: false,
      resultState: { finalResult: '', sessionId, inputTokens: 0, outputTokens: 0 },
      progress: { phases: [], turns: 0, startedAt: Date.now(), dirty: false, hasActiveAgent: false, pendingText: '' },
      lastActivityRef: { value: Date.now() },
    };

    const clearTimers = setupClaudeTimers(sourceMsg, progressMsg, state.progress, channelId, child, state.lastActivityRef);

    const cleanup = () => {
      clearTimers();
      if (child.pid) {
        activeClaudePids.delete(child.pid);
        const tokens = (state.resultState.inputTokens || state.resultState.outputTokens)
          ? { input: state.resultState.inputTokens, output: state.resultState.outputTokens }
          : undefined;
        retireProcess(db, child.pid, tokens);
      }
    };

    wireChildHandlers(child, state, channelId, cleanup, resolvePromise, reject);
  });
}

// ---------------------------------------------------------------------------
// Per-channel queue
// ---------------------------------------------------------------------------

const MAX_CHANNEL_STATES = 100;
const channelStates = new Map<string, ChannelState & { lastActiveAt: number }>();

/** Reference to the DB set during main() — needed by getChannelState for session restore. */
let _botDb: DB | null = null;

function getChannelState(channelId: string): ChannelState & { lastActiveAt: number } {
  let state = channelStates.get(channelId);
  if (!state) {
    // Evict oldest inactive channel if at capacity.
    if (channelStates.size >= MAX_CHANNEL_STATES) {
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

    // Phase 1b: Restore persisted session from DB on first access.
    let restoredSessionId: string | null = null;
    if (_botDb) {
      const persisted = loadSession(_botDb, channelId);
      if (persisted) {
        restoredSessionId = persisted.sessionId;
        log.info('Restored session from DB', { channelId, sessionId: persisted.sessionId, turnCount: persisted.turnCount });
      }
    }

    state = { sessionId: restoredSessionId, busy: false, queue: [], lastActiveAt: Date.now(), consecutiveFailures: 0, circuitOpenUntil: 0 };
    channelStates.set(channelId, state);
  }
  state.lastActiveAt = Date.now();
  return state;
}

/** Coalesce multiple queued messages into one prompt. */
function coalesceMessages(messages: Message[]): string {
  if (messages.length === 1) return messages[0].content.trim();
  return messages
    .map((m) => `[${m.author.username}]: ${m.content.trim()}`)
    .join('\n');
}

/** If circuit breaker is open, notify user and re-queue. Returns true if open. */
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

/** Rotate session if stale/long, sending handover prompt first. */
async function maybeRotateSession(
  state: ChannelState & { lastActiveAt: number },
  channelId: string,
  primaryMsg: Message,
  db: DB,
): Promise<void> {
  const persisted = loadSession(db, channelId);
  const rotationCheck = shouldRotateSession(
    persisted?.lastUsedAt ?? null,
    persisted?.turnCount ?? 0,
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

/** Call claude with stale-session retry: if first call fails with a session, retry without it. */
async function callClaudeWithRetry(
  fullPrompt: string,
  channelId: string,
  state: ChannelState,
  progressMsg: Message | null,
  primaryMsg: Message,
  db: DB,
): Promise<ClaudeResult> {
  try {
    return await callClaude(fullPrompt, channelId, state.sessionId, progressMsg, primaryMsg, db);
  } catch (firstErr) {
    if (state.sessionId) {
      log.warn('Retrying without session (stale session recovery)', { channelId });
      state.sessionId = null;
      clearSession(db, channelId);
      invalidatePreambleCache(channelId);
      return await callClaude(fullPrompt, channelId, null, progressMsg, primaryMsg, db);
    }
    throw firstErr;
  }
}

/** Replace progress message with final response chunks. */
async function sendFinalResponse(
  replyText: string,
  progressMsg: Message | null,
  primaryMsg: Message,
): Promise<void> {
  const text = replyText.trim() || '*(completed with no text output)*';
  const chunks = splitMessage(text);
  if (progressMsg) {
    try {
      await progressMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await (primaryMsg.channel as TextChannel).send(chunks[i]);
      }
    } catch (e: unknown) {
      log.warn('Progress message edit failed, sending as new messages', { error: String(e) });
      for (const chunk of chunks) {
        await (primaryMsg.channel as TextChannel).send(chunk);
      }
    }
  } else {
    for (const chunk of chunks) {
      await primaryMsg.reply(chunk);
    }
  }
}

/** Trigger pre-compaction context flush if turn count is high enough. */
async function maybeFlushContext(
  channelId: string,
  state: ChannelState,
  sessionId: string | null,
  primaryMsg: Message,
  db: DB,
): Promise<void> {
  if (!sessionId) return;
  const currentTurnCount = getSessionTurnCount(db, channelId);
  if (!shouldFlushContext(currentTurnCount)) return;

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

/** Track consecutive failures and open circuit breaker after 3. */
async function handleQueueError(
  err: unknown,
  channelId: string,
  state: ChannelState,
  primaryMsg: Message,
): Promise<void> {
  log.error('Failed to get Claude response', { error: String(err), channelId });

  state.consecutiveFailures++;
  if (state.consecutiveFailures >= 3) {
    const cooldownMin = Math.min(5 * Math.pow(2, state.consecutiveFailures - 3), 30);
    state.circuitOpenUntil = Date.now() + cooldownMin * 60_000;
    log.warn('Circuit breaker OPEN', { channelId, failures: state.consecutiveFailures, cooldownMin });
    try {
      await primaryMsg.reply(`⏸️ Claude has failed ${state.consecutiveFailures} times in a row. Pausing for ${cooldownMin}min.`);
    } catch (e: unknown) { log.warn('Discord reply failed (circuit open)', { error: String(e) }); }
  } else {
    try {
      await primaryMsg.reply(`⚠️ Error: ${String(err).slice(0, 150)}`);
    } catch (e: unknown) { log.warn('Discord reply failed (error notification)', { error: String(e) }); }
  }
}

/** Execute a batch of queued messages: rotate session, call claude, send response. */
async function executeQueuedMessages(
  messages: Message[],
  channelId: string,
  state: ChannelState & { lastActiveAt: number },
  db: DB,
): Promise<void> {
  const primaryMsg = messages[0];

  if (messages.length > 1) {
    log.info('Coalesced messages', { channelId, count: messages.length });
  }

  await maybeRotateSession(state, channelId, primaryMsg, db);

  const userContent = coalesceMessages(messages);
  const preamble = buildIdentityPreamble(db, channelId);
  const fullPrompt = preamble + '\n---\n' + userContent;

  let progressMsg: Message | null = null;
  try {
    progressMsg = await primaryMsg.reply('📋 **Working on your request**\n⏳ Thinking…');
  } catch (e: unknown) {
    log.warn('Failed to send progress message', { error: String(e) });
  }

  const result = await callClaudeWithRetry(fullPrompt, channelId, state, progressMsg, primaryMsg, db);
  state.sessionId = result.sessionId;

  if (result.sessionId) {
    saveSession(db, channelId, result.sessionId, 1);
  }

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

  if (await checkCircuitBreaker(state)) {
    state.busy = false;
    return;
  }

  // Wait briefly for additional messages to coalesce (only when rapid-fire).
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
      processQueue(channelId, db).catch((e) =>
        log.error('Queue processing error', { error: String(e) }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Install global error handlers to prevent unhandled crashes. */
function setupGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception (not crashing)', { error: String(err), stack: err.stack?.slice(0, 500) });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection (not crashing)', { error: String(reason) });
  });
}

/** Install Discord error/shard handlers to prevent crashes on WebSocket errors. */
function setupDiscordErrorHandlers(client: Client): void {
  client.on('error', (err) => {
    log.error('Discord client error', { error: String(err) });
  });
  client.on('shardError', (err, shardId) => {
    log.error('Discord shard error', { error: String(err), shardId });
  });
  client.on('shardReconnecting', (shardId) => {
    log.info('Discord shard reconnecting', { shardId });
  });
  client.on('shardResume', (shardId, replayedEvents) => {
    log.info('Discord shard resumed', { shardId, replayedEvents });
  });
  client.on('shardDisconnect', (event, shardId) => {
    log.warn('Discord shard disconnected', { shardId, code: event.code });
  });
}

/** Handle an inbound Discord message: log, enqueue, and trigger processing. */
async function handleInboundMessage(
  message: Message,
  allowedChannels: string[],
  db: DB,
  ready: boolean,
): Promise<void> {
  if (!ready) return;
  if (message.author.bot) return;
  if (allowedChannels.length > 0 && !allowedChannels.includes(message.channelId)) return;

  const content = message.content.trim();
  if (!content) return;

  log.info('Inbound message', {
    sender: message.author.username,
    channelId: message.channelId,
    length: content.length,
  });

  db.execute(
    'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
    ['discord', message.author.username, content, db.now()],
  );

  const state = getChannelState(message.channelId);
  state.queue.push(message);

  if (state.busy) {
    const pos = state.queue.length;
    try {
      await message.reply(`📥 Queued (position ${pos}) — I'll get to this next.`);
    } catch (e: unknown) { log.warn('Discord reply failed (queue notification)', { error: String(e) }); }
  } else {
    processQueue(message.channelId, db).catch((e) =>
      log.error('Queue processing error', { error: String(e) }),
    );
  }
}

/** Kill all active claude -p process groups and clean up. */
async function shutdownChildren(db: DB): Promise<void> {
  for (const pid of activeClaudePids) {
    try {
      process.kill(-pid, 'SIGTERM');
      retireProcess(db, pid);
      log.info('Sent SIGTERM to process group', { pid });
    } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('Shutdown SIGTERM failed', { pid, error: String(e) }); }
  }

  if (activeClaudePids.size > 0) {
    await new Promise((r) => setTimeout(r, 5000));
    for (const pid of activeClaudePids) {
      try {
        process.kill(-pid, 'SIGKILL');
        log.info('Sent SIGKILL to process group', { pid });
      } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('Shutdown SIGKILL failed', { pid, error: String(e) }); }
    }
  }
}

/** Wire up SIGTERM/SIGINT/beforeExit handlers for graceful shutdown. */
function setupShutdownHandlers(
  db: DB,
  client: Client,
  heartbeat: ReturnType<typeof startHeartbeat> | null,
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
    shutdown().catch((err) => {
      log.error('Shutdown error', { error: String(err) });
      process.exit(1);
    });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  process.on('beforeExit', handleShutdown);
}

/** Load config, open DB, register this process. Returns initialized services. */
function initBotServices(): { token: string; allowedChannels: string[]; db: DB } {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log.error('DISCORD_BOT_TOKEN not set');
    process.exit(1);
  }

  const allowedChannels = (process.env.DISCORD_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const projectRoot = process.env.JUSTCLAW_ROOT || resolve(process.cwd());
  const config = loadConfig(process.env.JUSTCLAW_CONFIG);
  const dbPath = resolveDbPath(config, projectRoot);
  const db = new DB(dbPath);
  _botDb = db;

  registerProcess(db, process.pid, 'discord-bot');

  log.info('Discord bot starting', {
    projectRoot, dbPath, pid: process.pid,
    allowedChannels: allowedChannels.length || 'all',
    baseTimeoutMs: BASE_INACTIVITY_MS,
    agentTimeoutMs: AGENT_INACTIVITY_MS,
  });

  return { token, allowedChannels, db };
}

/** Create Discord client with required intents. */
function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
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

  const heartbeatChannelId = process.env.DISCORD_HEARTBEAT_CHANNEL_ID || process.env.DISCORD_CHANNEL_IDS?.split(',')[0]?.trim() || '';
  const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

  client.once(Events.ClientReady, (c) => {
    log.info('Discord bot connected', { user: c.user.tag });
    console.log(`Discord bot connected as ${c.user.tag}`);
    ready = true;
    if (typeof process.send === 'function') {
      process.send('ready');
    }
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

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});

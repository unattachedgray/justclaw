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
import { existsSync } from 'fs';
import { resolve } from 'path';
import { DB } from '../db.js';
import { loadConfig, resolveDbPath } from '../config.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import { startHeartbeat } from './heartbeat.js';

const log = getLogger('discord');

const DISCORD_MAX_LENGTH = 2000;

/** Active claude -p child PIDs — tracked so heartbeat can distinguish legitimate from orphan. */
export const activeClaudePids = new Set<number>();
const BASE_INACTIVITY_MS = 120_000;    // 2 min base inactivity timeout
const AGENT_INACTIVITY_MS = 300_000;   // 5 min when sub-agents are running
const TYPING_INTERVAL_MS = 8_000;
const PROGRESS_EDIT_INTERVAL_MS = 3_000;

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

function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
    if (splitIdx <= 0) splitIdx = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^[\n ]/, '');
  }
  return chunks;
}

function findClaudeBin(): string {
  const home = process.env.HOME || '';
  for (const p of [
    home + '/.local/bin/claude',
    home + '/.claude/local/claude',
    '/usr/local/bin/claude',
  ]) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

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

        // Ensure we have an active phase.
        const phase = ensureActivePhase(progress);

        // Mark previous step done if needed.
        const lastStep = phase.steps[phase.steps.length - 1];
        if (lastStep && !lastStep.done) {
          lastStep.done = true;
        }

        // Add new step.
        phase.steps.push({ tool: toolName, detail, done: false });
        progress.dirty = true;

        // Track agent tools for timeout extension.
        if (isAgentTool(toolName)) {
          progress.hasActiveAgent = true;
        }
      }
    }
  } else if (type === 'user') {
    // Tool result — mark last step done.
    const current = getCurrentPhase(progress);
    if (current) {
      const lastStep = current.steps[current.steps.length - 1];
      if (lastStep && !lastStep.done) {
        lastStep.done = true;
        progress.dirty = true;

        // If this was an agent tool completing, clear the flag.
        if (isAgentTool(lastStep.tool)) {
          progress.hasActiveAgent = false;
        }
      }
    }
    progress.turns++;
  } else if (type === 'result') {
    // Close everything.
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

async function callClaude(
  message: string,
  channelId: string,
  sessionId: string | null,
  progressMsg: Message | null,
  sourceMsg: Message,
  db: DB,
): Promise<ClaudeResult> {
  const claudeBin = findClaudeBin();
  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools',
    [
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
    ].join(' '),
  ];
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  log.info('Calling claude (streaming)', { bin: claudeBin, channelId, hasSession: !!sessionId });

  const shellCmd = [claudeBin, ...args]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');

  return new Promise<ClaudeResult>((resolvePromise, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => { const e: Record<string, string | undefined> = { ...process.env, JUSTCLAW_NO_DASHBOARD: '1' }; delete e.CLAUDECODE; return e; })(),
    });

    // Track child PID for process management.
    if (child.pid == null) {
      reject(new Error('Failed to spawn claude -p (no PID)'));
      return;
    }
    activeClaudePids.add(child.pid);
    registerProcess(db, child.pid, 'claude-p', `channel:${channelId}`);
    log.info('claude -p spawned', { pid: child.pid, channelId });

    let lastActivityAt = Date.now();
    let buffer = '';
    let finalResult = '';
    let newSessionId: string | null = sessionId;
    let settled = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const progress: ProgressState = {
      phases: [],
      turns: 0,
      startedAt: Date.now(),
      dirty: false,
      hasActiveAgent: false,
      pendingText: '',
    };

    // -- Typing indicator refresh --
    const typingTimer = setInterval(() => {
      if ('sendTyping' in sourceMsg.channel) {
        (sourceMsg.channel as TextChannel).sendTyping().catch(() => {});
      }
    }, TYPING_INTERVAL_MS);

    // -- Progress message editor --
    let lastEditAt = 0;
    const progressTimer = setInterval(() => {
      // Always update the elapsed time display periodically.
      const timeSinceEdit = Date.now() - lastEditAt;
      if (!progressMsg) return;
      if (!progress.dirty && timeSinceEdit < 10_000) return;

      // Respect rate limit between edits.
      if (timeSinceEdit < PROGRESS_EDIT_INTERVAL_MS) return;

      progress.dirty = false;
      lastEditAt = Date.now();
      const text = renderProgress(progress);
      progressMsg.edit(text).catch(() => {});
    }, 1_500);

    // -- Adaptive inactivity timeout --
    const inactivityTimer = setInterval(() => {
      const timeout = progress.hasActiveAgent ? AGENT_INACTIVITY_MS : BASE_INACTIVITY_MS;
      const idleMs = Date.now() - lastActivityAt;

      if (idleMs > timeout) {
        log.warn('Inactivity timeout — killing claude', {
          channelId,
          elapsed: elapsed(progress.startedAt),
          idleMs,
          timeout,
          hasActiveAgent: progress.hasActiveAgent,
          lastPhase: getCurrentPhase(progress)?.label,
        });
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5_000);
      }
    }, 10_000);

    function cleanup() {
      clearInterval(typingTimer);
      clearInterval(progressTimer);
      clearInterval(inactivityTimer);
      if (child.pid) {
        activeClaudePids.delete(child.pid);
        const tokens = (totalInputTokens || totalOutputTokens)
          ? { input: totalInputTokens, output: totalOutputTokens }
          : undefined;
        retireProcess(db, child.pid, tokens);
      }
    }

    // -- Parse streaming stdout --
    child.stdout!.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processStreamEvent(event, progress);

          if (event.type === 'result') {
            finalResult = (event.result as string) || '';
            const sid = event.session_id as string | undefined;
            if (sid) newSessionId = sid;
            // Capture token usage from result event.
            const usage = event.usage as Record<string, number> | undefined;
            if (usage) {
              totalInputTokens += usage.input_tokens || 0;
              totalOutputTokens += usage.output_tokens || 0;
            }
          }
        } catch {
          // Not JSON or partial — ignore.
        }
      }
    });

    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      stderrBuf += chunk.toString();
      // Cap stderr buffer at 2KB to avoid memory bloat.
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      log.error('claude spawn error', { error: String(err) });
      reject(new Error(String(err)));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      // Process any remaining buffer.
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>;
          processStreamEvent(event, progress);
          if (event.type === 'result') {
            finalResult = (event.result as string) || '';
            const sid = event.session_id as string | undefined;
            if (sid) newSessionId = sid;
            const usage = event.usage as Record<string, number> | undefined;
            if (usage) {
              totalInputTokens += usage.input_tokens || 0;
              totalOutputTokens += usage.output_tokens || 0;
            }
          }
        } catch { /* ignore */ }
      }

      if (code !== 0 && !finalResult) {
        log.error('claude -p exited non-zero', { code, stderr: stderrBuf.trim().slice(-500) });
        reject(new Error(`claude exited with code ${code}`));
      } else {
        log.info('claude -p completed', {
          channelId,
          elapsed: elapsed(progress.startedAt),
          turns: progress.turns,
          phases: progress.phases.length,
        });
        resolvePromise({ reply: finalResult, sessionId: newSessionId });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Per-channel queue
// ---------------------------------------------------------------------------

const MAX_CHANNEL_STATES = 100;
const channelStates = new Map<string, ChannelState & { lastActiveAt: number }>();

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
    state = { sessionId: null, busy: false, queue: [], lastActiveAt: Date.now(), consecutiveFailures: 0, circuitOpenUntil: 0 };
    channelStates.set(channelId, state);
  }
  state.lastActiveAt = Date.now();
  return state;
}

async function processQueue(channelId: string, db: DB): Promise<void> {
  const state = getChannelState(channelId);
  if (state.busy) return;

  // Circuit breaker: if open, reject with cooldown message.
  if (Date.now() < state.circuitOpenUntil) {
    const remaining = Math.ceil((state.circuitOpenUntil - Date.now()) / 60_000);
    const msg = state.queue.shift();
    if (msg) {
      try { await msg.reply(`⏸️ Claude API appears to be down. Pausing for ${remaining}min. Your message is saved.`); } catch { /* */ }
      // Re-queue so it's processed when circuit closes.
      state.queue.unshift(msg);
    }
    state.busy = false;
    return;
  }

  const msg = state.queue.shift();
  if (!msg) return;

  state.busy = true;

  try {
    // Send initial progress message.
    let progressMsg: Message | null = null;
    try {
      progressMsg = await msg.reply('📋 **Working on your request**\n⏳ Thinking…');
    } catch {
      /* ignore */
    }

    let result: ClaudeResult;
    try {
      result = await callClaude(msg.content.trim(), channelId, state.sessionId, progressMsg, msg, db);
    } catch (firstErr) {
      // If we had a session and it failed, retry without session (stale session recovery).
      if (state.sessionId) {
        log.warn('Retrying without session (stale session recovery)', { channelId });
        state.sessionId = null;
        result = await callClaude(msg.content.trim(), channelId, null, progressMsg, msg, db);
      } else {
        throw firstErr;
      }
    }
    state.sessionId = result.sessionId;

    // Circuit breaker: success resets failure count.
    state.consecutiveFailures = 0;

    // Log response to DB.
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
      ['discord', 'charlie', result.reply, db.now()],
    );

    // Replace progress message with final response.
    const replyText = result.reply.trim() || '*(completed with no text output)*';
    const chunks = splitMessage(replyText);
    if (progressMsg) {
      try {
        await progressMsg.edit(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await (msg.channel as TextChannel).send(chunks[i]);
        }
      } catch {
        for (const chunk of chunks) {
          await (msg.channel as TextChannel).send(chunk);
        }
      }
    } else {
      for (const chunk of chunks) {
        await msg.reply(chunk);
      }
    }
  } catch (err) {
    log.error('Failed to get Claude response', { error: String(err), channelId });

    // Circuit breaker: track consecutive failures.
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= 3) {
      // Open circuit: escalating cooldown (5min, 10min, 30min max).
      const cooldownMin = Math.min(5 * Math.pow(2, state.consecutiveFailures - 3), 30);
      state.circuitOpenUntil = Date.now() + cooldownMin * 60_000;
      log.warn('Circuit breaker OPEN', { channelId, failures: state.consecutiveFailures, cooldownMin });
      try {
        await msg.reply(`⏸️ Claude has failed ${state.consecutiveFailures} times in a row. Pausing for ${cooldownMin}min.`);
      } catch { /* ignore */ }
    } else {
      try {
        await msg.reply(`⚠️ Error: ${String(err).slice(0, 150)}`);
      } catch { /* ignore */ }
    }
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

async function main(): Promise<void> {
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

  // Register this bot process in the registry.
  registerProcess(db, process.pid, 'discord-bot');

  log.info('Discord bot starting', {
    projectRoot,
    dbPath,
    pid: process.pid,
    allowedChannels: allowedChannels.length || 'all',
    baseTimeoutMs: BASE_INACTIVITY_MS,
    agentTimeoutMs: AGENT_INACTIVITY_MS,
  });

  // --- P0: Global error handlers (prevent unhandled crashes) ---
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception (not crashing)', { error: String(err), stack: err.stack?.slice(0, 500) });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection (not crashing)', { error: String(reason) });
  });

  // --- Readiness gate: don't process messages until fully connected ---
  let ready = false;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  // --- P0: Discord error handlers (prevent crashes on WebSocket errors) ---
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

  // Heartbeat config.
  const heartbeatChannelId = process.env.DISCORD_HEARTBEAT_CHANNEL_ID || process.env.DISCORD_CHANNEL_IDS?.split(',')[0]?.trim() || '';
  const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

  client.once(Events.ClientReady, (c) => {
    log.info('Discord bot connected', { user: c.user.tag });
    console.log(`Discord bot connected as ${c.user.tag}`);

    // Mark as ready — now we accept messages.
    ready = true;

    // Notify PM2 we're ready (if wait_ready is enabled).
    if (typeof process.send === 'function') {
      process.send('ready');
    }

    // Start heartbeat if we have a channel to post to.
    if (heartbeatChannelId) {
      heartbeat = startHeartbeat({
        db,
        client,
        channelId: heartbeatChannelId,
        intervalMs: heartbeatIntervalMs,
      });
      log.info('Heartbeat enabled', { channelId: heartbeatChannelId, intervalMs: heartbeatIntervalMs });
    } else {
      log.warn('Heartbeat disabled — no DISCORD_HEARTBEAT_CHANNEL_ID or DISCORD_CHANNEL_IDS set');
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (!ready) return; // Readiness gate: skip messages before fully connected
    if (message.author.bot) return;
    if (allowedChannels.length > 0 && !allowedChannels.includes(message.channelId)) return;

    const content = message.content.trim();
    if (!content) return;

    log.info('Inbound message', {
      sender: message.author.username,
      channelId: message.channelId,
      length: content.length,
    });

    // Log user message to DB.
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
      ['discord', message.author.username, content, db.now()],
    );

    // Enqueue.
    const state = getChannelState(message.channelId);
    state.queue.push(message);

    if (state.busy) {
      const pos = state.queue.length;
      try {
        await message.reply(`📥 Queued (position ${pos}) — I'll get to this next.`);
      } catch { /* ignore */ }
    } else {
      processQueue(message.channelId, db).catch((e) =>
        log.error('Queue processing error', { error: String(e) }),
      );
    }
  });

  // Graceful shutdown — kill all child process groups, then exit.
  const shutdown = async () => {
    log.info('Discord bot shutting down', { activeChildren: activeClaudePids.size });
    if (heartbeat) heartbeat.stop();

    // Kill all active claude -p process groups.
    for (const pid of activeClaudePids) {
      try {
        process.kill(-pid, 'SIGTERM'); // Negative PID = kill entire process group
        retireProcess(db, pid);
        log.info('Sent SIGTERM to process group', { pid });
      } catch { /* already dead */ }
    }

    // Wait up to 5s for children to exit, then SIGKILL survivors.
    if (activeClaudePids.size > 0) {
      await new Promise((r) => setTimeout(r, 5000));
      for (const pid of activeClaudePids) {
        try {
          process.kill(-pid, 'SIGKILL');
          log.info('Sent SIGKILL to process group', { pid });
        } catch { /* already dead */ }
      }
    }

    // Retire self.
    retireProcess(db, process.pid);

    client.destroy();
    db.close();
    process.exit(0);
  };
  let shuttingDown = false;
  const handleShutdown = () => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;
    shutdown().catch((err) => {
      log.error('Shutdown error', { error: String(err) });
      process.exit(1);
    });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  process.on('beforeExit', handleShutdown); // OpenHands pattern: catch unhandled exits

  await client.login(token);
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});

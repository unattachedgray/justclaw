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

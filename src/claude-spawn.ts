/**
 * Shared Claude Code CLI utilities — findClaudeBin() and spawnClaudeP().
 *
 * Extracted from bot.ts, scheduled-tasks.ts, escalation.ts, anticipation.ts
 * to eliminate 4x duplication of the same spawn + timeout + env setup pattern.
 */

import { spawn as spawnChild } from 'child_process';
import { existsSync } from 'fs';
import { getLogger } from './logger.js';

const log = getLogger('claude-spawn');

/** Find the claude CLI binary, checking common install locations. */
export function findClaudeBin(): string {
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

/** Build the env for claude -p spawns: inherit + JUSTCLAW_NO_DASHBOARD + strip CLAUDECODE. */
export function buildClaudeEnv(channelId?: string): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env, JUSTCLAW_NO_DASHBOARD: '1' };
  delete e.CLAUDECODE;
  if (channelId) e.JUSTCLAW_CHANNEL_ID = channelId;
  return e;
}

/** Shell-escape an argument array into a single command string. */
export function buildShellCmd(args: string[]): string {
  return args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');
}

export interface ClaudePOptions {
  prompt: string;
  allowedTools: string[];
  outputFormat?: 'json' | 'stream-json';
  sessionId?: string | null;
  timeoutMs?: number;
}

export interface ClaudePResult {
  text: string;
  sessionId: string | null;
}

/**
 * Spawn claude -p and collect the result. Handles timeout, env setup, and
 * JSON parsing. For simple (non-streaming) use cases like escalation and
 * anticipation. Bot.ts uses its own streaming implementation for progress display.
 */
export function spawnClaudeP(opts: ClaudePOptions): Promise<ClaudePResult> {
  const claudeBin = findClaudeBin();
  const outputFormat = opts.outputFormat || 'json';
  const timeoutMs = opts.timeoutMs || 120_000;

  const args = [
    claudeBin,
    '-p', opts.prompt,
    '--output-format', outputFormat,
  ];

  if (opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(' '));
  }

  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }

  const shellCmd = buildShellCmd(args);

  return new Promise<ClaudePResult>((resolve, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClaudeEnv(),
    });

    if (child.pid == null) {
      reject(new Error('Failed to spawn claude -p (no PID)'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already dead */ }
      }, 5_000);
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        log.warn('claude -p exited non-zero', { code, stderr: stderr.slice(-300) });
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(-200)}`));
        return;
      }

      // Parse JSON output to extract result text and session ID.
      let text = stdout.trim();
      let sessionId: string | null = null;

      if (outputFormat === 'json') {
        try {
          const parsed = JSON.parse(text);
          text = parsed.result || text;
          if (parsed.session_id) sessionId = parsed.session_id;
        } catch {
          // Use raw stdout if JSON parse fails.
        }
      } else if (outputFormat === 'stream-json') {
        // Parse last result event from stream.
        const lines = text.split('\n');
        for (const line of lines.reverse()) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'result') {
              text = event.result || text;
              if (event.session_id) sessionId = event.session_id;
              break;
            }
          } catch { /* skip non-JSON lines */ }
        }
      }

      resolve({ text, sessionId });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

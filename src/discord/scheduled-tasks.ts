/**
 * Scheduled task executor — runs due recurring tasks via claude -p.
 *
 * Called from the heartbeat tick every 5 minutes. Checks if any tasks
 * with recurrence + due_at are past due. If so, spawns claude -p to
 * execute the task, posts the result to Discord, and completes the task
 * (which auto-spawns the next recurrence instance).
 *
 * Uses a simpler claude -p invocation than the interactive bot flow —
 * no progress editing, just fire-and-collect.
 */

import { spawn as spawnChild } from 'child_process';
import { existsSync } from 'fs';
import type { Client, TextChannel } from 'discord.js';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';

const log = getLogger('scheduled-tasks');

const DISCORD_MAX_LENGTH = 2000;
const TASK_TIMEOUT_MS = 5 * 60_000; // 5 min max per scheduled task

/** Track active scheduled task to prevent overlap. */
let runningTaskId: number | null = null;

interface DueTask {
  id: number;
  title: string;
  description: string;
  priority: number;
  tags: string;
  recurrence: string;
  due_at: string;
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

/** Query for recurring tasks that are past due and still pending. */
function getDueTasks(db: DB): DueTask[] {
  const now = db.now();
  const rows = db.fetchall(
    `SELECT id, title, description, priority, tags, recurrence, due_at
     FROM tasks
     WHERE recurrence IS NOT NULL
       AND due_at IS NOT NULL
       AND due_at <= ?
       AND status = 'pending'
     ORDER BY priority ASC, due_at ASC
     LIMIT 1`,
    [now],
  );
  return rows.map((r) => ({
    id: r.id as number,
    title: r.title as string,
    description: (r.description as string) || '',
    priority: r.priority as number,
    tags: (r.tags as string) || '',
    recurrence: r.recurrence as string,
    due_at: r.due_at as string,
  }));
}

/** Spawn claude -p with a task prompt and collect the result. */
function runClaudeForTask(db: DB, task: DueTask): Promise<string> {
  const claudeBin = findClaudeBin();

  const prompt = [
    `You are executing a scheduled task: "${task.title}"`,
    '',
    'Instructions:',
    task.description,
    '',
    'After completing the task:',
    '1. Use mcp__justclaw__task_complete to mark this task done (id: ' + task.id + ')',
    '2. Include a brief result summary',
    '',
    'IMPORTANT: Your entire response will be posted to Discord. Format it for Discord (markdown, under 4000 chars total).',
  ].join('\n');

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools',
    [
      'mcp__justclaw__*',
      'Bash(curl:*)',
      'Bash(date:*)',
      'Bash(echo:*)',
      'Bash(node:*)',
      'Read', 'Write', 'Edit',
      'Glob', 'Grep',
      'WebSearch', 'WebFetch',
    ].join(' '),
  ];

  const shellCmd = [claudeBin, ...args]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');

  return new Promise<string>((resolve, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const e: Record<string, string | undefined> = { ...process.env, JUSTCLAW_NO_DASHBOARD: '1' };
        delete e.CLAUDECODE;
        return e;
      })(),
    });

    if (child.pid == null) {
      reject(new Error('Failed to spawn claude -p for scheduled task'));
      return;
    }

    registerProcess(db, child.pid, 'claude-p', `scheduled-task:${task.id}`);
    log.info('Scheduled task claude -p spawned', { pid: child.pid, taskId: task.id, title: task.title });

    let buffer = '';
    let finalResult = '';
    let stderrBuf = '';

    const timeout = setTimeout(() => {
      log.warn('Scheduled task timed out', { taskId: task.id, pid: child.pid });
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* */ }
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* */ }
      }, 5000);
    }, TASK_TIMEOUT_MS);

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Parse stream-json lines for the final result.
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && event.result) {
            finalResult = event.result;
          } else if (event.type === 'assistant' && event.message?.content) {
            // Collect text blocks from assistant messages.
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                finalResult = block.text;
              }
            }
          }
        } catch { /* not JSON or partial */ }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      retireProcess(db, child.pid!);

      if (code !== 0) {
        log.error('Scheduled task claude -p failed', { code, taskId: task.id, stderr: stderrBuf.slice(-300) });
        resolve(`⚠️ Scheduled task "${task.title}" failed (exit ${code}): ${stderrBuf.slice(-200)}`);
      } else {
        log.info('Scheduled task completed', { taskId: task.id });
        resolve(finalResult || '(no output)');
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      retireProcess(db, child.pid!);
      reject(err);
    });
  });
}

/**
 * Check for and execute due scheduled tasks.
 * Called from heartbeat tick. Runs at most one task per tick.
 */
export async function checkAndRunScheduledTasks(
  db: DB,
  client: Client,
  channelId: string,
): Promise<void> {
  // Don't overlap — one scheduled task at a time.
  if (runningTaskId !== null) {
    log.info('Scheduled task already running, skipping', { runningTaskId });
    return;
  }

  const dueTasks = getDueTasks(db);
  if (dueTasks.length === 0) return;

  const task = dueTasks[0];
  runningTaskId = task.id;

  log.info('Executing scheduled task', { id: task.id, title: task.title, dueAt: task.due_at });

  // Mark task as active.
  db.execute(
    "UPDATE tasks SET status = 'active', updated_at = ? WHERE id = ?",
    [db.now(), task.id],
  );

  try {
    // Post a "starting" message.
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      log.error('Cannot send to channel', { channelId });
      return;
    }
    const textChannel = channel as TextChannel;
    await textChannel.send(`📅 **Scheduled task starting:** ${task.title}`);

    // Run claude -p.
    const result = await runClaudeForTask(db, task);

    // Post result to Discord.
    const chunks = splitMessage(result);
    for (const chunk of chunks) {
      await textChannel.send(chunk);
    }

    // Log to conversations.
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
      ['discord', 'charlie', `[scheduled] ${task.title}: ${result.slice(0, 500)}`, db.now()],
    );
  } catch (err) {
    log.error('Scheduled task execution failed', { taskId: task.id, error: String(err) });

    // Post error to Discord.
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await (channel as TextChannel).send(
          `⚠️ **Scheduled task failed:** ${task.title}\n${String(err).slice(0, 200)}`,
        );
      }
    } catch { /* can't even post error */ }

    // Revert task to pending so it retries next cycle.
    db.execute(
      "UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?",
      [db.now(), task.id],
    );
  } finally {
    runningTaskId = null;
  }
}

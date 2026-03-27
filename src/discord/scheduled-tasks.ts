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
import type { Client, TextChannel } from 'discord.js';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { registerProcess, retireProcess } from '../process-registry.js';
import { splitMessage } from './discord-utils.js';
import { buildTaskPreamble } from './session-context.js';
import { findClaudeBin, buildClaudeEnv, buildShellCmd } from '../claude-spawn.js';
import { computeNextDue } from '../tasks.js';
import { formatLocalTime } from '../time-utils.js';
import { resolveTaskDescription, resolveTaskPhases, parseTemplateRef } from '../task-templates.js';
import { reflectOnTaskResult } from './reflect.js';
import { checkPendingDeliveries, registerPendingDelivery, executeInlineDelivery } from './task-delivery.js';

const log = getLogger('scheduled-tasks');
const TASK_TIMEOUT_MS = 20 * 60_000; // 20 min default — overridden by lead time if set
const MAX_STALENESS_MS = 2 * 60 * 60_000; // 2 hours — skip tasks older than this
const DEFAULT_LEAD_TIME_MS = 0; // No lead time by default — tasks trigger at due_at

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
  target_channel: string | null;
  session_id: string | null;
}

/**
 * Parse lead time from task tags. Tag format: "lead:60" = start 60 minutes before due_at.
 * When a task has lead time, it starts early and uses (due_at - now) as the timeout
 * instead of the default TASK_TIMEOUT_MS. This gives heavy tasks a natural deadline.
 */
function getLeadTimeMs(tags: string): number {
  const match = tags.match(/\blead:(\d+)\b/);
  return match ? parseInt(match[1], 10) * 60_000 : DEFAULT_LEAD_TIME_MS;
}

/**
 * Compute the effective timeout for a task. If the task has lead time,
 * the timeout is (due_at - now) so it runs until its scheduled delivery time.
 * Otherwise use the default TASK_TIMEOUT_MS.
 */
function getEffectiveTimeoutMs(task: DueTask): number {
  const leadMs = getLeadTimeMs(task.tags);
  if (leadMs <= 0) return TASK_TIMEOUT_MS;

  const dueTime = new Date(task.due_at.replace(' ', 'T') + 'Z').getTime();
  const remaining = dueTime - Date.now();
  // Use remaining time until due, but at least 5 minutes as a floor
  return Math.max(remaining, 5 * 60_000);
}

/** Query for recurring tasks that are past due OR within their lead time window. */
function getDueTasks(db: DB): DueTask[] {
  const now = db.now();
  // First: tasks that are past due (original behavior)
  const rows = db.fetchall(
    `SELECT id, title, description, priority, tags, recurrence, due_at, target_channel, session_id
     FROM tasks
     WHERE recurrence IS NOT NULL
       AND due_at IS NOT NULL
       AND status = 'pending'
     ORDER BY priority ASC, due_at ASC`,
    [],
  );

  const nowMs = Date.now();
  const candidates = rows
    .map((r) => ({
      id: r.id as number,
      title: r.title as string,
      description: (r.description as string) || '',
      priority: r.priority as number,
      tags: (r.tags as string) || '',
      recurrence: r.recurrence as string,
      due_at: r.due_at as string,
      target_channel: (r.target_channel as string) || null,
      session_id: (r.session_id as string) || null,
    }))
    .filter((task) => {
      const dueMs = new Date(task.due_at.replace(' ', 'T') + 'Z').getTime();
      const leadMs = getLeadTimeMs(task.tags);
      // Task is eligible if: now >= (due_at - lead_time)
      return nowMs >= dueMs - leadMs;
    });

  return candidates.slice(0, 1);
}

/** Query for auto-executable tasks (flagged for autonomous execution). */
function getAutoExecuteTasks(db: DB): DueTask[] {
  const rows = db.fetchall(
    `SELECT id, title, description, priority, tags, recurrence, due_at, target_channel
     FROM tasks
     WHERE auto_execute = 1
       AND status = 'pending'
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`,
  );
  return rows.map((r) => ({
    id: r.id as number,
    title: r.title as string,
    description: (r.description as string) || '',
    priority: r.priority as number,
    tags: (r.tags as string) || '',
    recurrence: (r.recurrence as string) || '',
    due_at: (r.due_at as string) || '',
    target_channel: (r.target_channel as string) || null,
    session_id: (r.session_id as string) || null,
  }));
}

interface TaskRunResult {
  text: string;
  sessionId: string | null;
}

/** Spawn claude -p with a task prompt and collect the result. Timeout is dynamic per task. */
function runClaudeForTask(db: DB, task: DueTask, prepOnly: boolean = false): Promise<TaskRunResult> {
  const claudeBin = findClaudeBin();

  // Phase 2: Inject task preamble for context continuity.
  const ref = parseTemplateRef(task.description);
  const preamble = buildTaskPreamble(db, ref?.templateName);
  const phases = resolveTaskPhases(task.description, { TASK_ID: String(task.id) });
  const taskDescription = phases.prepPrompt;

  const completionInstructions = prepOnly
    ? [
        'After completing preparation:',
        '1. Verify the report file exists at the path specified above',
        '2. Do NOT send any emails — delivery happens automatically at the scheduled time',
        '3. Do NOT call mcp__justclaw__task_complete — the system handles completion',
        '4. Include a brief result summary of what was prepared',
      ]
    : [
        'After completing the task:',
        '1. Use mcp__justclaw__task_complete to mark this task done (id: ' + task.id + ')',
        '2. Include a brief result summary',
      ];

  const prompt = [
    preamble,
    '---',
    `You are executing a scheduled task: "${task.title}"`,
    '',
    'Instructions:',
    taskDescription,
    '',
    ...completionInstructions,
    '',
    'IMPORTANT: Your entire response will be posted to Discord. Format it for Discord (markdown, under 4000 chars total).',
  ].join('\n');

  const args = [
    claudeBin,
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
      'Bash(git:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(mkdir:*)',
      'Bash(bash:*)',
      'Read', 'Write', 'Edit',
      'Glob', 'Grep',
      'WebSearch', 'WebFetch',
    ].join(' '),
  ];

  // Phase 6: Use --resume if the task has a persisted session.
  if (task.session_id) {
    args.push('--resume', task.session_id);
  }

  const shellCmd = buildShellCmd(args);

  return new Promise<TaskRunResult>((resolve, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClaudeEnv(task.target_channel || undefined),
    });

    if (child.pid == null) {
      reject(new Error('Failed to spawn claude -p for scheduled task'));
      return;
    }

    registerProcess(db, child.pid, 'claude-p', `scheduled-task:${task.id}`);
    log.info('Scheduled task claude -p spawned', { pid: child.pid, taskId: task.id, title: task.title });

    let buffer = '';
    let finalResult = '';
    let newSessionId: string | null = task.session_id;
    let stderrBuf = '';

    const effectiveTimeout = getEffectiveTimeoutMs(task);
    log.info('Task timeout set', { taskId: task.id, timeoutMs: effectiveTimeout, hasLeadTime: getLeadTimeMs(task.tags) > 0 });

    const timeout = setTimeout(() => {
      log.warn('Scheduled task timed out', { taskId: task.id, pid: child.pid, timeoutMs: effectiveTimeout });
      try { process.kill(-child.pid!, 'SIGTERM'); } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('Task SIGTERM failed', { pid: child.pid, error: String(e) }); }
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('Task SIGKILL failed', { pid: child.pid, error: String(e) }); }
      }, 5000);
    }, effectiveTimeout);

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Parse stream-json lines for the final result.
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            if (event.result) finalResult = event.result;
            // Capture session_id for continuity.
            if (event.session_id) newSessionId = event.session_id;
          } else if (event.type === 'assistant' && event.message?.content) {
            // Collect text blocks from assistant messages.
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                finalResult = block.text;
              }
            }
          }
        } catch (e: unknown) { log.debug('Task stream JSON parse failed', { error: String(e), line: line.slice(0, 120) }); }
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
        resolve({ text: `⚠️ Scheduled task "${task.title}" failed (exit ${code}): ${stderrBuf.slice(-200)}`, sessionId: newSessionId });
      } else {
        log.info('Scheduled task completed', { taskId: task.id });
        resolve({ text: finalResult || '(no output)', sessionId: newSessionId });
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
 * Resolve the Discord channel for a task: use task's target_channel if set,
 * otherwise fall back to the default (heartbeat) channel.
 */
async function resolveChannel(
  client: Client,
  task: DueTask,
  fallbackChannelId: string,
): Promise<TextChannel | null> {
  const targetId = task.target_channel || fallbackChannelId;
  if (!targetId) return null;
  try {
    const channel = await client.channels.fetch(targetId);
    if (channel && 'send' in channel) return channel as TextChannel;
  } catch (err) {
    log.error('Cannot fetch target channel, trying fallback', {
      taskId: task.id,
      targetChannel: targetId,
      error: String(err),
    });
    // If the task had a specific channel that failed, try the fallback.
    if (task.target_channel && fallbackChannelId && task.target_channel !== fallbackChannelId) {
      try {
        const fb = await client.channels.fetch(fallbackChannelId);
        if (fb && 'send' in fb) return fb as TextChannel;
      } catch (e: unknown) { log.warn('Fallback channel also unreachable', { fallbackChannelId, error: String(e) }); }
    }
  }
  return null;
}

/**
 * Check for and execute due scheduled tasks.
 * Called from heartbeat tick. Runs at most one task per tick.
 * Tasks with a target_channel are posted there; others go to fallbackChannelId.
 */
export async function checkAndRunScheduledTasks(
  db: DB,
  client: Client,
  fallbackChannelId: string,
): Promise<void> {
  // Execute any pending deliveries first — fast, deterministic, no AI.
  await checkPendingDeliveries(db, client, fallbackChannelId);

  // Don't overlap — one scheduled task at a time.
  if (runningTaskId !== null) {
    log.info('Scheduled task already running, skipping', { runningTaskId });
    return;
  }

  const dueTasks = getDueTasks(db);
  if (dueTasks.length === 0) {
    // Check for auto-executable tasks if no scheduled tasks are due.
    const autoExecuteEnabled = db.fetchone(
      "SELECT value FROM state WHERE key = 'auto_execute_enabled'",
    );
    // Auto-execute is opt-in: must be explicitly enabled.
    if (autoExecuteEnabled?.value === 'true') {
      const autoTasks = getAutoExecuteTasks(db);
      if (autoTasks.length > 0) {
        const task = autoTasks[0];
        runningTaskId = task.id;
        log.info('Auto-executing task', { id: task.id, title: task.title, targetChannel: task.target_channel });
        db.execute("UPDATE tasks SET status = 'active', updated_at = ? WHERE id = ?", [db.now(), task.id]);
        try {
          const textChannel = await resolveChannel(client, task, fallbackChannelId);
          if (textChannel) {
            await textChannel.send(`🤖 **Auto-executing task:** ${task.title}`);
            const result = await runClaudeForTask(db, task);
            for (const chunk of splitMessage(result.text)) {
              await textChannel.send(chunk);
            }
            // Phase 6: Persist session for task continuity.
            if (result.sessionId) {
              db.execute('UPDATE tasks SET session_id = ? WHERE id = ? OR (recurrence_source_id IS NOT NULL AND recurrence_source_id = ?)',
                [result.sessionId, task.id, task.id]);
            }
          }
        } catch (err) {
          log.error('Auto-execute task failed', { taskId: task.id, error: String(err) });
          db.execute("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?", [db.now(), task.id]);
        } finally {
          runningTaskId = null;
        }
      }
    }
    return;
  }

  const task = dueTasks[0];

  // Staleness guard: skip tasks that are way past due (e.g., bot was down).
  // Advance to next recurrence instead of running a stale report at the wrong time.
  const dueTime = new Date(task.due_at.replace(' ', 'T') + 'Z').getTime();
  const nowMs = Date.now();
  if (nowMs - dueTime > MAX_STALENESS_MS) {
    log.warn('Skipping stale scheduled task', {
      taskId: task.id,
      title: task.title,
      dueAt: task.due_at,
      staleByMs: nowMs - dueTime,
    });
    // Complete it silently so spawnNextRecurrence creates tomorrow's instance.
    db.execute(
      "UPDATE tasks SET status = 'completed', result = 'Skipped: stale (bot was down at scheduled time)', completed_at = ?, updated_at = ? WHERE id = ?",
      [db.now(), db.now(), task.id],
    );
    // Trigger next recurrence spawn via task_complete logic.
    const existing = db.fetchone('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (existing?.recurrence) {
      const nextDue = computeNextDue(existing.recurrence as string, existing.due_at as string);
      db.execute(
        `INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, recurrence_source_id, target_channel, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
        [existing.title, existing.description, existing.priority, existing.tags, nextDue,
         existing.recurrence, (existing.recurrence_source_id || existing.id), existing.target_channel || null, existing.session_id || null,
         db.now(), db.now()],
      );
      const next = db.fetchone('SELECT id, due_at FROM tasks ORDER BY id DESC LIMIT 1');
      log.info('Spawned next recurrence after stale skip', { nextId: next?.id, nextDue: next?.due_at });

      // Notify Discord about the skip.
      try {
        const skipChannel = await resolveChannel(client, task, fallbackChannelId);
        if (skipChannel) {
          await skipChannel.send(`⏭️ **Skipped stale task:** ${task.title} (was due ${formatLocalTime(task.due_at, { includeDate: true })}, bot was offline). Next run: ${next?.due_at ? formatLocalTime(next.due_at as string, { includeDate: true }) : 'unknown'}.`);
        }
      } catch (e: unknown) { log.warn('Failed to post stale-skip notice', { error: String(e) }); }
    }
    return;
  }

  runningTaskId = task.id;

  log.info('Executing scheduled task', { id: task.id, title: task.title, dueAt: task.due_at, targetChannel: task.target_channel });

  // Mark task as active.
  db.execute(
    "UPDATE tasks SET status = 'active', updated_at = ? WHERE id = ?",
    [db.now(), task.id],
  );

  // Determine if this is a two-phase (prep-only) run.
  const phases = resolveTaskPhases(task.description, { TASK_ID: String(task.id) });
  const leadMs = getLeadTimeMs(task.tags);
  const isPrepOnly = phases.deliveryCommands !== null && leadMs > 0 && nowMs < dueTime;
  const reportPath = `/tmp/justclaw-report-${task.id}.md`;

  try {
    const textChannel = await resolveChannel(client, task, fallbackChannelId);
    if (!textChannel) {
      log.error('Cannot send to any channel for task', { taskId: task.id, targetChannel: task.target_channel, fallback: fallbackChannelId });
      return;
    }

    if (isPrepOnly) {
      await textChannel.send(`📅 **Preparing scheduled task:** ${task.title}\n📧 Email delivery at ${formatLocalTime(task.due_at)}`);
    } else {
      await textChannel.send(`📅 **Scheduled task starting:** ${task.title}`);
    }
    const taskStartMs = Date.now();

    // Run claude -p (prep-only if two-phase, full otherwise).
    const result = await runClaudeForTask(db, task, isPrepOnly);

    // Post result to Discord.
    const chunks = splitMessage(result.text);
    for (const chunk of chunks) {
      await textChannel.send(chunk);
    }

    // Persist session_id for recurring task continuity.
    if (result.sessionId) {
      db.execute('UPDATE tasks SET session_id = ? WHERE recurrence_source_id = ? OR id = ?',
        [result.sessionId, task.id, task.id]);
    }

    // Log to conversations.
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
      ['discord', 'charlie', `[scheduled] ${task.title}: ${result.text.slice(0, 500)}`, db.now()],
    );

    if (isPrepOnly && phases.deliveryCommands) {
      // Two-phase: register pending delivery for execution at due_at
      registerPendingDelivery(db, {
        taskId: task.id,
        dueAt: task.due_at,
        deliveryCommands: phases.deliveryCommands,
        reportPath,
        targetChannel: task.target_channel,
        title: task.title,
        prepResult: result.text.slice(0, 500),
        tags: task.tags,
        recurrence: task.recurrence,
        description: task.description,
      });
      if (textChannel) {
        await textChannel.send(`✅ **Preparation complete.** Email delivery scheduled for ${formatLocalTime(task.due_at)}.`);
      }
    } else {
      // Monolithic or no-lead-time with delivery commands: run delivery inline
      if (phases.deliveryCommands && phases.deliveryCommands.length > 0) {
        await executeInlineDelivery(db, task.id, phases.deliveryCommands, textChannel);
      }

      // Post-task reflection: quality scan, learning extraction, playbook update.
      try {
        const reflection = reflectOnTaskResult(
          db, { id: task.id, title: task.title, description: task.description, tags: task.tags },
          result.text, Date.now() - taskStartMs, 0,
        );
        if (reflection.discordSummary) {
          await textChannel.send(reflection.discordSummary);
        }
      } catch (reflErr) {
        log.warn('Post-task reflection failed', { taskId: task.id, error: String(reflErr) });
      }
    }
  } catch (err) {
    log.error('Scheduled task execution failed', { taskId: task.id, error: String(err) });

    // Post error to Discord — try task's channel, then fallback.
    try {
      const errChannel = await resolveChannel(client, task, fallbackChannelId);
      if (errChannel) {
        await errChannel.send(
          `⚠️ **Scheduled task failed:** ${task.title}\n${String(err).slice(0, 200)}`,
        );
      }
    } catch (e: unknown) { log.warn('Failed to post task error to Discord', { taskId: task.id, error: String(e) }); }

    // Revert task to pending so it retries next cycle.
    db.execute(
      "UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?",
      [db.now(), task.id],
    );
  } finally {
    runningTaskId = null;

    // Immediately check for more due tasks instead of waiting for next heartbeat tick.
    // This handles multiple tasks sharing the same due_at (e.g., two daily reports at 8:50am).
    const moreDue = getDueTasks(db);
    if (moreDue.length > 0) {
      log.info('More due tasks found after completion, running next immediately', { nextId: moreDue[0].id });
      // Use setImmediate to avoid deep recursion — lets the event loop breathe.
      setImmediate(() => {
        checkAndRunScheduledTasks(db, client, fallbackChannelId).catch((err) => {
          log.error('Chained scheduled task check failed', { error: String(err) });
        });
      });
    }
  }
}

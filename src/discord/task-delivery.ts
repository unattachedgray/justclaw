/**
 * Deterministic delivery phase for scheduled tasks.
 *
 * Handles the second phase of two-phase task execution: after claude -p
 * prepares a report (research + compile + archive), this module executes
 * delivery commands (email, etc.) at the scheduled due_at time.
 *
 * No AI calls — just shell commands and DB updates.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { Client, TextChannel } from 'discord.js';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { splitMessage } from './discord-utils.js';
import { computeNextDue } from '../tasks.js';

const log = getLogger('task-delivery');

export interface PendingDelivery {
  taskId: number;
  dueAt: string;
  deliveryCommands: string[];
  reportPath: string;
  targetChannel: string | null;
  title: string;
  prepResult: string;
  tags: string;
  recurrence: string;
  description: string;
}

/** Register a pending delivery in the state table for deterministic execution at due_at. */
export function registerPendingDelivery(db: DB, delivery: PendingDelivery): void {
  db.execute(
    "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    [`pending_delivery:${delivery.taskId}`, JSON.stringify(delivery)],
  );
  db.execute(
    "UPDATE tasks SET status = 'delivering', updated_at = ? WHERE id = ?",
    [db.now(), delivery.taskId],
  );
  log.info('Registered pending delivery', {
    taskId: delivery.taskId,
    dueAt: delivery.dueAt,
    commandCount: delivery.deliveryCommands.length,
  });
}

/**
 * Execute delivery commands for a single delivery. Returns success status and results.
 */
function executeDeliveryCommands(
  delivery: PendingDelivery,
): { success: boolean; results: string[] } {
  let success = true;
  const results: string[] = [];

  for (const cmd of delivery.deliveryCommands) {
    try {
      const output = execSync(cmd, {
        timeout: 30_000,
        encoding: 'utf-8',
        cwd: '/home/julian/temp/justclaw',
      });
      const label = cmd.split('/').pop()?.split(' ')[0] || cmd.slice(0, 40);
      results.push(`✅ ${label}: ${output.trim().slice(0, 100)}`);
      log.info('Delivery command succeeded', { taskId: delivery.taskId, cmd: cmd.slice(0, 80) });
    } catch (err: unknown) {
      success = false;
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`❌ ${cmd.slice(0, 60)}: ${msg.slice(0, 100)}`);
      log.error('Delivery command failed', {
        taskId: delivery.taskId,
        cmd: cmd.slice(0, 80),
        error: msg.slice(0, 200),
      });
    }
  }

  return { success, results };
}

/** Complete a delivered task and spawn the next recurrence. */
function completeDeliveredTask(
  db: DB,
  delivery: PendingDelivery,
  resultNote: string,
): void {
  db.execute(
    "UPDATE tasks SET status = 'completed', result = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    [resultNote.slice(0, 500), db.now(), db.now(), delivery.taskId],
  );

  if (!delivery.recurrence) return;

  const existing = db.fetchone('SELECT * FROM tasks WHERE id = ?', [delivery.taskId]);
  if (!existing) return;

  const nextDue = computeNextDue(delivery.recurrence, delivery.dueAt);
  db.execute(
    `INSERT INTO tasks (title, description, priority, tags, due_at, depends_on, recurrence, recurrence_source_id, target_channel, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
    [
      existing.title, existing.description, existing.priority, existing.tags, nextDue,
      existing.recurrence, (existing.recurrence_source_id || existing.id),
      existing.target_channel || null, existing.session_id || null,
      db.now(), db.now(),
    ],
  );
  const next = db.fetchone('SELECT id, due_at FROM tasks ORDER BY id DESC LIMIT 1');
  log.info('Spawned next recurrence after delivery', { nextId: next?.id, nextDue: next?.due_at });
}

/**
 * Resolve a Discord channel by ID. Helper to avoid importing from scheduled-tasks.
 */
async function fetchChannel(
  client: Client,
  channelId: string,
): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && 'send' in ch) return ch as TextChannel;
  } catch (err) {
    log.warn('Cannot fetch channel', { channelId, error: String(err) });
  }
  return null;
}

/**
 * Check for pending deliveries that are due and execute them deterministically.
 * Called from heartbeat tick, before the main task check. Fast, no AI calls.
 */
export async function checkPendingDeliveries(
  db: DB,
  client: Client,
  fallbackChannelId: string,
): Promise<void> {
  const rows = db.fetchall(
    "SELECT key, value FROM state WHERE key LIKE 'pending_delivery:%'",
    [],
  );
  if (rows.length === 0) return;

  const nowMs = Date.now();

  for (const row of rows) {
    const stateKey = row.key as string;
    let delivery: PendingDelivery;
    try {
      delivery = JSON.parse(row.value as string);
    } catch {
      log.error('Invalid pending delivery JSON, removing', { key: stateKey });
      db.execute("DELETE FROM state WHERE key = ?", [stateKey]);
      continue;
    }

    const dueMs = new Date(delivery.dueAt.replace(' ', 'T') + 'Z').getTime();
    if (nowMs < dueMs) {
      log.debug('Pending delivery not yet due', {
        taskId: delivery.taskId,
        dueAt: delivery.dueAt,
      });
      continue;
    }

    log.info('Executing pending delivery', { taskId: delivery.taskId, title: delivery.title });

    const textChannel = await fetchChannel(
      client,
      delivery.targetChannel || fallbackChannelId,
    );

    // Verify report file exists
    if (!existsSync(delivery.reportPath)) {
      log.error('Report file missing for delivery', {
        taskId: delivery.taskId,
        path: delivery.reportPath,
      });
      if (textChannel) {
        await textChannel.send(
          `⚠️ **Delivery failed:** ${delivery.title}\nReport file not found at \`${delivery.reportPath}\`. Preparation may have failed.`,
        );
      }
      db.execute(
        "UPDATE tasks SET status = 'failed', result = 'Delivery failed: report file missing', updated_at = ? WHERE id = ?",
        [db.now(), delivery.taskId],
      );
      db.execute("DELETE FROM state WHERE key = ?", [stateKey]);
      continue;
    }

    // Execute delivery commands
    const { success, results } = executeDeliveryCommands(delivery);

    // Post results to Discord
    if (textChannel) {
      const emoji = success ? '📬' : '⚠️';
      const summary = [
        `${emoji} **Scheduled delivery:** ${delivery.title}`,
        '```',
        ...results,
        '```',
      ].join('\n');
      for (const chunk of splitMessage(summary)) {
        await textChannel.send(chunk);
      }
    }

    // Complete and spawn next recurrence
    const resultNote = success
      ? `Delivered: ${results.join('; ')}`
      : `Delivery partial: ${results.join('; ')}`;
    completeDeliveredTask(db, delivery, resultNote);

    // Clean up
    db.execute("DELETE FROM state WHERE key = ?", [stateKey]);
    log.info('Pending delivery completed', { taskId: delivery.taskId, success });
  }
}

/**
 * Execute delivery commands inline (for tasks without lead time).
 * Called directly from scheduled-tasks.ts when a monolithic task has a ---DELIVERY--- section.
 */
export async function executeInlineDelivery(
  db: DB,
  taskId: number,
  deliveryCommands: string[],
  textChannel: TextChannel | null,
): Promise<void> {
  for (const cmd of deliveryCommands) {
    try {
      execSync(cmd, { timeout: 30_000, encoding: 'utf-8', cwd: '/home/julian/temp/justclaw' });
      log.info('Inline delivery command succeeded', { taskId, cmd: cmd.slice(0, 80) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Inline delivery command failed', { taskId, cmd: cmd.slice(0, 80), error: msg.slice(0, 200) });
      if (textChannel) {
        await textChannel.send(`⚠️ **Delivery step failed:** \`${cmd.slice(0, 60)}\`\n${msg.slice(0, 200)}`);
      }
    }
  }
}

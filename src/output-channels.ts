/**
 * Output channel registry — tracks known destinations for task results.
 *
 * Channels are stored in the `state` table as JSON under key `output_channels`.
 * Each channel has a type (discord/email/github), a human-readable name,
 * config details, and a scope (general vs task-specific).
 *
 * General channels are suggested when creating new tasks.
 * Task-specific channels (like a dedicated GitHub repo) are only shown
 * when explicitly relevant or when the user has granted broader permissions.
 *
 * New channels are auto-registered when first used in a task.
 */

import type { DB } from './db.js';
import { getLogger } from './logger.js';

const log = getLogger('output-channels');

export interface OutputChannel {
  /** Unique identifier (e.g., "discord:1485102208122093658", "email:team@example.com") */
  id: string;
  /** Channel type */
  type: 'discord' | 'email' | 'github';
  /** Human-readable name (e.g., "Main Discord", "Banking team email") */
  name: string;
  /** Type-specific configuration */
  config: Record<string, string>;
  /** "general" = suggest for any task. "task-specific" = only suggest when relevant. */
  scope: 'general' | 'task-specific';
  /** When this channel was first registered */
  created_at: string;
}

const STATE_KEY = 'output_channels';

/** Load all registered channels from DB. */
export function loadChannels(db: DB): OutputChannel[] {
  const row = db.fetchone("SELECT value FROM state WHERE key = ?", [STATE_KEY]);
  if (!row?.value) return [];
  try {
    return JSON.parse(row.value as string);
  } catch {
    log.warn('Failed to parse output channels from state');
    return [];
  }
}

/** Save channels to DB. */
function saveChannels(db: DB, channels: OutputChannel[]): void {
  const json = JSON.stringify(channels);
  db.execute(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [STATE_KEY, json],
  );
}

/** Register a new channel if it doesn't already exist. Returns the channel. */
export function registerChannel(db: DB, channel: Omit<OutputChannel, 'created_at'>): OutputChannel {
  const channels = loadChannels(db);
  const existing = channels.find((c) => c.id === channel.id);
  if (existing) return existing;

  const full: OutputChannel = { ...channel, created_at: db.now() };
  channels.push(full);
  saveChannels(db, channels);
  log.info('Registered output channel', { id: channel.id, type: channel.type, name: channel.name });
  return full;
}

/** Get channels suitable for suggestion (general scope only). */
export function suggestChannels(db: DB): OutputChannel[] {
  return loadChannels(db).filter((c) => c.scope === 'general');
}

/** Get all channels, optionally filtered by type. */
export function listChannels(db: DB, type?: string): OutputChannel[] {
  const all = loadChannels(db);
  return type ? all.filter((c) => c.type === type) : all;
}

/** Update a channel's scope or name. */
export function updateChannel(db: DB, id: string, updates: { name?: string; scope?: 'general' | 'task-specific' }): boolean {
  const channels = loadChannels(db);
  const ch = channels.find((c) => c.id === id);
  if (!ch) return false;
  if (updates.name) ch.name = updates.name;
  if (updates.scope) ch.scope = updates.scope;
  saveChannels(db, channels);
  return true;
}

/**
 * Auto-register channels from a task's template variables.
 * Scans for email_to, repo_path/repo_name, and target_channel.
 */
export function autoRegisterFromTask(
  db: DB,
  vars: Record<string, string>,
  targetChannel: string | null,
): void {
  // Discord channel
  if (targetChannel) {
    registerChannel(db, {
      id: `discord:${targetChannel}`,
      type: 'discord',
      name: `Discord channel`,
      config: { channel_id: targetChannel },
      scope: 'general',
    });
  }

  // Email
  if (vars.email_to) {
    registerChannel(db, {
      id: `email:${vars.email_to}`,
      type: 'email',
      name: vars.email_to,
      config: { address: vars.email_to },
      scope: 'general',
    });
  }

  // GitHub repo — task-specific by default (user must promote to general)
  if (vars.repo_path && vars.repo_name) {
    registerChannel(db, {
      id: `github:${vars.repo_name}`,
      type: 'github',
      name: `GitHub: ${vars.repo_name}`,
      config: { repo_path: vars.repo_path, repo_name: vars.repo_name },
      scope: 'task-specific',
    });
  }
}

/**
 * Format channel suggestions for display in tool responses.
 */
export function formatChannelSuggestions(db: DB): string {
  const general = suggestChannels(db);
  if (general.length === 0) return 'No output channels registered yet.';

  const byType: Record<string, OutputChannel[]> = {};
  for (const ch of general) {
    (byType[ch.type] ??= []).push(ch);
  }

  const lines: string[] = ['**Available output channels:**'];
  for (const [type, channels] of Object.entries(byType)) {
    const icon = type === 'discord' ? '💬' : type === 'email' ? '📧' : '📦';
    lines.push(`${icon} **${type}**: ${channels.map((c) => c.name).join(', ')}`);
  }
  return lines.join('\n');
}

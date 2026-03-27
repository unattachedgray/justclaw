/**
 * Session context builder — constructs identity preamble for every claude -p prompt.
 *
 * Injects "state of the world" so every session feels like the same agent waking up:
 * last context snapshot, active goals, pending tasks, recent learnings, time context.
 *
 * Two variants:
 *   - buildIdentityPreamble(): full preamble for interactive Discord messages
 *   - buildTaskPreamble(): lighter version for scheduled tasks
 */

import type { DB } from '../db.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { formatLocalTime } from '../time-utils.js';

/**
 * Thresholds for session management.
 *
 * These work WITH Claude Code's native context compaction, not against it.
 * Claude Code compacts at ~80% context. Our flush at turn 20 is a safety net
 * to persist durable state (to SQLite) before native compaction might lose it.
 * Rotation at turn 30 starts a fresh session with full identity preamble,
 * keeping the agent responsive while preserving continuity via DB state.
 */
export const SESSION_TURN_FLUSH_THRESHOLD = 20;
export const SESSION_TURN_ROTATE_THRESHOLD = 30;
export const COALESCE_WINDOW_MS = 1_000;

/** Check if a session should be rotated (daily or turn-count). */
export function shouldRotateSession(
  lastUsedAt: string | null,
  turnCount: number,
): { rotate: boolean; reason: string } {
  // Daily rotation: if last interaction was a different calendar day (EDT).
  if (lastUsedAt) {
    const edtFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const lastDateUtc = new Date(lastUsedAt.replace(' ', 'T') + 'Z');
    const lastDateEdt = edtFmt.format(lastDateUtc);
    const todayEdt = edtFmt.format(new Date());
    if (lastDateEdt !== todayEdt) {
      return { rotate: true, reason: 'daily' };
    }
  }

  // Turn-count rotation.
  if (turnCount >= SESSION_TURN_ROTATE_THRESHOLD) {
    return { rotate: true, reason: 'turn_limit' };
  }

  return { rotate: false, reason: '' };
}

/** Check if a pre-compaction flush should be triggered. */
export function shouldFlushContext(turnCount: number): boolean {
  return turnCount >= SESSION_TURN_FLUSH_THRESHOLD;
}

/** Cached skill catalog — loaded once from data/skill-index.json. */
let skillCatalogCache: string | null = null;

function loadSkillCatalog(): string {
  if (skillCatalogCache !== null) return skillCatalogCache;

  const root = process.env.JUSTCLAW_ROOT || process.cwd();
  const indexPath = join(root, 'data', 'skill-index.json');

  if (!existsSync(indexPath)) {
    skillCatalogCache = '';
    return '';
  }

  try {
    const entries: Array<{ name: string; trigger: string; path: string }> =
      JSON.parse(readFileSync(indexPath, 'utf-8'));

    if (entries.length === 0) {
      skillCatalogCache = '';
      return '';
    }

    // Compact format: just skill names grouped in one line
    const names = entries.map((e) => e.name).join(', ');
    skillCatalogCache = [
      '**Available skills** (read `data/skill-index.json` for triggers, or `~/.claude/skills/<name>/SKILL.md` for full reference):',
      names,
    ].join('\n');
  } catch { /* skill-index.json missing or unreadable, skip skill catalog */
    skillCatalogCache = '';
  }

  return skillCatalogCache;
}

/** Cached Claude Code auto memory — refreshed every 5 minutes. */
let ccMemoryCache: { text: string | null; cachedAt: number } | null = null;
const CC_MEMORY_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/** Load Claude Code's auto memory index, extracting bullet points. */
function loadClaudeCodeMemory(): string | null {
  if (ccMemoryCache && Date.now() - ccMemoryCache.cachedAt < CC_MEMORY_CACHE_TTL_MS) {
    return ccMemoryCache.text;
  }

  const home = process.env.HOME || '/home/julian';
  const memPath = join(home, '.claude/projects/-home-julian-temp-justclaw/memory/MEMORY.md');

  if (!existsSync(memPath)) {
    ccMemoryCache = { text: null, cachedAt: Date.now() };
    return null;
  }

  try {
    const raw = readFileSync(memPath, 'utf-8');
    const lines = raw.split('\n');

    // Extract bullet points — skip headers, blank lines, frontmatter
    const bullets = lines
      .filter((line) => line.startsWith('- '))
      .map((line) => line.trim());

    if (bullets.length === 0) {
      ccMemoryCache = { text: null, cachedAt: Date.now() };
      return null;
    }

    let result = bullets.join('\n');
    if (result.length > 500) {
      result = result.slice(0, 497) + '...';
    }

    ccMemoryCache = { text: result, cachedAt: Date.now() };
    return result;
  } catch { /* MEMORY.md unreadable, cache null to avoid retrying until TTL */
    ccMemoryCache = { text: null, cachedAt: Date.now() };
    return null;
  }
}

/** Cache for identity preamble — avoids 6 DB queries on every message. */
const preambleCache = new Map<string, { text: string; cachedAt: number }>();
const PREAMBLE_CACHE_TTL_MS = 30_000; // 30 seconds — fresh enough for conversational use

/** Build the full identity preamble for interactive Discord messages. */
export function buildIdentityPreamble(db: DB, channelId: string): string {
  const cached = preambleCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < PREAMBLE_CACHE_TTL_MS) {
    return cached.text;
  }
  const parts: string[] = [];

  parts.push('[System context — you are Charlie, Julian\'s AI agent running via justclaw]');
  parts.push('');

  // Last context snapshot.
  const snapshot = db.fetchone(
    'SELECT session_id, summary, key_facts, created_at FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
  );
  if (snapshot) {
    parts.push(`**Last context snapshot** (${snapshot.created_at}):`);
    parts.push(String(snapshot.summary));
    if (snapshot.key_facts) {
      parts.push(`Key facts: ${snapshot.key_facts}`);
    }
    parts.push('');
  }

  // Active goals.
  const goals = db.fetchall(
    "SELECT key, content FROM memories WHERE type = 'goal' AND namespace = 'goals' ORDER BY id DESC LIMIT 5",
  );
  if (goals.length > 0) {
    parts.push('**Active goals:**');
    for (const g of goals) {
      parts.push(`- ${g.key}: ${String(g.content).slice(0, 100)}`);
    }
    parts.push('');
  }

  // Pending tasks (top 5 by priority).
  const tasks = db.fetchall(
    "SELECT id, title, priority, due_at FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC, created_at ASC LIMIT 5",
  );
  if (tasks.length > 0) {
    parts.push('**Pending tasks:**');
    for (const t of tasks) {
      const due = t.due_at ? ` (due: ${formatLocalTime(t.due_at as string, { includeDate: true })})` : '';
      parts.push(`- #${t.id} [P${t.priority}] ${t.title}${due}`);
    }
    parts.push('');
  }

  // Today's activity (last 5 entries).
  const today = new Date().toISOString().slice(0, 10);
  const logs = db.fetchall(
    'SELECT entry, category, created_at FROM daily_log WHERE date = ? ORDER BY created_at DESC LIMIT 5',
    [today],
  );
  if (logs.length > 0) {
    parts.push('**Today\'s activity (recent):**');
    for (const l of logs) {
      const cat = l.category ? `[${l.category}]` : '';
      parts.push(`- ${cat} ${l.entry}`);
    }
    parts.push('');
  }

  // Recent learnings (last 3).
  const learnings = db.fetchall(
    'SELECT lesson, area FROM learnings ORDER BY created_at DESC LIMIT 3',
  );
  if (learnings.length > 0) {
    parts.push('**Recent learnings:**');
    for (const l of learnings) {
      const area = l.area ? `[${l.area}]` : '';
      parts.push(`- ${area} ${l.lesson}`);
    }
    parts.push('');
  }

  // Claude Code auto memory bridge — surface key learnings from native memory
  const ccMemory = loadClaudeCodeMemory();
  if (ccMemory) {
    parts.push('**Claude Code auto memory notes:**');
    parts.push(ccMemory);
    parts.push('');
  }

  // Available skills (compact — just names, agent reads full SKILL.md when needed).
  const catalog = loadSkillCatalog();
  if (catalog) {
    parts.push(catalog);
    parts.push('');
  }

  // Time since last interaction.
  const session = db.fetchone(
    'SELECT last_used_at, turn_count FROM sessions WHERE channel_id = ?',
    [channelId],
  );
  if (session?.last_used_at) {
    const lastMs = new Date(String(session.last_used_at)).getTime();
    const agoMs = Date.now() - lastMs;
    const agoMin = Math.round(agoMs / 60_000);
    if (agoMin > 5) {
      const agoStr = agoMin < 60
        ? `${agoMin} minutes`
        : agoMin < 1440
          ? `${Math.round(agoMin / 60)} hours`
          : `${Math.round(agoMin / 1440)} days`;
      parts.push(`Time since last interaction in this channel: ${agoStr}`);
      parts.push('');
    }
  }

  const text = parts.join('\n');
  preambleCache.set(channelId, { text, cachedAt: Date.now() });
  return text;
}

/** Invalidate preamble cache for a channel (call after session rotation). */
export function invalidatePreambleCache(channelId?: string): void {
  if (channelId) {
    preambleCache.delete(channelId);
  } else {
    preambleCache.clear();
  }
}

/** Build a lighter preamble for scheduled tasks. */
export function buildTaskPreamble(db: DB): string {
  const parts: string[] = [];

  parts.push('[System context — you are Charlie executing a scheduled task]');
  parts.push('');

  // Active goals only.
  const goals = db.fetchall(
    "SELECT key, content FROM memories WHERE type = 'goal' AND namespace = 'goals' ORDER BY id DESC LIMIT 3",
  );
  if (goals.length > 0) {
    parts.push('**Active goals:**');
    for (const g of goals) {
      parts.push(`- ${g.key}: ${String(g.content).slice(0, 80)}`);
    }
    parts.push('');
  }

  // Last context snapshot (brief).
  const snapshot = db.fetchone(
    'SELECT summary, created_at FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
  );
  if (snapshot) {
    parts.push(`**Last context** (${snapshot.created_at}): ${String(snapshot.summary).slice(0, 200)}`);
    parts.push('');
  }

  return parts.join('\n');
}

/** Build the handover prompt sent before session rotation. */
export function buildHandoverPrompt(): string {
  return [
    '[SYSTEM: Session rotation required — context is getting large.]',
    'Before this session ends, please:',
    '1. Call context_flush with a thorough summary of: what you were working on, key decisions made, what needs to happen next, and any active task IDs.',
    '2. Include any important discoveries or state in key_facts.',
    'This is your last turn in this session. The next session will start fresh with your saved context.',
  ].join('\n');
}

/**
 * Build the flush reminder injected when turn count is high but below rotation.
 *
 * This is a lightweight nudge — Claude Code handles compaction natively,
 * but we want durable state persisted to SQLite as a safety net.
 */
export function buildFlushReminder(): string {
  return [
    '[SYSTEM: You have been working for many turns. Please call context_flush with a brief summary',
    'of current work, key decisions, and next steps. This persists your state to the database as a',
    'safety net alongside Claude Code\'s native context management. Keep it concise — just the essentials.]',
  ].join('\n');
}

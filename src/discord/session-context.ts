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

/** Token budget for identity preamble — sections dropped when exceeded. */
const PREAMBLE_TOKEN_BUDGET = 4000;
/** Budget threshold for condensation check (80% of a larger budget). */
const PREAMBLE_CONDENSE_BUDGET = 6000;

interface PreambleSection {
  priority: number; // 1 = never drop, 4 = drop first
  content: string;
}

/** Assemble sections respecting token budget. Lower priority number = higher importance. */
function assembleSections(sections: PreambleSection[], budget: number): string {
  sections.sort((a, b) => a.priority - b.priority);
  const result: string[] = [];
  let tokens = 0;
  for (const s of sections) {
    const sTokens = Math.ceil(s.content.length / 4);
    if (s.priority === 1 || tokens + sTokens <= budget) {
      result.push(s.content);
      tokens += sTokens;
    }
  }
  return result.join('\n');
}

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
export function shouldFlushContext(turnCount: number, db?: DB, channelId?: string): boolean {
  if (turnCount >= SESSION_TURN_FLUSH_THRESHOLD) return true;
  // Token-based check: flush if preamble is getting too large
  if (db && channelId) return shouldCondenseContext(db, channelId);
  return false;
}

/** Check if preamble token estimate exceeds 80% of condensation budget. */
export function shouldCondenseContext(db: DB, channelId: string): boolean {
  const preamble = buildIdentityPreamble(db, channelId);
  const estimatedTokens = Math.ceil(preamble.length / 4);
  return estimatedTokens > PREAMBLE_CONDENSE_BUDGET * 0.8;
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
  const sections: PreambleSection[] = [];

  // Priority 1: system context header (never dropped)
  sections.push({ priority: 1, content: '[System context — you are Charlie, Julian\'s AI agent running via justclaw]\n' });

  // Priority 2: context snapshot
  const snapshotText = buildSnapshotSection(db);
  if (snapshotText) sections.push({ priority: 2, content: snapshotText });

  // Priority 2: active goals
  const goalsText = buildGoalsSection(db);
  if (goalsText) sections.push({ priority: 2, content: goalsText });

  // Priority 3: pending tasks
  const tasksText = buildTasksSection(db);
  if (tasksText) sections.push({ priority: 3, content: tasksText });

  // Priority 3: recent learnings
  const learningsText = buildLearningsSection(db);
  if (learningsText) sections.push({ priority: 3, content: learningsText });

  // Priority 3: Claude Code auto memory
  const ccMemory = loadClaudeCodeMemory();
  if (ccMemory) sections.push({ priority: 3, content: `**Claude Code auto memory notes:**\n${ccMemory}\n` });

  // Priority 4: daily log
  const logEntries = buildDailyLogEntries(db);
  if (logEntries) sections.push({ priority: 4, content: `**Today's activity (recent):**\n${logEntries}\n` });

  // Priority 4: trigger-based skill injection
  const skillText = buildSkillSection(db);
  if (skillText) sections.push({ priority: 4, content: skillText });

  // Priority 4: time since last interaction
  const timeText = buildTimeSinceSection(db, channelId);
  if (timeText) sections.push({ priority: 4, content: timeText });

  const text = assembleSections(sections, PREAMBLE_TOKEN_BUDGET);
  preambleCache.set(channelId, { text, cachedAt: Date.now() });
  return text;
}

function buildSnapshotSection(db: DB): string | null {
  const snapshot = db.fetchone(
    'SELECT summary, key_facts, created_at FROM context_snapshots ORDER BY created_at DESC LIMIT 1',
  );
  if (!snapshot) return null;
  const lines = [`**Last context snapshot** (${snapshot.created_at}):`, String(snapshot.summary)];
  if (snapshot.key_facts) lines.push(`Key facts: ${snapshot.key_facts}`);
  lines.push('');
  return lines.join('\n');
}

function buildGoalsSection(db: DB): string | null {
  const goals = db.fetchall(
    "SELECT key, content FROM memories WHERE type = 'goal' AND namespace = 'goals' ORDER BY id DESC LIMIT 5",
  );
  if (goals.length === 0) return null;
  const lines = ['**Active goals:**'];
  for (const g of goals) lines.push(`- ${g.key}: ${String(g.content).slice(0, 100)}`);
  lines.push('');
  return lines.join('\n');
}

function buildTasksSection(db: DB): string | null {
  const tasks = db.fetchall(
    "SELECT id, title, priority, due_at FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority ASC, created_at ASC LIMIT 5",
  );
  if (tasks.length === 0) return null;
  const lines = ['**Pending tasks:**'];
  for (const t of tasks) {
    const due = t.due_at ? ` (due: ${formatLocalTime(t.due_at as string, { includeDate: true })})` : '';
    lines.push(`- #${t.id} [P${t.priority}] ${t.title}${due}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildLearningsSection(db: DB): string | null {
  const learnings = db.fetchall('SELECT lesson, area FROM learnings ORDER BY created_at DESC LIMIT 3');
  if (learnings.length === 0) return null;
  const lines = ['**Recent learnings:**'];
  for (const l of learnings) {
    const area = l.area ? `[${l.area}]` : '';
    lines.push(`- ${area} ${l.lesson}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildDailyLogEntries(db: DB): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const logs = db.fetchall(
    'SELECT entry, category FROM daily_log WHERE date = ? ORDER BY created_at DESC LIMIT 5',
    [today],
  );
  if (logs.length === 0) return null;
  return logs.map(l => `- ${l.category ? `[${l.category}]` : ''} ${l.entry}`).join('\n');
}

function buildTimeSinceSection(db: DB, channelId: string): string | null {
  const session = db.fetchone(
    'SELECT last_used_at FROM sessions WHERE channel_id = ?', [channelId],
  );
  if (!session?.last_used_at) return null;
  const agoMin = Math.round((Date.now() - new Date(String(session.last_used_at)).getTime()) / 60_000);
  if (agoMin <= 5) return null;
  const agoStr = agoMin < 60 ? `${agoMin} minutes`
    : agoMin < 1440 ? `${Math.round(agoMin / 60)} hours`
    : `${Math.round(agoMin / 1440)} days`;
  return `Time since last interaction in this channel: ${agoStr}\n`;
}

/** Skill triggers — keyword-matched skill descriptions for context injection. */
interface SkillTrigger {
  keywords: RegExp;
  skillName: string;
  description: string;
}

const SKILL_TRIGGERS: SkillTrigger[] = [
  { keywords: /report|daily|scheduled|cron/i, skillName: 'scheduled-tasks', description: 'Scheduled task management with two-phase execution' },
  { keywords: /monitor|alert|metric|track/i, skillName: 'monitors', description: 'Metric monitoring with condition-based alerts' },
  { keywords: /notebook|document|analyze|ingest/i, skillName: 'notebooks', description: 'Document analysis with source-grounded answers' },
  { keywords: /memory|remember|forget|recall/i, skillName: 'memory', description: 'Persistent memory with FTS5 search' },
  { keywords: /goal|objective|target/i, skillName: 'goals', description: 'Goal tracking and daily task generation' },
  { keywords: /learn|error|mistake|improve/i, skillName: 'learnings', description: 'Structured self-improvement from errors' },
  { keywords: /browser|page|click|screenshot/i, skillName: 'browser', description: 'Browser automation via Chrome extension' },
  { keywords: /image|photo|picture|generate/i, skillName: 'gemini', description: 'Image generation and editing via Gemini' },
];

function getRelevantSkills(recentMessages: string): string[] {
  const matched = SKILL_TRIGGERS.filter(t => t.keywords.test(recentMessages));
  if (matched.length === 0) return SKILL_TRIGGERS.map(t => `- ${t.skillName}: ${t.description}`);
  return matched.map(t => `- **${t.skillName}**: ${t.description}`);
}

/** Build skill section using recent messages for keyword-based injection. */
function buildSkillSection(db: DB): string | null {
  const recentMsgs = db.fetchall(
    "SELECT message FROM conversations WHERE is_from_charlie = 0 ORDER BY created_at DESC LIMIT 5",
  );
  const msgText = recentMsgs.map(r => String(r.message)).join(' ');
  const skills = getRelevantSkills(msgText);
  // Also include the static skill catalog if available
  const catalog = loadSkillCatalog();
  const lines = ['**Relevant capabilities:**', ...skills];
  if (catalog) lines.push('', catalog);
  lines.push('');
  return lines.join('\n');
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
export function buildTaskPreamble(db: DB, templateName?: string): string {
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

  // Area-relevant learnings for this task type
  if (templateName) {
    const areaMap: Record<string, string[]> = {
      'daily-report': ['email', 'git-archive', 'scheduled-tasks'],
      'rtx4090-hobby-report': ['email', 'git-archive', 'scheduled-tasks'],
      'email-report': ['email', 'scheduled-tasks'],
    };
    const areas = areaMap[templateName] || ['scheduled-tasks'];
    const placeholders = areas.map(() => '?').join(',');
    const learnings = db.fetchall(
      `SELECT lesson, area FROM learnings WHERE area IN (${placeholders}) ORDER BY created_at DESC LIMIT 5`,
      areas,
    );
    if (learnings.length > 0) {
      parts.push('**Past learnings for this task type:**');
      for (const l of learnings) {
        parts.push(`- [${l.area}] ${String(l.lesson).slice(0, 120)}`);
      }
      parts.push('');
    }
  }

  // High-confidence playbook entries for this task template
  if (templateName) {
    const goal = `task:${templateName}`;
    const entries = db.fetchall(
      "SELECT action, confidence FROM playbook WHERE goal = ? AND confidence >= 0.3 ORDER BY confidence DESC LIMIT 3",
      [goal],
    );
    if (entries.length > 0) {
      parts.push('**Known fixes for past issues:**');
      for (const e of entries) {
        parts.push(`- (${Math.round((e.confidence as number) * 100)}%) ${String(e.action).slice(0, 120)}`);
      }
      parts.push('');
    }
  }

  // Template performance stats
  if (templateName) {
    const statsRow = db.fetchone(
      "SELECT value FROM state WHERE key = ?",
      [`template_stats:${templateName}`],
    );
    if (statsRow?.value) {
      try {
        const stats = JSON.parse(statsRow.value as string);
        if (stats.runs >= 3) {
          const streakStr = stats.streak > 0
            ? `${stats.streak} successes`
            : stats.streak < 0 ? `${Math.abs(stats.streak)} failures` : 'neutral';
          parts.push(`**Template stats** (${templateName}): ${stats.runs} runs, avg score ${stats.avgScore}/100, avg duration ${Math.round(stats.avgDurationMs / 1000)}s, streak: ${streakStr}`);
          parts.push('');
        }
      } catch { /* ignore invalid stats */ }
    }
  }

  // Past execution context — last 3 completed runs of same template
  if (templateName) {
    const pastRuns = db.fetchall(
      `SELECT t.result, tr.quality_score, tr.error_class, tr.duration_ms
       FROM tasks t
       LEFT JOIN task_reflections tr ON tr.task_id = t.id
       WHERE t.status = 'completed'
         AND t.description LIKE ?
         AND t.completed_at IS NOT NULL
       ORDER BY t.completed_at DESC LIMIT 3`,
      [`template:${templateName}%`],
    );
    if (pastRuns.length > 0) {
      parts.push('**Past runs of this template:**');
      for (const run of pastRuns) {
        const score = run.quality_score != null ? `score:${run.quality_score}` : 'no-score';
        const duration = run.duration_ms ? `${Math.round((run.duration_ms as number) / 1000)}s` : '?s';
        const errors = run.error_class && run.error_class !== 'none' ? ` errors:${run.error_class}` : '';
        parts.push(`- ${score}, ${duration}${errors}`);
        if (run.result) parts.push(`  Result: ${String(run.result).slice(0, 150)}`);
      }
      parts.push('');
    }
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

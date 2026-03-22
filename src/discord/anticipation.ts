/**
 * Anticipation module — predicts what the user likely needs next.
 *
 * Deterministic signal gathering (SQL queries on tasks, goals, learnings,
 * conversations, time patterns) followed by an LLM call to synthesize
 * a prediction. The LLM is genuinely needed here — pattern recognition
 * across heterogeneous signals is not a deterministic problem.
 *
 * Runs from heartbeat every 12th cycle (~1h). Also available as an
 * MCP tool for manual invocation (returns signals without LLM).
 *
 * Budget: shares the awareness message budget. Active hours enforced.
 */

import { spawn as spawnChild } from 'child_process';
import { existsSync } from 'fs';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';

const log = getLogger('anticipation');

const ANTICIPATION_TIMEOUT_MS = 60_000; // 1 min max for LLM call

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

export interface AnticipationSignal {
  category: string;
  detail: string;
  /** Raw data for the LLM prompt (not shown to user directly). */
  data: string;
}

export interface AnticipationResult {
  suggestion: string;
  confidence: 'low' | 'medium' | 'high';
  action: 'suggest' | 'create_task' | 'none';
  reasoning: string;
  /** If action=create_task, the task details. */
  taskTitle?: string;
  taskDescription?: string;
  taskPriority?: number;
}

// ---------------------------------------------------------------------------
// Deterministic signal gathering
// ---------------------------------------------------------------------------

/** What has the user been working on recently? */
function gatherRecentWork(db: DB): AnticipationSignal | null {
  const completed = db.fetchall(
    `SELECT title, result, completed_at, tags FROM tasks
     WHERE status = 'completed' AND completed_at > datetime('now', '-48 hours')
     ORDER BY completed_at DESC LIMIT 5`,
  );

  if (completed.length === 0) return null;

  const titles = completed.map((r) => r.title as string);
  const data = completed.map((r) =>
    `- "${r.title}" (${r.completed_at})${r.tags ? ` [${r.tags}]` : ''}${r.result ? `: ${(r.result as string).slice(0, 100)}` : ''}`
  ).join('\n');

  return {
    category: 'recent_work',
    detail: `Completed ${completed.length} task(s) recently: ${titles.join(', ')}`,
    data,
  };
}

/** What's queued up and what's the priority landscape? */
function gatherPendingWork(db: DB): AnticipationSignal | null {
  const pending = db.fetchall(
    `SELECT title, priority, tags, due_at FROM tasks
     WHERE status IN ('pending', 'active')
     ORDER BY priority ASC, created_at ASC LIMIT 8`,
  );

  if (pending.length === 0) return null;

  const data = pending.map((r) =>
    `- P${r.priority}: "${r.title}"${r.due_at ? ` (due ${r.due_at})` : ''}${r.tags ? ` [${r.tags}]` : ''}`
  ).join('\n');

  return {
    category: 'pending_work',
    detail: `${pending.length} pending/active task(s)`,
    data,
  };
}

/** What goals exist and how are they progressing? */
function gatherGoalState(db: DB): AnticipationSignal | null {
  const goals = db.fetchall(
    "SELECT key, content FROM memories WHERE namespace = 'goals' AND type = 'goal'",
  );

  if (goals.length === 0) return null;

  const data = goals.map((r) =>
    `- Goal "${r.key}": ${(r.content as string).slice(0, 150)}`
  ).join('\n');

  return {
    category: 'goals',
    detail: `${goals.length} active goal(s)`,
    data,
  };
}

/** What time-based patterns exist? (day of week, hour of day) */
function gatherTimeContext(db: DB): AnticipationSignal {
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[now.getDay()];
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  // Check what tasks were typically done at this time of day
  const hourStr = String(hour).padStart(2, '0');
  const sameTimeTasks = db.fetchall(
    `SELECT title FROM tasks
     WHERE status = 'completed'
       AND completed_at LIKE '%${hourStr}:%'
     ORDER BY completed_at DESC LIMIT 3`,
  );

  const patterns = sameTimeTasks.length > 0
    ? `Tasks typically done around ${hour}:00: ${sameTimeTasks.map((r) => `"${r.title}"`).join(', ')}`
    : 'No strong time-of-day patterns yet.';

  return {
    category: 'time_context',
    detail: `${day} ${timeOfDay} (${hour}:00)`,
    data: `Day: ${day}, Time: ${hour}:00 (${timeOfDay})\n${patterns}`,
  };
}

/** Recent learnings that might inform what to do next. */
function gatherRecentLearnings(db: DB): AnticipationSignal | null {
  const learnings = db.fetchall(
    `SELECT category, trigger, lesson, area FROM learnings
     ORDER BY created_at DESC LIMIT 5`,
  );

  if (learnings.length === 0) return null;

  const data = learnings.map((r) =>
    `- [${r.category}] ${r.trigger}: ${(r.lesson as string).slice(0, 100)}${r.area ? ` (${r.area})` : ''}`
  ).join('\n');

  return {
    category: 'recent_learnings',
    detail: `${learnings.length} recent learning(s)`,
    data,
  };
}

/** Recent conversation topics. */
function gatherConversationContext(db: DB): AnticipationSignal | null {
  const messages = db.fetchall(
    `SELECT sender, message FROM conversations
     WHERE channel = 'discord' AND is_from_charlie = 0
       AND created_at > datetime('now', '-4 hours')
     ORDER BY created_at DESC LIMIT 5`,
  );

  if (messages.length === 0) return null;

  const data = messages.map((r) =>
    `- ${r.sender}: ${(r.message as string).slice(0, 100)}`
  ).join('\n');

  return {
    category: 'recent_conversations',
    detail: `${messages.length} recent message(s) from user`,
    data,
  };
}

/** Task completion velocity — is the user on a streak or stalled? */
function gatherVelocity(db: DB): AnticipationSignal | null {
  const last7d = db.fetchone(
    "SELECT COUNT(*) as n FROM tasks WHERE status = 'completed' AND completed_at > datetime('now', '-7 days')",
  );
  const last24h = db.fetchone(
    "SELECT COUNT(*) as n FROM tasks WHERE status = 'completed' AND completed_at > datetime('now', '-24 hours')",
  );

  const weekly = (last7d?.n as number) || 0;
  const daily = (last24h?.n as number) || 0;

  if (weekly === 0 && daily === 0) return null;

  const avgDaily = weekly / 7;
  const trend = daily > avgDaily * 1.5 ? 'above average' : daily < avgDaily * 0.5 ? 'below average' : 'normal';

  return {
    category: 'velocity',
    detail: `${daily} tasks today, ${weekly} this week (${trend})`,
    data: `Completed today: ${daily}, this week: ${weekly}, avg/day: ${avgDaily.toFixed(1)}, trend: ${trend}`,
  };
}

/**
 * Gather all signals. Pure, deterministic, no LLM.
 * Can be used directly by the MCP tool.
 */
export function gatherSignals(db: DB): AnticipationSignal[] {
  const signals: AnticipationSignal[] = [];
  const collectors = [
    gatherRecentWork, gatherPendingWork, gatherGoalState,
    gatherRecentLearnings, gatherConversationContext, gatherVelocity,
  ];

  // Time context always included (it's never null).
  signals.push(gatherTimeContext(db));

  for (const collector of collectors) {
    try {
      const signal = collector(db);
      if (signal) signals.push(signal);
    } catch (err) {
      log.error('Signal collection failed', { error: String(err) });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// LLM reasoning (claude -p)
// ---------------------------------------------------------------------------

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

function buildPrompt(signals: AnticipationSignal[]): string {
  const signalBlocks = signals.map((s) =>
    `### ${s.category}\n${s.data}`
  ).join('\n\n');

  return `You are justclaw's anticipation engine. Your job: look at the signals below about what the user has been doing, their goals, their schedule, and their patterns, then predict what they most likely want or need to do next.

## Signals
${signalBlocks}

## Instructions

1. Synthesize the signals. Look for: unfinished threads from recent work, natural next steps from completed tasks, goals that need attention, time-appropriate actions, patterns in their behavior.

2. Make ONE specific prediction about what the user likely needs next. Be concrete — "review PR #42" not "do some code review".

3. Evaluate whether to act: only suggest creating a task if confidence is high and the action is clearly useful. Default to "suggest" (just tell them).

4. Respond in this EXACT format (no other text):

SUGGESTION:
<one concrete thing the user probably wants or needs to do next>

CONFIDENCE:
<low, medium, or high>

ACTION:
<suggest, create_task, or none>

REASONING:
<2-3 sentences explaining why you predicted this, what signals drove it>

TASK_TITLE:
<only if ACTION is create_task — short title>

TASK_DESCRIPTION:
<only if ACTION is create_task — description with clear outcome>

TASK_PRIORITY:
<only if ACTION is create_task — 1-5, where 1=highest>`;
}

function parseResponse(text: string): AnticipationResult {
  const sections: Record<string, string> = {};
  let currentSection = '';

  for (const line of text.split('\n')) {
    const match = line.match(/^(SUGGESTION|CONFIDENCE|ACTION|REASONING|TASK_TITLE|TASK_DESCRIPTION|TASK_PRIORITY):\s*$/);
    if (match) {
      currentSection = match[1];
      sections[currentSection] = '';
    } else if (currentSection) {
      sections[currentSection] = (sections[currentSection] + '\n' + line).trim();
    }
  }

  // Handle inline format: "SUGGESTION: text here"
  for (const key of ['SUGGESTION', 'CONFIDENCE', 'ACTION', 'REASONING', 'TASK_TITLE', 'TASK_DESCRIPTION', 'TASK_PRIORITY']) {
    if (!sections[key]) {
      const match = text.match(new RegExp(`${key}:\\s*(.+?)(?=\\n(?:SUGGESTION|CONFIDENCE|ACTION|REASONING|TASK_TITLE|TASK_DESCRIPTION|TASK_PRIORITY):|$)`, 's'));
      if (match) sections[key] = match[1].trim();
    }
  }

  const confidence = (sections['CONFIDENCE'] || 'low').toLowerCase() as 'low' | 'medium' | 'high';
  const actionRaw = (sections['ACTION'] || 'suggest').toLowerCase();
  const action = actionRaw.includes('create_task') ? 'create_task'
    : actionRaw.includes('none') ? 'none'
    : 'suggest';

  return {
    suggestion: sections['SUGGESTION'] || text.slice(0, 300),
    confidence,
    action,
    reasoning: sections['REASONING'] || '',
    taskTitle: sections['TASK_TITLE'] || undefined,
    taskDescription: sections['TASK_DESCRIPTION'] || undefined,
    taskPriority: sections['TASK_PRIORITY'] ? parseInt(sections['TASK_PRIORITY'], 10) : undefined,
  };
}

/**
 * Run the full anticipation pipeline: gather signals → LLM reasoning.
 * Returns null if the LLM call fails or produces nothing useful.
 */
export async function anticipate(db: DB): Promise<AnticipationResult | null> {
  const signals = gatherSignals(db);

  if (signals.length <= 1) {
    // Only time context — not enough data to predict anything.
    log.info('Not enough signals for anticipation', { signalCount: signals.length });
    return null;
  }

  const prompt = buildPrompt(signals);
  const claudeBin = findClaudeBin();

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--allowedTools', '',
  ];

  const shellCmd = [claudeBin, ...args]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');

  try {
    const response = await new Promise<string>((resolve, reject) => {
      const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: (() => {
          const e: Record<string, string | undefined> = { ...process.env, JUSTCLAW_NO_DASHBOARD: '1' };
          delete e.CLAUDECODE;
          return e;
        })(),
      });

      let stdout = '';
      const timeout = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* */ }
        reject(new Error('Anticipation timed out'));
      }, ANTICIPATION_TIMEOUT_MS);

      child.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error(`claude exited with code ${code}`));
        else resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    let resultText = response.trim();
    try {
      const parsed = JSON.parse(resultText);
      resultText = parsed.result || resultText;
    } catch { /* use raw */ }

    const result = parseResponse(resultText);
    log.info('Anticipation result', {
      suggestion: result.suggestion.slice(0, 100),
      confidence: result.confidence,
      action: result.action,
    });

    return result;
  } catch (err) {
    log.error('Anticipation LLM call failed', { error: String(err) });
    return null;
  }
}

/**
 * Format anticipation result for Discord.
 */
export function formatAnticipation(result: AnticipationResult): string {
  const icon = result.confidence === 'high' ? '🎯' : result.confidence === 'medium' ? '💡' : '🤔';
  const lines = [
    `${icon} **Suggestion** _(${result.confidence} confidence)_`,
    result.suggestion,
    '',
    `_${result.reasoning}_`,
  ];

  if (result.action === 'create_task' && result.taskTitle) {
    lines.push('', `📋 Created task: **${result.taskTitle}** (P${result.taskPriority || 3})`);
  }

  return lines.join('\n');
}

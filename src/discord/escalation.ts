/**
 * Goal-driven LLM escalation — invoked when deterministic fixes fail.
 *
 * Architecture:
 *   1. Deterministic heartbeat detects issue (e.g., CRASH_LOOP)
 *   2. Deterministic fixes attempted (kill orphans, nudge pm2)
 *   3. If issue persists across N cycles, escalate to Claude
 *   4. Claude diagnoses (read-only first), then acts if high confidence
 *   5. Claude's recommendation stored in escalation_log for user review
 *   6. Recommendation surfaced on next system update / user interaction
 *
 * Guardrails:
 *   - Max ESCALATION_BUDGET calls per hour per goal
 *   - Read-only diagnosis first (scoped --allowedTools)
 *   - Circuit breaker: 3 consecutive failed escalations → stop, alert user
 *   - No code generation — only bash commands and pm2 actions
 *   - All actions logged to escalation_log
 */

import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { spawnClaudeP } from '../claude-spawn.js';
import { reflectOnEscalation } from './reflect.js';

const log = getLogger('escalation');

const ESCALATION_BUDGET_PER_HOUR = 3;
const ESCALATION_COOLDOWN_CYCLES = 3;  // Don't escalate until issue persists for 3 cycles
const MAX_CONSECUTIVE_FAILURES = 3;    // Circuit breaker

// Per-goal tracking (in-memory, resets on restart — that's fine).
interface GoalState {
  issueFirstSeen: number;    // When the issue was first detected this streak
  cyclesSeen: number;        // How many heartbeat cycles the issue persisted
  escalationsThisHour: number;
  hourStart: number;
  consecutiveFailures: number;
  lastEscalationAt: number;
}

const goalStates = new Map<string, GoalState>();

function getGoalState(goal: string): GoalState {
  let state = goalStates.get(goal);
  if (!state) {
    state = {
      issueFirstSeen: 0,
      cyclesSeen: 0,
      escalationsThisHour: 0,
      hourStart: Date.now(),
      consecutiveFailures: 0,
      lastEscalationAt: 0,
    };
    goalStates.set(goal, state);
  }
  // Reset hourly budget.
  if (Date.now() - state.hourStart > 3_600_000) {
    state.escalationsThisHour = 0;
    state.hourStart = Date.now();
  }
  return state;
}

/** Mark that an issue was seen this cycle (call from heartbeat). */
export function markIssueSeen(goal: string): void {
  const state = getGoalState(goal);
  if (state.cyclesSeen === 0) {
    state.issueFirstSeen = Date.now();
  }
  state.cyclesSeen++;
}

/** Mark that the issue resolved (call when heartbeat goes OK). */
export function markIssueResolved(goal: string): void {
  const state = getGoalState(goal);
  state.cyclesSeen = 0;
  state.consecutiveFailures = 0;
}

/** Check if escalation should happen for this goal. */
export function shouldEscalate(goal: string): { should: boolean; reason: string } {
  const state = getGoalState(goal);

  if (state.cyclesSeen < ESCALATION_COOLDOWN_CYCLES) {
    return { should: false, reason: `Only seen ${state.cyclesSeen}/${ESCALATION_COOLDOWN_CYCLES} cycles` };
  }

  if (state.escalationsThisHour >= ESCALATION_BUDGET_PER_HOUR) {
    return { should: false, reason: `Budget exhausted (${state.escalationsThisHour}/${ESCALATION_BUDGET_PER_HOUR} this hour)` };
  }

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { should: false, reason: `Circuit breaker: ${state.consecutiveFailures} consecutive failures` };
  }

  // Don't re-escalate within 10 minutes of last escalation.
  if (Date.now() - state.lastEscalationAt < 10 * 60_000) {
    return { should: false, reason: 'Cooling down (10min between escalations)' };
  }

  return { should: true, reason: `Issue persisted ${state.cyclesSeen} cycles` };
}

// ---------------------------------------------------------------------------
// Claude escalation call
// ---------------------------------------------------------------------------

interface EscalationResult {
  diagnosis: string;
  recommendation: string;
  actionTaken: string | null;  // null if Claude only diagnosed
  resolved: boolean;
}

/**
 * Escalate to Claude for diagnosis and remediation.
 * Two phases:
 *   1. Diagnose: Claude reads logs, checks state (read-only tools)
 *   2. Act: If Claude has a high-confidence fix, it can execute bash commands
 *
 * Returns the diagnosis, any action taken, and a recommendation for
 * improving the deterministic system to catch this next time.
 */
export async function escalate(
  db: DB,
  goal: string,
  issueDetail: string,
  context: string,
): Promise<EscalationResult> {
  const state = getGoalState(goal);
  state.escalationsThisHour++;
  state.lastEscalationAt = Date.now();

  log.info('Escalating to Claude', { goal, cyclesSeen: state.cyclesSeen, detail: issueDetail.slice(0, 200) });

  // Log the escalation attempt.
  db.execute(
    'INSERT INTO escalation_log (goal, trigger_detail, outcome) VALUES (?, ?, ?)',
    [goal, issueDetail, 'pending'],
  );
  const escalationId = (db.fetchone('SELECT last_insert_rowid() as id') as { id: number }).id;

  // Fetch past diagnoses for this goal to make Claude smarter over time.
  let pastDiagnoses = '';
  try {
    const past = db.fetchall(
      "SELECT diagnosis, action_taken, outcome, created_at FROM escalation_log WHERE goal = ? AND outcome != 'pending' ORDER BY created_at DESC LIMIT 3",
      [goal],
    );
    if (past.length > 0) {
      pastDiagnoses = '\n## Past escalations for this goal (learn from these)\n' +
        past.map((p) => `- ${p.created_at}: ${p.diagnosis} → ${p.outcome}${p.action_taken ? ` (action: ${p.action_taken})` : ''}`).join('\n');
    }
  } catch (e: unknown) { log.debug('Failed to load past escalation diagnoses', { goal, error: String(e) }); }

  const prompt = buildEscalationPrompt(goal, issueDetail, context + pastDiagnoses);

  try {
    const response = await spawnClaudeP({
      prompt,
      allowedTools: [
        'mcp__justclaw__*',
        'Bash(pm2:*)', 'Bash(ps:*)', 'Bash(journalctl:*)',
        'Bash(cat:*)', 'Bash(tail:*)', 'Bash(head:*)', 'Bash(grep:*)',
        'Bash(kill:*)', 'Bash(df:*)', 'Bash(free:*)', 'Bash(uname:*)',
        'Bash(ls:*)', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(sqlite3:*)',
        'Bash(curl:*)', 'Bash(git:*)',
        'Read', 'Glob', 'Grep',
      ],
      timeoutMs: 120_000,
    });

    // Extract structured sections from Claude's response.
    const result = parseEscalationResponse(response.text);

    // Update escalation log.
    db.execute(
      `UPDATE escalation_log SET diagnosis = ?, action_taken = ?, recommendation = ?,
       outcome = ?, resolved_at = datetime('now') WHERE id = ?`,
      [result.diagnosis, result.actionTaken || '', result.recommendation,
       result.resolved ? 'resolved' : 'unresolved', escalationId],
    );

    // Save diagnosis to justclaw memory so Charlie can recall past incidents.
    // This makes future escalations smarter without modifying code.
    const memoryKey = `escalation:${goal}:${new Date().toISOString().slice(0, 10)}`;
    const memoryContent = [
      `Goal: ${goal}`,
      `Trigger: ${issueDetail.slice(0, 200)}`,
      `Diagnosis: ${result.diagnosis}`,
      result.actionTaken ? `Action: ${result.actionTaken}` : null,
      result.recommendation ? `Recommendation: ${result.recommendation}` : null,
      `Outcome: ${result.resolved ? 'resolved' : 'unresolved'}`,
    ].filter(Boolean).join('\n');

    try {
      db.execute(
        `INSERT INTO memories (key, content, type, tags, namespace)
         VALUES (?, ?, 'diagnosis', ?, 'system')
         ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
        [memoryKey, memoryContent, `escalation,${goal}`],
      );
    } catch (e: unknown) { log.debug('Escalation memory save failed', { memoryKey, error: String(e) }); }

    // Post-escalation reflection: auto-extract learning + update playbook.
    try {
      reflectOnEscalation(db, goal, result.diagnosis, result.actionTaken || null, result.recommendation || null, result.resolved);
    } catch (e: unknown) { log.debug('Escalation reflection failed', { goal, error: String(e) }); }

    if (result.resolved) {
      state.consecutiveFailures = 0;
      log.info('Escalation resolved issue', { goal, diagnosis: result.diagnosis.slice(0, 100) });
    } else {
      state.consecutiveFailures++;
      log.warn('Escalation did not resolve issue', { goal, failures: state.consecutiveFailures });
    }

    return result;
  } catch (err) {
    state.consecutiveFailures++;

    db.execute(
      "UPDATE escalation_log SET diagnosis = ?, outcome = 'error', resolved_at = datetime('now') WHERE id = ?",
      [String(err).slice(0, 500), escalationId],
    );

    log.error('Escalation failed', { goal, error: String(err) });

    return {
      diagnosis: `Escalation failed: ${String(err).slice(0, 200)}`,
      recommendation: '',
      actionTaken: null,
      resolved: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt and response parsing
// ---------------------------------------------------------------------------

function buildEscalationPrompt(goal: string, issueDetail: string, context: string): string {
  return `You are justclaw's escalation agent. A deterministic health check has detected an issue that it couldn't fix automatically. Your job: diagnose the root cause, fix it if possible, and recommend how to improve the system.

## Issue
Goal: ${goal}
Detail: ${issueDetail}

## Context
${context}

## Instructions

1. **Diagnose**: Read relevant logs and check system state. Use Bash to run:
   - \`pm2 logs <name> --lines 30 --nostream\` for recent logs
   - \`pm2 jlist\` for process status
   - \`ps aux | grep justclaw\` for running processes
   - \`tail -20 ${process.env.JUSTCLAW_ROOT || '.'}/data/logs/*.jsonl\` for app logs

2. **Fix** (if high confidence): Execute a fix via Bash. Only take actions you're confident about:
   - \`pm2 restart <name>\` for crash-looping processes
   - \`kill <pid>\` for orphaned processes
   - \`fuser -k <port>/tcp\` for port conflicts
   - Do NOT edit source code. Do NOT modify configuration files.

3. **Respond** in this exact format (keep each section to 1-3 lines):

DIAGNOSIS:
<what's wrong and why>

ACTION:
<what you did to fix it, or "None — diagnosis only" if you didn't act>

RESOLVED:
<yes or no>

RECOMMENDATION:
<how the deterministic heartbeat system should be updated to catch this automatically next time. Be specific: what check to add, what pattern to detect, what action to take. This will be shown to the developer on next system update.>`;
}

function parseEscalationResponse(text: string): EscalationResult {
  const sections: Record<string, string> = {};
  let currentSection = '';

  for (const line of text.split('\n')) {
    const sectionMatch = line.match(/^(DIAGNOSIS|ACTION|RESOLVED|RECOMMENDATION):\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections[currentSection] = '';
    } else if (currentSection) {
      sections[currentSection] = (sections[currentSection] + '\n' + line).trim();
    }
  }

  // Handle inline format: "DIAGNOSIS: text here"
  for (const key of ['DIAGNOSIS', 'ACTION', 'RESOLVED', 'RECOMMENDATION']) {
    if (!sections[key]) {
      const match = text.match(new RegExp(`${key}:\\s*(.+?)(?=\\n(?:DIAGNOSIS|ACTION|RESOLVED|RECOMMENDATION):|$)`, 's'));
      if (match) sections[key] = match[1].trim();
    }
  }

  const resolved = (sections['RESOLVED'] || '').toLowerCase().includes('yes');
  const actionTaken = sections['ACTION'] && !sections['ACTION'].toLowerCase().includes('none')
    ? sections['ACTION']
    : null;

  return {
    diagnosis: sections['DIAGNOSIS'] || text.slice(0, 500),
    recommendation: sections['RECOMMENDATION'] || '',
    actionTaken,
    resolved,
  };
}

// ---------------------------------------------------------------------------
// Pending recommendations (surfaced to user)
// ---------------------------------------------------------------------------

/** Get unresolved recommendations for the user. */
export function getPendingRecommendations(db: DB): Array<{ id: number; goal: string; recommendation: string; created_at: string }> {
  return db.fetchall(
    `SELECT id, goal, recommendation, created_at FROM escalation_log
     WHERE recommendation != '' AND recommendation IS NOT NULL
     ORDER BY created_at DESC LIMIT 20`,
  ) as unknown as Array<{ id: number; goal: string; recommendation: string; created_at: string }>;
}

/** Format recommendations for display (Discord or CLI). */
export function formatRecommendations(db: DB): string | null {
  const recs = getPendingRecommendations(db);
  if (recs.length === 0) return null;

  const lines = ['**System Improvement Recommendations** (from escalation troubleshooting):\n'];
  for (const rec of recs.slice(0, 5)) {
    lines.push(`• **${rec.goal}** (${rec.created_at}):`);
    lines.push(`  ${rec.recommendation.slice(0, 200)}`);
  }
  if (recs.length > 5) {
    lines.push(`\n_...and ${recs.length - 5} more. Query escalation_log for full list._`);
  }
  return lines.join('\n');
}

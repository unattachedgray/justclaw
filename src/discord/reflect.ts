/**
 * Reflect module — post-task and post-escalation learning extraction.
 *
 * Runs deterministically after each scheduled task completes or each
 * escalation resolves. Reuses diagnosis context from heal phase —
 * no duplicate LLM calls.
 *
 * Three safety tiers:
 *   Tier 1 (core): report + recommend only
 *   Tier 2 (orchestration): auto-improve with validation
 *   Tier 3 (skills/scripts): hotplug freely
 *
 * All functions are deterministic except routeNovelError which
 * delegates to the existing escalation pipeline.
 */

import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { scanTaskOutput, classifyErrors, type QualityScan, type ErrorClass } from './quality-scan.js';
import { addLearningProgrammatic } from '../learnings.js';
import { recordPlaybookEntry, updatePlaybookOutcome, consultPlaybook } from '../playbook.js';
import { parseTemplateRef } from '../task-templates.js';

const log = getLogger('reflect');

// ---------------------------------------------------------------------------
// Schema: task_reflections table (created via migration)
// ---------------------------------------------------------------------------

const CREATE_REFLECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS task_reflections (
    id               INTEGER PRIMARY KEY,
    task_id          INTEGER NOT NULL,
    quality_score    INTEGER NOT NULL,
    error_class      TEXT,
    errors_found     TEXT,
    learnings_created INTEGER NOT NULL DEFAULT 0,
    playbook_updated INTEGER NOT NULL DEFAULT 0,
    duration_ms      INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** Ensure the task_reflections table exists. */
export function ensureReflectSchema(db: DB): void {
  try {
    db.execute(CREATE_REFLECTIONS_TABLE);
  } catch (e: unknown) {
    log.debug('Reflect schema check', { error: String(e) });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReflectionResult {
  taskId: number;
  qualityScore: number;
  errorClass: ErrorClass;
  errors: string[];
  warnings: string[];
  learningsCreated: number;
  playbookUpdated: boolean;
  /** If non-empty, post this summary to Discord. Empty = stay silent. */
  discordSummary: string;
}

// ---------------------------------------------------------------------------
// Post-task reflection
// ---------------------------------------------------------------------------

/**
 * Reflect on a completed scheduled task.
 * Called from scheduled-tasks.ts after each task finishes.
 * Entirely deterministic — no LLM calls.
 */
export function reflectOnTaskResult(
  db: DB,
  task: { id: number; title: string; description: string; tags?: string },
  resultText: string,
  durationMs: number,
  exitCode: number | null,
): ReflectionResult {
  ensureReflectSchema(db);

  // Determine template name for section-aware scanning
  const ref = parseTemplateRef(task.description);
  const templateName = ref?.templateName;

  // Phase 1: Quality scan (deterministic)
  const scan = scanTaskOutput(resultText, task.title, templateName);
  const errorClass = classifyErrors(scan);

  // Phase 2: Extract learnings (deterministic)
  let learningsCreated = 0;

  if (exitCode !== 0 && exitCode !== null) {
    addLearningProgrammatic(db, 'error',
      `Task "${task.title}" exited with code ${exitCode}`,
      `Scheduled task failed with exit code ${exitCode}. ${scan.errors.map(e => e.pattern).join(', ')}`,
      'scheduled-tasks',
    );
    learningsCreated++;
  }

  // Auto-learn from specific error patterns
  for (const error of scan.errors) {
    if (error.pattern === 'Email send failed' || error.pattern === 'SMTP not configured') {
      addLearningProgrammatic(db, 'error',
        `Email delivery failed in task "${task.title}"`,
        `Email step failed: ${error.match}. Check SMTP config in .env and scripts/send-email.sh.`,
        'email',
      );
      learningsCreated++;
      break; // One email learning per task is enough
    }
    if (error.pattern === 'Git fatal error') {
      addLearningProgrammatic(db, 'error',
        `Git archive failed in task "${task.title}"`,
        `Git operation failed: ${error.match}. Check repo exists and has push access.`,
        'git-archive',
      );
      learningsCreated++;
      break;
    }
  }

  // Phase 3: Playbook update (deterministic)
  let playbookUpdated = false;

  if (errorClass !== 'none') {
    const goal = `task:${templateName || 'custom'}`;
    const pattern = scan.errors[0]?.pattern || 'unknown';
    const existing = consultPlaybook(db, goal, pattern);

    if (existing) {
      updatePlaybookOutcome(db, existing.id, false);
      playbookUpdated = true;
    } else if (errorClass === 'permanent' || errorClass === 'novel') {
      // New pattern — record it for future reference
      recordPlaybookEntry(db, goal, pattern,
        `Error occurred: ${scan.errors.map(e => e.match).join('; ').slice(0, 200)}`,
        'auto-reflect',
      );
      playbookUpdated = true;
    }
  } else if (scan.score >= 80) {
    // Successful task — update playbook confidence if we have an entry
    const goal = `task:${templateName || 'custom'}`;
    const entries = db.fetchall(
      "SELECT id FROM playbook WHERE goal = ? ORDER BY last_used DESC LIMIT 1",
      [goal],
    );
    if (entries.length > 0) {
      updatePlaybookOutcome(db, entries[0].id as number, true);
      playbookUpdated = true;
    }
  }

  // Phase 4: Store reflection record
  db.execute(
    `INSERT INTO task_reflections (task_id, quality_score, error_class, errors_found, learnings_created, playbook_updated, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [task.id, scan.score, errorClass, JSON.stringify(scan.errors), learningsCreated, playbookUpdated ? 1 : 0, durationMs],
  );

  // Phase 5: Build Discord summary (only if issues found)
  let discordSummary = '';
  if (scan.score < 70) {
    const lines = [`📊 **Task reflection** — ${task.title} (score: ${scan.score}/100)`];
    if (scan.errors.length > 0) {
      lines.push(`❌ Errors: ${scan.errors.map(e => e.pattern).join(', ')}`);
    }
    if (scan.sections.missing.length > 0) {
      lines.push(`⚠️ Missing sections: ${scan.sections.missing.join(', ')}`);
    }
    if (learningsCreated > 0) {
      lines.push(`📝 ${learningsCreated} learning(s) auto-recorded`);
    }
    lines.push(`⏱️ Duration: ${Math.round(durationMs / 1000)}s | Class: ${errorClass}`);
    discordSummary = lines.join('\n');
  }

  log.info('Task reflection complete', {
    taskId: task.id,
    score: scan.score,
    errorClass,
    errors: scan.errors.length,
    learnings: learningsCreated,
    durationMs,
  });

  return {
    taskId: task.id,
    qualityScore: scan.score,
    errorClass,
    errors: scan.errors.map(e => e.pattern),
    warnings: scan.warnings.map(e => e.pattern),
    learningsCreated,
    playbookUpdated,
    discordSummary,
  };
}

// ---------------------------------------------------------------------------
// Post-escalation reflection
// ---------------------------------------------------------------------------

/**
 * Extract learnings from an escalation outcome.
 * Called from escalation.ts after diagnosis completes.
 * Reuses the diagnosis context — no duplicate LLM call.
 */
export function reflectOnEscalation(
  db: DB,
  goal: string,
  diagnosis: string,
  actionTaken: string | null,
  recommendation: string | null,
  resolved: boolean,
): void {
  ensureReflectSchema(db);

  // Auto-create learning from escalation outcome
  const category = resolved ? 'discovery' : 'error';
  const trigger = `Escalation for ${goal}`;
  const lesson = resolved
    ? `Resolved: ${diagnosis.slice(0, 200)}${actionTaken ? `. Fix: ${actionTaken.slice(0, 100)}` : ''}`
    : `Unresolved: ${diagnosis.slice(0, 200)}${recommendation ? `. Recommend: ${recommendation.slice(0, 100)}` : ''}`;

  addLearningProgrammatic(db, category, trigger, lesson, goal.split(':')[0] || 'system');

  // Update or create playbook entry
  const pattern = goal;
  if (resolved && actionTaken) {
    recordPlaybookEntry(db, goal, pattern, actionTaken, 'escalation');
    const entry = consultPlaybook(db, goal, pattern);
    if (entry) updatePlaybookOutcome(db, entry.id, true);
  } else {
    const entry = consultPlaybook(db, goal, pattern);
    if (entry) updatePlaybookOutcome(db, entry.id, false);
  }

  log.info('Escalation reflection complete', { goal, resolved, category });
}

// ---------------------------------------------------------------------------
// Anticipation validation
// ---------------------------------------------------------------------------

/**
 * Validate previous anticipation predictions against actual outcomes.
 * Checks if predicted tasks/actions materialized within a time window.
 * Deterministic — SQL queries only.
 */
export function validateAnticipations(db: DB): { validated: number; correct: number; wrong: number } {
  // Check if anticipation_log table exists
  try {
    db.execute(`CREATE TABLE IF NOT EXISTS anticipation_log (
      id INTEGER PRIMARY KEY, suggestion TEXT NOT NULL, confidence TEXT NOT NULL,
      action TEXT NOT NULL, reasoning TEXT, validated INTEGER DEFAULT NULL,
      validated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch { /* table may already exist */ }

  const pending = db.fetchall(
    `SELECT id, suggestion, confidence, created_at FROM anticipation_log
     WHERE validated IS NULL AND created_at < datetime('now', '-2 hours')
     LIMIT 10`,
  );

  let correct = 0;
  let wrong = 0;

  for (const pred of pending) {
    // Check if a task matching the suggestion was completed in the 4h after prediction
    const keywords = (pred.suggestion as string).slice(0, 100).split(/\s+/).filter(w => w.length > 4).slice(0, 3);
    if (keywords.length === 0) {
      db.execute("UPDATE anticipation_log SET validated = 0, validated_at = datetime('now') WHERE id = ?", [pred.id]);
      wrong++;
      continue;
    }

    const likeClause = keywords.map(() => 'title LIKE ?').join(' OR ');
    const params = keywords.map(k => `%${k}%`);
    const match = db.fetchone(
      `SELECT id FROM tasks WHERE status = 'completed' AND completed_at > ? AND completed_at < datetime(?, '+4 hours') AND (${likeClause})`,
      [pred.created_at, pred.created_at, ...params],
    );

    const wasCorrect = match !== null;
    db.execute("UPDATE anticipation_log SET validated = ?, validated_at = datetime('now') WHERE id = ?",
      [wasCorrect ? 1 : 0, pred.id]);

    if (wasCorrect) correct++;
    else wrong++;
  }

  if (pending.length > 0) {
    log.info('Anticipation validation', { validated: pending.length, correct, wrong });
  }

  return { validated: pending.length, correct, wrong };
}

// ---------------------------------------------------------------------------
// Quality trend analysis
// ---------------------------------------------------------------------------

/**
 * Get quality score trend for recent task reflections.
 * Used by awareness checks to detect declining task quality.
 */
export function getQualityTrend(db: DB, days: number = 7): { avg: number; count: number; declining: boolean } {
  ensureReflectSchema(db);

  const recent = db.fetchone(
    `SELECT AVG(quality_score) as avg, COUNT(*) as count FROM task_reflections
     WHERE created_at > datetime('now', '-${days} days')`,
  );
  const older = db.fetchone(
    `SELECT AVG(quality_score) as avg FROM task_reflections
     WHERE created_at > datetime('now', '-${days * 2} days')
       AND created_at <= datetime('now', '-${days} days')`,
  );

  const avg = (recent?.avg as number) || 0;
  const count = (recent?.count as number) || 0;
  const olderAvg = (older?.avg as number) || avg;
  const declining = count >= 3 && avg < olderAvg - 10;

  return { avg: Math.round(avg), count, declining };
}

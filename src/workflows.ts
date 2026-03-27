/**
 * Workflow engine — chain multiple task templates into sequential pipelines.
 * Each step's output feeds the next step's context.
 *
 * Workflow definitions stored in data/workflows/ as simple config files.
 * This module provides the execution engine; scheduling is handled
 * by the existing task system.
 */

import type { DB } from './db.js';
import { getLogger } from './logger.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const log = getLogger('workflows');

export interface WorkflowStep {
  template: string;
  vars?: Record<string, string>;
  depends_on?: string;  // step name this depends on
}

export interface WorkflowDef {
  name: string;
  steps: WorkflowStep[];
  parallel: boolean;
  on_failure: 'continue' | 'abort';
}

/** Parse a workflow definition file. */
export function parseWorkflow(content: string): WorkflowDef | null {
  const lines = content.split('\n');
  const def: Partial<WorkflowDef> = {
    steps: [],
    parallel: false,
    on_failure: 'continue',
  };

  let currentStep: Partial<WorkflowStep> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('name:')) {
      def.name = trimmed.slice(5).trim();
    } else if (trimmed.startsWith('parallel:')) {
      def.parallel = trimmed.slice(9).trim() === 'true';
    } else if (trimmed.startsWith('on_failure:')) {
      def.on_failure = trimmed.slice(11).trim() as 'continue' | 'abort';
    } else if (trimmed.startsWith('- template:')) {
      if (currentStep?.template) def.steps!.push(currentStep as WorkflowStep);
      currentStep = { template: trimmed.slice(11).trim() };
    } else if (trimmed.startsWith('depends_on:') && currentStep) {
      currentStep.depends_on = trimmed.slice(11).trim();
    }
  }
  if (currentStep?.template) def.steps!.push(currentStep as WorkflowStep);

  if (!def.name || !def.steps || def.steps.length === 0) return null;
  return def as WorkflowDef;
}

/** List available workflows from data/workflows/ directory. */
export function listWorkflows(): WorkflowDef[] {
  const dir = join(
    process.env.JUSTCLAW_ROOT || process.cwd(),
    'data',
    'workflows',
  );
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.md') || f.endsWith('.yml'))
    .map(f => {
      const content = readFileSync(join(dir, f), 'utf-8');
      return parseWorkflow(content);
    })
    .filter((w): w is WorkflowDef => w !== null);
}

/**
 * Create tasks for a workflow execution.
 * Each step becomes a task with depends_on linking to the previous step.
 */
export function instantiateWorkflow(
  db: DB,
  workflow: WorkflowDef,
  targetChannel?: string,
): number[] {
  const taskIds: number[] = [];
  const now = db.now();

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const dependsOn = !workflow.parallel && i > 0
      ? String(taskIds[i - 1])
      : '';

    const tags = `workflow,${workflow.name}`;
    db.execute(
      `INSERT INTO tasks (title, description, priority, tags, depends_on, target_channel, created_at, updated_at)
       VALUES (?, ?, 2, ?, ?, ?, ?, ?)`,
      [
        `[${workflow.name}] Step ${i + 1}: ${step.template}`,
        `template:${step.template}`,
        tags,
        dependsOn,
        targetChannel || null,
        now,
        now,
      ],
    );
    const last = db.fetchone('SELECT id FROM tasks ORDER BY id DESC LIMIT 1');
    if (last) taskIds.push(last.id as number);
  }

  log.info('Workflow instantiated', {
    name: workflow.name,
    steps: taskIds.length,
    taskIds,
  });
  return taskIds;
}

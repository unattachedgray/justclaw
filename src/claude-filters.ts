/**
 * Composable filter pipeline for claude -p invocations.
 * Each filter can run before/after a claude -p spawn.
 * Centralizes token metering, cost tracking, timeout, audit logging.
 */

import type { DB } from './db.js';
import { getLogger } from './logger.js';

const log = getLogger('claude-filters');

export interface SpawnContext {
  taskId?: number;
  role: string;        // 'scheduled-task', 'discord', 'escalation', 'heartbeat'
  prompt: string;
  startedAt: number;
  stepCount: number;
  metadata: Record<string, unknown>;
}

export interface SpawnResult {
  text: string;
  exitCode: number | null;
  durationMs: number;
  sessionId: string | null;
}

export interface ClaudeFilter {
  name: string;
  before?(ctx: SpawnContext): void;
  after?(ctx: SpawnContext, result: SpawnResult): void;
}

/** Token metering filter — estimates tokens from prompt and result. */
export const tokenMeterFilter: ClaudeFilter = {
  name: 'token-meter',
  before(ctx) {
    ctx.metadata.promptTokenEstimate = Math.ceil(ctx.prompt.length / 4);
  },
  after(ctx, result) {
    const resultTokens = Math.ceil(result.text.length / 4);
    const promptTokens = (ctx.metadata.promptTokenEstimate as number) || 0;
    log.info('Token usage', {
      role: ctx.role,
      taskId: ctx.taskId,
      promptTokens,
      resultTokens,
      totalTokens: promptTokens + resultTokens,
    });
  },
};

/** Audit log filter — records every invocation to the daily log. */
export function createAuditFilter(db: DB): ClaudeFilter {
  return {
    name: 'audit-log',
    after(ctx, result) {
      const entry = `claude-p [${ctx.role}] task:${ctx.taskId || 'none'} exit:${result.exitCode} ${result.durationMs}ms`;
      db.execute(
        "INSERT INTO daily_log (date, entry, category) VALUES (?, ?, 'claude-p')",
        [new Date().toISOString().slice(0, 10), entry],
      );
    },
  };
}

/** Duration tracking filter — warns on slow invocations. */
export const durationFilter: ClaudeFilter = {
  name: 'duration',
  after(ctx, result) {
    if (result.durationMs > 10 * 60_000) {
      log.warn('Long-running claude -p invocation', {
        role: ctx.role,
        taskId: ctx.taskId,
        durationMs: result.durationMs,
      });
    }
  },
};

/** Run all before-filters on a context. */
export function runBeforeFilters(filters: ClaudeFilter[], ctx: SpawnContext): void {
  for (const f of filters) {
    try {
      f.before?.(ctx);
    } catch (e: unknown) {
      log.warn('Filter before-hook failed', { filter: f.name, error: String(e) });
    }
  }
}

/** Run all after-filters on a context + result. */
export function runAfterFilters(filters: ClaudeFilter[], ctx: SpawnContext, result: SpawnResult): void {
  for (const f of filters) {
    try {
      f.after?.(ctx, result);
    } catch (e: unknown) {
      log.warn('Filter after-hook failed', { filter: f.name, error: String(e) });
    }
  }
}

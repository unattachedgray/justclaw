import { Hono } from 'hono';
import { execSync } from 'child_process';
import type { DB } from '../db.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { registerDataRoutes } from './api-data.js';
import { registerActionRoutes } from './api-actions.js';

// Shared types used by sub-modules
export interface ResourceHistoryPoint {
  t: number;
  mem_pct: number;
  dashboard_mb: number;
  discord_mb: number;
}

// --- Shared helpers (used by api-data.ts and api-actions.ts) ---

export function projectRoot(): string {
  return process.env.JUSTCLAW_ROOT || process.cwd();
}

export function pidFilePath(name: string): string {
  return join(projectRoot(), 'data', `${name}.pid`);
}

export function pidStatus(name: string): { pid: number | null; alive: boolean; file: string } {
  const path = pidFilePath(name);
  if (!existsSync(path)) return { pid: null, alive: false, file: `${name}.pid` };
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return { pid, alive: true, file: `${name}.pid` };
  } catch { /* PID file unreadable or process dead, report as not alive */
    return { pid: null, alive: false, file: `${name}.pid` };
  }
}

export function getPm2Processes(): Array<{ name: string; rss_mb: number; pid: number }> {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { timeout: 3000 }).toString().trim();
    const list = JSON.parse(raw) as Array<{ name: string; pid: number; monit?: { memory?: number } }>;
    return list
      .filter((p) => p.name.startsWith('justclaw'))
      .map((p) => ({
        name: p.name,
        rss_mb: Math.round((p.monit?.memory ?? 0) / 1048576),
        pid: p.pid,
      }));
  } catch { /* pm2 not running or command failed, return empty list */
    return [];
  }
}

export function createApiRoutes(db: DB): Hono {
  const api = new Hono();
  const startTime = Date.now() / 1000;

  registerDataRoutes(api, db, startTime);
  registerActionRoutes(api, db);

  return api;
}

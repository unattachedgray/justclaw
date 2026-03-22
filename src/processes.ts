/**
 * PID file utilities for MCP server lifecycle.
 *
 * Used by index.ts for PID tracking and dashboard spawning.
 * Process management MCP tools live in server.ts and delegate to process-registry.ts.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { getLogger } from './logger.js';

function projectRoot(): string {
  return process.env.JUSTCLAW_ROOT || process.cwd();
}

function pidFilePath(name: string): string {
  return join(projectRoot(), 'data', `${name}.pid`);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(name: string): number | null {
  const path = pidFilePath(name);
  if (!existsSync(path)) return null;
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function writePidFile(name: string, pid: number): void {
  const path = pidFilePath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
}

export function removePidFile(name: string): void {
  const path = pidFilePath(name);
  try {
    unlinkSync(path);
  } catch {
    /* PID file already gone */
  }
}

export function killStalePid(name: string, label: string): void {
  const log = getLogger('mcp-server');
  const pid = readPidFile(name);
  if (pid === null) return;
  if (pid === process.pid) return;
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      log.warn(`Killed stale ${label}`, { old_pid: pid });
    } catch {
      /* process already exiting */
    }
  }
  removePidFile(name);
}

export function spawnDashboard(): void {
  const log = getLogger('mcp-server');
  const root = projectRoot();

  killStalePid('dashboard', 'dashboard');

  const dashPid = readPidFile('dashboard');
  if (dashPid !== null && isPidAlive(dashPid)) {
    log.info('Dashboard already running', { pid: dashPid });
    return;
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    JUSTCLAW_ROOT: root,
  };
  if (process.env.JUSTCLAW_CONFIG) {
    env.JUSTCLAW_CONFIG = process.env.JUSTCLAW_CONFIG;
  }

  try {
    const child = spawn('node', [join(root, 'dist', 'dashboard', 'app.js')], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log.info('Dashboard spawned', { pid: child.pid });
  } catch (e) {
    log.warn('Failed to spawn dashboard', { error: String(e) });
  }
}

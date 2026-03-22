#!/usr/bin/env node
/**
 * justclaw Dashboard — web control plane.
 *
 * Reads charlie.db and renders a live dashboard with process management,
 * data views, and SSE for live refresh. Runs as a separate process.
 * Password-protected. Accessible from the local network.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { DB } from '../db.js';
import { loadConfig, resolveDbPath } from '../config.js';
import { getLogger } from '../logger.js';
import { createApiRoutes } from './api.js';
import { startHeartbeat } from './sse.js';
import { DASHBOARD_HTML } from './html.js';
import {
  LOGIN_HTML,
  checkPassword,
  makeSessionToken,
  isValidSession,
  sessionCookie,
  clearCookie,
  getSessionFromCookie,
} from './login.js';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

function projectRoot(): string {
  return process.env.JUSTCLAW_ROOT || process.cwd();
}

function pidFilePath(): string {
  return join(projectRoot(), 'data', 'dashboard.pid');
}

function writeDashboardPid(): void {
  const path = pidFilePath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const oldPid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
      if (oldPid !== process.pid) {
        process.kill(oldPid, 'SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }
  writeFileSync(path, String(process.pid));
}

function cleanupDashboard(): void {
  const path = pidFilePath();
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8').trim() === String(process.pid)) {
      unlinkSync(path);
    }
  } catch {
    /* ignore */
  }
}

// Keep the process alive on unhandled errors.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

function main(): void {
  process.on('SIGTERM', () => {
    cleanupDashboard();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanupDashboard();
    process.exit(0);
  });
  process.on('exit', cleanupDashboard);

  writeDashboardPid();

  const config = loadConfig(process.env.JUSTCLAW_CONFIG);
  const root = projectRoot();
  const dbPath = resolveDbPath(config, root);
  const db = new DB(dbPath);
  const log = getLogger('dashboard');

  const app = new Hono();

  // --- Auth routes (no middleware) ---

  app.get('/login', (c) => c.html(LOGIN_HTML));

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const password = String(body.password || '');
    if (checkPassword(password)) {
      const token = makeSessionToken();
      c.header('Set-Cookie', sessionCookie(token));
      return c.redirect('/');
    }
    return c.redirect('/login?error=1');
  });

  app.get('/logout', (c) => {
    c.header('Set-Cookie', clearCookie());
    return c.redirect('/login');
  });

  // --- Auth middleware for everything else ---

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/login' || path === '/logout') return next();

    const cookie = c.req.header('cookie');
    const token = getSessionFromCookie(cookie);
    if (!token || !isValidSession(token)) {
      return c.redirect('/login');
    }
    return next();
  });

  // --- Protected routes ---

  // Dashboard HTML page.
  app.get('/', (c) => c.html(DASHBOARD_HTML));

  // Mount API routes under /api.
  const apiRoutes = createApiRoutes(db);
  app.route('/api', apiRoutes);

  // Start heartbeat for SSE.
  startHeartbeat();

  const port = parseInt(process.env.PORT || '8787', 10);
  log.info('Dashboard starting', { port, pid: process.pid });

  // Bind to 0.0.0.0 to be accessible from the local network.
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    log.info('Dashboard listening', { port: info.port, hostname: '0.0.0.0' });
  });
}

main();

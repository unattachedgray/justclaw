#!/usr/bin/env node
/**
 * justclaw — Entry point for the MCP server.
 *
 * Lifecycle:
 *   - Writes PID file, cleans stale instances
 *   - Auto-spawns dashboard as detached subprocess
 *   - Connects MCP server to stdio transport
 *   - Graceful shutdown on SIGTERM/SIGINT
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'path';
import { getLogger } from './logger.js';
import {
  writePidFile,
  removePidFile,
  readPidFile,
  killStalePid,
  spawnDashboard,
} from './processes.js';
import { createServer, shutdown } from './server.js';

const PROJECT_ROOT = process.env.JUSTCLAW_ROOT || process.cwd();
const CONFIG_PATH = process.env.JUSTCLAW_CONFIG || undefined;

function cleanup(): void {
  try {
    // Kill dashboard
    const dashPid = readPidFile('dashboard');
    if (dashPid !== null) {
      try {
        process.kill(dashPid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const log = getLogger('mcp-server');
    log.info('MCP server shutting down', { pid: process.pid });
    shutdown();
  } catch {
    /* ignore */
  }

  try {
    // Only remove PID file if it's ours
    const currentPid = readPidFile('justclaw');
    if (currentPid === process.pid) {
      removePidFile('justclaw');
    }
  } catch {
    /* ignore */
  }
}

function signalHandler(): void {
  cleanup();
  process.exit(0);
}

async function main(): Promise<void> {
  process.on('SIGTERM', signalHandler);
  process.on('SIGINT', signalHandler);
  process.on('exit', cleanup);

  // Clean stale instances and write our PID.
  killStalePid('justclaw', 'MCP server');
  writePidFile('justclaw', process.pid);

  const log = getLogger('mcp-server');
  log.info('MCP server starting', { pid: process.pid });

  // Auto-start dashboard unless disabled.
  if (process.env.JUSTCLAW_NO_DASHBOARD !== '1') {
    spawnDashboard();
  }

  const server = createServer({
    configPath: CONFIG_PATH,
    projectRoot: resolve(PROJECT_ROOT),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  const log = getLogger('mcp-server');
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});

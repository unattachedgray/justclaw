import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { spawn as spawnChild, execSync } from 'child_process';
import type { DB } from '../db.js';
import { getLogger } from '../logger.js';
import { addClient, removeClient, pushEvent } from './sse.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { projectRoot, pidStatus } from './api.js';

const log = getLogger('dashboard');

// Persists across messages for multi-turn dashboard conversation
let chatSessionId: string | null = null;

// In-memory command queue for the browser extension
interface ExtensionCommand {
  id: string;
  type: string;
  createdAt: number;
  pickedUp: boolean;
  result?: unknown;
  completedAt?: number;
  [key: string]: unknown;
}

const extensionCommands: ExtensionCommand[] = [];
const MAX_EXTENSION_COMMANDS = 50;
const COMMAND_TTL_MS = 5 * 60 * 1000; // 5 min TTL
const COMPLETED_TTL_MS = 60 * 1000; // 1 min TTL for completed commands

function pruneExtensionCommands(): void {
  const now = Date.now();
  for (let i = extensionCommands.length - 1; i >= 0; i--) {
    const cmd = extensionCommands[i];
    if (cmd.completedAt && now - cmd.completedAt > COMPLETED_TTL_MS) {
      extensionCommands.splice(i, 1);
    }
  }
  while (extensionCommands.length > 0 && now - extensionCommands[0].createdAt > COMMAND_TTL_MS) {
    extensionCommands.shift();
  }
  while (extensionCommands.length > MAX_EXTENSION_COMMANDS) {
    extensionCommands.shift();
  }
}

export function registerActionRoutes(api: Hono, db: DB): void {
  // --- Chat (conversations/send) ---
  api.post('/conversations/send', async (c) => {
    const body = await c.req.json<{ message?: string; sender?: string; channel?: string }>();
    const message = (body.message || '').trim();
    const sender = (body.sender || 'dashboard-user').trim();
    const channel = (body.channel || 'dashboard').trim();
    if (!message) return c.json({ error: 'message required' }, 400);

    const now = db.now();
    db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
      [channel, sender, message, now],
    );

    try {
      const response = await callClaude(message);
      const { replyText, sessionId } = parseClaudeResponse(response);

      const replyNow = db.now();
      db.execute(
        'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 1, ?)',
        [channel, 'charlie', replyText, replyNow],
      );

      pushEvent('refresh', JSON.stringify({ reason: 'chat_response' }));

      return c.json({
        ok: true,
        reply: replyText,
        session_id: sessionId,
        created_at: replyNow,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Process management ---
  api.get('/processes', (c) => c.json({ mcp_server: pidStatus('justclaw'), dashboard: pidStatus('dashboard') }));

  api.post('/processes/kill', async (c) => {
    const body = await c.req.json<{ pid?: number }>();
    if (!body.pid) return c.json({ error: 'pid required' }, 400);
    if (body.pid === process.pid) return c.json({ error: 'cannot kill self' }, 400);
    const registered = db.fetchone(
      "SELECT pid, role FROM process_registry WHERE pid = ? AND status = 'active'",
      [body.pid],
    );
    if (!registered) return c.json({ error: 'PID not in justclaw process registry' }, 403);
    try {
      process.kill(body.pid, 'SIGTERM');
      log.info('Manual kill', { pid: body.pid });
      pushEvent('refresh', JSON.stringify({ reason: 'manual_kill', pid: body.pid }));
      return c.json({ killed: body.pid });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  api.post('/processes/check-ghosts', (c) => {
    const mcp = pidStatus('justclaw');
    const dashboard = pidStatus('dashboard');
    const stale: string[] = [];
    if (!mcp.alive && mcp.pid !== null) stale.push('justclaw.pid');
    if (!dashboard.alive && dashboard.pid !== null) stale.push('dashboard.pid');
    return c.json({ mcp_server: mcp, dashboard, stale_pid_files: stale });
  });

  api.get('/ghost-state', (c) => {
    const path = join(projectRoot(), 'data', 'ghost_check_state.json');
    if (existsSync(path)) {
      try {
        return c.json(JSON.parse(readFileSync(path, 'utf-8')));
      } catch { /* corrupt JSON state file, return defaults */ }
    }
    return c.json({ skip_budget: 0, forced_remaining: 0, total_checks: 0 });
  });

  // --- Build ---
  api.post('/actions/build', (c) => {
    try {
      const output = execSync('npm run build', { cwd: projectRoot(), timeout: 60000, encoding: 'utf-8' });
      log.info('Build completed via dashboard');
      return c.json({ ok: true, output: output.slice(-2000) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('Build failed via dashboard', { error: msg.slice(0, 500) });
      return c.json({ error: msg.slice(0, 2000) }, 500);
    }
  });

  // --- Webhook ---
  let lastWebhookTime = 0;
  api.post('/webhook', async (c) => {
    const token = process.env.JUSTCLAW_WEBHOOK_TOKEN;
    if (!token) return c.json({ error: 'Webhook not configured' }, 503);

    const auth = c.req.header('Authorization') || '';
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const now = Date.now();
    if (now - lastWebhookTime < 1000) {
      return c.json({ error: 'Rate limited' }, 429);
    }
    lastWebhookTime = now;

    const body = await c.req.json<{ message?: string; sender?: string; channel?: string }>();
    const message = (body.message || '').trim();
    if (!message) return c.json({ error: 'message required' }, 400);

    const sender = (body.sender || 'webhook').trim();
    const channel = (body.channel || 'webhook').trim();
    const ts = db.now();
    const result = db.execute(
      'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, 0, ?)',
      [channel, sender, message, ts],
    );
    pushEvent('refresh', JSON.stringify({ reason: 'webhook' }));
    return c.json({ ok: true, id: Number(result.lastInsertRowid) });
  });

  // --- SSE ---
  api.get('/events', (c) => {
    return stream(c, async (s) => {
      const readable = new ReadableStream<string>({
        start(controller) {
          const client = addClient(controller);
          controller.enqueue('event: connected\ndata: ok\n\n');

          c.req.raw.signal.addEventListener('abort', () => {
            removeClient(client);
            try {
              controller.close();
            } catch { /* controller already closed by another abort handler */ }
          });
        },
      });

      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } catch { /* SSE stream closed by client disconnect, expected */ }
    });
  });

  // --- Browser Extension Bridge ---
  registerExtensionRoutes(api, db);
}

// --- Extension command routes ---

function registerExtensionRoutes(api: Hono, db: DB): void {
  api.get('/extension-commands', (c) => {
    pruneExtensionCommands();
    const pickup = c.req.query('pickup') === 'true';
    const pending = extensionCommands.filter((cmd) => !cmd.pickedUp && !cmd.result);

    if (pickup) {
      for (const cmd of pending) {
        cmd.pickedUp = true;
      }
    }

    return c.json({ commands: pending });
  });

  api.post('/extension-commands', async (c) => {
    const body = await c.req.json();

    // Result post from the extension
    if (body.cmdId && body.result !== undefined) {
      const cmd = extensionCommands.find((cmd) => cmd.id === body.cmdId);
      if (cmd) {
        cmd.result = body.result;
        cmd.completedAt = Date.now();
      }
      return c.json({ ok: true });
    }

    // New command to queue
    pruneExtensionCommands();
    const id = body.id || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cmd: ExtensionCommand = {
      id,
      type: body.type,
      createdAt: Date.now(),
      pickedUp: false,
      ...body,
    };
    extensionCommands.push(cmd);
    return c.json({ queued: true, id });
  });

  api.get('/extension-commands/:id', (c) => {
    const id = c.req.param('id');
    const cmd = extensionCommands.find((cmd) => cmd.id === id);
    if (!cmd) return c.json({ error: 'Command not found' }, 404);
    return c.json(cmd);
  });

  api.post('/usage-calibration', async (c) => {
    const data = await c.req.json();
    const now = new Date().toISOString();

    try {
      db.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('extension_usage', ?)",
        [JSON.stringify({ ...data, receivedAt: now })],
      );
      db.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('extension_last_seen', ?)",
        [now],
      );
    } catch (err) {
      log.error('Failed to store usage data', { error: String(err) });
    }

    log.info('Usage calibration received', {
      session: data.session,
      weeklyAll: data.weeklyAll,
      plan: data.planInfo,
    });

    return c.json({ ok: true, receivedAt: now });
  });

  api.get('/usage-calibration', (c) => {
    const row = db.fetchone("SELECT value FROM state WHERE key = 'extension_usage'");
    if (!row) return c.json({ error: 'No usage data yet' }, 404);
    try {
      return c.json(JSON.parse(row.value as string));
    } catch { /* stored JSON is malformed, report error to caller */
      return c.json({ error: 'Corrupt usage data' }, 500);
    }
  });

  api.get('/extension-status', (c) => {
    return c.json(buildExtensionStatus(db));
  });
}

// --- Helpers ---

function buildExtensionStatus(db: DB): Record<string, unknown> {
  const lastSeen = db.fetchone("SELECT value FROM state WHERE key = 'extension_last_seen'");
  const usage = db.fetchone("SELECT value FROM state WHERE key = 'extension_usage'");

  let connected = false;
  let lastSeenAt: string | null = null;
  if (lastSeen) {
    lastSeenAt = lastSeen.value as string;
    const age = Date.now() - new Date(lastSeenAt).getTime();
    connected = age < 15 * 60 * 1000;
  }

  let usageData: Record<string, unknown> | null = null;
  if (usage) {
    try { usageData = JSON.parse(usage.value as string) as Record<string, unknown>; } catch { /* corrupt usage JSON in state table, treat as no data */ }
  }

  return {
    connected,
    lastSeenAt,
    pendingCommands: extensionCommands.filter((cmd) => !cmd.pickedUp && !cmd.result).length,
    usage: usageData ? {
      session: usageData.session,
      weeklyAll: usageData.weeklyAll,
      weeklySonnet: usageData.weeklySonnet,
      planInfo: usageData.planInfo,
    } : null,
  };
}

function findClaudeBin(): string {
  const home = process.env.HOME || '';
  const candidates = [
    home + '/.local/bin/claude',
    home + '/.claude/local/claude',
    '/usr/local/bin/claude',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

async function callClaude(message: string): Promise<string> {
  const claudeBin = findClaudeBin();
  const args = ['-p', message, '--output-format', 'json'];
  if (chatSessionId) {
    args.push('--resume', chatSessionId);
  }

  log.info('Calling claude', { bin: claudeBin, args: args.slice(0, 3), sessionId: chatSessionId });

  const shellCmd = [claudeBin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  return new Promise<string>((resolve, reject) => {
    const child = spawnChild('setsid', ['-w', 'bash', '-c', shellCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.on('error', (err) => {
      log.error('claude spawn error', { error: String(err) });
      reject(new Error(String(err)));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        log.error('claude -p exited non-zero', { code, stderr: stderr.slice(0, 500) });
        reject(new Error(stderr || `claude exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseClaudeResponse(response: string): { replyText: string; sessionId: string | null } {
  try {
    const parsed = JSON.parse(response);
    const replyText = parsed.result ?? response;
    if (parsed.session_id) {
      chatSessionId = parsed.session_id;
    }
    return { replyText, sessionId: chatSessionId };
  } catch { /* response is plain text, not JSON, use raw output */
    return { replyText: response.trim(), sessionId: chatSessionId };
  }
}

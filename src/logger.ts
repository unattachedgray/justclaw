import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const RETENTION_DAYS = 30;

function getLogDir(): string {
  const root = process.env.JUSTCLAW_ROOT || process.cwd();
  return join(root, 'data', 'logs');
}

function ensureLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function pruneOldLogs(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch { /* log directory doesn't exist or unreadable, skip pruning */
    return;
  }

  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const match = name.match(/_(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    const fileDate = new Date(match[1] + 'T00:00:00Z').getTime();
    if (fileDate < cutoff) {
      try {
        unlinkSync(join(dir, name));
      } catch { /* old log file already deleted or locked, skip */ }
    }
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowISO(): string {
  return new Date().toISOString();
}

export class Logger {
  private dir: string;

  constructor(private name: string) {
    this.dir = getLogDir();
    ensureLogDir(this.dir);
    pruneOldLogs(this.dir);
  }

  private todayFile(): string {
    return join(this.dir, `${this.name}_${todayStr()}.jsonl`);
  }

  private write(level: string, message: string, extra: Record<string, unknown> = {}): void {
    const entry = {
      ts: nowISO(),
      level,
      logger: this.name,
      msg: message,
      ...extra,
    };
    const line = JSON.stringify(entry);
    try {
      appendFileSync(this.todayFile(), line + '\n', 'utf-8');
    } catch { /* logging must never crash the app, silently drop the entry */ }
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    }
  }

  info(message: string, extra: Record<string, unknown> = {}): void {
    this.write('info', message, extra);
  }

  warn(message: string, extra: Record<string, unknown> = {}): void {
    this.write('warn', message, extra);
  }

  error(message: string, extra: Record<string, unknown> = {}): void {
    this.write('error', message, extra);
  }

  debug(message: string, extra: Record<string, unknown> = {}): void {
    this.write('debug', message, extra);
  }
}

const loggers = new Map<string, Logger>();

export function getLogger(name: string): Logger {
  let logger = loggers.get(name);
  if (!logger) {
    logger = new Logger(name);
    loggers.set(name, logger);
  }
  return logger;
}

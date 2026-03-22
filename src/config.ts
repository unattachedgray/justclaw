import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseTOML } from 'smol-toml';

export interface CharlieConfig {
  name: string;
  db_path: string;
  log_level: string;
  default_channel: string;
  respond_to_all: boolean;
  personality: string;
  timezone: string;
  memory_max_entries: number;
  auto_flush_on_exit: boolean;
  task_default_priority: number;
  active_hours_start: number;
  active_hours_end: number;
  max_proactive_messages_per_day: number;
  auto_execute_tasks: boolean;
}

const DEFAULTS: CharlieConfig = {
  name: 'Charlie',
  db_path: '',
  log_level: 'info',
  default_channel: 'discord',
  respond_to_all: true,
  personality: '',
  timezone: 'UTC',
  memory_max_entries: 1000,
  auto_flush_on_exit: true,
  task_default_priority: 5,
  active_hours_start: 8,
  active_hours_end: 22,
  max_proactive_messages_per_day: 3,
  auto_execute_tasks: false,
};

export function loadConfig(configPath?: string): CharlieConfig {
  if (!configPath) {
    configPath = process.env.JUSTCLAW_CONFIG || '';
  }

  if (!configPath) {
    const candidates = [
      resolve('config/charlie.toml'),
      join(process.env.HOME || '', '.config', 'justclaw', 'charlie.toml'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
  }

  if (configPath && existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const data = parseTOML(raw) as Record<string, unknown>;
    return fromDict(data);
  }

  return { ...DEFAULTS };
}

function fromDict(data: Record<string, unknown>): CharlieConfig {
  const charlie = (data.charlie ?? data) as Record<string, unknown>;
  const memory = (charlie.memory ?? {}) as Record<string, unknown>;
  const tasks = (charlie.tasks ?? {}) as Record<string, unknown>;

  const autonomy = (charlie.autonomy ?? {}) as Record<string, unknown>;

  return {
    name: (charlie.name as string) ?? DEFAULTS.name,
    db_path: (charlie.db_path as string) ?? DEFAULTS.db_path,
    log_level: (charlie.log_level as string) ?? DEFAULTS.log_level,
    default_channel: (charlie.default_channel as string) ?? DEFAULTS.default_channel,
    respond_to_all: (charlie.respond_to_all as boolean) ?? DEFAULTS.respond_to_all,
    personality: (charlie.personality as string) ?? DEFAULTS.personality,
    timezone: (charlie.timezone as string) ?? DEFAULTS.timezone,
    memory_max_entries: (memory.max_entries as number) ?? DEFAULTS.memory_max_entries,
    auto_flush_on_exit: (memory.auto_flush_on_exit as boolean) ?? DEFAULTS.auto_flush_on_exit,
    task_default_priority: (tasks.default_priority as number) ?? DEFAULTS.task_default_priority,
    active_hours_start: (autonomy.active_hours_start as number) ?? DEFAULTS.active_hours_start,
    active_hours_end: (autonomy.active_hours_end as number) ?? DEFAULTS.active_hours_end,
    max_proactive_messages_per_day: (autonomy.max_proactive_messages_per_day as number) ?? DEFAULTS.max_proactive_messages_per_day,
    auto_execute_tasks: (autonomy.auto_execute_tasks as boolean) ?? DEFAULTS.auto_execute_tasks,
  };
}

export function resolveDbPath(config: CharlieConfig, projectRoot?: string): string {
  if (config.db_path) {
    return resolve(config.db_path);
  }
  if (projectRoot) {
    return join(projectRoot, 'data', 'charlie.db');
  }
  return resolve('data', 'charlie.db');
}

/**
 * Parses Claude Code CLI session JSONL files for usage tracking.
 * Reads from ~/.claude/projects/ to extract token counts, models, cache stats.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

export interface SessionSummary {
  session_id: string;
  project: string;
  model: string;
  git_branch: string | null;
  started_at: string;
  last_activity: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cache_hit_rate: number;
  estimated_cost_usd: number;
}

interface AssistantMessage {
  type: string;
  timestamp: string;
  sessionId: string;
  gitBranch?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/** Find all Claude Code project directories under ~/.claude/projects/ */
function findProjectDirs(): { path: string; name: string }[] {
  const base = join(homedir(), '.claude', 'projects');
  try {
    return readdirSync(base)
      .filter((d) => {
        try {
          return statSync(join(base, d)).isDirectory();
        } catch { /* entry deleted between readdir and stat, skip */
          return false;
        }
      })
      .map((d) => ({ path: join(base, d), name: d.replace(/-/g, '/').replace(/^\//, '') }));
  } catch { /* ~/.claude/projects doesn't exist yet, no sessions to list */
    return [];
  }
}

/** Parse a single session JSONL file */
function parseSession(filePath: string, projectName: string): SessionSummary | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    let model = 'unknown';
    let gitBranch: string | null = null;
    let firstTimestamp = '';
    let lastTimestamp = '';
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreation = 0;
    let cacheRead = 0;

    for (const line of lines) {
      let entry: AssistantMessage;
      try {
        entry = JSON.parse(line);
      } catch { /* malformed JSONL line, skip */
        continue;
      }

      if (!firstTimestamp && entry.timestamp) firstTimestamp = entry.timestamp;
      if (entry.timestamp) lastTimestamp = entry.timestamp;

      if (entry.type !== 'assistant' || !entry.message?.usage) continue;

      turns++;
      const u = entry.message.usage;
      inputTokens += u.input_tokens || 0;
      outputTokens += u.output_tokens || 0;
      cacheCreation += u.cache_creation_input_tokens || 0;
      cacheRead += u.cache_read_input_tokens || 0;

      if (entry.message.model) model = entry.message.model;
      if (entry.gitBranch) gitBranch = entry.gitBranch;
    }

    if (turns === 0) return null;

    const totalInput = inputTokens + cacheCreation + cacheRead;
    const totalTokens = totalInput + outputTokens;
    const cacheHitRate = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;

    // Anthropic pricing (per 1M tokens): input $15, output $75, cache write $18.75, cache read $1.50
    const cost =
      (inputTokens / 1e6) * 15 +
      (outputTokens / 1e6) * 75 +
      (cacheCreation / 1e6) * 18.75 +
      (cacheRead / 1e6) * 1.5;

    const sessionId = basename(filePath, '.jsonl');

    return {
      session_id: sessionId,
      project: projectName,
      model,
      git_branch: gitBranch,
      started_at: firstTimestamp,
      last_activity: lastTimestamp,
      turns,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_tokens: cacheCreation,
      cache_read_tokens: cacheRead,
      total_tokens: totalTokens,
      cache_hit_rate: cacheHitRate,
      estimated_cost_usd: Math.round(cost * 100) / 100,
    };
  } catch { /* corrupt or truncated session file, skip */
    return null;
  }
}

/** Get all sessions, sorted by most recent first */
export function getAllSessions(limit = 20): SessionSummary[] {
  const dirs = findProjectDirs();
  const sessions: SessionSummary[] = [];

  for (const dir of dirs) {
    try {
      const files = readdirSync(dir.path).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const s = parseSession(join(dir.path, file), dir.name);
        if (s) sessions.push(s);
      }
    } catch { /* project directory unreadable or deleted, skip */
      continue;
    }
  }

  sessions.sort((a, b) => (b.last_activity > a.last_activity ? 1 : -1));
  return sessions.slice(0, limit);
}

/** Aggregate stats across all sessions */
export function getUsageStats(days = 7): {
  total_sessions: number;
  total_turns: number;
  total_input: number;
  total_output: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_tokens: number;
  avg_cache_hit_rate: number;
  total_cost_usd: number;
  by_model: Record<string, { sessions: number; tokens: number; cost: number }>;
  by_day: { day: string; sessions: number; tokens: number; cost: number }[];
} {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();

  const all = getAllSessions(500);
  const filtered = all.filter((s) => s.started_at >= cutoffIso);

  const byModel: Record<string, { sessions: number; tokens: number; cost: number }> = {};
  const byDay: Record<string, { sessions: number; tokens: number; cost: number }> = {};

  let totalInput = 0,
    totalOutput = 0,
    totalCacheCreation = 0,
    totalCacheRead = 0,
    totalCost = 0,
    totalTurns = 0;

  for (const s of filtered) {
    totalInput += s.input_tokens;
    totalOutput += s.output_tokens;
    totalCacheCreation += s.cache_creation_tokens;
    totalCacheRead += s.cache_read_tokens;
    totalCost += s.estimated_cost_usd;
    totalTurns += s.turns;

    // By model
    if (!byModel[s.model]) byModel[s.model] = { sessions: 0, tokens: 0, cost: 0 };
    byModel[s.model].sessions++;
    byModel[s.model].tokens += s.total_tokens;
    byModel[s.model].cost += s.estimated_cost_usd;

    // By day
    const day = s.started_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { sessions: 0, tokens: 0, cost: 0 };
    byDay[day].sessions++;
    byDay[day].tokens += s.total_tokens;
    byDay[day].cost += s.estimated_cost_usd;
  }

  const totalAll = totalInput + totalOutput + totalCacheCreation + totalCacheRead;
  const avgCache = totalAll > 0 ? Math.round((totalCacheRead / (totalInput + totalCacheCreation + totalCacheRead)) * 100) : 0;

  // Round costs
  for (const m of Object.values(byModel)) m.cost = Math.round(m.cost * 100) / 100;
  const dayList = Object.entries(byDay)
    .map(([day, v]) => ({ day, ...v, cost: Math.round(v.cost * 100) / 100 }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    total_sessions: filtered.length,
    total_turns: totalTurns,
    total_input: totalInput,
    total_output: totalOutput,
    total_cache_creation: totalCacheCreation,
    total_cache_read: totalCacheRead,
    total_tokens: totalAll,
    avg_cache_hit_rate: avgCache,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    by_model: byModel,
    by_day: dayList,
  };
}

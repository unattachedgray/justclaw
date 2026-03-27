/**
 * Stream JSON parser for claude -p --output-format stream-json.
 *
 * Extracts phases and tool calls from the streaming output, builds
 * progress messages for display in Discord.
 */

import { DISCORD_MAX_LENGTH } from './discord-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Step {
  tool: string;
  detail: string;
  done: boolean;
}

export interface Phase {
  label: string;
  steps: Step[];
  done: boolean;
  startedAt: number;
  durationMs: number;
}

export interface ProgressState {
  phases: Phase[];
  turns: number;
  startedAt: number;
  dirty: boolean;
  hasActiveAgent: boolean;
  pendingText: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format elapsed time since a start timestamp. */
export function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Short label for a tool. */
export function toolShort(name: string): string {
  if (name.startsWith('mcp__justclaw__')) return `justclaw:${name.slice(15)}`;
  const map: Record<string, string> = {
    Read: 'Read',
    Edit: 'Edit',
    Write: 'Write',
    Bash: 'Bash',
    Glob: 'Glob',
    Grep: 'Grep',
    WebSearch: 'WebSearch',
    WebFetch: 'WebFetch',
    Task: 'Agent',
    Agent: 'Agent',
    TaskOutput: 'AgentOutput',
    SendMessage: 'AgentMsg',
    TodoWrite: 'Todo',
    ToolSearch: 'ToolSearch',
    NotebookEdit: 'Notebook',
  };
  return map[name] || name;
}

/** True if this tool represents a sub-agent that can run for a long time. */
export function isAgentTool(name: string): boolean {
  return ['Task', 'Agent', 'TaskOutput', 'SendMessage'].includes(name);
}

/** Extract a short detail from tool input (file path, query, etc.) */
export function extractDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (typeof input.file_path === 'string') {
    const p = input.file_path as string;
    const parts = p.split('/');
    return parts.slice(-2).join('/');
  }
  if (typeof input.pattern === 'string') return `"${(input.pattern as string).slice(0, 40)}"`;
  if (typeof input.query === 'string') return `"${(input.query as string).slice(0, 40)}"`;
  if (typeof input.command === 'string') {
    const cmd = (input.command as string).slice(0, 50);
    return `\`${cmd}\``;
  }
  if (typeof input.prompt === 'string') return (input.prompt as string).slice(0, 50);
  if (typeof input.description === 'string') return (input.description as string).slice(0, 50);
  return '';
}

/** Derive a phase label from accumulated assistant text. */
export function derivePhaseLabel(text: string): string {
  const cleaned = text
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'Working';

  const sentenceMatch = cleaned.match(/^(.+?[.!])\s/);
  const raw = sentenceMatch ? sentenceMatch[1] : cleaned;

  if (raw.length <= 80) return raw;
  const cutoff = raw.lastIndexOf(' ', 80);
  return raw.slice(0, cutoff > 20 ? cutoff : 80) + '…';
}

// ---------------------------------------------------------------------------
// Progress rendering
// ---------------------------------------------------------------------------

/** Render a completed phase as a one-line summary. */
function renderCompletedPhase(phase: Phase, phaseNum: number): string {
  const stepCount = phase.steps.length;
  const dur = fmtDuration(phase.durationMs);
  const stepSummary = stepCount > 0 ? ` _(${stepCount} steps, ${dur})_` : ` _(${dur})_`;
  return `✅ **Phase ${phaseNum}:** ${phase.label}${stepSummary}`;
}

/** Render the active (in-progress) phase with live step detail. */
function renderActivePhase(phase: Phase, phaseNum: number): string[] {
  const lines: string[] = [];
  lines.push(`⏳ **Phase ${phaseNum}:** ${phase.label}`);

  const steps = phase.steps;
  const showFrom = Math.max(0, steps.length - 6);
  if (showFrom > 0) {
    lines.push(`   _…${showFrom} earlier steps_`);
  }
  for (let j = showFrom; j < steps.length; j++) {
    const step = steps[j];
    const icon = step.done ? '✅' : '⏳';
    const detail = step.detail ? ` — ${step.detail}` : '';
    lines.push(`   ${icon} ${toolShort(step.tool)}${detail}`);
  }

  lines.push(`   ⏱️ _${elapsed(phase.startedAt)} on this phase_`);
  return lines;
}

export function renderProgress(state: ProgressState): string {
  const lines: string[] = [];
  const header = `📋 **Working on your request** _(${elapsed(state.startedAt)})_\n`;
  lines.push(header);

  for (let i = 0; i < state.phases.length; i++) {
    const phase = state.phases[i];
    const phaseNum = i + 1;

    if (phase.done) {
      lines.push(renderCompletedPhase(phase, phaseNum));
    } else {
      lines.push(...renderActivePhase(phase, phaseNum));
    }
  }

  if (state.phases.length === 0) {
    lines.push('⏳ Thinking…');
  }

  let result = lines.join('\n');
  if (result.length > DISCORD_MAX_LENGTH - 50) {
    result = result.slice(0, DISCORD_MAX_LENGTH - 50) + '\n_…truncated_';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stream event processing
// ---------------------------------------------------------------------------

export function getCurrentPhase(progress: ProgressState): Phase | null {
  const last = progress.phases[progress.phases.length - 1];
  return last && !last.done ? last : null;
}

export function ensureActivePhase(progress: ProgressState): Phase {
  let current = getCurrentPhase(progress);
  if (!current) {
    const label = derivePhaseLabel(progress.pendingText);
    progress.pendingText = '';
    current = {
      label,
      steps: [],
      done: false,
      startedAt: Date.now(),
      durationMs: 0,
    };
    progress.phases.push(current);
    progress.dirty = true;
  }
  return current;
}

export function closeCurrentPhase(progress: ProgressState): void {
  const current = getCurrentPhase(progress);
  if (current) {
    current.done = true;
    current.durationMs = Date.now() - current.startedAt;
    for (const step of current.steps) {
      step.done = true;
    }
    progress.dirty = true;
  }
}

/** Process an assistant-type stream event: handle text blocks and tool_use blocks. */
export function processAssistantEvent(
  content: Array<Record<string, unknown>>,
  progress: ProgressState,
): void {
  for (const block of content) {
    if (block.type === 'text') {
      const text = (block.text as string) || '';
      if (text.trim()) {
        const current = getCurrentPhase(progress);
        if (current && current.steps.length > 0) {
          closeCurrentPhase(progress);
        }
        progress.pendingText += ' ' + text;
      }
    } else if (block.type === 'tool_use') {
      handleToolUseBlock(block, progress);
    }
  }
}

/** Handle a single tool_use block within a stream event. */
function handleToolUseBlock(
  block: Record<string, unknown>,
  progress: ProgressState,
): void {
  const toolName = block.name as string;
  const input = block.input as Record<string, unknown> | undefined;
  const detail = extractDetail(input);

  const phase = ensureActivePhase(progress);

  const lastStep = phase.steps[phase.steps.length - 1];
  if (lastStep && !lastStep.done) {
    lastStep.done = true;
  }

  phase.steps.push({ tool: toolName, detail, done: false });
  progress.dirty = true;

  if (isAgentTool(toolName)) {
    progress.hasActiveAgent = true;
  }
}

/** Process a user-type stream event (tool result): mark last step done. */
export function processUserEvent(progress: ProgressState): void {
  const current = getCurrentPhase(progress);
  if (current) {
    const lastStep = current.steps[current.steps.length - 1];
    if (lastStep && !lastStep.done) {
      lastStep.done = true;
      progress.dirty = true;

      if (isAgentTool(lastStep.tool)) {
        progress.hasActiveAgent = false;
      }
    }
  }
  progress.turns++;
}

export function processStreamEvent(
  event: Record<string, unknown>,
  progress: ProgressState,
): void {
  const type = event.type as string;

  if (type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;
    progress.turns = Math.max(progress.turns, 1);
    processAssistantEvent(content, progress);
  } else if (type === 'user') {
    processUserEvent(progress);
  } else if (type === 'result') {
    closeCurrentPhase(progress);
    progress.hasActiveAgent = false;
    progress.dirty = true;
  }
}

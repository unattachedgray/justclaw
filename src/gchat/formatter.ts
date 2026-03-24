/**
 * Google Chat message formatting — markdown dialect translation and Cards v2 builder.
 *
 * Google Chat uses a different markdown dialect than Discord:
 *   - Bold: *text* (not **text**)
 *   - Links: <url|label> (not [label](url))
 *   - Code blocks: ```code``` (no language hints in text messages)
 *   - No typing indicator available
 *   - 32KB message limit (vs Discord's 2000 chars)
 *
 * Cards v2 provide rich structured content for progress display.
 */

/** Google Chat max message size in bytes. */
export const GCHAT_MAX_BYTES = 32_000;

// ---------------------------------------------------------------------------
// Markdown dialect translation
// ---------------------------------------------------------------------------

/**
 * Convert Discord-flavored markdown to Google Chat text format.
 *
 * Handles: bold (**→*), links ([text](url)→<url|text>),
 * strips language hints from code fences.
 */
export function toGChatMarkdown(discord: string): string {
  let text = discord;

  // Bold: **text** → *text* (but avoid converting *** which is bold+italic).
  // Replace ** that aren't part of *** sequences.
  text = text.replace(/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/g, '*$1*');

  // Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Code blocks: ```lang\n → ```\n (strip language hints — GChat ignores them in text).
  text = text.replace(/```\w+\n/g, '```\n');

  return text;
}

/**
 * Split a long message into Google Chat-safe chunks.
 *
 * Much simpler than Discord splitting — 32KB is generous.
 * Only needed for truly massive responses (rare).
 */
export function splitGChatMessage(text: string): string[] {
  // Measure in bytes, not chars (32KB limit is byte-based).
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= GCHAT_MAX_BYTES) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (encoder.encode(remaining).length <= GCHAT_MAX_BYTES) {
      chunks.push(remaining);
      break;
    }

    // Estimate char count for ~30KB (leave margin).
    const targetChars = Math.min(remaining.length, 28_000);
    const window = remaining.slice(0, targetChars);

    // Split on paragraph boundary, then line, then space.
    let splitIdx = window.lastIndexOf('\n\n');
    if (splitIdx <= 0) splitIdx = window.lastIndexOf('\n');
    if (splitIdx <= 0) splitIdx = window.lastIndexOf(' ');
    if (splitIdx <= 0) splitIdx = targetChars;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Cards v2 progress display
// ---------------------------------------------------------------------------

interface ProgressStep {
  tool: string;
  detail: string;
  done: boolean;
}

interface ProgressPhase {
  label: string;
  steps: ProgressStep[];
  done: boolean;
  startedAt: number;
  durationMs: number;
}

interface ProgressData {
  phases: ProgressPhase[];
  startedAt: number;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function elapsed(startMs: number): string {
  return fmtDuration(Date.now() - startMs);
}

/** Short label for a tool name. */
function toolShort(name: string): string {
  if (name.startsWith('mcp__justclaw__')) return `justclaw:${name.slice(15)}`;
  const map: Record<string, string> = {
    Read: 'Read', Edit: 'Edit', Write: 'Write', Bash: 'Bash',
    Glob: 'Glob', Grep: 'Grep', WebSearch: 'WebSearch', WebFetch: 'WebFetch',
    Task: 'Agent', Agent: 'Agent', TaskOutput: 'AgentOutput',
    SendMessage: 'AgentMsg', TodoWrite: 'Todo', ToolSearch: 'ToolSearch',
    NotebookEdit: 'Notebook',
  };
  return map[name] || name;
}

/**
 * Render progress as a plain-text string for Google Chat messages.
 *
 * Uses the same emoji-based format as Discord but without the 2000-char
 * truncation constraint. Updated via message PATCH every 5 seconds.
 */
export function renderProgressText(data: ProgressData): string {
  const lines: string[] = [];
  lines.push(`*Working on your request* _(${elapsed(data.startedAt)})_\n`);

  for (let i = 0; i < data.phases.length; i++) {
    const phase = data.phases[i];
    const num = i + 1;

    if (phase.done) {
      const stepCount = phase.steps.length;
      const dur = fmtDuration(phase.durationMs);
      const summary = stepCount > 0 ? ` _(${stepCount} steps, ${dur})_` : ` _(${dur})_`;
      lines.push(`✅ *Phase ${num}:* ${phase.label}${summary}`);
    } else {
      lines.push(`⏳ *Phase ${num}:* ${phase.label}`);

      const steps = phase.steps;
      const showFrom = Math.max(0, steps.length - 8);
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
    }
  }

  if (data.phases.length === 0) {
    lines.push('⏳ Thinking…');
  }

  return lines.join('\n');
}

/**
 * Build a Cards v2 JSON structure for progress display.
 *
 * Cards provide richer formatting than plain text and are better suited
 * for structured progress updates. Used as the message body when creating
 * or updating the progress message via the Chat API.
 */
export function renderProgressCard(data: ProgressData): Record<string, unknown> {
  const sections: Record<string, unknown>[] = [];

  for (let i = 0; i < data.phases.length; i++) {
    const phase = data.phases[i];
    const num = i + 1;
    let text: string;

    if (phase.done) {
      const dur = fmtDuration(phase.durationMs);
      const stepCount = phase.steps.length;
      text = `✅ Phase ${num}: ${phase.label} (${stepCount} steps, ${dur})`;
    } else {
      const stepLines: string[] = [];
      const steps = phase.steps;
      const showFrom = Math.max(0, steps.length - 8);
      if (showFrom > 0) stepLines.push(`<i>…${showFrom} earlier steps</i>`);
      for (let j = showFrom; j < steps.length; j++) {
        const s = steps[j];
        const icon = s.done ? '✅' : '⏳';
        const detail = s.detail ? ` — ${s.detail}` : '';
        stepLines.push(`${icon} ${toolShort(s.tool)}${detail}`);
      }
      stepLines.push(`⏱️ <i>${elapsed(phase.startedAt)} on this phase</i>`);
      text = `⏳ Phase ${num}: ${phase.label}\n${stepLines.join('\n')}`;
    }

    sections.push({
      widgets: [{ textParagraph: { text } }],
    });
  }

  if (data.phases.length === 0) {
    sections.push({
      widgets: [{ textParagraph: { text: '⏳ Thinking…' } }],
    });
  }

  return {
    cardsV2: [{
      cardId: 'progress',
      card: {
        header: {
          title: 'Working on your request',
          subtitle: elapsed(data.startedAt),
          imageUrl: '',
          imageType: 'CIRCLE',
        },
        sections,
      },
    }],
  };
}

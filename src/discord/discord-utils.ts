/**
 * Shared Discord utilities — message splitting, constants.
 *
 * Extracted to avoid duplication between bot.ts and scheduled-tasks.ts.
 */

export const DISCORD_MAX_LENGTH = 2000;

/**
 * Count opening and closing code fences in text to determine if we're
 * "inside" a code block. Returns the language tag of the unclosed block
 * (empty string if the block had no language), or null if all blocks are closed.
 */
function unclosedCodeBlock(text: string): string | null {
  let inside = false;
  let lang = '';
  // Match lines that are ONLY a fence (optionally with a language tag).
  // This avoids matching ``` that appear inline or in content.
  const fenceRe = /^(`{3,})(\w*)\s*$/gm;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (inside) {
      inside = false;
      lang = '';
    } else {
      inside = true;
      lang = m[2] || '';
    }
  }
  return inside ? lang : null;
}

/**
 * Split a long message into Discord-safe chunks (<=2000 chars each).
 *
 * Strategy:
 * 1. Find the last point between two code blocks (closing fence line
 *    followed by a blank line) within the char limit — split there.
 * 2. If no block boundary fits, fall back to last double-newline, then
 *    last single newline, then last space, then hard cut.
 * 3. After splitting, verify code-block parity. If the chunk ends inside
 *    an unclosed block, append a closing fence and prepend an opening
 *    fence (with the same language tag) to the next chunk.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, DISCORD_MAX_LENGTH);

    // Strategy 1: Split between code blocks.
    // Look for a closing fence on its own line followed by blank line(s).
    // Only consider it a "between blocks" boundary if fence-counting up to
    // that point shows all blocks are closed.
    let splitIdx = -1;
    const betweenRe = /^```\s*\n\n/gm;
    let match;
    while ((match = betweenRe.exec(window)) !== null) {
      // Candidate split: right after the closing fence line + one newline.
      const candidate = match.index + match[0].indexOf('\n') + 1;
      if (candidate <= DISCORD_MAX_LENGTH) {
        // Verify this is actually a closing fence (not an opening one).
        const upTo = remaining.slice(0, candidate);
        if (unclosedCodeBlock(upTo) === null) {
          splitIdx = candidate;
        }
      }
    }

    // Strategy 2: Fall back to paragraph break, then line break, then space.
    if (splitIdx <= 0) {
      splitIdx = window.lastIndexOf('\n\n');
      if (splitIdx > 0) splitIdx += 1; // Include the first \n in this chunk.
    }
    if (splitIdx <= 0) {
      splitIdx = window.lastIndexOf('\n');
    }
    if (splitIdx <= 0) {
      splitIdx = window.lastIndexOf(' ');
    }
    if (splitIdx <= 0) {
      splitIdx = DISCORD_MAX_LENGTH;
    }

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');

    // Strategy 3: Fix up unclosed code blocks.
    const lang = unclosedCodeBlock(chunk);
    if (lang !== null) {
      chunk += '\n```';
      remaining = '```' + lang + '\n' + remaining;
    }

    chunks.push(chunk);
  }
  return chunks;
}

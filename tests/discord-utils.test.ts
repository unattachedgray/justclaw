import { describe, it, expect } from 'vitest';
import { splitMessage, DISCORD_MAX_LENGTH } from '../src/discord/discord-utils.js';

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits at newline when exceeding limit', () => {
    const line = 'x'.repeat(1000);
    const text = line + '\n' + line + '\n' + line;
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH + 4); // +4 for closing fence
    }
  });

  it('keeps code blocks intact when possible', () => {
    const block1 = '```\n' + 'a'.repeat(500) + '\n```';
    const block2 = '```\n' + 'b'.repeat(500) + '\n```';
    const block3 = '```\n' + 'c'.repeat(500) + '\n```';
    const text = block1 + '\n\n' + block2 + '\n\n' + block3;
    const chunks = splitMessage(text);
    // Each chunk should have balanced fences.
    for (const chunk of chunks) {
      const opens = (chunk.match(/^```\w*\s*$/gm) || []).length;
      // Opens and closes should be even (balanced).
      expect(opens % 2).toBe(0);
    }
  });

  it('closes and reopens code blocks when forced to split mid-block', () => {
    // Single code block that exceeds the limit.
    const bigBlock = '```markdown\n' + 'x\n'.repeat(1200) + '```';
    const chunks = splitMessage(bigBlock);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end with closing fence.
    expect(chunks[0].endsWith('```')).toBe(true);
    // Second chunk should start with opening fence (same language).
    expect(chunks[1].startsWith('```markdown\n')).toBe(true);
  });

  it('handles multiple code blocks in a financial report format', () => {
    // Simulate the actual report format.
    const header = 'DAILY FINANCIAL BRIEFING — March 22, 2026\n\n';
    const snapshot = '```\nMARKET SNAPSHOT\nS&P 500: 6,506 (-1.51%)\n' +
      'Line '.repeat(30) + '\n```';
    const opportunities = '```\nTOP OPPORTUNITIES\n' +
      'Ticker | Price | Category\n' +
      'ETH | $2,142 | Crypto\n'.repeat(30) + '\n```';
    const portfolio = '```\nPORTFOLIO TRACKER\n' +
      'Ticker | Entry | Shares\n' +
      'NVDA | $174.90 | 114\n'.repeat(30) + '\n```';

    const text = header + snapshot + '\n\n' + opportunities + '\n\n' + portfolio;
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH + 20);
      // Every chunk with fences should have balanced fences.
      const fences = chunk.match(/^`{3,}\w*\s*$/gm) || [];
      expect(fences.length % 2).toBe(0);
    }
  });

  it('does not introduce extra fences at block boundaries', () => {
    const block = '```\ncontent here\n```';
    const text = block + '\n\nSome text between blocks.\n\n' + block;
    // Under limit — should be returned as-is.
    if (text.length <= DISCORD_MAX_LENGTH) {
      expect(splitMessage(text)).toEqual([text]);
    }
  });

  it('handles text with no code blocks', () => {
    const text = 'Hello world\n'.repeat(200);
    const chunks = splitMessage(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
    }
  });

  it('splits between blocks rather than mid-block', () => {
    // Two blocks of ~900 chars each — total ~1800+header could exceed 2000.
    const block1 = '```\n' + 'AAAA '.repeat(170) + '\n```';
    const between = '\n\nSome text here\n\n';
    const block2 = '```\n' + 'BBBB '.repeat(170) + '\n```';
    const text = block1 + between + block2;

    if (text.length > DISCORD_MAX_LENGTH) {
      const chunks = splitMessage(text);
      // First chunk should contain complete block1.
      expect(chunks[0]).toContain('AAAA');
      expect(chunks[0].match(/^```\s*$/gm)?.length || 0).toBe(2); // open + close
    }
  });
});

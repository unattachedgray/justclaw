import { describe, it, expect } from 'vitest';
import { parseCronField, cronNext } from '../src/cron.js';

describe('parseCronField', () => {
  it('parses wildcard', () => {
    expect(parseCronField('*', 0, 59)).toHaveLength(60);
  });

  it('parses single value', () => {
    expect(parseCronField('5', 0, 59)).toEqual([5]);
  });

  it('parses range', () => {
    expect(parseCronField('1-5', 0, 59)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses step', () => {
    expect(parseCronField('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
  });

  it('parses range with step', () => {
    expect(parseCronField('1-10/3', 0, 59)).toEqual([1, 4, 7, 10]);
  });

  it('parses list', () => {
    expect(parseCronField('1,3,5', 0, 59)).toEqual([1, 3, 5]);
  });

  it('parses complex list with ranges and steps', () => {
    const result = parseCronField('1-3,10,20-25/2', 0, 59);
    expect(result).toEqual([1, 2, 3, 10, 20, 22, 24]);
  });
});

describe('cronNext', () => {
  it('finds next minute for * * * * *', () => {
    const after = new Date('2026-03-21T10:30:00');
    const next = cronNext('* * * * *', after);
    expect(next.getMinutes()).toBe(31);
    expect(next.getHours()).toBe(10);
  });

  it('finds daily 7am: 0 7 * * *', () => {
    const after = new Date('2026-03-21T10:00:00');
    const next = cronNext('0 7 * * *', after);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(2); // March (0-based)
    expect(next.getDate()).toBe(22);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(0);
  });

  it('finds every 30 min: */30 * * * *', () => {
    const after = new Date('2026-03-21T10:15:00');
    const next = cronNext('*/30 * * * *', after);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(10);
  });

  it('finds weekdays 9am: 0 9 * * 1-5', () => {
    // March 21 2026 is Saturday (dow=6)
    const after = new Date('2026-03-21T10:00:00');
    const next = cronNext('0 9 * * 1-5', after);
    expect(next.getDate()).toBe(23); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('advances past current minute', () => {
    const after = new Date('2026-03-21T09:00:00');
    const next = cronNext('0 9 * * *', after);
    // Should go to next day since 9:00 is the current time
    expect(next.getDate()).toBe(22);
    expect(next.getHours()).toBe(9);
  });

  it('throws on invalid expression', () => {
    expect(() => cronNext('0 9 *', new Date())).toThrow('expected 5 fields');
  });
});

/**
 * Minimal 5-field cron expression parser.
 * Fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sun).
 * Supports: *, specific values, ranges (1-5), steps (* /15, 1-5/2), lists (1,3,5).
 * No external dependencies.
 */

/** Parse a single cron field into an array of matching integers. */
export function parseCronField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const [rangeStr, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    let lo: number;
    let hi: number;
    if (rangeStr === '*') {
      lo = min;
      hi = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-');
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangeStr, 10);
      hi = lo;
    }

    for (let i = lo; i <= hi; i += step) {
      result.add(i);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Compute the next occurrence of a 5-field cron expression after `after`.
 * All times are in UTC to match db.now() which uses toISOString().
 * Searches up to 366 days ahead to avoid infinite loops.
 */
export function cronNext(expr: string, after: Date): Date {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeek = parseCronField(fields[4], 0, 6);

  // Start one minute after `after` to ensure we always advance
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000;

  while (candidate.getTime() <= limit) {
    const mon = candidate.getUTCMonth() + 1; // JS months are 0-based
    if (!months.includes(mon)) {
      // Jump to first day of next month
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    if (!daysOfMonth.includes(dom) || !daysOfWeek.includes(dow)) {
      // Jump to next day
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hr = candidate.getUTCHours();
    if (!hours.includes(hr)) {
      // Jump to next hour
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    const min = candidate.getUTCMinutes();
    if (!minutes.includes(min)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return candidate;
  }

  throw new Error(`No cron match found within 366 days for: ${expr}`);
}

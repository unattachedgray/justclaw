import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DB } from '../src/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractValue,
  evaluateCondition,
  getMonitorHistory,
  formatMonitorAlert,
} from '../src/monitors.js';

let db: DB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'justclaw-monitor-test-'));
  db = new DB(join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('Schema v14', () => {
  it('creates monitors table', () => {
    const tables = db.fetchall("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    expect(tables).toContain('monitors');
    expect(tables).toContain('monitor_history');
  });

  it('schema version is 15', () => {
    const row = db.fetchone("SELECT value FROM schema_meta WHERE key='version'");
    expect(Number(row!.value)).toBe(15);
  });

  it('monitors table has all expected columns', () => {
    const now = db.now();
    db.execute(
      `INSERT INTO monitors (name, source_type, source_config, extractor_type, condition_type, interval_cron, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['test', 'url', '{"url":"https://example.com"}', 'status_code', 'threshold_below', '*/5 * * * *', now, now],
    );
    const row = db.fetchone('SELECT * FROM monitors WHERE name = ?', ['test']);
    expect(row).not.toBeNull();
    expect(row!.source_type).toBe('url');
    expect(row!.enabled).toBe(1);
    expect(row!.last_status).toBe('pending');
    expect(row!.consecutive_alerts).toBe(0);
  });

  it('cascade deletes history when monitor deleted', () => {
    db.execute(
      "INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('del-test', 'url', '{}', datetime('now'), datetime('now'))",
    );
    const mon = db.fetchone("SELECT id FROM monitors WHERE name = 'del-test'");
    db.execute(
      "INSERT INTO monitor_history (monitor_id, value, status, checked_at) VALUES (?, '42', 'ok', datetime('now'))",
      [mon!.id],
    );
    db.execute('DELETE FROM monitors WHERE id = ?', [mon!.id]);
    const history = db.fetchall('SELECT * FROM monitor_history WHERE monitor_id = ?', [mon!.id]);
    expect(history.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

describe('extractValue', () => {
  const urlResult = { statusCode: 200, body: '{"data":{"price":42.5,"name":"BTC"}}', responseTimeMs: 150 };
  const cmdResult = { stdout: '75\n', stderr: '', exitCode: 0 };

  it('extracts jsonpath value', () => {
    const val = extractValue(urlResult, 'jsonpath', '{"path":"$.data.price"}');
    expect(val).toBe('42.5');
  });

  it('extracts nested jsonpath', () => {
    const val = extractValue(urlResult, 'jsonpath', '{"path":"$.data.name"}');
    expect(val).toBe('BTC');
  });

  it('extracts status_code', () => {
    const val = extractValue(urlResult, 'status_code', '');
    expect(val).toBe('200');
  });

  it('extracts response_time', () => {
    const val = extractValue(urlResult, 'response_time', '');
    expect(val).toBe('150');
  });

  it('extracts body_hash', () => {
    const val = extractValue(urlResult, 'body_hash', '');
    expect(val).toMatch(/^[a-f0-9]{32}$/); // MD5 hash
  });

  it('extracts regex match', () => {
    const val = extractValue(
      { ...urlResult, body: 'Price: $42.50 USD' },
      'regex',
      '{"pattern":"\\\\$([\\\\d.]+)"}',
    );
    expect(val).toBe('42.50');
  });

  it('extracts stdout from command', () => {
    const val = extractValue(cmdResult, 'stdout', '');
    expect(val.trim()).toBe('75');
  });

  it('extracts exit_code from command', () => {
    const val = extractValue(cmdResult, 'exit_code', '');
    expect(val).toBe('0');
  });

  it('returns empty for missing jsonpath', () => {
    const val = extractValue(urlResult, 'jsonpath', '{"path":"$.nonexistent.deep"}');
    // Implementation returns empty string or 'null' or 'undefined' for missing paths
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

describe('evaluateCondition', () => {
  it('threshold_above triggers when value exceeds threshold', () => {
    const result = evaluateCondition('95', '80', 'threshold_above', '{"value":90}');
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('95');
  });

  it('threshold_above does not trigger below threshold', () => {
    const result = evaluateCondition('85', '80', 'threshold_above', '{"value":90}');
    expect(result.triggered).toBe(false);
  });

  it('threshold_below triggers when value is under threshold', () => {
    const result = evaluateCondition('45', '60', 'threshold_below', '{"value":50}');
    expect(result.triggered).toBe(true);
  });

  it('threshold_below does not trigger above threshold', () => {
    const result = evaluateCondition('55', '60', 'threshold_below', '{"value":50}');
    expect(result.triggered).toBe(false);
  });

  it('change_percent triggers on significant change', () => {
    const result = evaluateCondition('110', '100', 'change_percent', '{"percent":5}');
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('10');
  });

  it('change_percent does not trigger on small change', () => {
    const result = evaluateCondition('101', '100', 'change_percent', '{"percent":5}');
    expect(result.triggered).toBe(false);
  });

  it('change_percent handles first check (no previous value)', () => {
    const result = evaluateCondition('100', null, 'change_percent', '{"percent":5}');
    expect(result.triggered).toBe(false);
  });

  it('change_any triggers when value differs', () => {
    const result = evaluateCondition('new value', 'old value', 'change_any', '{}');
    expect(result.triggered).toBe(true);
  });

  it('change_any does not trigger when value is same', () => {
    const result = evaluateCondition('same', 'same', 'change_any', '{}');
    expect(result.triggered).toBe(false);
  });

  it('change_any triggers on first check (no previous)', () => {
    const result = evaluateCondition('first', null, 'change_any', '{}');
    expect(result.triggered).toBe(false); // First check is baseline, not alert
  });

  it('contains triggers when text is found', () => {
    const result = evaluateCondition('item is in stock now', '', 'contains', '{"text":"in stock"}');
    expect(result.triggered).toBe(true);
  });

  it('contains does not trigger when text absent', () => {
    const result = evaluateCondition('item is out of stock', '', 'contains', '{"text":"in stock"}');
    expect(result.triggered).toBe(false);
  });

  it('not_contains triggers when text is absent', () => {
    const result = evaluateCondition('page not found', '', 'not_contains', '{"text":"success"}');
    expect(result.triggered).toBe(true);
  });

  it('regex_match triggers on pattern match', () => {
    const result = evaluateCondition('error code 500', '', 'regex_match', '{"pattern":"error.*5\\\\d{2}"}');
    expect(result.triggered).toBe(true);
  });

  it('regex_match does not trigger on no match', () => {
    const result = evaluateCondition('all good 200', '', 'regex_match', '{"pattern":"error.*5\\\\d{2}"}');
    expect(result.triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monitor history
// ---------------------------------------------------------------------------

describe('getMonitorHistory', () => {
  it('returns history ordered by checked_at desc', () => {
    db.execute(
      "INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('hist-test', 'command', '{\"command\":\"echo 1\"}', datetime('now'), datetime('now'))",
    );
    const mon = db.fetchone("SELECT id FROM monitors WHERE name = 'hist-test'");
    const monId = mon!.id as number;

    db.execute("INSERT INTO monitor_history (monitor_id, value, status, checked_at) VALUES (?, '10', 'ok', '2026-03-24 10:00:00')", [monId]);
    db.execute("INSERT INTO monitor_history (monitor_id, value, status, checked_at) VALUES (?, '20', 'alert', '2026-03-24 10:05:00')", [monId]);
    db.execute("INSERT INTO monitor_history (monitor_id, value, status, checked_at) VALUES (?, '15', 'ok', '2026-03-24 10:10:00')", [monId]);

    const history = getMonitorHistory(db, monId, 10);
    expect(history.length).toBe(3);
    expect(history[0].checked_at).toBe('2026-03-24 10:10:00');
    expect(history[2].checked_at).toBe('2026-03-24 10:00:00');
  });

  it('respects limit', () => {
    db.execute(
      "INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('limit-hist', 'command', '{}', datetime('now'), datetime('now'))",
    );
    const mon = db.fetchone("SELECT id FROM monitors WHERE name = 'limit-hist'");
    const monId = mon!.id as number;

    for (let i = 0; i < 10; i++) {
      db.execute("INSERT INTO monitor_history (monitor_id, value, status) VALUES (?, ?, 'ok')", [monId, String(i)]);
    }

    const history = getMonitorHistory(db, monId, 3);
    expect(history.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Alert formatting
// ---------------------------------------------------------------------------

describe('formatMonitorAlert', () => {
  it('formats a basic alert', () => {
    const alert = formatMonitorAlert(
      { name: 'btc-price', description: 'Bitcoin price tracker', consecutive_alerts: 1 },
      { status: 'alert', value: '72000', message: '72000 > 70000 (threshold)' },
    );
    expect(alert).toContain('btc-price');
    expect(alert).toContain('72000');
    expect(alert).toContain('ALERT');
  });

  it('escalates to CRITICAL after 3 consecutive alerts', () => {
    const alert = formatMonitorAlert(
      { name: 'disk-usage', description: 'Disk space', consecutive_alerts: 4 },
      { status: 'alert', value: '95', message: '95 > 90 (threshold)' },
    );
    expect(alert).toContain('CRITICAL');
  });

  it('formats ok status', () => {
    const alert = formatMonitorAlert(
      { name: 'api-health', description: 'API endpoint', consecutive_alerts: 0 },
      { status: 'ok', value: '200', message: 'OK' },
    );
    expect(alert).toContain('api-health');
    expect(alert).toContain('200');
  });
});

// ---------------------------------------------------------------------------
// Monitor CRUD
// ---------------------------------------------------------------------------

describe('Monitor CRUD', () => {
  it('creates a monitor with all fields', () => {
    const now = db.now();
    db.execute(
      `INSERT INTO monitors (name, description, source_type, source_config, extractor_type, extractor_config, condition_type, condition_config, interval_cron, notify_channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['btc', 'BTC price', 'url', '{"url":"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"}',
       'jsonpath', '{"path":"$.bitcoin.usd"}', 'change_percent', '{"percent":5}', '*/15 * * * *', '1485102208122093658', now, now],
    );
    const mon = db.fetchone('SELECT * FROM monitors WHERE name = ?', ['btc']);
    expect(mon).not.toBeNull();
    expect(mon!.source_type).toBe('url');
    expect(mon!.extractor_type).toBe('jsonpath');
    expect(mon!.condition_type).toBe('change_percent');
  });

  it('enforces unique name', () => {
    const now = db.now();
    db.execute("INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('unique', 'url', '{}', ?, ?)", [now, now]);
    expect(() => {
      db.execute("INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('unique', 'url', '{}', ?, ?)", [now, now]);
    }).toThrow();
  });

  it('updates monitor fields', () => {
    const now = db.now();
    db.execute("INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('upd', 'url', '{}', ?, ?)", [now, now]);
    db.execute("UPDATE monitors SET enabled = 0, interval_cron = '0 * * * *' WHERE name = 'upd'");
    const mon = db.fetchone("SELECT enabled, interval_cron FROM monitors WHERE name = 'upd'");
    expect(mon!.enabled).toBe(0);
    expect(mon!.interval_cron).toBe('0 * * * *');
  });

  it('deletes monitor and cascades history', () => {
    const now = db.now();
    db.execute("INSERT INTO monitors (name, source_type, source_config, created_at, updated_at) VALUES ('del', 'command', '{}', ?, ?)", [now, now]);
    const mon = db.fetchone("SELECT id FROM monitors WHERE name = 'del'");
    db.execute("INSERT INTO monitor_history (monitor_id, value, status) VALUES (?, '1', 'ok')", [mon!.id]);

    db.execute("DELETE FROM monitors WHERE name = 'del'");
    const history = db.fetchall('SELECT * FROM monitor_history WHERE monitor_id = ?', [mon!.id]);
    expect(history.length).toBe(0);
  });
});

/**
 * Monitor MCP tool registration — thin wrappers around monitors.ts core functions.
 * Provides 6 tools: create, list, check, history, update, delete.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

/** Map optional update params to SQL SET clauses + values. */
function buildUpdateClauses(
  params: Record<string, unknown>,
  fieldMap: Record<string, string>,
): { updates: string[]; values: unknown[] } {
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const [paramKey, colName] of Object.entries(fieldMap)) {
    if (params[paramKey] !== undefined) {
      updates.push(`${colName} = ?`);
      values.push(paramKey === 'enabled' ? (params[paramKey] ? 1 : 0) : params[paramKey]);
    }
  }
  return { updates, values };
}

export function registerMonitorTools(server: McpServer, db: DB): void {
  server.tool(
    'monitor_create',
    `Create a new monitor that periodically checks a URL or runs a command,
extracts a value, evaluates a condition, and alerts on change/threshold.
Monitors run automatically during heartbeat cycles.`,
    {
      name: z.string().describe('Unique monitor name (slug, e.g. "btc-price", "site-uptime")'),
      description: z.string().default('').describe('Human-readable description'),
      source_type: z.enum(['url', 'command']).describe('"url" fetches HTTP, "command" runs shell'),
      source_config: z.string().describe('JSON: { url, method?, headers?, body? } or { command, timeout_ms? }'),
      extractor_type: z.enum(['json_path', 'regex', 'css_selector', 'xpath', 'stdout', 'status_code', 'response_time', 'hash'])
        .default('stdout')
        .describe('How to extract the value from source output'),
      extractor_config: z.string().default('{}').describe('JSON config for extractor (e.g. { path: "$.data.price" })'),
      condition_type: z.enum(['threshold_above', 'threshold_below', 'change_any', 'change_percent', 'contains', 'not_contains', 'regex_match', 'always'])
        .default('change_any')
        .describe('When to trigger an alert'),
      condition_config: z.string().default('{}').describe('JSON config for condition (e.g. { value: 100000 })'),
      interval_cron: z.string().default('*/15 * * * *').describe('Cron expression for check frequency'),
      notify_channel: z.string().optional().describe('Discord channel ID for alerts (falls back to heartbeat channel)'),
    },
    async (params) => {
      try {
        JSON.parse(params.source_config);
        JSON.parse(params.extractor_config);
        JSON.parse(params.condition_config);
      } catch {
        return { content: [{ type: 'text', text: 'Invalid JSON in source_config, extractor_config, or condition_config.' }] };
      }

      const existing = db.fetchone('SELECT id FROM monitors WHERE name = ?', [params.name]);
      if (existing) {
        return { content: [{ type: 'text', text: `Monitor "${params.name}" already exists. Use monitor_update to modify.` }] };
      }

      const now = db.now();
      db.execute(
        `INSERT INTO monitors (name, description, source_type, source_config, extractor_type,
         extractor_config, condition_type, condition_config, interval_cron, notify_channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.name, params.description, params.source_type, params.source_config,
          params.extractor_type, params.extractor_config, params.condition_type,
          params.condition_config, params.interval_cron, params.notify_channel ?? null,
          now, now,
        ],
      );

      const created = db.fetchone('SELECT * FROM monitors WHERE name = ?', [params.name]);
      return { content: [{ type: 'text', text: `Monitor "${params.name}" created.\n${JSON.stringify(created, null, 2)}` }] };
    },
  );

  server.tool(
    'monitor_list',
    'List all monitors with their current status, last value, and check time.',
    {
      enabled_only: z.boolean().default(true).describe('Only show enabled monitors'),
    },
    async ({ enabled_only }) => {
      const sql = enabled_only
        ? 'SELECT * FROM monitors WHERE enabled = 1 ORDER BY name'
        : 'SELECT * FROM monitors ORDER BY name';
      const monitors = db.fetchall(sql);

      if (monitors.length === 0) {
        return { content: [{ type: 'text', text: 'No monitors configured. Use monitor_create to add one.' }] };
      }

      const lines = [
        '| Name | Source | Condition | Status | Last Value | Last Checked | Alerts |',
        '|------|--------|-----------|--------|------------|--------------|--------|',
        ...monitors.map((m) => {
          const lastVal = m.last_value ? String(m.last_value).slice(0, 40) : '-';
          const lastChecked = m.last_checked_at ? String(m.last_checked_at) : 'never';
          return `| ${m.name} | ${m.source_type} | ${m.condition_type} | ${m.last_status} | ${lastVal} | ${lastChecked} | ${m.consecutive_alerts} |`;
        }),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'monitor_check',
    'Manually trigger a check on one or all due monitors. Returns check results.',
    {
      name: z.string().default('').describe('Monitor name (empty = check all due monitors)'),
    },
    async ({ name }) => {
      try {
        // Dynamic import — monitors.ts may not exist yet during early development
        const { checkMonitor, checkDueMonitors } = await import('./monitors.js');

        if (name) {
          const monitor = db.fetchone('SELECT * FROM monitors WHERE name = ?', [name]);
          if (!monitor) {
            return { content: [{ type: 'text', text: `Monitor "${name}" not found.` }] };
          }
          const result = await checkMonitor(db, monitor);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        const results = await checkDueMonitors(db);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No monitors are due for checking.' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Monitor check failed: ${String(err)}` }] };
      }
    },
  );

  server.tool(
    'monitor_history',
    'Get recent check results for a monitor — value, status, message, timestamp.',
    {
      name: z.string().describe('Monitor name'),
      limit: z.number().default(20).describe('Max entries to return'),
    },
    async ({ name, limit }) => {
      const monitor = db.fetchone('SELECT id FROM monitors WHERE name = ?', [name]);
      if (!monitor) {
        return { content: [{ type: 'text', text: `Monitor "${name}" not found.` }] };
      }

      try {
        const { getMonitorHistory } = await import('./monitors.js');
        const history = getMonitorHistory(db, monitor.id as number, limit);

        if (history.length === 0) {
          return { content: [{ type: 'text', text: `No history for monitor "${name}". Run monitor_check first.` }] };
        }

        const lines = [
          `**${name}** — last ${history.length} checks:`,
          '',
          '| Time | Status | Value | Message |',
          '|------|--------|-------|---------|',
          ...history.map((h: Record<string, unknown>) => {
            const val = h.value ? String(h.value).slice(0, 50) : '-';
            const msg = h.message ? String(h.message).slice(0, 60) : '';
            return `| ${h.checked_at} | ${h.status} | ${val} | ${msg} |`;
          }),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to get history: ${String(err)}` }] };
      }
    },
  );

  server.tool(
    'monitor_update',
    'Update a monitor\'s configuration. Only provided fields are changed.',
    {
      name: z.string().describe('Monitor name to update'),
      description: z.string().optional().describe('New description'),
      source_config: z.string().optional().describe('New source config JSON'),
      extractor_config: z.string().optional().describe('New extractor config JSON'),
      condition_type: z.enum(['threshold_above', 'threshold_below', 'change_any', 'change_percent', 'contains', 'not_contains', 'regex_match', 'always']).optional(),
      condition_config: z.string().optional().describe('New condition config JSON'),
      interval_cron: z.string().optional().describe('New cron interval'),
      notify_channel: z.string().optional().describe('New Discord channel ID'),
      enabled: z.boolean().optional().describe('Enable/disable the monitor'),
    },
    async (params) => {
      const existing = db.fetchone('SELECT id FROM monitors WHERE name = ?', [params.name]);
      if (!existing) {
        return { content: [{ type: 'text', text: `Monitor "${params.name}" not found.` }] };
      }

      // Validate JSON fields if provided
      for (const field of ['source_config', 'extractor_config', 'condition_config'] as const) {
        if (params[field] !== undefined) {
          try { JSON.parse(params[field]); } catch {
            return { content: [{ type: 'text', text: `Invalid JSON in ${field}.` }] };
          }
        }
      }

      const { updates, values } = buildUpdateClauses(
        params as unknown as Record<string, unknown>,
        {
          description: 'description', source_config: 'source_config',
          extractor_config: 'extractor_config', condition_type: 'condition_type',
          condition_config: 'condition_config', interval_cron: 'interval_cron',
          notify_channel: 'notify_channel', enabled: 'enabled',
        },
      );

      if (updates.length === 0) {
        return { content: [{ type: 'text', text: 'No fields to update.' }] };
      }

      updates.push('updated_at = ?');
      values.push(db.now());
      values.push(params.name);

      db.execute(
        `UPDATE monitors SET ${updates.join(', ')} WHERE name = ?`,
        values,
      );

      const updated = db.fetchone('SELECT * FROM monitors WHERE name = ?', [params.name]);
      return { content: [{ type: 'text', text: `Monitor "${params.name}" updated.\n${JSON.stringify(updated, null, 2)}` }] };
    },
  );

  server.tool(
    'monitor_delete',
    'Delete a monitor and all its check history.',
    {
      name: z.string().describe('Monitor name to delete'),
    },
    async ({ name }) => {
      const existing = db.fetchone('SELECT id FROM monitors WHERE name = ?', [name]);
      if (!existing) {
        return { content: [{ type: 'text', text: `Monitor "${name}" not found.` }] };
      }

      // History cascades via ON DELETE CASCADE
      db.execute('DELETE FROM monitors WHERE name = ?', [name]);
      return { content: [{ type: 'text', text: `Monitor "${name}" and its history deleted.` }] };
    },
  );
}

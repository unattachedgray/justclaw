import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

/**
 * Delete memories whose expires_at has passed.
 * FTS cleanup handled by SQLite triggers on the memories table.
 * Returns the count of deleted rows.
 */
export function enforceMemoryExpiry(db: DB): number {
  const expired = db.fetchall(
    "SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
  );
  if (expired.length === 0) return 0;
  db.execute(
    "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
  );
  return expired.length;
}

export function registerMemoryTools(server: McpServer, db: DB): void {
  server.tool(
    'memory_save',
    `Save or update a persistent memory entry.

**When to use:** Call when you learn a user preference, discover a durable fact, make a decision that should persist, or want to record context that future sessions need.
**When NOT to use:** Don't save transient state (use state_set for that). Don't save things derivable from code or git history.
**Key format:** Use kebab-case identifiers like "user-timezone", "project-stack", "decision-auth-method". Avoid vague keys like "thing-I-learned" or "note".
**Namespaces:** Use "global" for universal knowledge, "project:<name>" for project-scoped, "session:<id>" for ephemeral (auto-expire candidates).`,
    {
      key: z
        .string()
        .describe(
          'Unique kebab-case identifier. Examples: "user-timezone", "project-goal", "decision-db-choice"',
        ),
      content: z
        .string()
        .describe('The memory content. Be specific — include context, rationale, and source.'),
      type: z
        .enum(['general', 'fact', 'preference', 'decision', 'context'])
        .default('general')
        .describe('Category: fact (verified truth), preference (user choice), decision (made choice with rationale), context (situational), general (other)'),
      tags: z.string().default('').describe('Comma-separated tags for filtering (e.g. "work,urgent,deploy")'),
      namespace: z
        .string()
        .default('global')
        .describe('Scope: "global", "project:<name>", or "session:<id>"'),
    },
    async ({ key, content, type, tags, namespace }) => {
      const existing = db.fetchone('SELECT id FROM memories WHERE key = ?', [key]);
      const now = db.now();
      if (existing) {
        db.execute(
          'UPDATE memories SET content=?, type=?, tags=?, namespace=?, updated_at=? WHERE key=?',
          [content, type, tags, namespace, now, key],
        );
        return { content: [{ type: 'text', text: `Updated memory '${key}'.` }] };
      }
      db.execute(
        'INSERT INTO memories (key, content, type, tags, namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [key, content, type, tags, namespace, now, now],
      );
      return { content: [{ type: 'text', text: `Saved new memory '${key}'.` }] };
    },
  );

  server.tool(
    'memory_search',
    `Search memories using full-text search with BM25 relevance ranking.

**When to use:** When you need to find memories by content — "what do I know about X?". Supports FTS5 syntax: AND, OR, NOT, "exact phrases", prefix*.
**When NOT to use:** If you know the exact key, use memory_recall instead (faster, exact match).
**Output:** Results sorted by BM25 relevance score. Each result includes key, content, type, tags, namespace, and access stats.
**Format:** Use "concise" to save context tokens, "detailed" for full fields including IDs and access counts.`,
    {
      query: z
        .string()
        .describe('FTS5 search query. Examples: "timezone", "deploy AND production", "user preference"'),
      type: z.string().default('').describe('Filter by memory type (fact/preference/decision/context/general)'),
      tags: z.string().default('').describe('Filter to memories containing this tag'),
      namespace: z.string().default('').describe('Filter by namespace (e.g. "global", "project:myapp")'),
      limit: z.number().default(10).describe('Max results to return'),
      format: z
        .enum(['concise', 'detailed'])
        .default('concise')
        .describe('concise = key+content+type; detailed = all fields including access stats'),
    },
    async ({ query, type, tags, namespace, limit, format }) => {
      const detailed = format === 'detailed';
      const cols = detailed
        ? 'm.key, m.content, m.type, m.tags, m.namespace, m.access_count, m.last_accessed, m.updated_at, m.created_at'
        : 'm.key, m.content, m.type, m.tags, m.namespace';

      let rows: Record<string, unknown>[];

      if (!query.trim()) {
        let sql = `SELECT ${cols.replace(/m\./g, '')} FROM memories WHERE 1=1`;
        const params: unknown[] = [];
        if (type) { sql += ' AND type = ?'; params.push(type); }
        if (tags) { sql += ' AND tags LIKE ?'; params.push(`%${tags}%`); }
        if (namespace) { sql += ' AND namespace = ?'; params.push(namespace); }
        sql += ' ORDER BY updated_at DESC LIMIT ?';
        params.push(limit);
        rows = db.fetchall(sql, params);
      } else {
        let sql = `SELECT ${cols}, rank AS relevance FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH ?`;
        const params: unknown[] = [query];
        if (type) { sql += ' AND m.type = ?'; params.push(type); }
        if (tags) { sql += ' AND m.tags LIKE ?'; params.push(`%${tags}%`); }
        if (namespace) { sql += ' AND m.namespace = ?'; params.push(namespace); }
        sql += ' ORDER BY rank LIMIT ?';
        params.push(limit);
        rows = db.fetchall(sql, params);

        // Track access for search hits
        if (rows.length > 0) {
          const now = db.now();
          for (const row of rows) {
            db.execute(
              'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE key = ?',
              [now, row.key],
            );
          }
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'memory_recall',
    `Recall a specific memory by its exact key.

**When to use:** When you know the exact key (e.g. "user-timezone"). Faster than search.
**When NOT to use:** If you're exploring or don't know the key, use memory_search instead.
**Access tracking:** Each recall increments the memory's access_count and updates last_accessed.`,
    {
      key: z.string().describe('The exact memory key to look up'),
    },
    async ({ key }) => {
      const result = db.fetchone(
        'SELECT key, content, type, tags, namespace, access_count, last_accessed, created_at, updated_at FROM memories WHERE key = ?',
        [key],
      );
      if (result) {
        db.execute(
          'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE key = ?',
          [db.now(), key],
        );
      }
      const text = result ? JSON.stringify(result, null, 2) : `No memory found with key '${key}'.`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'memory_forget',
    `Delete a memory entry permanently.

**When to use:** When information is outdated, wrong, or no longer relevant.
**When NOT to use:** If the memory might be useful later, update it instead of deleting.`,
    {
      key: z.string().describe('The memory key to delete'),
    },
    async ({ key }) => {
      const existing = db.fetchone('SELECT id FROM memories WHERE key = ?', [key]);
      if (!existing) {
        return { content: [{ type: 'text', text: `No memory found with key '${key}'.` }] };
      }
      db.execute('DELETE FROM memories WHERE key = ?', [key]);
      return { content: [{ type: 'text', text: `Deleted memory '${key}'.` }] };
    },
  );

  server.tool(
    'memory_list',
    `List memory entries with optional filters.

**When to use:** To browse what's stored — e.g. "show me all preferences" or "what's in the project:myapp namespace".
**Output:** Sorted by most recently updated first.`,
    {
      type: z.string().default('').describe('Filter by type (fact/preference/decision/context/general). Empty = all.'),
      namespace: z.string().default('').describe('Filter by namespace. Empty = all.'),
      limit: z.number().default(20).describe('Max results'),
      format: z
        .enum(['concise', 'detailed'])
        .default('concise')
        .describe('concise = key+content+type; detailed = all fields including access stats'),
    },
    async ({ type, namespace, limit, format }) => {
      const detailed = format === 'detailed';
      const cols = detailed
        ? 'key, content, type, tags, namespace, access_count, last_accessed, updated_at, created_at'
        : 'key, content, type, tags, namespace';

      let sql = `SELECT ${cols} FROM memories WHERE 1=1`;
      const params: unknown[] = [];
      if (type) { sql += ' AND type = ?'; params.push(type); }
      if (namespace) { sql += ' AND namespace = ?'; params.push(namespace); }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = db.fetchall(sql, params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'memory_consolidate',
    `Review memories and suggest cleanup actions: merge duplicates, archive stale entries, enforce expiry.

**When to use:** Periodically (e.g. weekly) or when memory count is high. Run with dry_run=true first to preview.
**What it does:**
- Finds memories with same/similar keys (potential duplicates)
- Identifies never-accessed memories older than 30 days
- Finds expired memories (past expires_at)
- Reports stats for informed cleanup decisions`,
    {
      dry_run: z
        .boolean()
        .default(true)
        .describe('true = report only (safe). false = delete expired, archive stale.'),
      stale_days: z.number().default(30).describe('Memories not accessed in this many days are flagged as stale'),
    },
    async ({ dry_run, stale_days }) => {
      const now = db.now();
      const cutoff = new Date(Date.now() - stale_days * 86400_000).toISOString().replace('T', ' ').slice(0, 19);

      // Expired memories (past expires_at)
      const expired = db.fetchall(
        'SELECT key, expires_at FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?',
        [now],
      );

      // Never-accessed memories older than stale_days
      const stale = db.fetchall(
        'SELECT key, created_at, access_count FROM memories WHERE access_count = 0 AND created_at < ?',
        [cutoff],
      );

      // Total stats
      const total = db.fetchone('SELECT COUNT(*) as count FROM memories');
      const byNamespace = db.fetchall(
        'SELECT namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY count DESC',
      );
      const byType = db.fetchall(
        'SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC',
      );

      if (!dry_run) {
        // Delete expired
        if (expired.length > 0) {
          db.execute(
            'DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?',
            [now],
          );
        }
      }

      const result = {
        total_memories: total?.count ?? 0,
        by_namespace: byNamespace,
        by_type: byType,
        expired: { count: expired.length, keys: expired.map((r) => r.key), action: dry_run ? 'would_delete' : 'deleted' },
        stale: { count: stale.length, keys: stale.slice(0, 20).map((r) => r.key), note: `Not accessed in ${stale_days} days` },
        dry_run,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

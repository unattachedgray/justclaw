import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';

export function registerConversationTools(server: McpServer, db: DB): void {
  server.tool(
    'conversation_log',
    `Log a conversation message to maintain history across sessions.

**When to use:** For every inbound message you receive and every response you send on any channel.
**When NOT to use:** Don't log system messages or internal tool calls.
**Hooks:** A PostToolUse hook should auto-call this after Discord replies — but call manually if the hook doesn't fire.`,
    {
      sender: z.string().describe("Who sent the message — username for inbound, 'charlie' for outbound"),
      message: z.string().describe('The full message content'),
      channel: z.string().default('discord').describe('Channel source: discord, telegram, dashboard, etc.'),
      is_from_charlie: z.boolean().default(false).describe("True if this is Charlie's own response"),
    },
    async ({ sender, message, channel, is_from_charlie }) => {
      db.execute(
        'INSERT INTO conversations (channel, sender, message, is_from_charlie, created_at) VALUES (?, ?, ?, ?, ?)',
        [channel, sender, message, is_from_charlie ? 1 : 0, db.now()],
      );
      return { content: [{ type: 'text', text: 'Logged.' }] };
    },
  );

  server.tool(
    'conversation_history',
    `Get recent conversation history in chronological order.

**When to use:** At session start to catch up on what was discussed while you were away. Also useful before responding to ensure continuity.
**Output:** Messages returned in chronological order (oldest first). Includes channel, sender, message, and timestamp.
**Format:** "concise" omits channel field; "detailed" includes all fields.`,
    {
      channel: z.string().default('').describe('Filter by channel. Empty = all channels.'),
      limit: z.number().default(20).describe('Max messages to return'),
      since: z.string().default('').describe('Only messages after this ISO datetime (e.g. "2026-03-20 10:00:00")'),
      format: z
        .enum(['concise', 'detailed'])
        .default('concise')
        .describe('concise = sender+message+time; detailed = all fields'),
    },
    async ({ channel, limit, since, format }) => {
      const cols = format === 'detailed'
        ? 'id, channel, sender, message, is_from_charlie, created_at'
        : 'sender, message, created_at';

      let sql = `SELECT ${cols} FROM conversations WHERE 1=1`;
      const params: unknown[] = [];
      if (channel) { sql += ' AND channel = ?'; params.push(channel); }
      if (since) { sql += ' AND created_at > ?'; params.push(since); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.fetchall(sql, params);
      rows.reverse();
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'conversation_search',
    `Search conversation history using full-text search.

**When to use:** When you need to find past conversations by content — "what did we discuss about X?", "when did we talk about the deploy?".
**Supports:** FTS5 syntax: AND, OR, NOT, "exact phrases".
**Output:** Results sorted by relevance (BM25). Returns matching messages with context.`,
    {
      query: z.string().describe('FTS5 search query (e.g. "deploy production", "auth AND security")'),
      channel: z.string().default('').describe('Filter by channel'),
      limit: z.number().default(20).describe('Max results'),
    },
    async ({ query, channel, limit }) => {
      let sql = `SELECT c.channel, c.sender, c.message, c.is_from_charlie, c.created_at, rank AS relevance
        FROM conversations_fts fts
        JOIN conversations c ON c.id = fts.rowid
        WHERE conversations_fts MATCH ?`;
      const params: unknown[] = [query];
      if (channel) { sql += ' AND c.channel = ?'; params.push(channel); }
      sql += ' ORDER BY rank LIMIT ?';
      params.push(limit);
      const rows = db.fetchall(sql, params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'conversation_summary',
    `Get a formatted plain-text summary of recent conversation for quick context loading.

**When to use:** When you want a human-readable transcript rather than JSON — good for including in context_flush summaries.
**Output:** One line per message: "[timestamp] sender: message".`,
    {
      channel: z.string().default('discord').describe('Channel to summarize'),
      last_n: z.number().default(50).describe('Number of recent messages to include'),
    },
    async ({ channel, last_n }) => {
      const rows = db.fetchall(
        'SELECT sender, message, created_at FROM conversations WHERE channel = ? ORDER BY created_at DESC LIMIT ?',
        [channel, last_n],
      );
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: 'No conversation history.' }] };
      }
      rows.reverse();
      const lines = rows.map((msg) => `[${msg.created_at}] ${msg.sender}: ${msg.message}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

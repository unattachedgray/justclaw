/**
 * Notebook MCP tool registration — thin wrappers around notebooks.ts core functions.
 * Split from notebooks.ts to stay under 500 lines per file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.js';
import {
  ingestNotebook,
  searchNotebook,
  loadAllChunks,
  formatChunksAsContext,
  listSources,
} from './notebooks.js';

const DIRECT_MODE_TOKEN_LIMIT = 100_000;

export function registerNotebookTools(server: McpServer, db: DB): void {
  server.tool(
    'notebook_create',
    'Ingest a directory into a named notebook. Chunks files, indexes with FTS5. Direct mode (<100K tokens) loads all; chunked mode uses BM25 retrieval.',
    {
      name: z.string().describe('Notebook name (slug, e.g. "research", "project-docs")'),
      path: z.string().describe('Absolute path to directory containing source documents'),
    },
    async ({ name, path: dirPath }) => {
      try {
        const info = ingestNotebook(db, name, dirPath);
        const modeDesc = info.mode === 'direct'
          ? `Direct mode — all ${info.total_tokens.toLocaleString()} tokens fit in context`
          : `Chunked mode — ${info.total_tokens.toLocaleString()} tokens across ${info.total_chunks} chunks (FTS5 retrieval)`;
        const lines = [
          `Notebook "${info.name}" created.`,
          `Source: ${info.source_path}`,
          `Files: ${info.total_files} | Chunks: ${info.total_chunks} | Est. tokens: ${info.total_tokens.toLocaleString()}`,
          `Mode: ${modeDesc}`,
        ];
        if (info.skipped.length > 0) {
          lines.push(`Skipped: ${info.skipped.length} files`);
          if (info.unsupportedFormats.length > 0) {
            lines.push(`Unsupported formats: ${info.unsupportedFormats.join(', ')} — consider researching support`);
          }
          const tooLarge = info.skipped.filter((s) => s.reason === 'too_large');
          if (tooLarge.length > 0) {
            lines.push(`Too large (>1MB): ${tooLarge.map((s) => s.name).join(', ')}`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to create notebook: ${String(err)}` }] };
      }
    },
  );

  server.tool(
    'notebook_query',
    'Search a notebook for relevant content. Direct mode returns all sources; chunked mode uses FTS5 BM25. Cite results as [source:filename:lines].',
    {
      notebook: z.string().describe('Notebook name'),
      query: z.string().describe('Search query or question'),
      limit: z.number().default(15).describe('Max chunks to return (chunked mode only)'),
    },
    async ({ notebook: name, query, limit }) => {
      const nb = db.fetchone('SELECT id, mode, total_tokens, total_files FROM notebooks WHERE name = ?', [name]);
      if (!nb) return { content: [{ type: 'text', text: `Notebook "${name}" not found. Use notebook_create first.` }] };

      const notebookId = nb.id as number;
      const mode = nb.mode as string;

      const chunks = mode === 'direct'
        ? loadAllChunks(db, notebookId)
        : searchNotebook(db, notebookId, query, limit);

      if (chunks.length === 0) {
        return { content: [{ type: 'text', text: `No relevant content found for "${query}" in notebook "${name}".` }] };
      }

      const context = formatChunksAsContext(chunks);
      const header = mode === 'direct'
        ? `[All ${nb.total_files} sources loaded — ${nb.total_tokens} tokens]`
        : `[${chunks.length} relevant chunks retrieved via FTS5]`;

      return {
        content: [{
          type: 'text',
          text: `${header}\n\n${context}\n\n---\nCite sources as [source:filename:line_start-line_end] in your response.`,
        }],
      };
    },
  );

  server.tool(
    'notebook_sources',
    'List all source files in a notebook with chunk counts and token estimates.',
    { notebook: z.string().describe('Notebook name') },
    async ({ notebook: name }) => {
      const nb = db.fetchone('SELECT id, name, source_path, mode, total_files, total_chunks, total_tokens FROM notebooks WHERE name = ?', [name]);
      if (!nb) return { content: [{ type: 'text', text: `Notebook "${name}" not found.` }] };

      const sources = listSources(db, nb.id as number);
      const lines = [
        `**Notebook: ${nb.name}** (${nb.mode} mode)`,
        `Source: ${nb.source_path}`,
        `Files: ${nb.total_files} | Chunks: ${nb.total_chunks} | Tokens: ${(nb.total_tokens as number).toLocaleString()}`,
        '', '| File | Chunks | Tokens |', '|------|--------|--------|',
        ...sources.map((s) => `| ${s.file_name} | ${s.chunks} | ${s.tokens.toLocaleString()} |`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'notebook_list',
    'List all notebooks with their stats.',
    {},
    async () => {
      const notebooks = db.fetchall(
        'SELECT name, source_path, mode, total_files, total_chunks, total_tokens FROM notebooks ORDER BY created_at DESC',
      );
      if (notebooks.length === 0) {
        return { content: [{ type: 'text', text: 'No notebooks. Use notebook_create to ingest a document directory.' }] };
      }
      const lines = [
        '| Notebook | Mode | Files | Chunks | Tokens | Path |',
        '|----------|------|-------|--------|--------|------|',
        ...notebooks.map((n) =>
          `| ${n.name} | ${n.mode} | ${n.total_files} | ${n.total_chunks} | ${(n.total_tokens as number).toLocaleString()} | ${n.source_path} |`
        ),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'notebook_overview',
    'Returns source data for notebook guide synthesis. Produce: overview, key topics, suggested questions, per-source summaries.',
    { notebook: z.string().describe('Notebook name') },
    async ({ notebook: name }) => {
      const nb = db.fetchone('SELECT id, mode, total_files, total_tokens FROM notebooks WHERE name = ?', [name]);
      if (!nb) return { content: [{ type: 'text', text: `Notebook "${name}" not found.` }] };

      const notebookId = nb.id as number;
      let context: string;
      if (nb.mode === 'direct' || (nb.total_tokens as number) <= DIRECT_MODE_TOKEN_LIMIT * 1.5) {
        context = formatChunksAsContext(loadAllChunks(db, notebookId));
      } else {
        const introChunks = db.fetchall(
          `SELECT file_path, file_name, content, line_start, line_end
           FROM document_chunks WHERE notebook_id = ? AND chunk_index < 2
           ORDER BY file_path, chunk_index`,
          [notebookId],
        ) as Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number }>;
        context = formatChunksAsContext(introChunks);
      }

      return {
        content: [{
          type: 'text',
          text: [
            `[Notebook: ${nb.total_files} files, ${(nb.total_tokens as number).toLocaleString()} tokens]`,
            '', context, '',
            '---',
            'Synthesize: (1) overview paragraph, (2) key topics, (3) suggested questions, (4) per-source summaries.',
            'Cite as [source:filename:line_start-line_end].',
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'notebook_delete',
    'Delete a notebook and all its indexed chunks.',
    { notebook: z.string().describe('Notebook name to delete') },
    async ({ notebook: name }) => {
      const nb = db.fetchone('SELECT id FROM notebooks WHERE name = ?', [name]);
      if (!nb) return { content: [{ type: 'text', text: `Notebook "${name}" not found.` }] };
      db.execute('DELETE FROM notebooks WHERE id = ?', [nb.id]);
      return { content: [{ type: 'text', text: `Notebook "${name}" deleted.` }] };
    },
  );
}

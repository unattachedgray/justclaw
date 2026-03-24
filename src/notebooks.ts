/**
 * Notebooks — NotebookLM-style document analysis for justclaw.
 *
 * Architecture: "context-window-first" like NotebookLM.
 *   - Small doc sets (< DIRECT_MODE_TOKEN_LIMIT): load all files directly into prompt
 *   - Large doc sets: chunk into ~CHUNK_TARGET_TOKENS segments, store in SQLite,
 *     retrieve via FTS5 BM25 search at query time
 *
 * All ingestion and chunking is deterministic — no LLM calls.
 * The LLM is only used for the actual analysis/Q&A (via claude -p or MCP tool).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, extname, resolve } from 'path';
import type { DB } from './db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Token limit for "direct mode" — load all sources into one prompt. */
const DIRECT_MODE_TOKEN_LIMIT = 100_000;

/** Target chunk size in estimated tokens. */
const CHUNK_TARGET_TOKENS = 1500;

/** Max chunk size — hard cap. */
const CHUNK_MAX_TOKENS = 2500;

/** Supported file extensions for ingestion. */
const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go',
  '.java', '.rb', '.sh', '.bash', '.zsh', '.css', '.html', '.xml',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.sql', '.r', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.swift', '.kt', '.lua', '.pl', '.ex', '.exs', '.erl',
  '.env.example', '.gitignore', '.dockerignore', 'Dockerfile',
  'Makefile', 'Rakefile', 'Gemfile', '.editorconfig',
]);

// ---------------------------------------------------------------------------
// Chunking (deterministic, paragraph-aware)
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  content: string;
  lineStart: number;
  lineEnd: number;
  tokenEstimate: number;
}

/**
 * Split text into chunks that respect paragraph and code block boundaries.
 * Each chunk targets CHUNK_TARGET_TOKENS but won't exceed CHUNK_MAX_TOKENS.
 */
export function chunkText(text: string): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track code fences to avoid splitting inside code blocks.
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    currentLines.push(line);
    const currentText = currentLines.join('\n');
    const tokens = estimateTokens(currentText);

    // Flush chunk when we hit the target and we're at a natural boundary.
    const atBoundary = !inCodeBlock && (
      line.trim() === '' ||                    // Empty line (paragraph break)
      line.startsWith('#') ||                  // Heading
      line.startsWith('---') ||                // Horizontal rule
      tokens >= CHUNK_MAX_TOKENS               // Hard cap
    );

    if (tokens >= CHUNK_TARGET_TOKENS && atBoundary) {
      const content = currentText.trimEnd();
      if (content) {
        chunks.push({
          content,
          lineStart: currentStart,
          lineEnd: lineNum,
          tokenEstimate: estimateTokens(content),
        });
      }
      currentLines = [];
      currentStart = lineNum + 1;
    }
  }

  // Flush remaining.
  const remaining = currentLines.join('\n').trimEnd();
  if (remaining) {
    chunks.push({
      content: remaining,
      lineStart: currentStart,
      lineEnd: lines.length,
      tokenEstimate: estimateTokens(remaining),
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// File scanning (deterministic)
// ---------------------------------------------------------------------------

interface ScannedFile {
  path: string;
  name: string;
  content: string;
  tokenEstimate: number;
}

export interface SkippedFile {
  path: string;
  name: string;
  reason: string;
  extension: string;
}

interface ScanResult {
  files: ScannedFile[];
  skipped: SkippedFile[];
}

/** Check if a file extension is supported. */
function isSupported(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath);
  return SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_EXTENSIONS.has(name);
}

/** Recursively scan a directory for supported text files. Tracks skipped files for format gap detection. */
export function scanDirectory(dirPath: string, maxDepth: number = 5): ScanResult {
  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];
  const absDir = resolve(dirPath);

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // Permission denied or not a directory
    }

    for (const entry of entries) {
      // Skip hidden dirs and common noise.
      if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__'
          || entry === 'dist' || entry === 'build' || entry === '.git') continue;

      const fullPath = join(dir, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const ext = extname(fullPath).toLowerCase();
        if (!isSupported(fullPath)) {
          skipped.push({ path: fullPath, name: basename(fullPath), reason: 'unsupported_format', extension: ext || basename(fullPath) });
          continue;
        }
        if (stat.size >= 1_000_000) {
          skipped.push({ path: fullPath, name: basename(fullPath), reason: 'too_large', extension: ext });
          continue;
        }
        try {
          const content = readFileSync(fullPath, 'utf-8');
          files.push({
            path: fullPath,
            name: basename(fullPath),
            content,
            tokenEstimate: estimateTokens(content),
          });
        } catch {
          skipped.push({ path: fullPath, name: basename(fullPath), reason: 'read_error', extension: ext });
        }
      }
    }
  }

  walk(absDir, 0);
  return { files, skipped };
}

// ---------------------------------------------------------------------------
// Notebook operations
// ---------------------------------------------------------------------------

interface NotebookInfo {
  id: number;
  name: string;
  source_path: string;
  mode: string;
  total_files: number;
  total_chunks: number;
  total_tokens: number;
  created_at: string;
}

export interface IngestResult extends NotebookInfo {
  skipped: SkippedFile[];
  unsupportedFormats: string[];
}

/** Create or re-ingest a notebook from a directory. */
export function ingestNotebook(db: DB, name: string, dirPath: string): IngestResult {
  const absPath = resolve(dirPath);
  const { files, skipped } = scanDirectory(absPath);
  const totalTokens = files.reduce((sum, f) => sum + f.tokenEstimate, 0);

  // Track unsupported formats for auto-research triggering.
  const unsupportedFormats = [...new Set(
    skipped.filter((s) => s.reason === 'unsupported_format').map((s) => s.extension),
  )];
  const mode = totalTokens <= DIRECT_MODE_TOKEN_LIMIT ? 'direct' : 'chunked';

  // Upsert notebook.
  db.execute(
    `INSERT INTO notebooks (name, source_path, mode, total_files, total_tokens, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       source_path = excluded.source_path, mode = excluded.mode,
       total_files = excluded.total_files, total_tokens = excluded.total_tokens,
       updated_at = datetime('now')`,
    [name, absPath, mode, files.length, totalTokens],
  );

  const notebook = db.fetchone('SELECT id FROM notebooks WHERE name = ?', [name]);
  const notebookId = notebook!.id as number;

  // Clear old chunks and re-ingest.
  db.execute('DELETE FROM document_chunks WHERE notebook_id = ?', [notebookId]);

  let totalChunks = 0;
  db.transaction(() => {
    for (const file of files) {
      const chunks = chunkText(file.content);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        db.execute(
          `INSERT INTO document_chunks (notebook_id, file_path, file_name, chunk_index, content, line_start, line_end, token_estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [notebookId, file.path, file.name, i, chunk.content, chunk.lineStart, chunk.lineEnd, chunk.tokenEstimate],
        );
        totalChunks++;
      }
    }
  });

  db.execute('UPDATE notebooks SET total_chunks = ? WHERE id = ?', [totalChunks, notebookId]);

  // Log unsupported formats as learnings for future format support.
  if (unsupportedFormats.length > 0) {
    try {
      db.execute(
        "INSERT INTO learnings (category, trigger, lesson, area, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        [
          'discovery',
          `notebook_ingest:${name}`,
          `Skipped ${skipped.length} files with unsupported formats: ${unsupportedFormats.join(', ')}. Consider adding support for these formats.`,
          'notebooks',
        ],
      );
    } catch { /* best-effort */ }
  }

  return {
    id: notebookId,
    name,
    source_path: absPath,
    mode,
    total_files: files.length,
    total_chunks: totalChunks,
    total_tokens: totalTokens,
    created_at: db.now(),
    skipped,
    unsupportedFormats,
  };
}

/** Search notebook chunks using FTS5 BM25. */
export function searchNotebook(
  db: DB, notebookId: number, query: string, limit: number = 20,
): Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number; rank: number }> {
  // Sanitize query for FTS5 — escape special chars, wrap terms in quotes if needed.
  const safeQuery = query.replace(/['"]/g, '').split(/\s+/).filter(Boolean).join(' OR ');
  if (!safeQuery) return [];

  return db.fetchall(
    `SELECT dc.file_path, dc.file_name, dc.content, dc.line_start, dc.line_end,
            rank AS rank
     FROM chunks_fts fts
     JOIN document_chunks dc ON dc.id = fts.rowid
     WHERE chunks_fts MATCH ? AND dc.notebook_id = ?
     ORDER BY rank
     LIMIT ?`,
    [safeQuery, notebookId, limit],
  ) as Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number; rank: number }>;
}

/** Load all chunks for a notebook (for direct mode). */
export function loadAllChunks(
  db: DB, notebookId: number,
): Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number }> {
  return db.fetchall(
    `SELECT file_path, file_name, content, line_start, line_end
     FROM document_chunks WHERE notebook_id = ?
     ORDER BY file_path, chunk_index`,
    [notebookId],
  ) as Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number }>;
}

/** Format chunks as source-grounded context for Claude. */
export function formatChunksAsContext(
  chunks: Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number }>,
): string {
  const byFile = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const existing = byFile.get(chunk.file_path) || [];
    existing.push(chunk);
    byFile.set(chunk.file_path, existing);
  }

  const sections: string[] = [];
  for (const [filePath, fileChunks] of byFile) {
    const fileName = fileChunks[0].file_name;
    sections.push(`### Source: ${fileName} (${filePath})`);
    for (const chunk of fileChunks) {
      sections.push(`[lines ${chunk.line_start}-${chunk.line_end}]`);
      sections.push(chunk.content);
      sections.push('');
    }
  }
  return sections.join('\n');
}

/** List all sources in a notebook. */
export function listSources(
  db: DB, notebookId: number,
): Array<{ file_path: string; file_name: string; chunks: number; tokens: number }> {
  return db.fetchall(
    `SELECT file_path, file_name, COUNT(*) as chunks, SUM(token_estimate) as tokens
     FROM document_chunks WHERE notebook_id = ?
     GROUP BY file_path ORDER BY file_path`,
    [notebookId],
  ) as Array<{ file_path: string; file_name: string; chunks: number; tokens: number }>;
}

// MCP tool registration is in notebook-tools.ts (split to stay under 500 lines).
export { registerNotebookTools } from './notebook-tools.js';

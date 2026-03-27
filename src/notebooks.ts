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
import { extractText, EXTRACTABLE_EXTENSIONS } from './extractors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Token limit for "direct mode" — load all sources into one prompt. */
const DIRECT_MODE_TOKEN_LIMIT = 100_000;

/** Target chunk size in estimated tokens. */
const CHUNK_TARGET_TOKENS = 1500;

/** Max chunk size — hard cap. */
const CHUNK_MAX_TOKENS = 2500;

/** Overlap tokens carried from end of one chunk to start of next. */
const CHUNK_OVERLAP_TOKENS = 150;

/** Text-based extensions that can be read directly with readFileSync. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go',
  '.java', '.rb', '.sh', '.bash', '.zsh', '.css', '.html', '.xml',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.sql', '.r', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.swift', '.kt', '.lua', '.pl', '.ex', '.exs', '.erl',
  '.env.example', '.gitignore', '.dockerignore', 'Dockerfile',
  'Makefile', 'Rakefile', 'Gemfile', '.editorconfig',
]);

/** All extensions we support — text + extractable binary formats. */
const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...EXTRACTABLE_EXTENSIONS,
]);

// ---------------------------------------------------------------------------
// Chunking (deterministic, paragraph-aware, with overlap)
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
 * Compute overlap text from end of a flushed chunk.
 * Takes approximately CHUNK_OVERLAP_TOKENS worth of text from the tail.
 */
function computeOverlapLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const result: string[] = [];
  let tokens = 0;
  // Walk backwards collecting lines until we hit the overlap budget.
  for (let i = lines.length - 1; i >= 0 && tokens < CHUNK_OVERLAP_TOKENS; i--) {
    result.unshift(lines[i]);
    tokens += estimateTokens(lines[i]);
  }
  return result;
}

/**
 * Split text into chunks that respect paragraph and code block boundaries.
 * Each chunk targets CHUNK_TARGET_TOKENS but won't exceed CHUNK_MAX_TOKENS.
 * Adjacent chunks overlap by ~CHUNK_OVERLAP_TOKENS for continuity.
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
      // Carry overlap into next chunk.
      const overlap = computeOverlapLines(currentLines);
      currentLines = overlap;
      currentStart = lineNum - overlap.length + 1;
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
// File scanning (async — supports text files and binary extraction)
// ---------------------------------------------------------------------------

interface ScannedFile {
  path: string;
  name: string;
  content: string;
  tokenEstimate: number;
  mtime: string;
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

/** Check if a file is a plain text format (readable with readFileSync). */
function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath);
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(name);
}

/** Collect file paths from a directory tree (sync). Returns paths + skipped. */
function collectFiles(
  absDir: string,
  maxDepth: number,
): { paths: Array<{ fullPath: string; ext: string; size: number; mtime: string }>; skipped: SkippedFile[] } {
  const paths: Array<{ fullPath: string; ext: string; size: number; mtime: string }> = [];
  const skipped: SkippedFile[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { /* directory unreadable or deleted, skip subtree */ return; }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__'
          || entry === 'dist' || entry === 'build' || entry === '.git') continue;

      const fullPath = join(dir, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { /* file deleted between readdir and stat, skip */ continue; }

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
        paths.push({ fullPath, ext, size: stat.size, mtime: stat.mtime.toISOString() });
      }
    }
  }

  walk(absDir, 0);
  return { paths, skipped };
}

/** Recursively scan a directory for supported files. Extracts text from binary formats. */
export async function scanDirectory(dirPath: string, maxDepth: number = 5): Promise<ScanResult> {
  const absDir = resolve(dirPath);
  const { paths, skipped } = collectFiles(absDir, maxDepth);
  const files: ScannedFile[] = [];

  for (const { fullPath, ext, mtime } of paths) {
    if (isTextFile(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        files.push({ path: fullPath, name: basename(fullPath), content, tokenEstimate: estimateTokens(content), mtime });
      } catch { /* file unreadable (permissions, encoding, or deleted), track as skipped */
        skipped.push({ path: fullPath, name: basename(fullPath), reason: 'read_error', extension: ext });
      }
    } else {
      // Binary format — use extractor.
      const result = await extractText(fullPath);
      files.push({
        path: fullPath,
        name: basename(fullPath),
        content: result.text,
        tokenEstimate: estimateTokens(result.text),
        mtime,
      });
    }
  }

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

/** Check if a file needs re-indexing by comparing mtime. */
function fileNeedsReindex(
  db: DB,
  notebookId: number,
  filePath: string,
  currentMtime: string,
): boolean {
  const row = db.fetchone(
    'SELECT file_mtime FROM document_chunks WHERE notebook_id = ? AND file_path = ? LIMIT 1',
    [notebookId, filePath],
  );
  if (!row || !row.file_mtime) return true;
  return String(row.file_mtime) !== currentMtime;
}

/** Remove stale file chunks and re-index changed files. Returns total chunk count. */
function syncChunks(
  db: DB,
  notebookId: number,
  files: ScannedFile[],
): number {
  let totalChunks = 0;
  const currentFilePaths = new Set(files.map((f) => f.path));

  // Remove chunks for files that no longer exist.
  const existingPaths = db.fetchall(
    'SELECT DISTINCT file_path FROM document_chunks WHERE notebook_id = ?',
    [notebookId],
  );
  for (const row of existingPaths) {
    if (!currentFilePaths.has(String(row.file_path))) {
      db.execute(
        'DELETE FROM document_chunks WHERE notebook_id = ? AND file_path = ?',
        [notebookId, row.file_path],
      );
    }
  }

  // Insert/update chunks for each file.
  for (const file of files) {
    totalChunks += indexFileChunks(db, notebookId, file);
  }
  return totalChunks;
}

/** Index a single file's chunks, skipping if mtime unchanged. Returns chunk count. */
function indexFileChunks(db: DB, notebookId: number, file: ScannedFile): number {
  if (!fileNeedsReindex(db, notebookId, file.path, file.mtime)) {
    const countRow = db.fetchone(
      'SELECT COUNT(*) as c FROM document_chunks WHERE notebook_id = ? AND file_path = ?',
      [notebookId, file.path],
    );
    return (countRow?.c as number) || 0;
  }

  db.execute(
    'DELETE FROM document_chunks WHERE notebook_id = ? AND file_path = ?',
    [notebookId, file.path],
  );

  const chunks = chunkText(file.content);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    db.execute(
      `INSERT INTO document_chunks (notebook_id, file_path, file_name, chunk_index, content, line_start, line_end, token_estimate, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [notebookId, file.path, file.name, i, chunk.content, chunk.lineStart, chunk.lineEnd, chunk.tokenEstimate, file.mtime],
    );
  }
  return chunks.length;
}

/** Upsert notebook row. Returns notebook ID. */
function upsertNotebook(
  db: DB, name: string, absPath: string, mode: string,
  fileCount: number, totalTokens: number,
): number {
  db.execute(
    `INSERT INTO notebooks (name, source_path, mode, total_files, total_tokens, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       source_path = excluded.source_path, mode = excluded.mode,
       total_files = excluded.total_files, total_tokens = excluded.total_tokens,
       updated_at = datetime('now')`,
    [name, absPath, mode, fileCount, totalTokens],
  );
  const notebook = db.fetchone('SELECT id FROM notebooks WHERE name = ?', [name]);
  return notebook!.id as number;
}

/** Log unsupported formats as learnings (best-effort). */
function logUnsupportedFormats(
  db: DB, name: string, skipped: SkippedFile[], formats: string[],
): void {
  if (formats.length === 0) return;
  try {
    db.execute(
      "INSERT INTO learnings (category, trigger, lesson, area, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      [
        'discovery',
        `notebook_ingest:${name}`,
        `Skipped ${skipped.length} files with unsupported formats: ${formats.join(', ')}. Consider adding support for these formats.`,
        'notebooks',
      ],
    );
  } catch { /* best-effort learning log, DB write failure is non-critical */ }
}

/** Create or re-ingest a notebook from a directory (incremental). */
export async function ingestNotebook(db: DB, name: string, dirPath: string): Promise<IngestResult> {
  const absPath = resolve(dirPath);
  const { files, skipped } = await scanDirectory(absPath);
  const totalTokens = files.reduce((sum, f) => sum + f.tokenEstimate, 0);

  const unsupportedFormats = [...new Set(
    skipped.filter((s) => s.reason === 'unsupported_format').map((s) => s.extension),
  )];
  const mode = totalTokens <= DIRECT_MODE_TOKEN_LIMIT ? 'direct' : 'chunked';

  const notebookId = upsertNotebook(db, name, absPath, mode, files.length, totalTokens);
  const totalChunks = db.transaction(() => syncChunks(db, notebookId, files));

  db.execute('UPDATE notebooks SET total_chunks = ? WHERE id = ?', [totalChunks, notebookId]);
  logUnsupportedFormats(db, name, skipped, unsupportedFormats);

  return {
    id: notebookId, name, source_path: absPath, mode,
    total_files: files.length, total_chunks: totalChunks,
    total_tokens: totalTokens, created_at: db.now(),
    skipped, unsupportedFormats,
  };
}

/** Search notebook chunks using FTS5 BM25. */
export function searchNotebook(
  db: DB, notebookId: number, query: string, limit: number = 20,
): Array<{ file_path: string; file_name: string; content: string; line_start: number; line_end: number; rank: number }> {
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
  for (const [, fileChunks] of byFile) {
    const fileName = fileChunks[0].file_name;
    const filePath = fileChunks[0].file_path;
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

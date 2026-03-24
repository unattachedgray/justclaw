import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DB } from '../src/db.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  estimateTokens,
  chunkText,
  scanDirectory,
  ingestNotebook,
  searchNotebook,
  loadAllChunks,
  formatChunksAsContext,
  listSources,
} from '../src/notebooks.js';

let db: DB;
let tmpDir: string;
let docsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'justclaw-notebook-test-'));
  db = new DB(join(tmpDir, 'test.db'));

  // Create a test documents directory.
  docsDir = join(tmpDir, 'docs');
  mkdirSync(docsDir);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75, ceil = 3
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long text', () => {
    const text = 'a'.repeat(4000);
    expect(estimateTokens(text)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('returns single chunk for small text', () => {
    const chunks = chunkText('Hello world\nThis is a test.');
    expect(chunks.length).toBe(1);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(2);
  });

  it('splits at paragraph boundaries', () => {
    // Create text with two clear paragraphs, each > CHUNK_TARGET_TOKENS
    const para1 = 'First paragraph. '.repeat(400); // ~6800 chars, ~1700 tokens
    const para2 = 'Second paragraph. '.repeat(400);
    const text = para1.trim() + '\n\n' + para2.trim();
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('respects code block boundaries', () => {
    const text = [
      'Some text before code.',
      '',
      '```typescript',
      'function hello() {',
      '  console.log("hello");',
      '}',
      '```',
      '',
      'Some text after code.',
    ].join('\n');
    const chunks = chunkText(text);
    // Small enough to be one chunk.
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('```typescript');
    expect(chunks[0].content).toContain('```');
  });

  it('tracks line numbers correctly', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(80)}`);
    const text = lines.join('\n');
    const chunks = chunkText(text);

    // First chunk starts at line 1.
    expect(chunks[0].lineStart).toBe(1);

    // Last chunk ends at line 100.
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.lineEnd).toBe(100);
  });

  it('handles empty text', () => {
    const chunks = chunkText('');
    expect(chunks.length).toBe(0);
  });

  it('each chunk has a token estimate', () => {
    const text = 'Hello world. '.repeat(500);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
    }
  });

  it('produces overlapping chunks for large text', () => {
    // Generate text large enough to produce multiple chunks.
    const para = 'Overlap test content here. '.repeat(300);
    const text = para + '\n\n' + para;
    const chunks = chunkText(text);
    if (chunks.length >= 2) {
      // The end of chunk N should overlap with the start of chunk N+1.
      const endOfFirst = chunks[0].content.slice(-200);
      const startOfSecond = chunks[1].content.slice(0, 400);
      // Some text from the tail of the first chunk should appear in the second.
      const endWords = endOfFirst.split(/\s+/).filter(Boolean).slice(-3);
      const hasOverlap = endWords.some((w) => startOfSecond.includes(w));
      expect(hasOverlap).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

describe('scanDirectory', () => {
  it('finds supported text files', async () => {
    writeFileSync(join(docsDir, 'readme.md'), '# Hello\nThis is a test.');
    writeFileSync(join(docsDir, 'code.ts'), 'const x = 1;');

    const { files, skipped } = await scanDirectory(docsDir);
    expect(files.length).toBe(2);
    expect(files.map((f) => f.name).sort()).toEqual(['code.ts', 'readme.md']);
  });

  it('skips truly unsupported formats and tracks them', async () => {
    writeFileSync(join(docsDir, 'readme.md'), '# Hello');
    writeFileSync(join(docsDir, 'data.bin'), 'binary stuff');

    const { files, skipped } = await scanDirectory(docsDir);
    expect(files.length).toBe(1);
    expect(skipped.length).toBe(1);
    expect(skipped[0].extension).toBe('.bin');
  });

  it('skips node_modules and hidden dirs', async () => {
    mkdirSync(join(docsDir, 'node_modules'));
    writeFileSync(join(docsDir, 'node_modules', 'dep.js'), 'module.exports = {}');
    mkdirSync(join(docsDir, '.hidden'));
    writeFileSync(join(docsDir, '.hidden', 'secret.md'), 'secret');
    writeFileSync(join(docsDir, 'visible.md'), 'visible');

    const { files } = await scanDirectory(docsDir);
    expect(files.length).toBe(1);
    expect(files[0].name).toBe('visible.md');
  });

  it('recurses into subdirectories', async () => {
    mkdirSync(join(docsDir, 'sub'));
    writeFileSync(join(docsDir, 'top.md'), 'top');
    writeFileSync(join(docsDir, 'sub', 'nested.md'), 'nested');

    const { files } = await scanDirectory(docsDir);
    expect(files.length).toBe(2);
  });

  it('returns empty for non-existent directory', async () => {
    const { files, skipped } = await scanDirectory('/tmp/nonexistent-dir-12345');
    expect(files.length).toBe(0);
    expect(skipped.length).toBe(0);
  });

  it('calculates token estimates per file', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Hello world test content here');

    const { files } = await scanDirectory(docsDir);
    expect(files[0].tokenEstimate).toBeGreaterThan(0);
  });

  it('extracts CSV files via extractor pipeline', async () => {
    writeFileSync(join(docsDir, 'data.csv'), 'name,value\nalice,1\nbob,2');

    const { files } = await scanDirectory(docsDir);
    const csv = files.find((f) => f.name === 'data.csv');
    expect(csv).toBeDefined();
    expect(csv!.content).toContain('alice');
  });

  it('handles SVG files via extractor pipeline', async () => {
    writeFileSync(join(docsDir, 'icon.svg'), '<svg><text>Hello SVG</text></svg>');

    const { files } = await scanDirectory(docsDir);
    const svg = files.find((f) => f.name === 'icon.svg');
    expect(svg).toBeDefined();
    expect(svg!.content).toContain('Hello SVG');
  });

  it('handles image files with placeholder', async () => {
    writeFileSync(join(docsDir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { files } = await scanDirectory(docsDir);
    const img = files.find((f) => f.name === 'photo.png');
    expect(img).toBeDefined();
    expect(img!.content).toContain('[Image:');
  });
});

// ---------------------------------------------------------------------------
// Notebook ingestion
// ---------------------------------------------------------------------------

describe('ingestNotebook', () => {
  it('creates a notebook with correct stats', async () => {
    writeFileSync(join(docsDir, 'doc1.md'), '# Doc 1\nContent here.');
    writeFileSync(join(docsDir, 'doc2.md'), '# Doc 2\nMore content.');

    const result = await ingestNotebook(db, 'test-nb', docsDir);
    expect(result.name).toBe('test-nb');
    expect(result.total_files).toBe(2);
    expect(result.total_chunks).toBeGreaterThanOrEqual(2);
    expect(result.total_tokens).toBeGreaterThan(0);
  });

  it('chooses direct mode for small notebooks', async () => {
    writeFileSync(join(docsDir, 'small.md'), 'Small document.');

    const result = await ingestNotebook(db, 'small', docsDir);
    expect(result.mode).toBe('direct');
  });

  it('persists notebook to DB', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Content.');

    await ingestNotebook(db, 'persist-test', docsDir);
    const row = db.fetchone('SELECT * FROM notebooks WHERE name = ?', ['persist-test']);
    expect(row).not.toBeNull();
    expect(row!.name).toBe('persist-test');
  });

  it('stores chunks in document_chunks table', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Line 1\nLine 2\nLine 3');

    const result = await ingestNotebook(db, 'chunks-test', docsDir);
    const chunks = db.fetchall('SELECT * FROM document_chunks WHERE notebook_id = ?', [result.id]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].file_name).toBe('doc.md');
  });

  it('re-ingestion replaces old chunks', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Version 1');
    await ingestNotebook(db, 'reingest', docsDir);

    writeFileSync(join(docsDir, 'doc.md'), 'Version 2 with more content');
    const result = await ingestNotebook(db, 'reingest', docsDir);

    const chunks = db.fetchall('SELECT content FROM document_chunks WHERE notebook_id = ?', [result.id]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('Version 2');
  });

  it('tracks skipped files', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Good file');
    writeFileSync(join(docsDir, 'data.bin'), 'not recognized');

    const result = await ingestNotebook(db, 'skip-test', docsDir);
    expect(result.skipped.length).toBe(1);
    expect(result.unsupportedFormats).toContain('.bin');
  });

  it('logs unsupported formats as learnings', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Good file');
    writeFileSync(join(docsDir, 'data.xyz'), 'unknown format');

    await ingestNotebook(db, 'learning-test', docsDir);
    const learnings = db.fetchall("SELECT * FROM learnings WHERE area = 'notebooks'");
    expect(learnings.length).toBe(1);
    expect(String(learnings[0].lesson)).toContain('.xyz');
  });

  it('stores file_mtime in chunks for incremental re-indexing', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Content');

    const result = await ingestNotebook(db, 'mtime-test', docsDir);
    const chunk = db.fetchone('SELECT file_mtime FROM document_chunks WHERE notebook_id = ?', [result.id]);
    expect(chunk).not.toBeNull();
    expect(chunk!.file_mtime).toBeTruthy();
  });

  it('skips unchanged files on re-ingest (incremental)', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Stable content');
    writeFileSync(join(docsDir, 'other.md'), 'Other content');
    await ingestNotebook(db, 'incr-test', docsDir);

    // Only modify one file.
    writeFileSync(join(docsDir, 'other.md'), 'Updated other content');
    const result = await ingestNotebook(db, 'incr-test', docsDir);

    // Both files should be present.
    expect(result.total_files).toBe(2);
    expect(result.total_chunks).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// FTS5 search
// ---------------------------------------------------------------------------

describe('searchNotebook', () => {
  it('finds matching chunks via BM25', async () => {
    writeFileSync(join(docsDir, 'api.md'), '# API Reference\nThe authentication endpoint uses JWT tokens.');
    writeFileSync(join(docsDir, 'db.md'), '# Database\nSQLite with WAL mode for concurrent reads.');

    const nb = await ingestNotebook(db, 'search-test', docsDir);
    const results = searchNotebook(db, nb.id, 'authentication JWT');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('JWT');
  });

  it('returns empty for no matches', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Hello world');

    const nb = await ingestNotebook(db, 'empty-search', docsDir);
    const results = searchNotebook(db, nb.id, 'xyznonexistent');
    expect(results.length).toBe(0);
  });

  it('respects limit parameter', async () => {
    // Create multiple files with the same keyword.
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(docsDir, `doc${i}.md`), `Document ${i} about testing and quality.`);
    }

    const nb = await ingestNotebook(db, 'limit-test', docsDir);
    const results = searchNotebook(db, nb.id, 'testing quality', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('includes file path and line numbers in results', async () => {
    writeFileSync(join(docsDir, 'code.ts'), 'function hello() {\n  return "world";\n}');

    const nb = await ingestNotebook(db, 'meta-test', docsDir);
    const results = searchNotebook(db, nb.id, 'hello');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file_name).toBe('code.ts');
    expect(results[0].line_start).toBeGreaterThanOrEqual(1);
    expect(results[0].line_end).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Load all chunks (direct mode)
// ---------------------------------------------------------------------------

describe('loadAllChunks', () => {
  it('returns all chunks ordered by file and index', async () => {
    writeFileSync(join(docsDir, 'a.md'), 'First file content');
    writeFileSync(join(docsDir, 'b.md'), 'Second file content');

    const nb = await ingestNotebook(db, 'load-all', docsDir);
    const chunks = loadAllChunks(db, nb.id);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

describe('formatChunksAsContext', () => {
  it('groups chunks by file with source headers', () => {
    const chunks = [
      { file_path: '/docs/a.md', file_name: 'a.md', content: 'Content A', line_start: 1, line_end: 5 },
      { file_path: '/docs/b.md', file_name: 'b.md', content: 'Content B', line_start: 1, line_end: 3 },
    ];
    const context = formatChunksAsContext(chunks);
    expect(context).toContain('### Source: a.md');
    expect(context).toContain('### Source: b.md');
    expect(context).toContain('[lines 1-5]');
    expect(context).toContain('Content A');
  });

  it('handles multiple chunks from same file', () => {
    const chunks = [
      { file_path: '/docs/a.md', file_name: 'a.md', content: 'Part 1', line_start: 1, line_end: 10 },
      { file_path: '/docs/a.md', file_name: 'a.md', content: 'Part 2', line_start: 11, line_end: 20 },
    ];
    const context = formatChunksAsContext(chunks);
    // Should have one file header but two chunk sections.
    const headers = context.split('### Source: a.md').length - 1;
    expect(headers).toBe(1);
    expect(context).toContain('[lines 1-10]');
    expect(context).toContain('[lines 11-20]');
  });
});

// ---------------------------------------------------------------------------
// List sources
// ---------------------------------------------------------------------------

describe('listSources', () => {
  it('returns per-file stats', async () => {
    writeFileSync(join(docsDir, 'api.md'), '# API\nLong content here. '.repeat(50));
    writeFileSync(join(docsDir, 'db.md'), '# DB\nShort.');

    const nb = await ingestNotebook(db, 'sources-test', docsDir);
    const sources = listSources(db, nb.id);
    expect(sources.length).toBe(2);
    expect(sources[0].chunks).toBeGreaterThan(0);
    expect(sources[0].tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Schema v13
// ---------------------------------------------------------------------------

describe('Schema v13', () => {
  it('creates notebooks table', () => {
    const tables = db.fetchall("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    expect(tables).toContain('notebooks');
    expect(tables).toContain('document_chunks');
  });

  it('creates FTS5 virtual table for chunks', () => {
    const tables = db.fetchall("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    expect(tables).toContain('chunks_fts');
  });

  it('document_chunks has file_mtime column', () => {
    const cols = db.fetchall("PRAGMA table_info(document_chunks)").map((r) => r.name);
    expect(cols).toContain('file_mtime');
  });

  it('cascade deletes chunks when notebook deleted', async () => {
    writeFileSync(join(docsDir, 'doc.md'), 'Content');
    const nb = await ingestNotebook(db, 'cascade-test', docsDir);

    const chunksBefore = db.fetchall('SELECT COUNT(*) as c FROM document_chunks WHERE notebook_id = ?', [nb.id]);
    expect((chunksBefore[0].c as number)).toBeGreaterThan(0);

    db.execute('DELETE FROM notebooks WHERE id = ?', [nb.id]);

    const chunksAfter = db.fetchall('SELECT COUNT(*) as c FROM document_chunks WHERE notebook_id = ?', [nb.id]);
    expect((chunksAfter[0].c as number)).toBe(0);
  });

  it('schema version is current', () => {
    const row = db.fetchone("SELECT value FROM schema_meta WHERE key='version'");
    expect(Number(row!.value)).toBeGreaterThanOrEqual(14);
  });
});

// ---------------------------------------------------------------------------
// Extractors (integration)
// ---------------------------------------------------------------------------

describe('extractors integration', () => {
  it('extracts HTML to markdown', async () => {
    writeFileSync(join(docsDir, 'page.html'), '<h1>Title</h1><p>Hello <strong>world</strong></p>');

    const { files } = await scanDirectory(docsDir);
    const html = files.find((f) => f.name === 'page.html');
    expect(html).toBeDefined();
    // Turndown converts to markdown.
    expect(html!.content).toContain('Title');
    expect(html!.content).toContain('world');
  });
});

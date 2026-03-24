/**
 * Document text extraction — unified interface for PDF, DOCX, XLSX, PPTX,
 * ODP, ODS, ODT, RTF, HTML, EPUB, images, SVG, and CSV.
 *
 * Each extractor returns clean text + metadata. Errors are caught and
 * returned as descriptive messages — no throws escape to callers.
 */

import { readFileSync, statSync } from 'fs';
import { extname, basename } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  text: string;
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Extension sets
// ---------------------------------------------------------------------------

/** Extensions handled by officeparser (spreadsheets, presentations, rich text). */
const OFFICEPARSER_EXTENSIONS = new Set([
  '.xlsx', '.pptx', '.odp', '.ods', '.odt', '.rtf', '.epub',
]);

/** Image extensions — return placeholder for Claude's native Read tool. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** All extensions this module can extract text from. */
export const EXTRACTABLE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.odp', '.ods', '.odt', '.rtf',
  '.html', '.htm', '.epub',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.csv',
]);

// ---------------------------------------------------------------------------
// Individual extractors (each under 50 lines)
// ---------------------------------------------------------------------------

async function extractPdf(filePath: string): Promise<ExtractionResult> {
  const { extractText: extractPdfText } = await import('unpdf');
  const buffer = readFileSync(filePath);
  const result = await extractPdfText(new Uint8Array(buffer), { mergePages: true });
  const pageCount = result.totalPages ?? 0;
  const text = typeof result.text === 'string' ? result.text : '';
  return {
    text: text.trim() || '[No extractable text in PDF]',
    metadata: {
      format: 'pdf',
      pages: String(pageCount),
      fileSize: String(statSync(filePath).size),
    },
  };
}

async function extractDocx(filePath: string): Promise<ExtractionResult> {
  const mammoth = await import('mammoth');
  const buffer = readFileSync(filePath);
  const result = await mammoth.default.extractRawText({ buffer });
  return {
    text: result.value?.trim() || '[No extractable text in DOCX]',
    metadata: {
      format: 'docx',
      fileSize: String(statSync(filePath).size),
    },
  };
}

async function extractWithOfficeparser(
  filePath: string,
  format: string,
): Promise<ExtractionResult> {
  const { parseOffice } = await import('officeparser');
  const ast = await parseOffice(filePath);
  // officeparser v6 returns an AST with .toText() method.
  const text = typeof ast === 'string' ? ast : ast.toText();
  return {
    text: text.trim() || `[No extractable text in ${format.toUpperCase()}]`,
    metadata: {
      format,
      fileSize: String(statSync(filePath).size),
    },
  };
}

async function extractHtml(filePath: string): Promise<ExtractionResult> {
  const TurndownService = (await import('turndown')).default;
  const html = readFileSync(filePath, 'utf-8');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = td.turndown(html);
  return {
    text: markdown.trim() || '[No extractable text in HTML]',
    metadata: {
      format: 'html',
      fileSize: String(statSync(filePath).size),
    },
  };
}

function extractImage(filePath: string): ExtractionResult {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase().replace('.', '');
  const size = statSync(filePath).size;
  return {
    text: `[Image: ${name} — use Claude's Read tool to view this image for visual analysis]`,
    metadata: {
      format: ext,
      fileSize: String(size),
    },
  };
}

function extractSvg(filePath: string): ExtractionResult {
  const content = readFileSync(filePath, 'utf-8');
  // Pull text content from <text>, <tspan>, <title>, <desc> elements.
  const textParts: string[] = [];
  const tagPattern = /<(?:text|tspan|title|desc)[^>]*>([\s\S]*?)<\/(?:text|tspan|title|desc)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(content)) !== null) {
    const inner = match[1].replace(/<[^>]+>/g, '').trim();
    if (inner) textParts.push(inner);
  }
  const extracted = textParts.length > 0
    ? textParts.join('\n')
    : '[SVG vector image — no text content found]';
  return {
    text: `[SVG vector image]\n${extracted}`,
    metadata: {
      format: 'svg',
      fileSize: String(statSync(filePath).size),
    },
  };
}

function extractCsv(filePath: string): ExtractionResult {
  const content = readFileSync(filePath, 'utf-8');
  return {
    text: content,
    metadata: {
      format: 'csv',
      fileSize: String(statSync(filePath).size),
    },
  };
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Extract text and metadata from a file. Handles PDF, DOCX, XLSX, PPTX,
 * ODP, ODS, ODT, RTF, HTML, EPUB, images, SVG, and CSV.
 *
 * Never throws — returns an error description on failure.
 */
export async function extractText(filePath: string): Promise<ExtractionResult> {
  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') return await extractPdf(filePath);
    if (ext === '.docx') return await extractDocx(filePath);
    if (OFFICEPARSER_EXTENSIONS.has(ext)) {
      return await extractWithOfficeparser(filePath, ext.replace('.', ''));
    }
    if (ext === '.html' || ext === '.htm') return await extractHtml(filePath);
    if (IMAGE_EXTENSIONS.has(ext)) return extractImage(filePath);
    if (ext === '.svg') return extractSvg(filePath);
    if (ext === '.csv') return extractCsv(filePath);

    return {
      text: `[Unsupported format: ${ext}]`,
      metadata: { format: ext, fileSize: String(statSync(filePath).size) },
    };
  } catch (err) {
    return {
      text: `[Extraction failed for ${basename(filePath)}: ${String(err)}]`,
      metadata: {
        format: ext,
        error: String(err),
        fileSize: String(tryFileSize(filePath)),
      },
    };
  }
}

/** Safe file size check — returns 0 if stat fails. */
function tryFileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

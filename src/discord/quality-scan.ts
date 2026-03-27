/**
 * Deterministic quality analysis of task output text.
 *
 * Pure functions — no DB, no LLM, no side effects. Testable in isolation.
 * Scans task output for error patterns, missing sections, empty output,
 * and success indicators. Returns a structured QualityScan.
 */

import { existsSync } from 'fs';

export interface PatternMatch {
  pattern: string;
  match: string;
  severity: 'error' | 'warning' | 'info';
}

export interface QualityScan {
  /** Quality score 0-100. 100 = perfect, <70 = issues found. */
  score: number;
  /** Error-level pattern matches. */
  errors: PatternMatch[];
  /** Warning-level pattern matches. */
  warnings: PatternMatch[];
  /** Whether the output is empty or near-empty. */
  isEmpty: boolean;
  /** Expected sections that were found / missing. */
  sections: { found: string[]; missing: string[] };
}

// ---------------------------------------------------------------------------
// Error patterns — things that indicate task failure
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /SMTP not configured/i, label: 'SMTP not configured' },
  { regex: /Email send failed/i, label: 'Email send failed' },
  { regex: /fatal:\s/i, label: 'Git fatal error' },
  { regex: /ENOENT|no such file/i, label: 'File not found' },
  { regex: /EACCES|permission denied/i, label: 'Permission denied' },
  { regex: /ETIMEDOUT|ECONNREFUSED|ECONNRESET/i, label: 'Network error' },
  { regex: /exit code [1-9]/i, label: 'Non-zero exit code' },
  { regex: /Error:\s+\S/i, label: 'Error message' },
  { regex: /SIGTERM|SIGKILL|timed? ?out/i, label: 'Process killed/timeout' },
  { regex: /rate limit|429|too many requests/i, label: 'Rate limited' },
  { regex: /auth.*fail|401|403/i, label: 'Authentication failure' },
  { regex: /No body content provided/i, label: 'Empty email body' },
];

const WARNING_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\(no output\)/i, label: 'No output from subprocess' },
  { regex: /Unresolved template variable/i, label: 'Unresolved template variable' },
  { regex: /not found|could not find/i, label: 'Resource not found' },
  { regex: /deprecated/i, label: 'Deprecated API/feature' },
  { regex: /WARNING|⚠️/i, label: 'Warning indicator' },
  { regex: /retry|retrying/i, label: 'Retry occurred' },
];

// ---------------------------------------------------------------------------
// Section detection — expected structure in reports
// ---------------------------------------------------------------------------

/** Common report sections. Used when no template-specific sections available. */
const GENERIC_REPORT_SECTIONS = [
  { regex: /#{1,3}\s+/m, label: 'Has headings' },
  { regex: /https?:\/\//m, label: 'Has links' },
  { regex: /\*\*|__/m, label: 'Has emphasis' },
];

/** Template-specific section patterns. */
export const TEMPLATE_SECTIONS: Record<string, Array<{ regex: RegExp; label: string }>> = {
  'daily-report': [
    { regex: /RESEARCH|web search|검색/i, label: 'Research section' },
    { regex: /GitHub|archive|git/i, label: 'Archive section' },
    { regex: /email|send|발송/i, label: 'Email section' },
  ],
  'rtx4090-hobby-report': [
    { regex: /AI News|뉴스/i, label: 'AI News section' },
    { regex: /Expert|Analysis|분석/i, label: 'Expert Analysis section' },
    { regex: /Home Lab|Hobbyist|RTX/i, label: 'Hobbyist section' },
    { regex: /Quick Links|source/i, label: 'Sources section' },
  ],
};

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Scan task output for quality issues.
 * Pure function — no side effects.
 */
export function scanTaskOutput(
  text: string,
  taskTitle: string,
  templateName?: string,
): QualityScan {
  const errors: PatternMatch[] = [];
  const warnings: PatternMatch[] = [];

  // Empty check
  const isEmpty = !text || text.trim().length < 50;
  if (isEmpty) {
    errors.push({ pattern: 'empty_output', match: 'Output is empty or near-empty', severity: 'error' });
  }

  // Error patterns
  for (const { regex, label } of ERROR_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      errors.push({ pattern: label, match: match[0].slice(0, 100), severity: 'error' });
    }
  }

  // Warning patterns
  for (const { regex, label } of WARNING_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      warnings.push({ pattern: label, match: match[0].slice(0, 100), severity: 'warning' });
    }
  }

  // Section detection
  const sectionPatterns = (templateName && TEMPLATE_SECTIONS[templateName])
    ? TEMPLATE_SECTIONS[templateName]
    : GENERIC_REPORT_SECTIONS;

  const found: string[] = [];
  const missing: string[] = [];
  for (const { regex, label } of sectionPatterns) {
    if (regex.test(text)) {
      found.push(label);
    } else {
      missing.push(label);
    }
  }

  // Score calculation
  let score = 100;
  score -= errors.length * 15;
  score -= warnings.length * 5;
  score -= missing.length * 10;
  if (isEmpty) score = 0;
  // Bonus for content quality
  if (text.length > 1000) score = Math.min(100, score + 5);
  if (found.length >= 3) score = Math.min(100, score + 5);
  score = Math.max(0, Math.min(100, score));

  return { score, errors, warnings, isEmpty, sections: { found, missing } };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ErrorClass = 'none' | 'transient' | 'permanent' | 'novel';

const TRANSIENT_PATTERNS = [
  /ETIMEDOUT|ECONNREFUSED|ECONNRESET/i,
  /rate limit|429|too many requests/i,
  /SQLITE_BUSY/i,
  /timed? ?out/i,
  /503|502|504/i,
];

const PERMANENT_PATTERNS = [
  /ENOENT|no such file/i,
  /EACCES|permission denied/i,
  /auth.*fail|401|403/i,
  /SMTP not configured/i,
  /Template.*not found/i,
];

/** Classify the dominant error type in a quality scan. */
export function classifyErrors(scan: QualityScan): ErrorClass {
  if (scan.errors.length === 0) return 'none';

  const allMatches = scan.errors.map((e) => e.match).join(' ');

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(allMatches)) return 'transient';
  }

  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(allMatches)) return 'permanent';
  }

  return 'novel';
}

// ---------------------------------------------------------------------------
// Post-execution verification helpers
// ---------------------------------------------------------------------------

/**
 * Verify that expected task outputs exist on disk.
 * Called after task completion for two-phase tasks.
 */
export function verifyTaskOutputs(
  reportPath: string | null,
  expectedGitRepo: string | null,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  if (reportPath && !existsSync(reportPath)) {
    issues.push(`Report file missing: ${reportPath}`);
  }

  if (expectedGitRepo) {
    const gitDir = `${expectedGitRepo}/.git`;
    if (!existsSync(gitDir)) {
      issues.push(`Git repo not found: ${expectedGitRepo}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Check if task output text indicates successful git operations.
 */
export function verifyGitSuccess(text: string): boolean {
  return /committed|pushed|archived|git-archive.*success/i.test(text);
}

/**
 * Verify section content meets minimum length requirements.
 * Returns descriptions of sections that are present but too short.
 */
export function findThinSections(
  text: string,
  templateName?: string,
  minChars: number = 200,
): string[] {
  const sectionPatterns = TEMPLATE_SECTIONS[templateName || ''];
  if (!sectionPatterns) return [];

  const thin: string[] = [];
  const headingRegex = /^#{1,3}\s+.+$/gm;
  const sections = text.split(headingRegex);

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length > 0 && trimmed.length < minChars) {
      thin.push(`Section too short (${trimmed.length} chars < ${minChars} min)`);
    }
  }

  return thin;
}

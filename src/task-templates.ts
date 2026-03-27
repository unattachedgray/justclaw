/**
 * Task template system — resolve template references in task descriptions.
 *
 * Templates live in `data/task-templates/<name>.md` with {{variable}} placeholders.
 * Task descriptions starting with `template:<name>` are resolved at execution time.
 *
 * Format:
 *   template:daily-report
 *   search_topics: Fed rates, treasury yields, bank failures
 *   email_to: team@example.com
 *   report_type: banking industry
 *
 * Built-in variables (auto-populated):
 *   {{DATE}}     — YYYY-MM-DD
 *   {{DATE_KR}}  — YYYY년 MM월 DD일
 *   {{YEAR}}     — YYYY
 *   {{MONTH}}    — MM
 *   {{DAY}}      — DD
 *   {{DOW}}      — Monday, Tuesday, etc.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';

const log = getLogger('task-templates');

/** Directory where templates are stored. */
function getTemplateDir(): string {
  const root = process.env.JUSTCLAW_ROOT || process.cwd();
  return join(root, 'data', 'task-templates');
}

/** Parse a task description that starts with `template:<name>`. */
function parseTemplateRef(description: string): { templateName: string; vars: Record<string, string> } | null {
  const lines = description.split('\n');
  const firstLine = lines[0].trim();

  if (!firstLine.startsWith('template:')) return null;

  const templateName = firstLine.slice('template:'.length).trim();
  const vars: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) vars[key] = value;
  }

  return { templateName, vars };
}

/** Get built-in date variables for template interpolation. */
function getBuiltinVars(): Record<string, string> {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    DATE: `${yyyy}-${mm}-${dd}`,
    DATE_KR: `${yyyy}년 ${mm}월 ${dd}일`,
    YEAR: yyyy,
    MONTH: mm,
    DAY: dd,
    DOW: days[now.getDay()],
  };
}

/** Load a template file by name. Returns null if not found. */
function loadTemplate(name: string): string | null {
  const dir = getTemplateDir();
  const path = join(dir, `${name}.md`);

  if (!existsSync(path)) {
    log.warn('Template not found', { name, path });
    return null;
  }

  return readFileSync(path, 'utf-8');
}

/** Interpolate {{variables}} in a template string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in vars) return vars[key];
    log.warn('Unresolved template variable', { key });
    return match;
  });
}

/**
 * Resolve a task description — if it starts with `template:<name>`,
 * load the template and interpolate variables. Otherwise return as-is.
 */
export function resolveTaskDescription(description: string): string {
  const ref = parseTemplateRef(description);
  if (!ref) return description;

  const template = loadTemplate(ref.templateName);
  if (!template) {
    log.error('Template not found, using raw description', { template: ref.templateName });
    return description;
  }

  const builtins = getBuiltinVars();
  // First pass: resolve builtins inside user-provided variable values
  // (e.g., email_subject might contain {{DATE_KR}}).
  const resolvedVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(ref.vars)) {
    resolvedVars[k] = interpolate(v, builtins);
  }
  const allVars = { ...builtins, ...resolvedVars };
  // Second pass: resolve all variables in the template.
  const resolved = interpolate(template, allVars);

  log.info('Resolved task template', {
    template: ref.templateName,
    varCount: Object.keys(ref.vars).length,
    unresolvedCount: (resolved.match(/\{\{\w+\}\}/g) || []).length,
  });

  return resolved;
}

/**
 * List available templates with their variable names.
 */
export function listTemplates(): Array<{ name: string; variables: string[] }> {
  const dir = getTemplateDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  return files.map((f) => {
    const name = f.replace(/\.md$/, '');
    const content = readFileSync(join(dir, f), 'utf-8');
    const vars = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map((m) => m.slice(2, -2)))];
    return { name, variables: vars };
  });
}

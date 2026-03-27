#!/usr/bin/env node
/**
 * Build a compact skill index from ~/.claude/skills/ SKILL.md files.
 * Outputs data/skill-index.json — loaded by session-context.ts into identity preamble.
 *
 * Run: npx tsx scripts/build-skill-index.ts
 * Or:  npm run build:skills
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(process.env.HOME || '', '.claude', 'skills');
const OUTPUT = join(process.env.JUSTCLAW_ROOT || process.cwd(), 'data', 'skill-index.json');

interface SkillEntry {
  name: string;
  trigger: string;
  path: string;
}

function extractDescription(content: string): string {
  // Try frontmatter description field
  const m = content.match(/^description:\s*(.+?)(?:\n\w|\n---)/ms);
  if (m) return m[1].trim().replace(/\n/g, ' ').replace(/^["']|["']$/g, '');

  // Fallback: first paragraph after heading
  const m2 = content.match(/^#[^#].+?\n\n(.+?)(?:\n\n|\n#)/ms);
  if (m2) return m2[1].trim().replace(/\n/g, ' ').replace(/^["']|["']$/g, '');

  return '';
}

function shortenTrigger(desc: string): string {
  // Compress to ~80 chars: first sentence or truncate
  const firstSentence = desc.match(/^.+?[.!]/)?.[0] || desc;
  return firstSentence.slice(0, 120);
}

function main(): void {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`Skills directory not found: ${SKILLS_DIR}`);
    process.exit(1);
  }

  const entries: SkillEntry[] = [];

  for (const name of readdirSync(SKILLS_DIR).sort()) {
    const skillFile = join(SKILLS_DIR, name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    const content = readFileSync(skillFile, 'utf-8');
    const desc = extractDescription(content);
    if (!desc) continue;

    entries.push({
      name,
      trigger: shortenTrigger(desc),
      path: skillFile,
    });
  }

  mkdirSync(join(OUTPUT, '..'), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(entries, null, 2));
  console.log(`Built skill index: ${entries.length} skills → ${OUTPUT}`);

  // Show compact size
  const compact = entries.map((e) => `${e.name}: ${e.trigger}`).join('\n');
  console.log(`Index size: ~${compact.length} chars (${Math.round(compact.length / 4)} tokens est.)`);
}

main();

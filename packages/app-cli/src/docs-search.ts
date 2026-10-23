import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveSdkDir, toPosix } from './paths';

export interface DocsHit {
  /** Path inside the SDK package (`docs/components.md`, `llms.txt`). */
  file: string;
  heading: string;
  line: number;
  score: number;
  excerpt: string;
}

interface Section {
  file: string;
  heading: string;
  line: number;
  lines: string[];
  weight: number;
}

function splitSections(file: string, text: string, weight: number): Section[] {
  const sections: Section[] = [];
  let current: Section = { file, heading: file, line: 1, lines: [], weight };
  let fenced = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = !fenced && /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      if (current.lines.length > 0 || current.heading !== file) sections.push(current);
      current = { file, heading: heading[1]!.trim(), line: index + 1, lines: [line], weight };
    } else {
      current.lines.push(line);
    }
  });
  sections.push(current);
  return sections;
}

export function docsLocation(projectDir: string): { sdkDir: string | null; files: string[] } {
  const sdkDir = resolveSdkDir(projectDir);
  if (!sdkDir) return { sdkDir: null, files: [] };
  const files: string[] = [];
  const docs = join(sdkDir, 'docs');
  if (existsSync(docs)) for (const name of readdirSync(docs).sort()) if (name.endsWith('.md')) files.push(`docs/${name}`);
  if (existsSync(join(sdkDir, 'README.md'))) files.push('README.md');
  if (existsSync(join(sdkDir, 'llms.txt'))) files.push('llms.txt');
  return { sdkDir: toPosix(sdkDir), files };
}

function terms(query: string): string[] {
  const words = query.toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (const word of words) {
    out.add(word);
    for (const part of word.split(/[.,:;()<>"'`/]+/)) if (part.length > 1) out.add(part);
  }
  return [...out];
}

function count(haystack: string, needle: string): number {
  let total = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    total++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return total;
}

/**
 * Grep-like search over the SDK's offline docs (`docs/*.md`, `README.md`, `llms.txt`): sections
 * ranked by how many query words they contain, then by frequency (headings count more). Sections
 * of `llms.txt` that repeat a `docs/` heading are skipped, because the digest mirrors the docs.
 */
export function searchDocs(query: string, projectDir: string, limit = 8): { sdkDir: string | null; results: DocsHit[] } {
  const { sdkDir, files } = docsLocation(projectDir);
  if (!sdkDir) return { sdkDir: null, results: [] };
  const sections: Section[] = [];
  for (const file of files) {
    const text = readFileSync(join(sdkDir, file), 'utf8');
    sections.push(...splitSections(file, text, file === 'llms.txt' ? 0.6 : 1));
  }
  const docHeadings = new Set(sections.filter((section) => section.file !== 'llms.txt').map((section) => section.heading.toLowerCase()));
  const wanted = terms(query);
  if (wanted.length === 0) return { sdkDir, results: [] };
  const hits: (DocsHit & { distinct: number })[] = [];
  for (const section of sections) {
    if (section.file === 'llms.txt' && docHeadings.has(section.heading.toLowerCase())) continue;
    const heading = section.heading.toLocaleLowerCase('en');
    const body = section.lines.join('\n').toLocaleLowerCase('en');
    let distinct = 0;
    let score = 0;
    for (const term of wanted) {
      const inHeading = count(heading, term);
      const inBody = count(body, term);
      if (inHeading + inBody > 0) distinct++;
      score += inHeading * 5 + inBody;
    }
    if (distinct === 0) continue;
    const firstMatch = section.lines.findIndex((line) => wanted.some((term) => line.toLocaleLowerCase('en').includes(term)));
    const start = section.lines.length <= 40 ? 0 : Math.max(0, Math.min(firstMatch - 5, section.lines.length - 40));
    hits.push({
      file: section.file,
      heading: section.heading,
      line: section.line + start,
      score: Math.round(score * section.weight * 10) / 10,
      distinct,
      excerpt: section.lines.slice(start, start + 40).join('\n').trim(),
    });
  }
  hits.sort((a, b) => b.distinct - a.distinct || b.score - a.score);
  return { sdkDir, results: hits.slice(0, limit).map(({ distinct: _distinct, ...hit }) => hit) };
}

// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { COMPONENT_TYPES, EVENT_TYPES, INTERNAL_RPC_METHODS, RPC_METHODS, SURFACES } from '@olan-app/schema';

import { searchDocs } from '../src/docs-search';
// @ts-expect-error plain .mjs build script without types
import { buildLlms } from '../scripts/build-llms.mjs';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const sdkDir = join(cliDir, '..', 'app-sdk');
const doc = (name: string) => readFileSync(join(sdkDir, 'docs', name), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'templates' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('SDK docs', () => {
  it('has every documented file and an up-to-date llms.txt within 4720 lines', () => {
    const files = readdirSync(join(sdkDir, 'docs')).sort();
    expect(files).toEqual(['api.md', 'backend.md', 'cards.md', 'cli.md', 'components.md', 'database.md', 'errors.md', 'examples.md', 'files.md', 'getting-started.md', 'hooks.md', 'links.md', 'manifest.md', 'marketplace.md', 'navigation.md', 'permissions.md', 'remote-requests.md', 'review-guidelines.md', 'server.md', 'surfaces.md', 'testing.md']);
    // A Windows checkout with core.autocrlf has CRLF; buildLlms writes LF.
    const llms = readFileSync(join(sdkDir, 'llms.txt'), 'utf8').replace(/\r\n/g, '\n');
    expect(llms).toBe((buildLlms as () => string)());
    expect(llms.split('\n').length).toBeLessThanOrEqual(4720);
  });

  it('documents every component and every olan.* method', () => {
    const components = doc('components.md');
    for (const type of COMPONENT_TYPES) expect(components, type).toContain(`## ${type}`);
    const api = doc('api.md');
    // `olan.storage.get(` or `olan.storage.get<T>(`
    for (const method of RPC_METHODS.filter((name) => !INTERNAL_RPC_METHODS.includes(name))) {
      // `db.insert` is `olan.db.collection(name).insert(…)` (api.md or database.md).
      const [text, needles] = method.startsWith('db.') ? [api + doc('database.md'), [`.${method.slice(3)}(`]] : [api, [`olan.${method}(`, `olan.${method}<`]];
      expect(needles.some((needle) => text.includes(needle)), method).toBe(true);
    }
    expect(api).toContain('olan.db.collection');
    expect(doc('database.md')).toContain('olan.db.collection');
  });

  it('explains every error code the CLI can report', () => {
    const errors = doc('errors.md');
    const codes = new Set<string>();
    for (const file of sourceFiles(join(cliDir, 'src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'((?:cli|project|build|validate|ui|app|runtime|permission|fixtures|test|pack|keygen|sign|publish|init|docs|dev|mcp|manifest|revocations|events|tools|remote|requests)\.[a-z_]+)'/g)) {
        codes.add(match[1]!);
      }
    }
    // RPC method names that match the pattern are not error codes.
    for (const method of RPC_METHODS) codes.delete(method);
    for (const type of EVENT_TYPES) codes.delete(type);
    for (const surface of SURFACES) codes.delete(surface);
    const missing = [...codes].filter((code) => !errors.includes(code));
    expect(missing).toEqual([]);
  });

  it('explains every marketplace code the CLI reports or has a hint for', () => {
    const errors = doc('errors.md');
    const codes = new Set<string>();
    for (const file of sourceFiles(join(cliDir, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/marketplaceFail\(\s*'([a-z_]+)'/g)) codes.add(`marketplace.${match[1]}`);
      for (const match of text.matchAll(/'(marketplace\.[a-z_]+)'/g)) codes.add(match[1]!);
    }
    // Server error codes with a CLI hint (marketplace.ts HINTS).
    const hints = /const HINTS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(readFileSync(join(cliDir, 'src', 'marketplace.ts'), 'utf8'))![1]!;
    for (const match of hints.matchAll(/^ {2}([a-z_]+):/gm)) codes.add(`marketplace.${match[1]}`);
    codes.delete('marketplace.json'); // the session file name
    expect(codes.size).toBeGreaterThan(30);
    expect([...codes].filter((code) => !errors.includes(code))).toEqual([]);
  });

  it('is searchable offline', () => {
    const { sdkDir: found, results } = searchDocs('updateTask revision', cliDir, 3);
    expect(found).toBeTruthy();
    expect(results[0]?.file).toMatch(/docs\/|llms\.txt/);
    expect(results.some((hit) => hit.excerpt.includes('revision'))).toBe(true);
  });
});

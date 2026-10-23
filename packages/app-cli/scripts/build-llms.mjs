// Generates packages/app-sdk/llms.txt: every docs/*.md in reading order in one file, for coding
// agents that read a single file. `--check` fails when the file is out of date (CI, unit test).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app-sdk');
const ORDER = ['getting-started', 'components', 'api', 'hooks', 'navigation', 'surfaces', 'cards', 'database', 'permissions', 'manifest', 'server', 'remote-requests', 'files', 'links', 'backend', 'testing', 'cli', 'marketplace', 'review-guidelines', 'errors', 'examples'];
const MAX_LINES = 4720;

export function buildLlms() {
  const header = [
    '# @olan-app/sdk — Olan Apps SDK (llms.txt)',
    '',
    '> One-file digest of node_modules/@olan-app/sdk/docs/*.md (generated; edit the docs instead).',
    '> Olan Apps are React + TypeScript running in a sandbox; UI = the 23 SDK components, data = permission-checked olan.* calls.',
    '> Done = `npx olan-app validate --strict` and `npx olan-app test` both pass.',
    '',
  ];
  const parts = ORDER.map((name) => {
    const text = readFileSync(join(sdkDir, 'docs', `${name}.md`), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    return [`<!-- docs/${name}.md -->`, text, ''].join('\n');
  });
  const out = `${header.join('\n')}\n${parts.join('\n')}`;
  const lines = out.split('\n').length;
  if (lines > MAX_LINES) throw new Error(`llms.txt would have ${lines} lines (limit ${MAX_LINES}); shorten the docs`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(sdkDir, 'llms.txt');
  const next = buildLlms();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current !== next) {
      console.error('packages/app-sdk/llms.txt is out of date: run `node packages/app-cli/scripts/build-llms.mjs`');
      process.exit(1);
    }
    console.log('llms.txt is up to date');
  } else {
    writeFileSync(target, next);
    console.log(`wrote ${target} (${next.split('\n').length} lines)`);
  }
}

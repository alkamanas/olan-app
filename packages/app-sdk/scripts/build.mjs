/* global process, console */
// Bundles the entry points that run outside a bundler (an app's own Node server) into committed
// dist/: `@olan-app/sdk/server` → dist/server.js, `@olan-app/sdk/backend` → dist/backend.js. Types
// stay the TypeScript sources. `--check` fails when dist/ is stale (also a unit test).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRIES = { server: 'src/server/index.ts', backend: 'src/backend/index.ts' };

/** The bundled files as `{ 'server.js': text, … }`. */
export async function buildDist() {
  const out = {};
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const result = await build({
      entryPoints: [join(root, entry)],
      // Source path comments are relative to this; without it they follow the caller's cwd.
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
      // Type-only imports of @olan-app/schema are erased; nothing else may be imported.
      external: ['@olan-app/schema'],
      legalComments: 'none',
      logLevel: 'warning',
      banner: { js: `${name === 'server' ? '/* eslint-disable -- generated bundle */\n' : ''}// @olan-app/sdk/${name}: generated from ${entry} by scripts/build.mjs; do not edit.` },
    });
    out[`${name}.js`] = result.outputFiles[0].text.replace(/\r\n/g, '\n');
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await buildDist();
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [name, text] of Object.entries(files)) {
    const target = join(root, 'dist', name);
    if (check) {
      let current = '';
      try {
        current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
      } catch {
        // missing counts as stale
      }
      if (current !== text) stale.push(name);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  if (check && stale.length) {
    console.error(`packages/app-sdk/dist is out of date (${stale.join(', ')}): run \`npm run build\` in packages/app-sdk`);
    process.exit(1);
  }
  console.log(check ? 'dist/ is up to date' : `wrote ${Object.keys(files).map((name) => `dist/${name}`).join(', ')}`);
}

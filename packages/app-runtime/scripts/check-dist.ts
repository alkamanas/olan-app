/**
 * `dist/` is committed: the web (Turbopack) and the Platform server (Node ESM)
 * both consume the compiled JavaScript and declarations, so neither has to
 * resolve `./x.js` imports to TypeScript sources. This check rebuilds into a
 * temporary directory and fails when the committed output is stale.
 * Run from this package: `npm run check-dist`; refresh with `npm run build`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committed = resolve(packageRoot, 'dist');
const scratch = mkdtempSync(join(tmpdir(), 'olan-app-runtime-dist-'));

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).replace(/\\/g, '/'));
    }
  };
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return out;
}

const normalise = (text: string) => text.replace(/\r\n/g, '\n');

try {
  const tsc = resolve(packageRoot, '../../node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', resolve(packageRoot, 'tsconfig.build.json'), '--outDir', scratch], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  const expected = files(scratch);
  const actual = files(committed);
  const problems: string[] = [];
  for (const name of expected) {
    if (!actual.includes(name)) problems.push(`missing: dist/${name}`);
    else if (normalise(readFileSync(join(scratch, name), 'utf8')) !== normalise(readFileSync(join(committed, name), 'utf8'))) {
      problems.push(`stale: dist/${name}`);
    }
  }
  for (const name of actual) if (!expected.includes(name)) problems.push(`unexpected: dist/${name}`);
  if (problems.length) {
    console.error(`dist/ is out of date. Run: npm run build\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`dist/ is up to date (${expected.length} files).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

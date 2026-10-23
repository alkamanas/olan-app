import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('committed dist/', () => {
  it('matches a fresh build of src/ (run `npm run build` in packages/app-runtime when this fails)', () => {
    const tsx = resolve(packageRoot, '../../node_modules/tsx/dist/cli.mjs');
    const run = () => execFileSync(process.execPath, [tsx, resolve(packageRoot, 'scripts/check-dist.ts')], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(run).not.toThrow();
  }, 120_000);
});

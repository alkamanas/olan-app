import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The SDK's name before the `@olan-app` scope (formerly @olan/app-sdk); still accepted. */
const LEGACY_SDK_NAME = '@olan/app-sdk';

/**
 * The `@olan-app/cli` package directory. Works from the bundle (`dist/cli.js`) and from the
 * TypeScript sources (unit tests), by walking up to the package.json that names the package.
 */
export function cliPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@olan-app/cli') return dir;
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate the @olan-app/cli package directory');
    dir = parent;
  }
}

export function templatesDir(): string {
  return join(cliPackageDir(), 'src', 'templates');
}

/**
 * Finds `node_modules/<name>` from `fromDir` upwards (Node's lookup), without going through the
 * package's `exports` (which may not expose package.json). Returns the real path.
 */
export function findPackageDir(name: string, fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `@olan-app/sdk` for a project: the project's own dependency, else the copy next to this CLI
 * (the monorepo `packages/app-sdk`, or the CLI's own dependency).
 */
export function resolveSdkDir(projectDir: string): string | null {
  // Apps from before the rename may still install the SDK as `@olan/app-sdk` (same package).
  const own = findPackageDir('@olan-app/sdk', projectDir) ?? findPackageDir(LEGACY_SDK_NAME, projectDir);
  if (own) return own;
  const cliDir = cliPackageDir();
  const sibling = join(cliDir, '..', 'app-sdk');
  if (existsSync(join(sibling, 'package.json'))) return realpathSync(sibling);
  return findPackageDir('@olan-app/sdk', cliDir);
}

/** Project-relative path with forward slashes (for messages and JSON output). */
export function displayPath(projectDir: string, file: string): string {
  const rel = relative(projectDir, file);
  if (!rel || rel.startsWith('..')) return file.split(sep).join('/');
  return rel.split(sep).join('/');
}

/** Forward slashes, as used inside packages and in JSON output. */
export function toPosix(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scratch projects live inside the package so `@olan-app/sdk` resolves through the workspace. */
export const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');

export interface TempProject {
  dir: string;
  write(path: string, content: string | Uint8Array): void;
  remove(): void;
}

export function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      id: 'com.example.test-app',
      name: 'Test app',
      version: '0.1.0',
      sdk: '^1.0.0',
      entry: 'dist/app.js',
      surfaces: { app: { title: 'Test' } },
      permissions: ['projects:read'],
      ...overrides,
    },
    null,
    2,
  );
}

export function tempProject(name: string, files: Record<string, string | Uint8Array> = {}): TempProject {
  const dir = join(TMP_ROOT, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const write = (path: string, content: string | Uint8Array) => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  return { dir, write, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

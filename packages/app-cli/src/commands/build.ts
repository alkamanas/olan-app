import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { build, type Metafile } from 'esbuild';
import { MAX_PACKAGE_BYTES } from '@olan-app/schema';

import { backendBuildWarnings, buildBackend } from '../backend/build';
import { appBuildOptions, esbuildIssues, rethrowBuildFailure } from '../bundle';
import type { Command } from '../command';
import { issue, type Issue } from '../errors';
import { displayPath } from '../paths';
import { entryPath, loadManifest, requireProjectDir, WORK_DIR } from '../project';

export interface BuildResult {
  /** Project-relative path of the written bundle (the manifest `entry`). */
  entry: string;
  bytes: number;
  durationMs: number;
  /** First 12 hex digits of the bundle's SHA-256. */
  buildId: string;
  /** The biggest inputs, for "why is my bundle large". */
  largestInputs: { path: string; bytes: number }[];
  /** Manifest `server`: the backend bundle (`dist/server.js`), else null. */
  backend: { file: string; bytes: number; sha256: string } | null;
}

export function buildIdOf(code: Uint8Array | string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 12);
}

export function largestInputs(metafile: Metafile | undefined, projectDir: string, limit = 5): { path: string; bytes: number }[] {
  if (!metafile) return [];
  const output = Object.values(metafile.outputs)[0];
  const inputs = output ? Object.entries(output.inputs).map(([path, info]) => ({ path, bytes: info.bytesInOutput })) : [];
  return inputs
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((entry) => ({ path: displayPath(projectDir, join(projectDir, entry.path)), bytes: entry.bytes }));
}

/**
 * `olan-app build`: bundles `src/app.tsx` with the generated runtime entry into the manifest
 * `entry` (`dist/app.js`) as one minified classic script, and writes the esbuild metafile to
 * `.olan-app/metafile.json`. With a manifest `server` it also bundles `server.entry` into
 * `dist/server.js` (IIFE `__olanBackendModule`, no Node built-ins; Phase 3 §15.2).
 */
export async function buildApp(projectDir: string, options: { minify?: boolean } = {}): Promise<{ result: BuildResult; warnings: Issue[] }> {
  const started = performance.now();
  const loaded = loadManifest(projectDir);
  const warnings: Issue[] = [];
  if (!loaded.manifest) {
    warnings.push(issue('build.manifest_invalid', 'olan-app.json has errors; building to dist/app.js. Run `olan-app validate` for details.', { file: 'olan-app.json' }));
  }
  const entry = entryPath(loaded.manifest);
  const buildOptions = appBuildOptions({ projectDir, mode: 'production', minify: options.minify });
  let output;
  try {
    output = await build(buildOptions);
  } catch (error) {
    rethrowBuildFailure(projectDir, error);
  }
  warnings.push(...esbuildIssues(projectDir, output.warnings, 'build.warning'));
  const code = output.outputFiles?.[0]?.contents ?? new Uint8Array();
  const target = join(projectDir, entry);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
  const workDir = join(projectDir, WORK_DIR);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'metafile.json'), JSON.stringify(output.metafile ?? {}, null, 2));
  if (code.byteLength > MAX_PACKAGE_BYTES) {
    warnings.push(issue('build.too_large', `The bundle is ${code.byteLength} bytes; packages are limited to ${MAX_PACKAGE_BYTES} bytes`, { file: entry }));
  }
  let backend: BuildResult['backend'] = null;
  if (loaded.manifest?.server) {
    const built = await buildBackend(projectDir, loaded.manifest, { minify: options.minify ?? true });
    warnings.push(...backendBuildWarnings(projectDir, built));
    backend = { file: built.file, bytes: built.bytes, sha256: built.digest };
  }
  return {
    result: {
      entry,
      bytes: code.byteLength,
      durationMs: Math.round(performance.now() - started),
      buildId: buildIdOf(code),
      largestInputs: largestInputs(output.metafile, projectDir),
      backend,
    },
    warnings,
  };
}

export const buildCommand: Command = {
  name: 'build',
  summary: 'Bundle src/app.tsx into dist/app.js (and server.entry into dist/server.js)',
  usage: 'olan-app build [--no-minify]',
  options: ['--no-minify   Keep the bundle readable (debugging)'],
  spec: { booleans: ['minify'] },
  async run(args, context) {
    const projectDir = requireProjectDir(context.cwd);
    const { result, warnings } = await buildApp(projectDir, { minify: args.flags.minify === false ? false : undefined });
    return {
      result,
      warnings,
      human: [
        `Built ${result.entry} (${formatBytes(result.bytes)}, ${result.durationMs} ms, build ${result.buildId})`,
        ...(result.backend ? [`Built ${result.backend.file} (${formatBytes(result.backend.bytes)}, sha256 ${result.backend.sha256.slice(0, 12)})`] : []),
      ],
    };
  },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

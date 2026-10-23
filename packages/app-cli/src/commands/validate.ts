import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_PACKAGE_BYTES, MANIFEST_FILE } from '@olan-app/schema';

import { booleanFlag, stringFlag } from '../args';
import { BACKEND_BUNDLE } from '../backend/build';
import { backendHandlerIssues, inspectBackend } from '../backend/inspect';
import { backendEngineFlag, type BackendEngine } from '../backend/runner';
import type { Command } from '../command';
import { devKeyPath } from '../dev-key';
import { CliError, formatIssue, issue, type Issue } from '../errors';
import { entryPath, KEY_FILE, loadManifest, requireProjectDir } from '../project';
import { findingIssue, strictChecks, type StrictReview, type SurfaceReport } from '../strict';
import { typeCheck } from '../typescript';
import { buildApp, formatBytes } from './build';

export interface ValidateOptions {
  strict?: boolean;
  /** Build first (default `true`); `false` checks the existing bundle. */
  build?: boolean;
  /** Run `tsc --noEmit` when a tsconfig.json exists (default `true`). */
  typecheck?: boolean;
  /** Engine for the backend check (default `auto`). */
  engine?: BackendEngine;
  /** Engine notices (the QuickJS fallback). */
  onWarning?: (message: string) => void;
  /** Where the development key is looked up for the `validate.unsigned` hint (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface ValidateResult {
  app: { id: string; version: string } | null;
  strict: boolean;
  checks: { name: string; ok: boolean; skipped?: string }[];
  bundleBytes: number | null;
  surfaces: SurfaceReport[];
  /**
   * With strict: the Olan Marketplace's static review findings (every severity, info included) and the
   * permission usage, exactly as the marketplace computes them for this package.
   */
  review?: StrictReview | null;
  /** Manifest `server`: `dist/server.js` size, the engine that loaded it and its handler names. */
  backend?: { bytes: number; engine: string | null; handlers: { functions: string[]; schedules: string[]; events: string[]; hooks: string[]; migrate: boolean } | null };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Runs every check and collects all problems in one pass (an agent fixes them together):
 * manifest, build, entry and icon files, size, TypeScript and, with `strict`, a headless render of
 * every surface.
 */
export async function validateApp(projectDir: string, options: ValidateOptions = {}): Promise<{ result: ValidateResult; errors: Issue[]; warnings: Issue[] }> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const checks: ValidateResult['checks'] = [];
  const record = (name: string, found: Issue[], skipped?: string) => {
    checks.push(skipped ? { name, ok: true, skipped } : { name, ok: found.length === 0 });
    errors.push(...found);
  };

  const loaded = loadManifest(projectDir);
  record('manifest', loaded.issues);
  const manifest = loaded.manifest;
  const result: ValidateResult = {
    app: manifest ? { id: manifest.id, version: manifest.version } : null,
    strict: options.strict === true,
    checks,
    bundleBytes: null,
    surfaces: [],
  };
  if (manifest && manifest.kind === 'web-link') {
    record('build', [], 'web links have no bundle');
    return { result, errors, warnings };
  }

  // Build (or check the existing bundle).
  let built = false;
  if (options.build !== false) {
    try {
      const output = await buildApp(projectDir);
      warnings.push(...output.warnings.filter((item) => item.code !== 'build.manifest_invalid'));
      record('build', []);
      built = true;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      record('build', error.issues);
    }
  } else {
    record('build', [], 'skipped (--no-build)');
  }

  const entry = entryPath(manifest);
  const entryFile = join(projectDir, entry);
  const files: Issue[] = [];
  if (existsSync(entryFile)) {
    result.bundleBytes = statSync(entryFile).size;
    built = true;
  } else if (options.build === false || built) {
    files.push(issue('validate.entry_missing', `The entry ${entry} does not exist`, { file: MANIFEST_FILE, hint: 'Run `olan-app build` (or drop --no-build).' }));
  }
  if (manifest?.icon && !existsSync(join(projectDir, manifest.icon))) {
    files.push(issue('validate.icon_missing', `The icon ${manifest.icon} does not exist`, { file: MANIFEST_FILE, hint: 'Add the file (a square PNG or SVG, e.g. assets/icon.png) or remove "icon".' }));
  }
  record('files', files);

  const size: Issue[] = [];
  if (result.bundleBytes !== null && result.bundleBytes > MAX_PACKAGE_BYTES) {
    size.push(issue('validate.bundle_too_large', `${entry} is ${formatBytes(result.bundleBytes)}; the limit is ${formatBytes(MAX_PACKAGE_BYTES)}`, { file: entry, hint: 'Remove large dependencies (see `olan-app build --json` → largestInputs).' }));
  } else {
    const assets = filesUnder(join(projectDir, 'assets')).reduce((sum, file) => sum + statSync(file).size, 0);
    const total = (result.bundleBytes ?? 0) + assets;
    if (total > MAX_PACKAGE_BYTES) {
      size.push(issue('validate.package_too_large', `Bundle and assets are ${formatBytes(total)}; packages are limited to ${formatBytes(MAX_PACKAGE_BYTES)}`, { hint: 'Shrink or remove files under assets/.' }));
    }
  }
  record('size', size);

  // Backend (Phase 3 §15.1): dist/server.js loads in the runtime and every schedule, event and
  // hook resolves to a handler.
  if (manifest?.server) {
    const serverFile = join(projectDir, BACKEND_BUNDLE);
    if (!existsSync(serverFile)) {
      record('backend', [issue('validate.backend_missing', `${BACKEND_BUNDLE} does not exist`, { file: MANIFEST_FILE, hint: 'Run `olan-app build` (or drop --no-build).' })]);
    } else {
      const inspected = await inspectBackend(readFileSync(serverFile, 'utf8'), { engine: options.engine, onWarning: options.onWarning });
      const found = [...inspected.issues];
      if (inspected.shape) {
        const handlers = backendHandlerIssues(manifest.server, inspected.shape);
        found.push(...handlers.errors);
        warnings.push(...handlers.warnings);
      }
      record('backend', found);
      result.backend = { bytes: statSync(serverFile).size, engine: inspected.engine, handlers: inspected.shape };
    }
  }

  if (options.typecheck !== false) {
    const checked = typeCheck(projectDir);
    if (!checked.ran) {
      record('typescript', [], checked.skipped);
      if (checked.skipped?.startsWith('typescript is not installed')) warnings.push(issue('validate.typescript_missing', 'TypeScript is not installed; type errors are not checked', { hint: 'npm install -D typescript' }));
    } else {
      record('typescript', checked.issues);
    }
  }

  if (options.strict) {
    if (!manifest) record('strict', [], 'the manifest has errors');
    else if (!built) record('strict', [], 'the app does not build');
    else {
      const strict = await strictChecks(projectDir, manifest);
      record('strict', strict.errors);
      warnings.push(...strict.warnings);
      result.surfaces = strict.surfaces;
      result.review = strict.review;
    }
    // A plain `olan-app pack` without a key makes a package servers list but never install. This only
    // matters for organization catalog uploads (`publish --org`): the marketplace signs what it approves.
    if (manifest && manifest.kind !== 'web-link' && !existsSync(join(projectDir, KEY_FILE))) {
      const devKey = devKeyPath(options.env ?? process.env);
      warnings.push(issue('validate.unsigned', '`olan-app pack` will produce an unsigned package: fine for `olan-app publish --marketplace` (the marketplace signs approved versions); an organization catalog (`publish --org`) lists an unsigned package but does not install it', {
        hint: existsSync(devKey)
          ? `Marketplace submissions: nothing to do. For a local Olan that trusts your development key (${devKey}): \`olan-app pack --dev-sign\` signs the package with it; \`olan-app publish --org --dev-sign\` uploads it signed.`
          : 'Marketplace submissions: nothing to do. Organization catalogs: `olan-app publish --org --dev-sign` for a local Olan that trusts your development key (`olan-app keygen --dev` creates it, `olan-app pack --dev-sign` signs with it).',
      }));
    }
  }
  return { result, errors, warnings };
}

/** `3 functions, 1 schedule, 1 hook` for the human summary. */
function describeHandlers(handlers: { functions: string[]; schedules: string[]; events: string[]; hooks: string[]; migrate: boolean }): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [count(handlers.functions.length, 'function')];
  if (handlers.schedules.length) parts.push(count(handlers.schedules.length, 'schedule handler'));
  if (handlers.events.length) parts.push(count(handlers.events.length, 'event handler'));
  if (handlers.hooks.length) parts.push(count(handlers.hooks.length, 'hook handler'));
  if (handlers.migrate) parts.push('migrate');
  return parts.join(', ');
}

/** `0 errors, 2 warnings, 3 info (permissions used: …)` for the human summary. */
function reviewSummary(review: StrictReview): string {
  const count = (severity: string) => review.findings.filter((finding) => finding.severity === severity).length;
  const info = count('info');
  return `marketplace static checks: ${count('error')} errors, ${count('warning')} warnings, ${info} info${info ? ' (--verbose shows them)' : ''}`;
}

export const validateCommand: Command = {
  name: 'validate',
  summary: 'Check the manifest, build, size and types (--strict: also render every surface)',
  usage: 'olan-app validate [--strict [--verbose]] [--no-build] [--no-typecheck] [--engine auto|isolated-vm|quickjs] [--json]',
  options: [
    '--engine <name> Backend engine for the server check: auto (default), isolated-vm or quickjs',
    '--strict        Render every surface headlessly (component props, missing permissions) and run Olan',
    '                Marketplace\'s static review checks on the files `olan-app pack` would package: size, files,',
    '                forbidden APIs, permissions, accessibility, licenses (same findings as the marketplace)',
    '--verbose       With --strict, also print the info findings (--json always has them in result.review)',
    '--no-build      Check the existing dist/app.js instead of building',
    '--no-typecheck  Skip tsc --noEmit',
  ],
  spec: { booleans: ['strict', 'build', 'typecheck', 'verbose'], strings: ['engine'] },
  async run(args, context) {
    const projectDir = requireProjectDir(context.cwd);
    const notices: Issue[] = [];
    const { result, errors, warnings } = await validateApp(projectDir, {
      strict: booleanFlag(args, 'strict'),
      build: args.flags.build !== false,
      typecheck: args.flags.typecheck !== false,
      engine: backendEngineFlag(stringFlag(args, 'engine')),
      onWarning: (message) => notices.push(issue('backend.engine', message)),
      env: context.env,
    });
    warnings.push(...notices);
    if (errors.length > 0) throw new CliError(errors, { ...result, warnings });
    const human = [
      `${result.app?.id ?? 'app'} ${result.app?.version ?? ''}: ${result.strict ? 'strict ' : ''}validation passed`,
      ...result.checks.map((check) => `  ${check.ok ? 'ok' : 'FAIL'}  ${check.name}${check.skipped ? ` (${check.skipped})` : ''}`),
      ...(result.bundleBytes !== null ? [`  bundle ${formatBytes(result.bundleBytes)}`] : []),
      ...(result.backend ? [`  backend ${formatBytes(result.backend.bytes)} (${result.backend.engine ?? 'not loaded'}): ${result.backend.handlers ? describeHandlers(result.backend.handlers) : 'no handlers'}`] : []),
      ...result.surfaces.map((surface) => `  surface ${surface.surface}: ${surface.nodes} nodes, ${surface.calls.length} olan.* calls`),
      ...(result.review ? [`  review: ${reviewSummary(result.review)}`] : []),
      ...(result.review && booleanFlag(args, 'verbose')
        ? result.review.findings.filter((finding) => finding.severity === 'info').map((finding) => `  info ${formatIssue(findingIssue(finding)).replace(/\n/g, '\n  ')}`)
        : []),
    ];
    return { result, warnings, human };
  },
};

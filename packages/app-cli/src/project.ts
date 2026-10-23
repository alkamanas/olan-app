import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { MANIFEST_FILE, validateManifest, type ManifestIssue, type OlanAppManifest } from '@olan-app/schema';

import { CliError, issue, type Issue } from './errors';
import { locateJson, positionFor } from './json-locate';

/** The app source entry the CLI bundles (contract §5: the generated entry imports it). */
export const APP_SOURCE = 'src/app.tsx';
export const DEFAULT_ENTRY = 'dist/app.js';
/** Scratch directory for generated files (test bundles, metafile); listed in the template .gitignore. */
export const WORK_DIR = '.olan-app';
export const KEY_FILE = 'olan-app.key.json';

/**
 * The project directory: `start` or the nearest parent with an `olan-app.json`. Commands that
 * need a project fail with `project.not_found` when there is none.
 */
export function findProjectDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireProjectDir(start: string): string {
  const dir = findProjectDir(start);
  if (!dir) {
    throw new CliError(
      issue('project.not_found', `No ${MANIFEST_FILE} in ${resolve(start)} or its parents`, {
        hint: 'Run the command inside an app directory, pass --cwd <dir>, or create one with `olan-app init <name>`.',
      }),
    );
  }
  return dir;
}

export interface LoadedManifest {
  text: string;
  /** Raw parsed JSON (null when the text is not JSON). */
  raw: unknown;
  manifest: OlanAppManifest | null;
  issues: Issue[];
}

/** Converts schema issues into CLI issues with `olan-app.json` line numbers. */
export function manifestIssues(text: string, issues: ManifestIssue[]): Issue[] {
  const positions = locateJson(text);
  return issues.map((item) => {
    const position = positionFor(positions, item.path);
    return issue(item.code, item.path ? `${item.path}: ${item.message}` : item.message, {
      file: MANIFEST_FILE,
      line: position?.line,
      column: position?.column,
      hint: item.hint,
    });
  });
}

export function loadManifest(projectDir: string): LoadedManifest {
  const path = join(projectDir, MANIFEST_FILE);
  if (!existsSync(path)) {
    return {
      text: '',
      raw: null,
      manifest: null,
      issues: [issue('manifest.missing', `${MANIFEST_FILE} does not exist`, { file: MANIFEST_FILE, hint: 'Create it with `olan-app init` or copy one from the docs (manifest.md).' })],
    };
  }
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  // `server` (backend code) is on by default (Phase 3 §15.1); OLAN_APPS_BACKEND=0 mirrors a server that turned it off.
  const result = validateManifest(text, { backend: process.env.OLAN_APPS_BACKEND !== '0' });
  if (result.ok) return { text, raw, manifest: result.manifest, issues: [] };
  return { text, raw, manifest: null, issues: manifestIssues(text, result.issues) };
}

/** Loads and validates the manifest; throws the manifest issues when it is invalid. */
export function requireManifest(projectDir: string): OlanAppManifest {
  const loaded = loadManifest(projectDir);
  if (!loaded.manifest) throw new CliError(loaded.issues);
  return loaded.manifest;
}

/** `entry` of an app manifest (`dist/app.js` when missing, e.g. for a manifest with errors). */
export function entryPath(manifest: Pick<OlanAppManifest, 'entry'> | null | undefined): string {
  return manifest?.entry ?? DEFAULT_ENTRY;
}

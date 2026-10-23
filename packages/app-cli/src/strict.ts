import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  DIGEST_FILE,
  dedupeFindings,
  isHttpUrlAllowed,
  isRpcMethod,
  lintUiTree,
  methodAllowed,
  REQUIRED_PERMISSION,
  reviewPermissions,
  runStaticReviewChecks,
  scanPackageUsage,
  sortFindings,
  urlPermissionHost,
  validateTree,
  type OlanAppManifest,
  type ReviewFinding,
  type ReviewUsage,
  type Surface,
  type TreeIssue,
} from '@olan-app/schema';
import type { NodeId, UiNode } from '@olan-app/sdk/protocol';

import { collectPackageFiles, packageMetaFile, zipPackage } from './commands/pack';
import { CliError, issue, type Issue } from './errors';
import { dbFixtureIssues, loadProjectFixtures } from './mock-server';
import { templatesDir, toPosix } from './paths';
import { APP_SOURCE, entryPath } from './project';
import { renderApp } from './testing';
import { bundleForTest, evaluateApp } from './testing/sandbox';

/** Surfaces drawn as a whole screen or tab: their root should be `<Screen>` (Phase 6 adds the project tab and settings). */
const SCREEN_SURFACES: ReadonlySet<string> = new Set(['app', 'settings', 'project.tab', 'project.settings']);

export interface SurfaceReport {
  surface: Surface;
  rendered: boolean;
  nodes: number;
  calls: { method: string; ok: boolean; code?: string }[];
  text: string;
}

const TREE_HINTS: Record<string, string> = {
  'tree.unknown_type': 'Use only the components exported by @olan-app/sdk (docs/components.md); DOM elements like <div> do not exist.',
  'tree.unknown_prop': 'Remove the prop; components accept only the props listed in docs/components.md (no style, className, color).',
  'tree.invalid_prop': 'Check the allowed values in docs/components.md.',
  'tree.text_outside_text': 'Wrap strings in <Text>…</Text> (or pass text="…"); strings cannot be direct children of layout components.',
  'tree.children_not_allowed': 'Only Screen, Stack, Form and Card take children; Text takes text only.',
  'tree.text_invalid': 'Text nodes carry a single string.',
};

const SANDBOX_GLOBALS = /\b(fetch|document|window|localStorage|sessionStorage|XMLHttpRequest|WebSocket|navigator|process|require) is not defined/;

/** "Screen > Stack > Button "Kaydet"" — where a node sits, for messages. */
function nodePath(nodes: Map<NodeId, UiNode>, parents: Map<NodeId, NodeId>, id: NodeId): string {
  const parts: string[] = [];
  let current: NodeId | undefined = id;
  while (current !== undefined && parts.length < 12) {
    const node = nodes.get(current);
    if (!node) break;
    const label = typeof node.props.label === 'string' ? node.props.label : typeof node.props.title === 'string' ? node.props.title : typeof node.props.text === 'string' ? node.props.text : '';
    parts.unshift(label ? `${node.type} "${label.slice(0, 40)}"` : node.type);
    current = parents.get(current);
  }
  return parts.join(' > ');
}

/** `permissions.missing` messages name the permission as `the "<permission>" permission`. */
const NEEDED_PERMISSION = /"([^"]+)" permission/;
/** Key of the `data`-without-`db` issue (the review reports it at `olan-app.json#data`). */
const DATA_WITHOUT_DB = 'db#data';

/**
 * A review finding as a CLI issue: `path` `file#line:column` (or `file#field`) becomes the location;
 * accessibility findings (whose path is the surface) point to the app source.
 */
export function findingIssue(finding: ReviewFinding): Issue {
  if (finding.check === 'accessibility') {
    return issue(finding.code, `${finding.path ? `${finding.path}: ` : ''}${finding.message}`, { file: APP_SOURCE, hint: finding.hint, rule: finding.rule });
  }
  const [file, at] = (finding.path ?? '').split('#');
  const position = at ? /^(\d+):(\d+)$/.exec(at) : null;
  return issue(finding.code, finding.message, {
    file: file || undefined,
    line: position ? Number(position[1]) : undefined,
    column: position ? Number(position[2]) : undefined,
    hint: finding.hint,
    rule: finding.rule,
  });
}

export interface StrictReview {
  /** Every finding of the marketplace's static checks, info included, sorted like the marketplace's report. */
  findings: ReviewFinding[];
  usage: ReviewUsage;
}

/**
 * The marketplace's automatic checks that need no review sandbox, on the files `olan-app pack` would
 * package (contract §22): `runStaticReviewChecks` (size, files, forbidden APIs, licenses) and
 * `reviewPermissions` over the bundle's static usage merged with the `olan.*` calls the surfaces made,
 * plus the accessibility lint of the rendered trees. Same functions and inputs as the marketplace.
 */
export function reviewPackage(
  projectDir: string,
  manifest: OlanAppManifest,
  run: { rpcMethods: readonly string[]; fetchedHosts: readonly string[]; accessibility: readonly ReviewFinding[] },
): StrictReview {
  const { files, digest } = collectPackageFiles(projectDir, manifest);
  const archive = zipPackage(files, digest, null);
  const packaged: Record<string, Uint8Array> = { ...Object.fromEntries(files), [DIGEST_FILE]: packageMetaFile(digest) };
  const statics = runStaticReviewChecks({ manifest, files: packaged, sizeBytes: archive.byteLength });
  const entry = entryPath(manifest);
  // The entry and, with `server`, the backend bundle (dist/server.js): backend-only permissions are used.
  const scanned = scanPackageUsage(manifest, packaged);
  const permissions = reviewPermissions({
    manifest,
    rpcMethods: [...scanned.rpcMethods, ...run.rpcMethods],
    urlHosts: scanned.urlHosts,
    fetchedHosts: run.fetchedHosts,
    path: entry,
    server: scanned.server,
  });
  const findings = sortFindings(dedupeFindings([...statics.findings.filter((finding) => finding.check !== 'permissions'), ...run.accessibility, ...permissions.findings]));
  return { findings, usage: permissions.usage };
}

/**
 * Calls that usually run in handlers (so a render does not reach them), found in the source:
 * `[pattern, method, what]`. `methodAllowed` decides whether the manifest permissions cover them.
 */
const SOURCE_CALLS: [RegExp, string, string][] = [
  [/\bolan\.db\b|\buseCollection\s*[<(]|\buseRecord\s*[<(]/, 'db.query', 'olan.db'],
  [/\.createTask\s*\(/, 'projects.createTask', 'olan.projects.createTask'],
  [/\.updateTask\s*\(/, 'projects.updateTask', 'olan.projects.updateTask'],
  [/\.deleteTask\s*\(/, 'projects.deleteTask', 'olan.projects.deleteTask'],
  [/\.deleteList\s*\(/, 'projects.deleteList', 'olan.projects.deleteList'],
  [/\bolan\.files\.(?:pick|upload)\s*\(/, 'files.pick', 'olan.files'],
];

/** `olan.remote.request` needs the manifest `remote` with `"requests": true` (no permission to list). */
/** Key of the remote.request-without-requests issue (no review finding claims it). */
const REMOTE_REQUESTS_KEY = 'remote:requests';
const REMOTE_REQUEST_CALL = /\bolan\.remote\.request\s*\(/;
const REMOTE_REQUESTS_HINT = 'Add "requests": true to "remote" in olan-app.json ("remote": { "url": "https://…", "jwksUrl": "https://…", "requests": true }).';

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && /\.(tsx?|mts|jsx?)$/.test(entry.name)) out.push(path);
  }
  return out;
}

let templateDescriptionCache: Set<string> | null = null;

/** The `description` of every `olan-app init` template, so a description left unchanged is noticed. */
function templateDescriptions(): Set<string> {
  if (templateDescriptionCache) return templateDescriptionCache;
  const found = new Set<string>();
  const dir = templatesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name, 'olan-app.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      try {
        const text = (JSON.parse(readFileSync(file, 'utf8')) as { description?: unknown }).description;
        if (typeof text === 'string' && text.trim()) found.add(text.trim());
      } catch {
        // A template manifest is JSON with placeholders; skip one that does not parse.
      }
    }
  }
  templateDescriptionCache = found;
  return found;
}

/**
 * Write, delete and `olan.db` calls in `src/` whose permission the manifest lacks
 * (`permission.missing`, one per permission, at the first use), plus `data` without `db`.
 */
export function sourcePermissionIssues(projectDir: string, manifest: OlanAppManifest): { issues: Issue[]; permissions: Set<string>; byPermission: Map<string, Issue> } {
  const issues: Issue[] = [];
  const reported = new Set<string>();
  const byPermission = new Map<string, Issue>();
  if (manifest.data && !manifest.permissions.includes('db')) {
    reported.add('db');
    const item = issue('permission.missing', 'İzin eksik: olan-app.json declares "data" (an app database) but not the "db" permission', { file: 'olan-app.json', hint: 'Add "db" to "permissions" (or remove "data").' });
    issues.push(item);
    byPermission.set(DATA_WITHOUT_DB, item);
  }
  for (const path of sourceFiles(join(projectDir, 'src'))) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '').trim();
      if (!code || code.startsWith('*') || code.startsWith('/*')) return;
      if (REMOTE_REQUEST_CALL.test(code) && manifest.remote?.requests !== true && !reported.has(REMOTE_REQUESTS_KEY)) {
        reported.add(REMOTE_REQUESTS_KEY);
        const item = issue('permission.missing', 'İzin eksik: olan.remote.request needs "remote" with "requests": true in olan-app.json', { file: toPosix(relative(projectDir, path)), line: index + 1, hint: REMOTE_REQUESTS_HINT });
        issues.push(item);
        // No review finding claims this key, so the issue is always reported.
        byPermission.set(REMOTE_REQUESTS_KEY, item);
      }
      for (const [pattern, method, what] of SOURCE_CALLS) {
        if (!pattern.test(code) || methodAllowed(method, manifest.permissions)) continue;
        const needed = REQUIRED_PERMISSION[method]!;
        if (reported.has(needed)) continue;
        reported.add(needed);
        const item = issue('permission.missing', `İzin eksik: ${what} needs "${needed}"`, {
          file: toPosix(relative(projectDir, path)),
          line: index + 1,
          hint: `Add "${needed}" to "permissions" in olan-app.json.`,
        });
        issues.push(item);
        byPermission.set(needed, item);
      }
    });
  }
  return { issues, permissions: reported, byPermission };
}

/** Surfaces the app module defines (`defineApp({ ... })` keys), or an issue when it does not load. */
export async function definedSurfaces(projectDir: string): Promise<{ surfaces: string[]; issues: Issue[] }> {
  const code = await bundleForTest(projectDir);
  let sandbox;
  try {
    sandbox = evaluateApp(code);
  } catch (error) {
    return { surfaces: [], issues: [issue('runtime.load_failed', `src/app.tsx threw while loading: ${error instanceof Error ? error.message : String(error)}`, { file: APP_SOURCE })] };
  }
  try {
    const app = sandbox.app as { $olanApp?: unknown; surfaces?: Record<string, unknown> } | undefined;
    if (!app || app.$olanApp !== 1 || !app.surfaces) {
      return { surfaces: [], issues: [issue('app.default_export', 'src/app.tsx does not export an app definition', { file: APP_SOURCE, hint: 'End the file with `export default defineApp({ app: MyScreen })`.' })] };
    }
    return { surfaces: Object.keys(app.surfaces), issues: [] };
  } finally {
    sandbox.dispose();
  }
}


export interface StrictResult {
  errors: Issue[];
  warnings: Issue[];
  surfaces: SurfaceReport[];
  /** The marketplace's static review findings (null when the app did not load or could not be packaged). */
  review: StrictReview | null;
}

/**
 * `validate --strict`: renders every declared surface against the mock server with the default
 * fixtures (and the project's `fixtures/`), validates the first tree against the component
 * schemas, then runs the marketplace's static review checks on the files `olan-app pack` would
 * package (`reviewPackage`: size, files, forbidden APIs, licenses, permissions merged with the calls
 * the surfaces made, accessibility of the rendered trees). Error findings are errors, warnings are
 * warnings, info findings are only in `review` (`--verbose` prints them).
 */
export async function strictChecks(projectDir: string, manifest: OlanAppManifest): Promise<StrictResult> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const reports: SurfaceReport[] = [];
  const declared = Object.keys(manifest.surfaces ?? {}) as Surface[];
  const defined = await definedSurfaces(projectDir);
  errors.push(...defined.issues);
  if (defined.issues.length > 0) return { errors, warnings, surfaces: reports, review: null };

  // Permissions the source needs (writes run in handlers, which a render does not reach).
  const fromSource = sourcePermissionIssues(projectDir, manifest);
  // fixtures/db.json must match the manifest `data`; with bad rows, render on an empty database.
  let dbOverride: { db: Record<string, never[]> } | undefined;
  try {
    const dbIssues = dbFixtureIssues(manifest.data, loadProjectFixtures(projectDir).db);
    if (dbIssues.length > 0) {
      errors.push(...dbIssues);
      dbOverride = { db: {} };
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    errors.push(...fromSource.issues, ...error.issues);
    return { errors, warnings, surfaces: reports, review: null };
  }

  for (const surface of declared) {
    if (!defined.surfaces.includes(surface)) {
      errors.push(issue('app.surface_missing', `olan-app.json declares the "${surface}" surface but defineApp() does not define it`, { file: APP_SOURCE, hint: `Add it: defineApp({ ${JSON.stringify(surface)}: MyComponent }) or remove it from "surfaces".` }));
    }
  }
  for (const surface of defined.surfaces) {
    if (!declared.includes(surface as Surface)) {
      warnings.push(issue('app.surface_undeclared', `defineApp() defines "${surface}" but olan-app.json does not declare it, so Olan never opens it`, { file: 'olan-app.json', hint: `Add "${surface}": { "title": "…" } to "surfaces".` }));
    }
  }

  const description = manifest.description?.trim();
  if (description && templateDescriptions().has(description)) {
    warnings.push(issue('manifest.description_template', `"description" is still the template's ("${description}")`, {
      file: 'olan-app.json',
      hint: 'Describe what your app does in one sentence: Olan and the marketplace store page show it.',
    }));
  }

  // What the review checks merge in: UI calls (the marketplace runs no backend), fetched hosts, rendered trees.
  const rpcMethods = new Set<string>();
  const fetchedHosts = new Set<string>();
  const accessibility: ReviewFinding[] = [];
  for (const surface of declared) {
    if (!defined.surfaces.includes(surface)) continue;
    let app;
    try {
      app = await renderApp({ root: projectDir, surface, allowErrors: true, ...(dbOverride ? { fixtures: dbOverride } : {}) });
    } catch (error) {
      errors.push(issue('runtime.render_failed', `The ${surface} surface could not be rendered: ${error instanceof Error ? error.message : String(error)}`, { file: APP_SOURCE }));
      reports.push({ surface, rendered: false, nodes: 0, calls: [], text: '' });
      continue;
    }
    try {
      for (const entry of app.errors()) {
        const global = SANDBOX_GLOBALS.exec(entry.message);
        errors.push(
          issue('runtime.error', `${surface}: ${entry.fatal ? 'fatal ' : ''}error while rendering: ${entry.message}`, {
            file: APP_SOURCE,
            hint: global ? `"${global[1]}" does not exist in the Olan sandbox; use olan.* APIs (olan.http.fetch, olan.storage) and SDK components instead.` : undefined,
          }),
        );
      }
      const nodes = app.tree();
      const table = new Map(nodes.map((node) => [node.id, node]));
      const parents = new Map<NodeId, NodeId>();
      for (const node of nodes) for (const child of node.children) parents.set(child, node.id);
      const describe = (id: NodeId) => nodePath(table, parents, id);
      if (nodes.length === 0) {
        warnings.push(issue('ui.empty_tree', `${surface}: the surface rendered nothing with the default fixtures`, { file: APP_SOURCE }));
      } else {
        const tree = validateTree(table, nodes[0]!.id);
        for (const problem of tree.issues as TreeIssue[]) {
          errors.push(issue(problem.code, `${surface}: ${problem.message}${problem.path ? ` (prop ${problem.path})` : ''} at ${describe(problem.nodeId)}`, { file: APP_SOURCE, hint: TREE_HINTS[problem.code] }));
        }
        accessibility.push(...lintUiTree(nodes, surface));
        if (SCREEN_SURFACES.has(surface) && nodes[0]!.type !== 'Screen') {
          warnings.push(issue('ui.root_not_screen', `${surface}: the root is ${nodes[0]!.type}; full-screen surfaces should start with <Screen>`, { file: APP_SOURCE }));
        }
      }
      const reported = new Set<string>();
      for (const call of app.calls()) {
        const params = call.params as { url?: unknown } | null;
        const url = typeof params?.url === 'string' ? params.url : '';
        if (call.source !== 'backend' && isRpcMethod(call.method)) {
          rpcMethods.add(call.method);
          const host = call.method === 'http.fetch' ? urlPermissionHost(url) : null;
          if (host) fetchedHosts.add(host);
        }
        if (call.ok || !call.error) continue;
        const key = `${call.source ?? 'ui'}:${call.method}:${call.error.code}`;
        if (reported.has(key)) continue;
        reported.add(key);
        if (call.error.code === 'permission_denied' && call.source === 'backend') {
          // UI calls are judged by the review's permission check below; the review runs no backend.
          const needed = /needs the (\S+) permission/.exec(call.error.message)?.[1] ?? 'a permission';
          if (fromSource.permissions.has(needed)) continue;
          errors.push(issue('permission.missing', `İzin eksik: ${surface} (backend) calls olan.${call.method} which needs "${needed}"`, { file: 'olan-app.json', hint: `Add "${needed}" to "permissions" in olan-app.json.` }));
        } else if (call.method === 'remote.request' && call.error.code === 'permission_denied') {
          if (!fromSource.permissions.has(REMOTE_REQUESTS_KEY)) {
            errors.push(issue('permission.missing', `İzin eksik: ${surface} calls olan.remote.request, which needs "remote" with "requests": true`, { file: 'olan-app.json', hint: REMOTE_REQUESTS_HINT }));
          }
        } else if (call.method === 'remote.request' && call.error.code === 'remote_unavailable' && /^No app server/.test(call.error.message)) {
          const request = (call.params ?? {}) as { method?: unknown; path?: unknown };
          const route = `${String(request.method)} ${String(request.path)}`;
          warnings.push(issue('fixtures.remote_missing', `${surface}: no fixtures/remote.json answer for ${route}`, { file: 'fixtures/remote.json', hint: `Add { "${route}": { "status": 200, "body": { … } } } to fixtures/remote.json so headless runs get an answer (tests: renderApp({ remote })).` }));
        } else if (call.error.code === 'http_blocked' && isHttpUrlAllowed(url, manifest.permissions)) {
          warnings.push(issue('fixtures.http_missing', `${surface}: no HTTP fixture for ${url}`, { file: 'fixtures/http.json', hint: `Add { "${url}": { "status": 200, "json": { … } } } to fixtures/http.json so headless runs get a response.` }));
        } else if (call.error.code === 'unknown_method') {
          errors.push(issue('runtime.unknown_method', `${call.source === 'backend' ? `${surface} (backend)` : surface}: ${call.error.message}`, { file: APP_SOURCE }));
        }
      }
      reports.push({
        surface,
        rendered: true,
        nodes: nodes.length,
        calls: app.calls().map((call) => (call.ok ? { method: call.method, ok: true } : { method: call.method, ok: false, code: call.error?.code })),
        text: app.text(),
      });
    } finally {
      await app.dispose();
    }
  }

  let review: StrictReview | null = null;
  try {
    review = reviewPackage(projectDir, manifest, { rpcMethods: [...rpcMethods], fetchedHosts: [...fetchedHosts], accessibility });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    errors.push(...error.issues);
  }
  // A permission the source scan found missing keeps its file:line on the review's finding.
  const unmatched = new Map(fromSource.byPermission);
  for (const finding of review?.findings ?? []) {
    if (finding.severity === 'info') continue;
    const item = findingIssue(finding);
    const needed = finding.code !== 'permissions.missing' ? undefined : finding.path === 'olan-app.json#data' ? DATA_WITHOUT_DB : NEEDED_PERMISSION.exec(finding.message)?.[1];
    const located = needed ? unmatched.get(needed) : undefined;
    if (needed && located) {
      unmatched.delete(needed);
      item.file = located.file;
      if (located.line !== undefined) item.line = located.line;
      else delete item.line;
      delete item.column;
    }
    (finding.severity === 'error' ? errors : warnings).push(item);
  }
  const remaining = new Set(unmatched.values());
  errors.push(...fromSource.issues.filter((item) => remaining.has(item)));
  return { errors, warnings, surfaces: reports, review };
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { build, type Plugin } from 'esbuild';
import type { OlanAppManifest } from '@olan-app/schema';

import { esbuildIssues } from '../bundle';
import { CliError, issue, type Issue } from '../errors';
import { CLI_PACKAGE, SDK_ROOT, packageAliasPlugin } from '../package-aliases';
import { displayPath, resolveSdkDir } from '../paths';

/** Where `olan-app build` writes the backend bundle (Phase 3 §15.2); packed and signed with the app. */
export const BACKEND_BUNDLE = 'dist/server.js';
/** The IIFE global the runtime reads the module from (`__olanBackendModule.default`). */
export const BACKEND_GLOBAL = '__olanBackendModule';

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
/** Packages that need Node or a DOM and can never load in the backend sandbox. */
const NODE_ONLY = /^(?:node-fetch|undici|axios|ws|pg|mysql2?|sqlite3|better-sqlite3|redis|ioredis|mongodb|express|fastify|koa|dotenv|fs-extra|react-dom)(?:\/.*)?$/;
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: SDK_ROOT, reason: 'Backend code imports "@olan-app/sdk/backend" (defineBackend, olan); the UI SDK does not run on the server.' },
  { pattern: /^@olan(?:-app\/sdk|\/app-sdk)\/(?!backend$).+/, reason: 'Backend code may only import "@olan-app/sdk/backend" from the SDK.' },
  { pattern: CLI_PACKAGE, reason: '@olan-app/cli is a development tool; import it only from tests/.' },
  { pattern: /^react(\/.*)?$|^react-reconciler(\/.*)?$/, reason: 'Backend code has no UI; keep React in src/app.tsx.' },
];

export interface BackendBuildResult {
  /** `dist/server.js`. */
  file: string;
  bytes: number;
  /** SHA-256 hex of the bundle (the runtime's `digest`). */
  digest: string;
  /** The bundle text (also written to `file` unless `write: false`). */
  code: string;
}

/**
 * Rejects Node built-ins and Node-only packages: the backend runs in an isolated V8/QuickJS sandbox
 * with ES built-ins, `console`, `setTimeout` and `olan.*` only (no `fs`, `net`, `process`, `fetch`).
 */
function backendImportsPlugin(sdkDir: string | null): Plugin {
  return {
    name: 'olan-backend-imports',
    setup(buildApi) {
      // The project's SDK (or the one next to this CLI): the same copy the UI bundle uses.
      if (sdkDir) buildApi.onResolve({ filter: /^@olan(?:-app\/sdk|\/app-sdk)\/backend$/ }, () => ({ path: join(sdkDir, 'dist', 'backend.js') }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const forbidden = FORBIDDEN.find((entry) => entry.pattern.test(args.path));
        if (forbidden && !args.importer.includes('node_modules')) {
          return { errors: [{ text: `"${args.path}" cannot be imported in backend code. ${forbidden.reason}`, detail: 'build.backend_forbidden_import' }] };
        }
        if (NODE_BUILTINS.has(args.path) || args.path.startsWith('node:') || NODE_ONLY.test(args.path)) {
          const via = args.importer.includes('node_modules') ? ` (imported by ${args.importer.replace(/\\/g, '/').split('/node_modules/').pop()})` : '';
          return {
            errors: [
              {
                text: `"${args.path}"${via} is a Node.js module; backend code runs in Olan's sandbox without Node APIs. Use olan.http.fetch for network, olan.db for storage and olan.secrets for credentials.`,
                detail: 'build.backend_node_import',
              },
            ],
          };
        }
        return undefined;
      });
    },
  };
}

/**
 * Bundles `server.entry` into `dist/server.js` (Phase 3 §15.2): an esbuild IIFE with
 * `globalName: '__olanBackendModule'`, platform neutral, ES2022, `@olan-app/sdk/backend` bundled
 * in. The module's `default` export must be `defineBackend({ ... })`.
 */
export async function buildBackend(projectDir: string, manifest: Pick<OlanAppManifest, 'server'>, options: { write?: boolean; minify?: boolean } = {}): Promise<BackendBuildResult> {
  const server = manifest.server;
  if (!server) throw new CliError(issue('build.backend_missing', 'olan-app.json declares no "server"', { file: 'olan-app.json' }));
  const entryFile = resolve(projectDir, server.entry);
  if (!existsSync(entryFile)) {
    throw new CliError(issue('build.backend_entry_missing', `server.entry ${server.entry} does not exist`, { file: 'olan-app.json', hint: 'Create it with `export default defineBackend({ functions: { … } })` from "@olan-app/sdk/backend".' }));
  }
  const sdkDir = resolveSdkDir(projectDir);
  let output;
  try {
    output = await build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: BACKEND_GLOBAL,
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['import', 'default'],
      minify: options.minify ?? false,
      define: { 'process.env.NODE_ENV': '"production"' },
      // Keep bundled dependencies' license notices (guideline 6.1, contract decision 6).
      legalComments: 'eof',
      logLevel: 'silent',
      absWorkingDir: projectDir,
      plugins: [backendImportsPlugin(sdkDir), packageAliasPlugin(sdkDir)],
    });
  } catch (error) {
    const messages = (error as { errors?: Parameters<typeof esbuildIssues>[1] }).errors;
    if (!messages) throw error;
    throw new CliError(esbuildIssues(projectDir, messages, 'build.backend_error').map((item) => (item.file === 'src/app.tsx' ? { ...item, file: server.entry } : item)));
  }
  const code = output.outputFiles[0]?.text ?? '';
  const result: BackendBuildResult = {
    file: BACKEND_BUNDLE,
    bytes: Buffer.byteLength(code),
    digest: createHash('sha256').update(code).digest('hex'),
    code,
  };
  if (options.write !== false) {
    const target = join(projectDir, BACKEND_BUNDLE);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
  }
  return result;
}

/** Warnings for a fresh backend bundle (size). */
export function backendBuildWarnings(projectDir: string, result: BackendBuildResult): Issue[] {
  const limit = 1024 * 1024;
  return result.bytes > limit
    ? [issue('build.backend_large', `${displayPath(projectDir, join(projectDir, result.file))} is ${result.bytes} bytes; large backends load slowly on every new sandbox`, { file: result.file })]
    : [];
}

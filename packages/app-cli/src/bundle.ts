import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

import type { BuildOptions, Message, Plugin } from 'esbuild';

import { CliError, issue, type Issue } from './errors';
import { CLI_PACKAGE, packageAliasPlugin } from './package-aliases';
import { displayPath, resolveSdkDir, toPosix } from './paths';
import { APP_SOURCE } from './project';

/** Packages that must exist exactly once in a bundle (hooks break with two React copies). */
const SINGLETONS = /^(react|react-reconciler|scheduler)(\/.*)?$/;
/** Imports an app can never use: the sandbox has no DOM, no React Native, no Node. */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /^react-dom(\/.*)?$/, reason: 'Olan apps do not render to the DOM; use the components from @olan-app/sdk.' },
  { pattern: /^react-native(\/.*)?$/, reason: 'Olan apps do not use React Native; use the components from @olan-app/sdk.' },
  { pattern: CLI_PACKAGE, reason: '@olan-app/cli is a development tool; import it only from tests/.' },
];
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export type BundleMode = 'production' | 'test';

export interface AppBundleOptions {
  projectDir: string;
  mode: BundleMode;
  /** Minify (production default `true`). */
  minify?: boolean;
  /** Project-relative app module (default `src/app.tsx`; only the test harness changes it). */
  appSource?: string;
}

/**
 * The generated entry (contract §5). In production it starts the runtime on the Worker transport;
 * the test harness exposes the app definition and a starter for its in-memory transport instead.
 */
export function entrySource(appFile: string, mode: BundleMode): string {
  const app = JSON.stringify(toPosix(appFile));
  if (mode === 'production') {
    return `import app from ${app};\nimport { startRuntime, workerTransport } from '@olan-app/sdk/runtime';\nstartRuntime(workerTransport(), app);\n`;
  }
  return [
    `import app from ${app};`,
    `import { startRuntime } from '@olan-app/sdk/runtime';`,
    `globalThis.__olanApp = app;`,
    `globalThis.__olanStartRuntime = (transport) => startRuntime(transport, app, { captureGlobalErrors: false });`,
    '',
  ].join('\n');
}

/** Resolves React and the reconciler from the SDK's location, so app and SDK share one copy. */
function singletonPlugin(sdkDir: string): Plugin {
  return {
    name: 'olan-react-singleton',
    setup(build) {
      build.onResolve({ filter: SINGLETONS }, async (args) => {
        if (args.pluginData?.olanSingleton) return undefined;
        const result = await build.resolve(args.path, { kind: args.kind, resolveDir: sdkDir, pluginData: { olanSingleton: true } });
        if (result.errors.length > 0) return { errors: result.errors };
        return { path: result.path, external: result.external, sideEffects: result.sideEffects, namespace: result.namespace };
      });
    },
  };
}

function forbiddenImportsPlugin(): Plugin {
  return {
    name: 'olan-forbidden-imports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const forbidden = FORBIDDEN.find((entry) => entry.pattern.test(args.path));
        const reason = forbidden?.reason ?? (NODE_BUILTINS.has(args.path) ? 'The app runs in a sandboxed worker without Node APIs; use olan.* for storage and network.' : null);
        if (!reason) return undefined;
        // Only the app's own files are checked; dependencies are trusted to be browser-safe.
        if (args.importer.includes('node_modules')) return undefined;
        return { errors: [{ text: `"${args.path}" cannot be imported in an Olan app. ${reason}`, detail: 'build.forbidden_import' }] };
      });
    },
  };
}

/** esbuild options for an app bundle (contract §5: classic script, React and SDK inside). */
export function appBuildOptions(options: AppBundleOptions): BuildOptions {
  const { projectDir, mode } = options;
  const appSource = options.appSource ?? APP_SOURCE;
  const appFile = resolve(projectDir, appSource);
  if (!existsSync(appFile)) {
    throw new CliError(issue('build.entry_missing', `${appSource} does not exist`, { file: appSource, hint: 'The CLI bundles src/app.tsx; it must `export default defineApp({ ... })`.' }));
  }
  const sdkDir = resolveSdkDir(projectDir);
  if (!sdkDir) {
    throw new CliError(issue('build.sdk_missing', '@olan-app/sdk is not installed', { hint: 'Run `npm install` in the app directory.' }));
  }
  return {
    stdin: { contents: entrySource(appFile, mode), resolveDir: projectDir, sourcefile: 'olan-app-entry.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: options.minify ?? mode === 'production',
    define: { 'process.env.NODE_ENV': '"production"' },
    external: [],
    // License notices of bundled code (React, MIT) go to the end of the file: the marketplace's
    // licenses check (guideline 6.1) reads them (contract decision 6).
    legalComments: 'eof',
    logLevel: 'silent',
    metafile: true,
    write: false,
    absWorkingDir: projectDir,
    plugins: [forbiddenImportsPlugin(), packageAliasPlugin(sdkDir), singletonPlugin(sdkDir)],
  };
}

/** Maps esbuild messages to CLI issues with project-relative locations. */
export function esbuildIssues(projectDir: string, messages: readonly Message[], code = 'build.error'): Issue[] {
  return messages.map((message) => {
    const detailCode = typeof message.detail === 'string' && message.detail.startsWith('build.') ? message.detail : code;
    const location = message.location;
    const file = location?.file ? displayPath(projectDir, join(projectDir, location.file)) : undefined;
    return issue(detailCode, message.text, {
      file: file === 'olan-app-entry.js' ? APP_SOURCE : file,
      line: location?.line,
      column: location ? location.column + 1 : undefined,
      hint: hintFor(message.text, detailCode),
    });
  });
}

function hintFor(text: string, code: string): string | undefined {
  if (code === 'build.forbidden_import') return 'Remove the import; see the component list in node_modules/@olan-app/sdk/docs/components.md.';
  if (/No matching export in ".*olan-app-entry|No matching export.*default/.test(text)) return 'src/app.tsx must `export default defineApp({ app: MyScreen })`.';
  if (/Could not resolve "@olan(-app\/sdk|\/app-sdk)/.test(text)) return 'Run `npm install` in the app directory.';
  if (/Could not resolve/.test(text)) return 'Install the package (`npm install <name>`) or fix the import path.';
  return undefined;
}

/** Turns a thrown esbuild failure into a `CliError`; rethrows anything else. */
export function rethrowBuildFailure(projectDir: string, error: unknown): never {
  const failure = error as { errors?: Message[] };
  if (Array.isArray(failure?.errors) && failure.errors.length > 0) throw new CliError(esbuildIssues(projectDir, failure.errors));
  throw error;
}

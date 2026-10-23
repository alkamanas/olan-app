import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PACKAGE_EXTENSION } from '@olan-app/schema';
import { build, type Plugin } from 'esbuild';

import { stringFlag } from '../args';
import { backendEngineFlag, type BackendEngine } from '../backend/runner';
import type { Command } from '../command';
import { ensureDevKey } from '../dev-key';
import { CliError, fail, issue, type Issue } from '../errors';
import { keyRegistration } from '../marketplace';
import { esbuildIssues } from '../bundle';
import { CLI_TESTING, packageAliasPlugin } from '../package-aliases';
import { cliPackageDir, displayPath, resolveSdkDir, toPosix } from '../paths';
import { requireManifest, requireProjectDir, WORK_DIR } from '../project';
import { readPackageIdentity, signTestReport, testReportPayload, type PackageIdentity, type TestResult } from '../test-report';
import { packApp } from './pack';

export interface TestFailure {
  name: string;
  file: string;
  message: string;
}

/** A test file whose process ended with a non-zero exit code after every one of its tests passed. */
export interface TestCrash {
  file: string;
  exitCode: number | null;
  signal: string | null;
  message: string;
}

export interface TestSummary {
  files: string[];
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: TestFailure[];
  /** Files whose process crashed after their tests passed (not counted as failed tests). */
  crashes: TestCrash[];
}

/** `STATUS_STACK_BUFFER_OVERRUN`: how Node's libuv assertion abort ends a process on Windows. */
const WINDOWS_ABORT_EXIT = 0xc0000409;

/**
 * Prepended to every test bundle: once the file's tests are done (a root `after` hook) the process
 * gets a fallback exit after `TEST_EXIT_FALLBACK_MS`, unref'd so it never keeps the process alive.
 * Normally the event loop drains and the process ends on its own; the fallback only ends files a
 * forked backend runtime left a timer in. node:test's `forceExit` is not used: exiting right after
 * the tests' sockets closed aborts Node 24 on Windows ("Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)", the same libuv bug as the CLI's own exit, src/cli.ts).
 */
const TEST_EXIT_FALLBACK_MS = 1500;
const TEST_BANNER = [
  "import { createRequire as __olanCreateRequire } from 'node:module'; const require = __olanCreateRequire(import.meta.url);",
  "import { after as __olanAfter } from 'node:test';",
  `__olanAfter(() => { setTimeout(() => process.exit(), ${TEST_EXIT_FALLBACK_MS}).unref(); });`,
].join('\n');

function crashMessage(exitCode: number | null, signal: string | null): string {
  if (exitCode === WINDOWS_ABORT_EXIT || exitCode === -1073740791) {
    return 'The test process crashed after its tests passed (exit 0xC0000409, the Node/libuv abort on Windows when a process exits while sockets are closing). The tests themselves passed.';
  }
  return `The test process crashed after its tests passed (${signal ? `signal ${signal}` : `exit code ${String(exitCode)}`}). The tests themselves passed; look for code that exits or aborts after the last test.`;
}

const TEST_FILE = /\.test\.(ts|tsx|mts)$/;

function findTests(dir: string, base: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findTests(path, base, out);
    else if (TEST_FILE.test(entry.name)) out.push(toPosix(relative(base, path)));
  }
  return out.sort();
}

/**
 * Where `@olan-app/cli/testing` comes from in a test bundle: this CLI's own `dist/testing.js`
 * (kept external, so tests and CLI are the same version), or — when the CLI runs from its
 * TypeScript sources — `src/testing/index.ts`, bundled in.
 */
function testingModule(): { external: true; path: string } | { external: false; path: string } {
  const here = fileURLToPath(import.meta.url);
  const sibling = join(here, '..', 'testing.js');
  if (here.endsWith('.js') && existsSync(sibling)) return { external: true, path: pathToFileURL(sibling).href };
  const dist = join(cliPackageDir(), 'dist', 'testing.js');
  if (here.endsWith('.js') && existsSync(dist)) return { external: true, path: pathToFileURL(dist).href };
  return { external: false, path: join(cliPackageDir(), 'src', 'testing', 'index.ts') };
}

function testingPlugin(): Plugin {
  const target = testingModule();
  return {
    name: 'olan-testing',
    setup(buildApi) {
      buildApi.onResolve({ filter: CLI_TESTING }, () => (target.external ? { path: target.path, external: true } : { path: target.path }));
    },
  };
}

// @olan-app/runtime forks its own process and loads native/WASM engines: never bundled into tests.
const NODE_EXTERNALS = ['node:*', ...builtinModules, 'esbuild', '@olan-app/runtime', 'isolated-vm', 'quickjs-emscripten'];

function failureMessage(error: unknown): string {
  const failure = error as { cause?: unknown; message?: string } | undefined;
  const cause = failure?.cause as { message?: string; code?: string } | undefined;
  const message = cause?.message ?? failure?.message ?? String(error);
  return message.split('\n').slice(0, 40).join('\n');
}

/**
 * `olan-app test`: bundles each `tests/**\/*.test.ts` with esbuild (Node platform; Node
 * built-ins and `@olan-app/cli/testing` external) into `.olan-app/tests/`, and runs them with
 * `node:test` in child processes whose working directory (and `OLAN_APP_ROOT`) is the app.
 * Backend tests are ordinary test files that use `createBackendHarness` (by convention
 * `tests/**\/*.backend.test.ts`); `engine` sets `OLAN_APP_BACKEND_ENGINE` for them.
 */
export async function runTests(
  projectDir: string,
  options: { pattern?: string; log?: (line: string) => void; engine?: BackendEngine; /** Receives every test (for `--report`). */ results?: TestResult[] } = {},
): Promise<TestSummary> {
  const started = performance.now();
  let files = findTests(join(projectDir, 'tests'), projectDir);
  if (options.pattern) files = files.filter((file) => file.includes(options.pattern!));
  if (files.length === 0) {
    throw new CliError(
      issue('test.none', options.pattern ? `No test file matches "${options.pattern}"` : 'No tests found (tests/**/*.test.ts)', {
        hint: 'Write tests with node:test and renderApp / createBackendHarness from @olan-app/cli/testing; see docs/testing.md.',
      }),
    );
  }
  const outDir = join(projectDir, WORK_DIR, 'tests');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outputs = new Map<string, string>();
  const buildErrors: Issue[] = [];
  for (const file of files) {
    const outfile = join(outDir, `${file.replace(/[\\/]/g, '__').replace(TEST_FILE, '')}.test.mjs`);
    try {
      await build({
        entryPoints: [join(projectDir, file)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        jsx: 'automatic',
        sourcemap: 'inline',
        external: NODE_EXTERNALS,
        logLevel: 'silent',
        absWorkingDir: projectDir,
        banner: { js: TEST_BANNER },
        plugins: [testingPlugin(), packageAliasPlugin(resolveSdkDir(projectDir))],
      });
      outputs.set(outfile, file);
    } catch (error) {
      const messages = (error as { errors?: Parameters<typeof esbuildIssues>[1] }).errors;
      if (!messages) throw error;
      buildErrors.push(...esbuildIssues(projectDir, messages, 'test.build_error'));
    }
  }
  if (buildErrors.length > 0) throw new CliError(buildErrors);

  const { run } = await import('node:test');
  const previousRoot = process.env.OLAN_APP_ROOT;
  const previousEngine = process.env.OLAN_APP_BACKEND_ENGINE;
  process.env.OLAN_APP_ROOT = projectDir;
  if (options.engine && options.engine !== 'auto') process.env.OLAN_APP_BACKEND_ENGINE = options.engine;
  const summary: TestSummary = { files, tests: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [], crashes: [] };
  const sourceOf = (file: string | undefined) => (file ? (outputs.get(file) ?? outputs.get(file.replace(/^file:\/\//, '')) ?? toPosix(relative(projectDir, file))) : '');
  /** Per test file: tests that passed and failed so far (a crash after only passes is not a failure). */
  const perFile = new Map<string, { passed: number; failed: number }>();
  const tally = (file: string) => {
    let entry = perFile.get(file);
    if (!entry) perFile.set(file, (entry = { passed: 0, failed: 0 }));
    return entry;
  };
  try {
    // No forceExit (see TEST_BANNER): each file ends by itself, or through the banner's fallback exit.
    const stream = run({ files: [...outputs.keys()], cwd: projectDir, concurrency: 1, timeout: 120_000 });
    for await (const event of stream as AsyncIterable<{ type: string; data: Record<string, unknown> }>) {
      const data = event.data;
      const details = (data.details ?? {}) as { type?: string; duration_ms?: number; error?: unknown };
      switch (event.type) {
        case 'test:pass':
          if (details.type === 'suite') break;
          summary.tests++;
          if (data.skip !== undefined && data.skip !== false) {
            summary.skipped++;
            options.results?.push({ file: sourceOf(data.file as string), name: String(data.name), status: 'skipped' });
            options.log?.(`skip ${sourceOf(data.file as string)} › ${String(data.name)}`);
          } else {
            summary.passed++;
            tally(sourceOf(data.file as string)).passed++;
            options.results?.push({ file: sourceOf(data.file as string), name: String(data.name), status: 'passed', durationMs: details.duration_ms ?? 0 });
            options.log?.(`ok   ${sourceOf(data.file as string)} › ${String(data.name)} (${Math.round(details.duration_ms ?? 0)} ms)`);
          }
          break;
        case 'test:fail': {
          if (details.type === 'suite') break;
          // The file's own process ended with a non-zero code: node:test reports it as a failed
          // "test" named after the file, with `exitCode`/`signal`. After passing tests only, that
          // is a crash on the way out, not a failing test.
          const processError = details.error as { failureType?: string; exitCode?: number | null; signal?: string | null } | undefined;
          const file = sourceOf(data.file as string);
          const fileLevel = processError?.failureType === 'testCodeFailure' && (processError.exitCode !== undefined || processError.signal !== undefined) && outputs.has(String(data.name));
          if (fileLevel && (perFile.get(file)?.passed ?? 0) > 0 && (perFile.get(file)?.failed ?? 0) === 0) {
            const crash: TestCrash = { file, exitCode: processError.exitCode ?? null, signal: processError.signal ?? null, message: crashMessage(processError.exitCode ?? null, processError.signal ?? null) };
            summary.crashes.push(crash);
            options.log?.(`warn ${file}: ${crash.message}`);
            break;
          }
          tally(file).failed++;
          summary.tests++;
          summary.failed++;
          const failure = fileLevel
            ? { name: file, file, message: `The test file's process ended (${processError.signal ? `signal ${processError.signal}` : `exit code ${String(processError.exitCode)}`}) without passing tests: it crashed while loading or running. Its output is above.` }
            : { name: String(data.name), file, message: failureMessage(details.error) };
          summary.failures.push(failure);
          options.results?.push({ file: failure.file, name: failure.name, status: 'failed', durationMs: details.duration_ms ?? 0, error: failure.message });
          options.log?.(`FAIL ${failure.file} › ${failure.name}\n${failure.message.replace(/^/gm, '     ')}`);
          break;
        }
        case 'test:stdout':
        case 'test:stderr':
          options.log?.(String(data.message ?? '').replace(/\n$/, ''));
          break;
        default:
          break;
      }
    }
  } finally {
    if (previousRoot === undefined) delete process.env.OLAN_APP_ROOT;
    else process.env.OLAN_APP_ROOT = previousRoot;
    if (previousEngine === undefined) delete process.env.OLAN_APP_BACKEND_ENGINE;
    else process.env.OLAN_APP_BACKEND_ENGINE = previousEngine;
  }
  summary.durationMs = Math.round(performance.now() - started);
  return summary;
}

export interface TestReportInfo {
  /** Where the signed report was written. */
  file: string;
  appId: string;
  appVersion: string;
  /** `digest.package` of the package the report is bound to. */
  packageSha256: string;
  /** The package the digest came from (packed by the command, or `--package`). */
  package: string;
  keyFingerprint: string;
  keyFile: string;
  keyCreated: boolean;
}

/**
 * The package a report binds to: `--package <file>`, else a fresh unsigned pack of the project into
 * `.olan-app/report/` (validated and built like `olan-app pack`). A signature does not change
 * `digest.package`, so `olan-app publish --marketplace` and `pack --dev-sign` of the same sources
 * give the same digest.
 */
async function reportPackage(projectDir: string, packageFlag: string | undefined, cwd: string, log: (line: string) => void): Promise<{ path: string; identity: PackageIdentity }> {
  if (packageFlag) {
    const path = resolve(cwd, packageFlag);
    return { path, identity: readPackageIdentity(path) };
  }
  const manifest = requireManifest(projectDir);
  const packed = await packApp(projectDir, { signKey: false, out: join(WORK_DIR, 'report', `${manifest.id}-${manifest.version}${PACKAGE_EXTENSION}`) });
  log(`Packed ${packed.file} (sha256 ${packed.sha256}) for the test report`);
  const path = resolve(projectDir, packed.file);
  return { path, identity: readPackageIdentity(path) };
}

/** A warning when `dist/<id>-<version>.olanapp` exists but is another build than the report's package. */
function stalePackageWarning(projectDir: string, identity: PackageIdentity, packagePath: string): Issue[] {
  const dist = join(projectDir, 'dist', `${identity.appId}-${identity.appVersion}${PACKAGE_EXTENSION}`);
  if (!existsSync(dist) || resolve(dist) === resolve(packagePath)) return [];
  try {
    if (readPackageIdentity(dist).packageSha256 === identity.packageSha256) return [];
  } catch {
    // unreadable: same advice
  }
  return [
    issue('test.report_package_stale', `${toPosix(relative(projectDir, dist))} is another build than the package the report is bound to`, {
      hint: 'Pack again (`olan-app pack`) before `publish --file`, or publish without --file (it packs the same sources).',
    }),
  ];
}

/** `file` relative to `cwd` when it is inside it, else absolute. */
function shownPath(cwd: string, file: string): string {
  const rel = toPosix(relative(cwd, file));
  return rel && !rel.startsWith('..') ? rel : toPosix(file);
}

export const testCommand: Command = {
  name: 'test',
  summary: 'Run tests/**/*.test.ts headlessly against the mock Olan host (node:test); --report writes a signed test report',
  usage: 'olan-app test [pattern] [--engine auto|isolated-vm|quickjs] [--report <file> [--package <pkg.olanapp>]] [--json]',
  options: [
    '[pattern]        Only test files whose path contains this text (e.g. "backend")',
    '--engine <name>  Backend engine for createBackendHarness: auto (default), isolated-vm or quickjs',
    '--report <file>  Pack the app first (like `olan-app pack`), run the whole suite and write a test report bound',
    '                 to that package (digest.package), signed with your development key',
    '                 (~/.olan/olan-app-dev.key.json, created on first use). Attach it with',
    '                 `olan-app publish --marketplace --test-report <file>`; make it after your last source change.',
    '--package <file> Bind the report to this .olanapp instead of packing',
  ],
  spec: { strings: ['engine', 'report', 'package'] },
  async run(args, context) {
    const projectDir = requireProjectDir(context.cwd);
    const engine = backendEngineFlag(stringFlag(args, 'engine'));
    const reportFlag = stringFlag(args, 'report');
    const packageFlag = stringFlag(args, 'package');
    if (packageFlag && !reportFlag) fail('test.package_without_report', '--package applies to --report only');
    if (reportFlag && args.positionals[0]) fail('test.report_pattern', 'A test report covers the whole suite: drop the pattern', { hint: `olan-app test --report ${reportFlag}` });

    const target = reportFlag ? await reportPackage(projectDir, packageFlag, context.cwd, context.log) : null;
    const results: TestResult[] = [];
    const summary = await runTests(projectDir, { pattern: args.positionals[0], log: context.json ? undefined : context.log, engine, results });
    const line = `${summary.passed} passed, ${summary.failed} failed${summary.skipped ? `, ${summary.skipped} skipped` : ''} (${summary.files.length} file${summary.files.length === 1 ? '' : 's'}, ${summary.durationMs} ms)`;

    // The report is written for failing runs too: reviewers see the failures.
    let report: TestReportInfo | undefined;
    const warnings: Issue[] = summary.crashes.map((crash) =>
      issue('test.process_crashed', crash.message, {
        file: crash.file,
        hint: 'Not a failing test: every test in the file passed. Rerun to confirm; if it repeats, look for process.exit()/abort calls or handles closed in after() hooks.',
      }),
    );
    const human = [line, ...summary.crashes.map((crash) => `  ${crash.file}: the process crashed after the tests passed (${crash.exitCode !== null ? `exit ${crash.exitCode === WINDOWS_ABORT_EXIT ? '0xC0000409' : crash.exitCode}` : `signal ${crash.signal}`}); not counted as a failure`)];
    if (target && reportFlag && summary.tests > 0) {
      const devKey = ensureDevKey(context.env);
      const document = signTestReport(testReportPayload(target.identity, results, summary.durationMs), devKey.path);
      const file = resolve(context.cwd, reportFlag);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
      report = {
        file: displayPath(projectDir, file),
        ...target.identity,
        package: displayPath(projectDir, target.path),
        keyFingerprint: devKey.fingerprint,
        keyFile: devKey.path,
        keyCreated: devKey.created,
      };
      warnings.push(...stalePackageWarning(projectDir, target.identity, target.path));
      // Whether reviewers will see it as verified depends on the key being registered (asked only when signed in).
      const registration = context.json ? null : await keyRegistration(context.env, devKey.key.publicKey);
      human.push(
        `Wrote test report ${report.file} for ${report.appId} ${report.appVersion} (package sha256 ${report.packageSha256}), signed with key ${report.keyFingerprint}`,
        ...(devKey.created ? [`  Created the development key ${devKey.path}`] : []),
        `  Attach it: olan-app publish --marketplace --test-report ${shownPath(context.cwd, file)}`,
        registration?.registered
          ? `  The key is registered with ${registration.developer}: reviewers see the report as verified.`
          : registration
            ? '  Reviewers see it as verified once the key is registered: olan-app keys register --marketplace'
            : '  Reviewers see it as verified when this key is registered with your developer account (`olan-app keys list --marketplace` shows the registered keys).',
      );
    }
    const result = report ? { ...summary, report } : summary;
    if (summary.failed > 0 || summary.tests === 0) {
      const errors = summary.failures.map((failure) => issue('test.failed', `${failure.name}: ${failure.message}`, { file: failure.file }));
      if (summary.tests === 0) errors.push(issue('test.none', 'The test files define no tests'));
      if (report) context.log(human.slice(1).join('\n'));
      throw new CliError(errors, warnings.length ? { ...result, warnings } : result);
    }
    return { result, warnings, human };
  },
};

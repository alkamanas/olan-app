import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { build } from 'esbuild';

import { appBuildOptions, rethrowBuildFailure } from '../bundle';
import { APP_SOURCE } from '../project';

/** The sandbox-side transport shape (`Transport` of `@olan-app/sdk/runtime`). */
export interface SandboxTransport {
  post(message: unknown): void;
  onMessage(listener: (message: never) => void): () => void;
}

export interface SandboxRuntime {
  dispose(): void;
}

export interface EvaluatedApp {
  /** The module's default export (an `AppDefinition` when the app is written correctly). */
  app: unknown;
  start(transport: SandboxTransport): SandboxRuntime;
  /** Timers the app scheduled and that have not run yet (short ones count as "still busy"). */
  pendingShortTimers(): number;
  /** Errors thrown from the app's own timers. */
  timerErrors: unknown[];
  /** Clears every timer the app left behind. */
  dispose(): void;
}

interface CachedBundle {
  code: string;
  inputs: { path: string; mtimeMs: number }[];
}

const bundleCache = new Map<string, CachedBundle>();

function stillFresh(entry: CachedBundle): boolean {
  return entry.inputs.every((input) => {
    try {
      return statSync(input.path).mtimeMs === input.mtimeMs;
    } catch {
      return false;
    }
  });
}

/**
 * Bundles the app for headless runs: the same esbuild options as `olan-app build` (one React,
 * no DOM/Node imports), unminified, with an entry that exposes the definition and a runtime
 * starter instead of starting on a Worker. Cached per process until an input file changes.
 */
export async function bundleForTest(projectDir: string, appSource = APP_SOURCE): Promise<string> {
  const key = resolve(projectDir, appSource);
  const cached = bundleCache.get(key);
  if (cached && stillFresh(cached)) return cached.code;
  const options = appBuildOptions({ projectDir, mode: 'test', minify: false, appSource });
  let output;
  try {
    output = await build(options);
  } catch (error) {
    rethrowBuildFailure(projectDir, error);
  }
  const code = output.outputFiles?.[0]?.text ?? '';
  const inputs = Object.keys(output.metafile?.inputs ?? {})
    .filter((path) => !path.startsWith('<'))
    .map((path) => {
      const absolute = resolve(projectDir, path);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(absolute).mtimeMs;
      } catch {
        // Virtual inputs (the generated entry) have no file.
      }
      return { path: absolute, mtimeMs };
    })
    .filter((input) => input.mtimeMs > 0);
  bundleCache.set(key, { code, inputs });
  return code;
}

const SHORT_TIMER_MS = 20;

/**
 * Runs a test bundle in a fresh `node:vm` context. Like the sandbox Worker, the context has
 * timers, `console`, `URL`, `TextEncoder`/`TextDecoder`, `structuredClone` and `performance`, but
 * no `fetch`, `process`, `require`, DOM or storage. `now` freezes `Date.now()`/`new Date()`.
 */
export function evaluateApp(code: string, options: { now?: number; console?: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> } = {}): EvaluatedApp {
  const timeouts = new Map<unknown, number>();
  const intervals = new Set<unknown>();
  const immediates = new Set<unknown>();
  const timerErrors: unknown[] = [];
  const guard =
    (fn: unknown, args: unknown[]) =>
    () => {
      if (typeof fn !== 'function') return;
      try {
        fn(...args);
      } catch (error) {
        timerErrors.push(error);
      }
    };
  const quiet = () => {};
  const consoleImpl = options.console ?? { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet };

  const sandboxGlobals: Record<string, unknown> = {
    console: { ...consoleImpl },
    setTimeout(fn: unknown, delay = 0, ...args: unknown[]) {
      const handle: NodeJS.Timeout = setTimeout(() => {
        timeouts.delete(handle);
        guard(fn, args)();
      }, delay);
      timeouts.set(handle, Number(delay) || 0);
      return handle;
    },
    clearTimeout(handle: NodeJS.Timeout) {
      timeouts.delete(handle);
      clearTimeout(handle);
    },
    setInterval(fn: unknown, delay = 0, ...args: unknown[]) {
      const handle = setInterval(guard(fn, args), delay);
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle: NodeJS.Timeout) {
      intervals.delete(handle);
      clearInterval(handle);
    },
    setImmediate(fn: unknown, ...args: unknown[]) {
      const handle: NodeJS.Immediate = setImmediate(() => {
        immediates.delete(handle);
        guard(fn, args)();
      });
      immediates.add(handle);
      return handle;
    },
    clearImmediate(handle: NodeJS.Immediate) {
      immediates.delete(handle);
      clearImmediate(handle);
    },
    queueMicrotask,
    structuredClone,
    performance: { now: () => performance.now(), timeOrigin: performance.timeOrigin },
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    atob,
    btoa,
  };
  const context = vm.createContext(sandboxGlobals, { name: 'olan-app', codeGeneration: { strings: true, wasm: false } });
  vm.runInContext('globalThis.self = globalThis;', context);
  if (options.now !== undefined) {
    vm.runInContext(
      `(() => {
        const RealDate = Date;
        const fixed = ${Number(options.now)};
        class OlanTestDate extends RealDate {
          constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
          static now() { return fixed; }
        }
        globalThis.Date = OlanTestDate;
      })();`,
      context,
    );
  }
  new vm.Script(code, { filename: 'olan-app.test-bundle.js' }).runInContext(context);
  const exposed = context as unknown as { __olanApp?: unknown; __olanStartRuntime?: (transport: SandboxTransport) => SandboxRuntime };
  if (typeof exposed.__olanStartRuntime !== 'function') throw new Error('The test bundle did not expose the runtime starter');
  const start = exposed.__olanStartRuntime;
  return {
    app: exposed.__olanApp,
    start: (transport) => start(transport),
    pendingShortTimers: () => immediates.size + [...timeouts.values()].filter((delay) => delay <= SHORT_TIMER_MS).length,
    timerErrors,
    dispose() {
      for (const handle of timeouts.keys()) clearTimeout(handle as NodeJS.Timeout);
      for (const handle of intervals) clearInterval(handle as NodeJS.Timeout);
      for (const handle of immediates) clearImmediate(handle as NodeJS.Immediate);
      timeouts.clear();
      intervals.clear();
      immediates.clear();
    },
  };
}

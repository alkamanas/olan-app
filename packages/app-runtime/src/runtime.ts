import { SandboxRuntime } from './core.js';
import { isolatedVmDriver, loadIsolatedVm } from './engines/isolated-vm.js';
import { quickJsDriver } from './engines/quickjs.js';
import type { AppRuntime, CreateRuntimeOptions } from './types.js';

function defaultCatastrophe(message: string): void {
  process.stderr.write(`[olan-app-runtime] isolated-vm catastrophic error, exiting: ${message}\n`);
  process.exit(70);
}

/** True when this process exposes V8's `gc` (`--expose-gc`); isolated-vm isolates would see it too. */
export function hostExposesGc(): boolean {
  const flag = /--expose[-_]gc\b/;
  return typeof (globalThis as { gc?: unknown }).gc === 'function'
    || process.execArgv.some((arg) => flag.test(arg))
    || flag.test(process.env.NODE_OPTIONS ?? '');
}

/**
 * Creates an in-process runtime. `auto` prefers isolated-vm and falls back to QuickJS (with a
 * warning) when the native module cannot be loaded on this platform.
 */
export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<AppRuntime> {
  const choice = options.engine ?? 'auto';
  if (choice === 'quickjs') return new SandboxRuntime(quickJsDriver());
  const loaded = loadIsolatedVm();
  if ('error' in loaded) {
    if (choice === 'isolated-vm') throw new Error(`isolated-vm is not available on ${process.platform}-${process.arch}: ${loaded.error.message}`);
    options.onWarning?.(`isolated-vm prebuild not available on ${process.platform}-${process.arch}; using QuickJS (slower). Reason: ${loaded.error.message}`);
    return new SandboxRuntime(quickJsDriver());
  }
  if (hostExposesGc()) {
    options.onWarning?.('this process runs with --expose-gc; V8 would expose gc to app code. The bootstrap hides it, but run the app runtime without --expose-gc.');
  }
  return new SandboxRuntime(isolatedVmDriver(loaded.ivm, { onCatastrophicError: options.onCatastrophicError ?? defaultCatastrophe }));
}

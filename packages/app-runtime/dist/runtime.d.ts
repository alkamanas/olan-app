import type { AppRuntime, CreateRuntimeOptions } from './types.js';
/** True when this process exposes V8's `gc` (`--expose-gc`); isolated-vm isolates would see it too. */
export declare function hostExposesGc(): boolean;
/**
 * Creates an in-process runtime. `auto` prefers isolated-vm and falls back to QuickJS (with a
 * warning) when the native module cannot be loaded on this platform.
 */
export declare function createRuntime(options?: CreateRuntimeOptions): Promise<AppRuntime>;

import type { AppRuntime, InvocationKind, InvocationResult, JsonValue, RuntimeLimits } from './types.js';
/** A hand-written stand-in for an esbuild IIFE (`globalName: '__olanBackendModule'`). */
export declare const CONTRACT_BUNDLE: string;
/** Minimal bundle without `migrate`. */
export declare const MINIMAL_BUNDLE = "var __olanBackendModule = { default: { $olanBackend: 1, functions: { ping: () => 'pong' } } };";
export declare const DEFAULT_TEST_LIMITS: RuntimeLimits;
export declare const digestOf: (source: string) => string;
export interface ContractHarness {
    runtime: AppRuntime;
    hostCalls: {
        installationId: string;
        method: string;
        args: string;
    }[];
    codeCalls: number;
    invoke(options: {
        installationId?: string;
        kind?: InvocationKind;
        name: string;
        fallback?: string;
        payload?: JsonValue;
        limits?: Partial<RuntimeLimits>;
        source?: string;
        code?: () => Promise<string>;
    }): Promise<InvocationResult>;
}
export declare function createContractHarness(runtime: AppRuntime): ContractHarness;
export declare function runContractSuite(label: string, createRuntime: () => Promise<AppRuntime>): void;

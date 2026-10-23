import { z } from 'zod';
/** Where a package carries the built backend (`olan-app build` bundles `server.entry` there). */
export declare const SERVER_BUNDLE_PATH = "dist/server.js";
/**
 * Per-invocation limits (§15.1). The plain values are the defaults; `*Max` are Olan's ceilings.
 * Administrators may change the defaults per tenant but never go past the ceilings.
 */
export declare const BACKEND_LIMITS: Readonly<{
    /** `backend.call` wall-clock time. */
    callMs: 10000;
    callMsMax: 30000;
    /** Schedules, events and hooks wall-clock time (default and ceiling). */
    invocationMs: 30000;
    /** CPU time per invocation, including code after `await` and in timers. */
    cpuMs: 1000;
    cpuMsMax: 5000;
    /** Heap of the installation's isolate. */
    memoryMiB: 64;
    memoryMiBMax: 128;
    /** Simultaneous invocations per installation; more fail with `backend_busy`. */
    concurrencyPerInstallation: 4;
    concurrencyMax: 8;
    /** Console lines kept per invocation (then one truncation marker), bytes per line. */
    logLines: 1000;
    logLineBytes: number;
    schedules: 10;
    /** Shortest interval between two runs of a schedule. */
    scheduleMinMinutes: 5;
    hooks: 10;
    /** Arguments and results of `backend.call`. */
    payloadBytes: number;
    hookBodyBytes: number;
    hookRequestsPerMinute: 120;
    /** A hook function that answers within this time returns its response; else `202`. */
    hookResponseMs: 10000;
}>;
export declare const BACKEND_FUNCTION_PATTERN: RegExp;
export declare const BACKEND_NAME_PATTERN: RegExp;
export declare const HOOK_VERIFY_KINDS: readonly ["hmac-sha256", "standard-webhooks", "none"];
export type HookVerifyKind = (typeof HOOK_VERIFY_KINDS)[number];
export interface BackendSchedule {
    /** `^[a-z][a-z0-9-]{0,31}$`, unique. */
    name: string;
    /** Five fields (minute hour day-of-month month day-of-week); at least 5 minutes apart. */
    cron: string;
    /** IANA time zone (default UTC). */
    timeZone?: string;
    /**
     * Optional fallback: `functions[function]` of the backend module, used when `schedules[name]` is
     * not defined. A name used here is never callable from the UI (`backendCallable`).
     */
    function?: string;
}
export interface BackendHookVerify {
    /** `none` only in development installations. */
    kind: HookVerifyKind;
    /** Signature header (`hmac-sha256`; Standard Webhooks uses its own headers). */
    header?: string;
    /** A `secret: true` settings field holding the shared secret. */
    secretSetting?: string;
}
export interface BackendHook {
    name: string;
    /**
     * Optional fallback: `functions[function]`, used when `hooks[name]` is not defined. A name used
     * here is never callable from the UI (`backendCallable`).
     */
    function?: string;
    verify: BackendHookVerify;
}
/** Manifest `server`. */
export interface ManifestServer {
    /** Package path of the backend module, e.g. `server/index.ts`. */
    entry: string;
    schedules?: BackendSchedule[];
    /**
     * Event type → fallback function (§5.1 catalogue, same permission and scope rules), used when
     * `events[type]` is not defined. A name used here is never callable from the UI.
     */
    events?: Record<string, string>;
    /** Incoming webhooks: `POST /api/v2/apps/hooks/<installationId>/<name>`. */
    hooks?: BackendHook[];
}
/**
 * Methods backend code may call through `__olan.call(method, argsJson)` (`olan.*` in
 * `@olan-app/sdk/backend`). Names, params and results are the UI RPC ones (`RpcMethods`); the
 * host checks them with `backendMethodAllowed`. Left out on purpose: `ui.*` and `navigation.*`
 * (no screen), `storage.*` (per person; use `db`), `mail.getMessage` (bound to the mail surface
 * that was opened), `backend.call` (no recursion) and the Phase 5a UI calls `remote.request`
 * (always on behalf of the person in front of the app), `files.*` (the device's picker) and
 * `timers.*` (`useQuery` refetching).
 */
export declare const BACKEND_HOST_METHODS: readonly string[];
/** Backend-only host methods (not UI RPCs). `secrets.get` `{ name }` → `string | null`, no permission. */
export declare const BACKEND_ONLY_METHODS: readonly string[];
export declare function isBackendHostMethod(method: unknown): method is string;
/**
 * Whether backend code may call `method` with the `granted` permissions (the caller's for
 * `backend.call`, the app identity's otherwise): a `BACKEND_HOST_METHODS` entry and, for UI RPC
 * names, `methodAllowed`. `secrets.get` needs no permission.
 */
export declare function backendMethodAllowed(method: string, granted: readonly string[], url?: string): boolean;
/**
 * `@olan-app/runtime` error code → the RPC error code `olan.backend.call` rejects with (and the
 * `error` of hook/schedule/event invocation logs). `bundle_error` is the app's fault (a broken
 * `dist/server.js`), so it is `backend_error`; `runtime_unavailable` is Olan's.
 */
export declare const BACKEND_RUNTIME_ERRORS: Readonly<{
    readonly not_found: "backend_function_not_found";
    readonly handler_error: "backend_error";
    readonly bundle_error: "backend_error";
    readonly cpu_limit: "backend_limit";
    readonly timeout: "backend_limit";
    readonly memory_limit: "backend_limit";
    readonly concurrency_limit: "backend_busy";
    readonly payload_too_large: "payload_too_large";
    readonly runtime_unavailable: "backend_unavailable";
    /**
     * Host-side, not a runtime code (decision 2026-10-18): the installed version's `migrate` has not
     * succeeded yet. Every call of that version answers this (HTTP 503) until it does; the host retries
     * `migrate` with backoff, an administrator or developer can retry it by hand.
     */
    readonly migrating: "backend_migrating";
}>;
export type BackendRuntimeErrorCode = keyof typeof BACKEND_RUNTIME_ERRORS;
export type BackendCallErrorCode = (typeof BACKEND_RUNTIME_ERRORS)[BackendRuntimeErrorCode];
/** The `backend.call` RPC error code for a runtime error code (unknown codes: `backend_error`). */
export declare function backendCallErrorCode(runtimeCode: string): BackendCallErrorCode;
/** The HTTP answer to an incoming hook. */
export interface BackendHookHttpResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}
/**
 * The HTTP answer for what a hook handler returned (§8.1), the same on the Olan server, in
 * `olan-app dev` and in `createBackendHarness`:
 * - `{ status, headers?, body? }` with an integer `status` 200–599 → that response. A string
 *   `body` is sent as is (default `content-type: text/plain; charset=utf-8`); any other JSON value
 *   is serialised with `JSON.stringify` (default `application/json; charset=utf-8`). Only
 *   `content-type`, `cache-control`, `etag`, `last-modified` and `x-*` headers are kept.
 * - anything else (no return value, `null`, no valid `status`) → `202` with an empty body.
 */
export declare function backendHookResponse(value: unknown): BackendHookHttpResponse;
/** A manifest-declared trigger and the runtime request that runs it (`InvocationRequest.kind/name/fallback`). */
export interface BackendTrigger {
    kind: 'schedule' | 'event' | 'hook';
    /** Schedule name, event type or hook name. */
    name: string;
    /** The manifest's `function`: used when the kind-specific map of `defineBackend` has no `name`. */
    fallback?: string;
}
/**
 * Every schedule, event and hook the manifest declares, with the §15.1 handler resolution:
 * schedule → `schedules[name]` else `functions[function]`; event → `events[type]` else
 * `functions[server.events[type]]`; hook → `hooks[name]` else `functions[function]`.
 */
export declare function backendTriggers(server: BackendTriggerSource): BackendTrigger[];
/** The parts of a manifest `server` that declare triggers. */
export interface BackendTriggerSource {
    schedules?: readonly Pick<BackendSchedule, 'name' | 'function'>[];
    events?: Readonly<Record<string, string>>;
    hooks?: readonly Pick<BackendHook, 'name' | 'function'>[];
}
/**
 * Whether the UI may call `functions[name]` with `olan.backend.call(name)` (§15.1). A function
 * named as the `function` fallback of a schedule or hook, or as a `server.events` value, is a
 * trigger handler: it runs only for its trigger (hooks only after their signature check), never
 * from the UI. Hosts answer such calls `backend_function_not_found`, exactly like a missing
 * function, so the answer does not reveal it. Without `server` nothing is callable.
 */
export declare function backendCallable(manifest: {
    server?: BackendTriggerSource | null;
} | null | undefined, name: string): boolean;
/** Whether a `defineBackend(...)` value has a handler for `trigger` (§15.1). */
export declare function backendHandlerResolves(definition: unknown, trigger: BackendTrigger): boolean;
/** Problems of a five-field cron expression (empty when valid and at least `scheduleMinMinutes` apart). */
export declare function cronProblems(cron: string): string[];
export declare const serverSchema: z.ZodObject<{
    entry: z.ZodString;
    schedules: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        cron: z.ZodString;
        timeZone: z.ZodOptional<z.ZodString>;
        function: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    events: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    hooks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        function: z.ZodOptional<z.ZodString>;
        verify: z.ZodObject<{
            kind: z.ZodEnum<{
                "hmac-sha256": "hmac-sha256";
                "standard-webhooks": "standard-webhooks";
                none: "none";
            }>;
            header: z.ZodOptional<z.ZodString>;
            secretSetting: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>>>;
}, z.core.$strict>;

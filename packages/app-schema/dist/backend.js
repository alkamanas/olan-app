import { z } from 'zod';
import { EVENT_TYPES } from './events.js';
import { isPackagePath } from './paths.js';
import { methodAllowed } from './rpc.js';
/*
 * Backend code (`server`, Phase 3 contract §8.1, §15). The runtime is `@olan-app/runtime`
 * (isolated-vm, QuickJS-WASM as fallback). `validateManifest` accepts `server` by default;
 * `{ backend: false }` turns it off (`manifest.feature_not_available`; the server does so with
 * `OLAN_APPS_BACKEND=0`).
 */
/** Where a package carries the built backend (`olan-app build` bundles `server.entry` there). */
export const SERVER_BUNDLE_PATH = 'dist/server.js';
/**
 * Per-invocation limits (§15.1). The plain values are the defaults; `*Max` are Olan's ceilings.
 * Administrators may change the defaults per tenant but never go past the ceilings.
 */
export const BACKEND_LIMITS = Object.freeze({
    /** `backend.call` wall-clock time. */
    callMs: 10_000,
    callMsMax: 30_000,
    /** Schedules, events and hooks wall-clock time (default and ceiling). */
    invocationMs: 30_000,
    /** CPU time per invocation, including code after `await` and in timers. */
    cpuMs: 1_000,
    cpuMsMax: 5_000,
    /** Heap of the installation's isolate. */
    memoryMiB: 64,
    memoryMiBMax: 128,
    /** Simultaneous invocations per installation; more fail with `backend_busy`. */
    concurrencyPerInstallation: 4,
    concurrencyMax: 8,
    /** Console lines kept per invocation (then one truncation marker), bytes per line. */
    logLines: 1000,
    logLineBytes: 4 * 1024,
    schedules: 10,
    /** Shortest interval between two runs of a schedule. */
    scheduleMinMinutes: 5,
    hooks: 10,
    /** Arguments and results of `backend.call`. */
    payloadBytes: 256 * 1024,
    hookBodyBytes: 1024 * 1024,
    hookRequestsPerMinute: 120,
    /** A hook function that answers within this time returns its response; else `202`. */
    hookResponseMs: 10_000,
});
export const BACKEND_FUNCTION_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
export const BACKEND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const HOOK_VERIFY_KINDS = ['hmac-sha256', 'standard-webhooks', 'none'];
const SERVER_ENTRY_PATTERN = /\.(?:ts|tsx|js|mjs)$/;
// ---------------------------------------------------------------------------
// Host bridge methods and handler resolution (§15.1, §15.2)
// ---------------------------------------------------------------------------
/**
 * Methods backend code may call through `__olan.call(method, argsJson)` (`olan.*` in
 * `@olan-app/sdk/backend`). Names, params and results are the UI RPC ones (`RpcMethods`); the
 * host checks them with `backendMethodAllowed`. Left out on purpose: `ui.*` and `navigation.*`
 * (no screen), `storage.*` (per person; use `db`), `mail.getMessage` (bound to the mail surface
 * that was opened), `backend.call` (no recursion) and the Phase 5a UI calls `remote.request`
 * (always on behalf of the person in front of the app), `files.*` (the device's picker) and
 * `timers.*` (`useQuery` refetching).
 */
export const BACKEND_HOST_METHODS = Object.freeze([
    'secrets.get',
    'settings.get',
    'db.insert',
    'db.get',
    'db.query',
    'db.update',
    'db.delete',
    'db.count',
    'http.fetch',
    'project.config.get',
    'project.config.set',
    'project.statuses.list',
    'project.statuses.define',
    'project.statuses.remove',
    'project.labels.list',
    'project.labels.define',
    'project.labels.remove',
    'project.fields.list',
    'project.fields.define',
    'project.fields.remove',
    'project.fields.values',
    'project.fields.setValues',
    'project.links.list',
    'project.links.upsert',
    'project.links.remove',
    'project.links.setStatus',
    'project.calendar.list',
    'project.calendar.upsert',
    'project.calendar.remove',
    'project.activity.post',
    'project.approvals.list',
    'project.approvals.request',
    'project.approvals.cancel',
    'projects.list',
    'projects.get',
    'projects.tasks',
    'projects.createTask',
    'projects.updateTask',
    'projects.deleteTask',
    'projects.deleteList',
    'projects.create',
    'projects.archive',
    'users.get',
    'chat.conversations',
    'chat.messages',
    'chat.postCard',
    'chat.updateCard',
    'calendar.calendars',
    'calendar.events',
    'calendar.createEvent',
    'calendar.updateEvent',
    'calendar.deleteEvent',
    'contacts.addressBooks',
    'contacts.search',
    'contacts.create',
    'contacts.update',
    'contacts.delete',
    'meetings.get',
]);
/** Backend-only host methods (not UI RPCs). `secrets.get` `{ name }` → `string | null`, no permission. */
export const BACKEND_ONLY_METHODS = Object.freeze(['secrets.get']);
export function isBackendHostMethod(method) {
    return typeof method === 'string' && BACKEND_HOST_METHODS.includes(method);
}
/**
 * Whether backend code may call `method` with the `granted` permissions (the caller's for
 * `backend.call`, the app identity's otherwise): a `BACKEND_HOST_METHODS` entry and, for UI RPC
 * names, `methodAllowed`. `secrets.get` needs no permission.
 */
export function backendMethodAllowed(method, granted, url) {
    if (!isBackendHostMethod(method))
        return false;
    if (BACKEND_ONLY_METHODS.includes(method))
        return true;
    return methodAllowed(method, granted, url);
}
/**
 * `@olan-app/runtime` error code → the RPC error code `olan.backend.call` rejects with (and the
 * `error` of hook/schedule/event invocation logs). `bundle_error` is the app's fault (a broken
 * `dist/server.js`), so it is `backend_error`; `runtime_unavailable` is Olan's.
 */
export const BACKEND_RUNTIME_ERRORS = Object.freeze({
    not_found: 'backend_function_not_found',
    handler_error: 'backend_error',
    bundle_error: 'backend_error',
    cpu_limit: 'backend_limit',
    timeout: 'backend_limit',
    memory_limit: 'backend_limit',
    concurrency_limit: 'backend_busy',
    payload_too_large: 'payload_too_large',
    runtime_unavailable: 'backend_unavailable',
    /**
     * Host-side, not a runtime code (decision 2026-10-18): the installed version's `migrate` has not
     * succeeded yet. Every call of that version answers this (HTTP 503) until it does; the host retries
     * `migrate` with backoff, an administrator or developer can retry it by hand.
     */
    migrating: 'backend_migrating',
});
/** The `backend.call` RPC error code for a runtime error code (unknown codes: `backend_error`). */
export function backendCallErrorCode(runtimeCode) {
    return Object.prototype.hasOwnProperty.call(BACKEND_RUNTIME_ERRORS, runtimeCode)
        ? BACKEND_RUNTIME_ERRORS[runtimeCode]
        : 'backend_error';
}
const HOOK_RESPONSE_HEADER = /^(?:content-type|cache-control|etag|last-modified|x-[a-z0-9-]{1,60})$/;
const HOOK_BLOCKED_HEADERS = new Set(['x-powered-by', 'x-frame-options', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);
/**
 * The HTTP answer for what a hook handler returned (§8.1), the same on the Olan server, in
 * `olan-app dev` and in `createBackendHarness`:
 * - `{ status, headers?, body? }` with an integer `status` 200–599 → that response. A string
 *   `body` is sent as is (default `content-type: text/plain; charset=utf-8`); any other JSON value
 *   is serialised with `JSON.stringify` (default `application/json; charset=utf-8`). Only
 *   `content-type`, `cache-control`, `etag`, `last-modified` and `x-*` headers are kept.
 * - anything else (no return value, `null`, no valid `status`) → `202` with an empty body.
 */
export function backendHookResponse(value) {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
    const status = record?.status;
    if (!record || typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599)
        return { status: 202, headers: {}, body: '' };
    const headers = {};
    if (typeof record.headers === 'object' && record.headers !== null && !Array.isArray(record.headers)) {
        for (const [name, raw] of Object.entries(record.headers)) {
            const key = name.toLowerCase();
            if (typeof raw !== 'string' || !HOOK_RESPONSE_HEADER.test(key) || HOOK_BLOCKED_HEADERS.has(key) || /[\r\n]/.test(raw) || raw.length > 1024)
                continue;
            headers[key] = raw;
        }
    }
    const body = record.body === undefined || record.body === null ? '' : typeof record.body === 'string' ? record.body : JSON.stringify(record.body);
    if (body && !headers['content-type'])
        headers['content-type'] = typeof record.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
    return { status, headers, body };
}
/**
 * Every schedule, event and hook the manifest declares, with the §15.1 handler resolution:
 * schedule → `schedules[name]` else `functions[function]`; event → `events[type]` else
 * `functions[server.events[type]]`; hook → `hooks[name]` else `functions[function]`.
 */
export function backendTriggers(server) {
    const trigger = (kind, name, fallback) => fallback ? { kind, name, fallback } : { kind, name };
    return [
        ...(server.schedules ?? []).map((schedule) => trigger('schedule', schedule.name, schedule.function)),
        ...Object.entries(server.events ?? {}).map(([type, fn]) => trigger('event', type, fn)),
        ...(server.hooks ?? []).map((hook) => trigger('hook', hook.name, hook.function)),
    ];
}
/**
 * Whether the UI may call `functions[name]` with `olan.backend.call(name)` (§15.1). A function
 * named as the `function` fallback of a schedule or hook, or as a `server.events` value, is a
 * trigger handler: it runs only for its trigger (hooks only after their signature check), never
 * from the UI. Hosts answer such calls `backend_function_not_found`, exactly like a missing
 * function, so the answer does not reveal it. Without `server` nothing is callable.
 */
export function backendCallable(manifest, name) {
    const server = manifest?.server;
    if (!server || typeof server !== 'object' || !BACKEND_FUNCTION_PATTERN.test(name))
        return false;
    return !backendTriggers(server).some((trigger) => trigger.fallback === name);
}
/** Whether a `defineBackend(...)` value has a handler for `trigger` (§15.1). */
export function backendHandlerResolves(definition, trigger) {
    if (typeof definition !== 'object' || definition === null)
        return false;
    const map = (key) => {
        const value = definition[key];
        return typeof value === 'object' && value !== null ? value : undefined;
    };
    const own = (record, name) => record !== undefined && Object.prototype.hasOwnProperty.call(record, name) && typeof record[name] === 'function';
    const kindMap = map(trigger.kind === 'schedule' ? 'schedules' : trigger.kind === 'event' ? 'events' : 'hooks');
    return own(kindMap, trigger.name) || (trigger.fallback !== undefined && own(map('functions'), trigger.fallback));
}
// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------
const CRON_FIELDS = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
    { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
function cronValue(text, field) {
    if (/^\d+$/.test(text))
        return Number(text);
    if ('names' in field) {
        const index = field.names.indexOf(text.toLowerCase());
        if (index >= 0)
            return field === CRON_FIELDS[3] ? index + 1 : index;
    }
    return null;
}
/** Values a cron field allows, or an error message. */
function expandCronField(text, field) {
    const values = new Set();
    for (const part of text.split(',')) {
        const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
        if (!match)
            return `invalid ${field.name} "${part}"`;
        const step = match[2] === undefined ? 1 : Number(match[2]);
        if (!Number.isInteger(step) || step < 1)
            return `invalid step in ${field.name} "${part}"`;
        let from = field.min;
        let to = field.max;
        if (match[1] !== '*') {
            const [a, b] = match[1].split('-');
            const start = cronValue(a, field);
            const end = b === undefined ? (match[2] === undefined ? start : field.max) : cronValue(b, field);
            if (start === null || end === null || start < field.min || end > field.max || start > end)
                return `invalid ${field.name} "${part}" (${field.min}–${field.max})`;
            from = start;
            to = end;
        }
        for (let value = from; value <= to; value += step)
            values.add(value);
    }
    return [...values].sort((a, b) => a - b);
}
/** Problems of a five-field cron expression (empty when valid and at least `scheduleMinMinutes` apart). */
export function cronProblems(cron) {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5)
        return ['cron needs five fields: minute hour day-of-month month day-of-week'];
    const expanded = parts.map((part, index) => expandCronField(part, CRON_FIELDS[index]));
    const errors = expanded.filter((value) => typeof value === 'string');
    if (errors.length > 0)
        return errors;
    const [minutes, hours] = expanded;
    const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute)).sort((a, b) => a - b);
    let gap = times.length > 1 ? Infinity : 1440;
    for (let index = 1; index < times.length; index++)
        gap = Math.min(gap, times[index] - times[index - 1]);
    if (times.length > 1)
        gap = Math.min(gap, times[0] + 1440 - times[times.length - 1]);
    return gap < BACKEND_LIMITS.scheduleMinMinutes ? [`runs ${gap} minute(s) apart; schedules must be at least ${BACKEND_LIMITS.scheduleMinMinutes} minutes apart`] : [];
}
function isTimeZone(value) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// zod
// ---------------------------------------------------------------------------
const functionName = z.string().regex(BACKEND_FUNCTION_PATTERN).describe('Exported function of the backend module.');
const backendName = z.string().regex(BACKEND_NAME_PATTERN);
const fallbackDescription = (map) => `Optional fallback: functions[function] of the backend module, used when defineBackend has no ${map}. A function named here is never callable from the UI (olan.backend.call).`;
export const serverSchema = z
    .strictObject({
    entry: z
        .string()
        .refine((value) => isPackagePath(value) && SERVER_ENTRY_PATTERN.test(value), 'entry must be a .ts/.tsx/.js/.mjs path inside the package')
        .describe('Backend module inside the package, normally "server/index.ts".'),
    schedules: z
        .array(z.strictObject({
        name: backendName,
        cron: z.string().superRefine((value, ctx) => {
            for (const message of cronProblems(value))
                ctx.addIssue({ code: 'custom', message });
        }),
        timeZone: z.string().refine(isTimeZone, 'unknown IANA time zone').optional(),
        function: functionName.optional().describe(fallbackDescription('schedules[name]')),
    }))
        .max(BACKEND_LIMITS.schedules)
        .optional()
        .describe(`Scheduled runs (≤ ${BACKEND_LIMITS.schedules}, at least ${BACKEND_LIMITS.scheduleMinMinutes} minutes apart).`),
    events: z
        .record(z.string(), functionName)
        .optional()
        .describe(`Event type → fallback function (used when defineBackend has no events[type]; never callable from the UI). Event types: ${EVENT_TYPES.join(', ')}.`),
    hooks: z
        .array(z.strictObject({
        name: backendName,
        function: functionName.optional().describe(fallbackDescription('hooks[name]')),
        verify: z.strictObject({
            kind: z.enum(HOOK_VERIFY_KINDS),
            header: z.string().min(1).max(128).optional(),
            secretSetting: z.string().min(1).max(64).optional(),
        }),
    }))
        .max(BACKEND_LIMITS.hooks)
        .optional()
        .describe('Incoming webhooks: POST /api/v2/apps/hooks/<installationId>/<name>.'),
})
    .describe('Backend code that runs on the Olan server, in an isolated sandbox (docs/backend.md).');

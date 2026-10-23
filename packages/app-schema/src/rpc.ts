import { HTTP_PERMISSION_PATTERN, isHttpUrlAllowed } from './permissions.js';

/**
 * Error codes carried in `rpc-result` failures (contract §4; Phase 1b §3.2 added the last five).
 * Additive: hosts that predate a code never send it; `rpc-result.error` stays `{ code, message }`.
 */
export const RPC_ERROR_CODES = [
  'permission_denied',
  'not_installed',
  'invalid_params',
  'unknown_method',
  'host_error',
  'http_blocked',
  'cancelled',
  'quota_exceeded',
  'conflict',
  'forbidden_record',
  'not_found',
  'validation_failed',
  // Phase 3 §15: `backend.call` failures (see `BACKEND_RUNTIME_ERRORS` in backend.ts).
  'backend_function_not_found',
  'backend_error',
  'backend_limit',
  'backend_busy',
  'payload_too_large',
  'backend_unavailable',
  // Decision 2026-10-18: the installed version's `migrate` has not succeeded yet (retried with backoff).
  'backend_migrating',
  // Phase 5a §1.6: `remote.request` (with `payload_too_large`); §3.2: `files.upload`.
  'remote_unavailable',
  'remote_rejected',
  'consent_required',
  'rate_limited',
  'feature_not_enabled',
  'upload_failed',
  // Phase 6: the call names a project the app is not enabled in (a member adds it in "Uygulamalar").
  'project_not_enabled',
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

/**
 * Permission each `olan.*` RPC method needs. `null` means none. `http:*`
 * means the host must check the request URL's host against the granted
 * `http:<host>` permissions (see `isHttpUrlAllowed`).
 *
 * Extension point: a new method is one line here. Each method maps to exactly
 * one permission; a method that more than one permission unlocks lists the
 * others in `ALTERNATIVE_PERMISSIONS`. The host, the server guard and the CLI
 * mock server check calls only through `methodAllowed`.
 */
const METHOD_PERMISSIONS = {
  'projects.list': 'projects:read',
  'projects.get': 'projects:read',
  'projects.tasks': 'projects:read',
  'projects.createTask': 'tasks:write',
  'projects.updateTask': 'tasks:write',
  'projects.deleteTask': 'tasks:delete',
  'projects.deleteList': 'projects:delete',
  'users.get': 'users:read',
  'chat.conversations': 'chat:read',
  'chat.messages': 'chat:read',
  // Phase 3 (contract §3.2, §7.2)
  'chat.postCard': 'chat:write',
  'chat.updateCard': 'chat:write',
  'calendar.calendars': 'calendar:read',
  'calendar.events': 'calendar:read',
  'calendar.createEvent': 'calendar:write',
  'calendar.updateEvent': 'calendar:write',
  'calendar.deleteEvent': 'calendar:delete',
  'contacts.addressBooks': 'contacts:read',
  'contacts.search': 'contacts:read',
  'contacts.create': 'contacts:write',
  'contacts.update': 'contacts:write',
  'contacts.delete': 'contacts:delete',
  // Host-side: only the message in the invocation context (`mail.sidebar` / `mail.action` params).
  'mail.getMessage': 'mail:read',
  'meetings.get': 'meetings:read',
  'projects.create': 'projects:create',
  'projects.archive': 'projects:archive',
  // Phase 3 §8.1: needs the manifest `server` (the host checks it), runs with the caller's permissions.
  'backend.call': null,
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.remove': 'storage',
  'storage.keys': 'storage',
  'db.insert': 'db',
  'db.get': 'db',
  'db.query': 'db',
  'db.update': 'db',
  'db.delete': 'db',
  'db.count': 'db',
  'settings.get': null,
  // Phase 6: the app's configuration of a project it is enabled in (any member reads, writers change).
  'project.config.get': null,
  'project.config.set': null,
  // Phase 6 (second wave): what the app adds to projects it is enabled in (the project's grant decides
  // where; these decide what). Reads need `projects:read`.
  'project.statuses.list': 'projects:read',
  'project.statuses.define': 'projects:extend',
  'project.statuses.remove': 'projects:extend',
  'project.labels.list': 'projects:read',
  'project.labels.define': 'projects:extend',
  'project.labels.remove': 'projects:extend',
  // Custom fields: the app defines its own (members fill them in) and reads/writes values of records.
  'project.fields.list': 'projects:read',
  'project.fields.define': 'projects:extend',
  'project.fields.remove': 'projects:extend',
  'project.fields.values': 'projects:read',
  'project.fields.setValues': 'tasks:write',
  // Records of the app linked to tasks and issues, with the card the app draws on them.
  'project.links.list': 'projects:read',
  'project.links.upsert': 'tasks:write',
  'project.links.remove': 'tasks:write',
  'project.links.setStatus': 'tasks:write',
  'project.calendar.list': 'projects:read',
  'project.calendar.upsert': 'projects:extend',
  'project.calendar.remove': 'projects:extend',
  'project.activity.post': 'projects:extend',
  'project.approvals.list': 'projects:read',
  'project.approvals.request': 'projects:extend',
  'project.approvals.cancel': 'projects:extend',
  'http.fetch': HTTP_PERMISSION_PATTERN,
  'ui.confirm': null,
  'ui.prompt': null,
  'ui.toast': null,
  'ui.menu': null,
  'ui.datePicker': null,
  'ui.share': null,
  // Phase 5a §5 (G5): any https URL (http only to private hosts in development).
  'ui.openUrl': null,
  'ui.openExternal': null,
  // Phase 5a §1 (G1): the implied `remote`; the host also requires the manifest `remote.requests`.
  'remote.request': 'remote',
  // Phase 5a §3 (G3).
  'files.pick': 'files:pick',
  'files.upload': 'files:pick',
  'files.cancel': 'files:pick',
  // Phase 5a §7 (G7): host-driven `useQuery` refetch timers.
  'timers.set': null,
  'timers.clear': null,
  'navigation.push': null,
  'navigation.pop': null,
  'navigation.replace': null,
} as const satisfies Record<string, string | null>;

export type RpcMethod = keyof typeof METHOD_PERMISSIONS;

/** Most ids one `users.get` call may ask for (`{ ids }`); more is `invalid_params`. */
export const USERS_GET_MAX_IDS = 100;

/** Phase 3 RPC limits (contract §7.2, §10). */
export const RPC_LIMITS = Object.freeze({
  /** `calendar.events` `limit`. */
  calendarEvents: 200,
  /** `calendar.events` `from`..`to` span in days. */
  calendarRangeDays: 366,
  /** `contacts.search` `limit`. */
  contactsSearch: 50,
  /** `timers.set` `intervalMs` (Phase 5a §7): smaller `useQuery` intervals are raised to this. */
  timerMinIntervalMs: 5000,
  /** Timers per sandbox. */
  timersPerSandbox: 16,
  /** Phase 6: statuses, labels or fields one `project.statuses.define` / `project.labels.define` / `project.fields.define` call may carry. */
  projectDefinitions: 20,
  /** Phase 6: `project.calendar.list` span in days, and items one app keeps per project. */
  projectCalendarRangeDays: 366,
  projectCalendarItems: 500,
  /** Phase 6: links one app keeps per task or issue. */
  recordLinksPerTarget: 10,
  /** Phase 6: `project.activity.post` text (characters). */
  projectActivityText: 280,
  /** Phase 6: approvers of one `project.approvals.request`. */
  projectApprovers: 10,
});

/**
 * `reason` of `forbidden_record` failures (Phase 1b §4.6, Phase 3 §7.3): `system_record` (Olan
 * meetings, project calendars, shared address books), `not_organizer` (someone else's invitation),
 * `permission_denied` (the calendar or address book is read-only).
 */
export const FORBIDDEN_RECORD_REASONS = ['default_record', 'not_empty', 'workflow_record', 'not_created_by_app', 'rule', 'system_record', 'not_organizer', 'permission_denied'] as const;
export type ForbiddenRecordReason = (typeof FORBIDDEN_RECORD_REASONS)[number];

export const REQUIRED_PERMISSION: Readonly<Record<string, string | null>> = Object.freeze({ ...METHOD_PERMISSIONS });

/**
 * Other permissions that also unlock a method (any one is enough). `projects:write` keeps its
 * Phase 1 meaning: it still allows `projects.updateTask` for apps written before `tasks:write`.
 */
export const ALTERNATIVE_PERMISSIONS: Readonly<Record<string, readonly string[] | undefined>> = Object.freeze({
  'projects.updateTask': Object.freeze(['projects:write']),
  'project.links.setStatus': Object.freeze(['projects:write']),
});

export const RPC_METHODS: readonly string[] = Object.freeze(Object.keys(REQUIRED_PERMISSION));

/** Methods the SDK calls for the app (`useQuery` refetch timers), not exposed as `olan.*`. */
export const INTERNAL_RPC_METHODS: readonly string[] = Object.freeze(['timers.set', 'timers.clear']);

export function isRpcMethod(method: unknown): method is RpcMethod {
  return typeof method === 'string' && Object.prototype.hasOwnProperty.call(REQUIRED_PERMISSION, method);
}

/** Every permission that unlocks `method` (the required one first); empty when none is needed. */
export function permissionsForMethod(method: string): readonly string[] {
  if (!isRpcMethod(method)) return [];
  const required = REQUIRED_PERMISSION[method];
  if (!required) return [];
  const alternatives = Object.prototype.hasOwnProperty.call(ALTERNATIVE_PERMISSIONS, method) ? ALTERNATIVE_PERMISSIONS[method] : undefined;
  return [required, ...(alternatives ?? [])];
}

/**
 * Whether a call to `method` is allowed with the `granted` permissions: the method's
 * `REQUIRED_PERMISSION` or one of its `ALTERNATIVE_PERMISSIONS`. `http.fetch` also needs `url`,
 * which must match a granted `http:<host>` (`isHttpUrlAllowed`). Unknown methods are not allowed.
 */
export function methodAllowed(method: string, granted: readonly string[], url?: string): boolean {
  if (!isRpcMethod(method)) return false;
  const required = REQUIRED_PERMISSION[method];
  if (required === null || required === undefined) return true;
  if (required === HTTP_PERMISSION_PATTERN) return typeof url === 'string' && isHttpUrlAllowed(url, granted);
  return permissionsForMethod(method).some((permission) => granted.includes(permission));
}

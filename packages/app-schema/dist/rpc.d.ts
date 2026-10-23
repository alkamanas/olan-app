/**
 * Error codes carried in `rpc-result` failures (contract §4; Phase 1b §3.2 added the last five).
 * Additive: hosts that predate a code never send it; `rpc-result.error` stays `{ code, message }`.
 */
export declare const RPC_ERROR_CODES: readonly ["permission_denied", "not_installed", "invalid_params", "unknown_method", "host_error", "http_blocked", "cancelled", "quota_exceeded", "conflict", "forbidden_record", "not_found", "validation_failed", "backend_function_not_found", "backend_error", "backend_limit", "backend_busy", "payload_too_large", "backend_unavailable", "backend_migrating", "remote_unavailable", "remote_rejected", "consent_required", "rate_limited", "feature_not_enabled", "upload_failed", "project_not_enabled"];
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
declare const METHOD_PERMISSIONS: {
    readonly 'projects.list': "projects:read";
    readonly 'projects.get': "projects:read";
    readonly 'projects.tasks': "projects:read";
    readonly 'projects.createTask': "tasks:write";
    readonly 'projects.updateTask': "tasks:write";
    readonly 'projects.deleteTask': "tasks:delete";
    readonly 'projects.deleteList': "projects:delete";
    readonly 'users.get': "users:read";
    readonly 'chat.conversations': "chat:read";
    readonly 'chat.messages': "chat:read";
    readonly 'chat.postCard': "chat:write";
    readonly 'chat.updateCard': "chat:write";
    readonly 'calendar.calendars': "calendar:read";
    readonly 'calendar.events': "calendar:read";
    readonly 'calendar.createEvent': "calendar:write";
    readonly 'calendar.updateEvent': "calendar:write";
    readonly 'calendar.deleteEvent': "calendar:delete";
    readonly 'contacts.addressBooks': "contacts:read";
    readonly 'contacts.search': "contacts:read";
    readonly 'contacts.create': "contacts:write";
    readonly 'contacts.update': "contacts:write";
    readonly 'contacts.delete': "contacts:delete";
    readonly 'mail.getMessage': "mail:read";
    readonly 'meetings.get': "meetings:read";
    readonly 'projects.create': "projects:create";
    readonly 'projects.archive': "projects:archive";
    readonly 'backend.call': null;
    readonly 'storage.get': "storage";
    readonly 'storage.set': "storage";
    readonly 'storage.remove': "storage";
    readonly 'storage.keys': "storage";
    readonly 'db.insert': "db";
    readonly 'db.get': "db";
    readonly 'db.query': "db";
    readonly 'db.update': "db";
    readonly 'db.delete': "db";
    readonly 'db.count': "db";
    readonly 'settings.get': null;
    readonly 'project.config.get': null;
    readonly 'project.config.set': null;
    readonly 'project.statuses.list': "projects:read";
    readonly 'project.statuses.define': "projects:extend";
    readonly 'project.statuses.remove': "projects:extend";
    readonly 'project.labels.list': "projects:read";
    readonly 'project.labels.define': "projects:extend";
    readonly 'project.labels.remove': "projects:extend";
    readonly 'project.fields.list': "projects:read";
    readonly 'project.fields.define': "projects:extend";
    readonly 'project.fields.remove': "projects:extend";
    readonly 'project.fields.values': "projects:read";
    readonly 'project.fields.setValues': "tasks:write";
    readonly 'project.links.list': "projects:read";
    readonly 'project.links.upsert': "tasks:write";
    readonly 'project.links.remove': "tasks:write";
    readonly 'project.links.setStatus': "tasks:write";
    readonly 'project.calendar.list': "projects:read";
    readonly 'project.calendar.upsert': "projects:extend";
    readonly 'project.calendar.remove': "projects:extend";
    readonly 'project.activity.post': "projects:extend";
    readonly 'project.approvals.list': "projects:read";
    readonly 'project.approvals.request': "projects:extend";
    readonly 'project.approvals.cancel': "projects:extend";
    readonly 'http.fetch': "http:*";
    readonly 'ui.confirm': null;
    readonly 'ui.prompt': null;
    readonly 'ui.toast': null;
    readonly 'ui.menu': null;
    readonly 'ui.datePicker': null;
    readonly 'ui.share': null;
    readonly 'ui.openUrl': null;
    readonly 'ui.openExternal': null;
    readonly 'remote.request': "remote";
    readonly 'files.pick': "files:pick";
    readonly 'files.upload': "files:pick";
    readonly 'files.cancel': "files:pick";
    readonly 'timers.set': null;
    readonly 'timers.clear': null;
    readonly 'navigation.push': null;
    readonly 'navigation.pop': null;
    readonly 'navigation.replace': null;
};
export type RpcMethod = keyof typeof METHOD_PERMISSIONS;
/** Most ids one `users.get` call may ask for (`{ ids }`); more is `invalid_params`. */
export declare const USERS_GET_MAX_IDS = 100;
/** Phase 3 RPC limits (contract §7.2, §10). */
export declare const RPC_LIMITS: Readonly<{
    /** `calendar.events` `limit`. */
    calendarEvents: 200;
    /** `calendar.events` `from`..`to` span in days. */
    calendarRangeDays: 366;
    /** `contacts.search` `limit`. */
    contactsSearch: 50;
    /** `timers.set` `intervalMs` (Phase 5a §7): smaller `useQuery` intervals are raised to this. */
    timerMinIntervalMs: 5000;
    /** Timers per sandbox. */
    timersPerSandbox: 16;
    /** Phase 6: statuses, labels or fields one `project.statuses.define` / `project.labels.define` / `project.fields.define` call may carry. */
    projectDefinitions: 20;
    /** Phase 6: `project.calendar.list` span in days, and items one app keeps per project. */
    projectCalendarRangeDays: 366;
    projectCalendarItems: 500;
    /** Phase 6: links one app keeps per task or issue. */
    recordLinksPerTarget: 10;
    /** Phase 6: `project.activity.post` text (characters). */
    projectActivityText: 280;
    /** Phase 6: approvers of one `project.approvals.request`. */
    projectApprovers: 10;
}>;
/**
 * `reason` of `forbidden_record` failures (Phase 1b §4.6, Phase 3 §7.3): `system_record` (Olan
 * meetings, project calendars, shared address books), `not_organizer` (someone else's invitation),
 * `permission_denied` (the calendar or address book is read-only).
 */
export declare const FORBIDDEN_RECORD_REASONS: readonly ["default_record", "not_empty", "workflow_record", "not_created_by_app", "rule", "system_record", "not_organizer", "permission_denied"];
export type ForbiddenRecordReason = (typeof FORBIDDEN_RECORD_REASONS)[number];
export declare const REQUIRED_PERMISSION: Readonly<Record<string, string | null>>;
/**
 * Other permissions that also unlock a method (any one is enough). `projects:write` keeps its
 * Phase 1 meaning: it still allows `projects.updateTask` for apps written before `tasks:write`.
 */
export declare const ALTERNATIVE_PERMISSIONS: Readonly<Record<string, readonly string[] | undefined>>;
export declare const RPC_METHODS: readonly string[];
/** Methods the SDK calls for the app (`useQuery` refetch timers), not exposed as `olan.*`. */
export declare const INTERNAL_RPC_METHODS: readonly string[];
export declare function isRpcMethod(method: unknown): method is RpcMethod;
/** Every permission that unlocks `method` (the required one first); empty when none is needed. */
export declare function permissionsForMethod(method: string): readonly string[];
/**
 * Whether a call to `method` is allowed with the `granted` permissions: the method's
 * `REQUIRED_PERMISSION` or one of its `ALTERNATIVE_PERMISSIONS`. `http.fetch` also needs `url`,
 * which must match a granted `http:<host>` (`isHttpUrlAllowed`). Unknown methods are not allowed.
 */
export declare function methodAllowed(method: string, granted: readonly string[], url?: string): boolean;
export {};

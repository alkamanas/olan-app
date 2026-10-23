/**
 * `@olan-app/sdk/backend`: backend code (manifest `server`, Phase 3 contract §8.1, §15).
 *
 * `olan-app build` bundles `server.entry` with this module into `dist/server.js` (an IIFE with
 * `globalName: '__olanBackendModule'`). Olan runs it in an isolated sandbox (`@olan-app/runtime`:
 * isolated-vm, QuickJS as fallback) with no Node APIs, no network and no `fetch`; everything goes
 * through `olan.*`, which calls the host over `globalThis.__olan.call(method, argsJson)`.
 *
 * ```ts
 * import { defineBackend, olan } from '@olan-app/sdk/backend';
 *
 * export default defineBackend({
 *   functions: { async summary(args, ctx) { return { count: await olan.db.collection('items').count() }; } },
 *   events: { 'project.task.created': async (event, ctx) => { … } },
 *   schedules: { digest: async (ctx) => { … } },
 *   hooks: { github: async (request, ctx) => ({ status: 204 }) },
 * });
 * ```
 *
 * Handler resolution (§15.1): `olan.backend.call(name)` → `functions[name]` only; schedule →
 * `schedules[schedule.name]`, else `functions[schedule.function]`; event → `events[type]`, else
 * `functions[server.events[type]]`; hook → `hooks[hook.name]`, else `functions[hook.function]`.
 * No handler → `not_found` (`backend_function_not_found` in the UI). Put trigger handlers in
 * `schedules`/`events`/`hooks`: a `functions` entry named as a trigger's fallback (`function` of a
 * schedule or hook, a `server.events` value) is not callable from the UI.
 */
import type { AnyAppEvent, AppCard, DbQuery, DbRow, DbWhere, EventType, JsonValue } from '@olan-app/schema';

import type { DbData, DbPatch } from '../api/db';
import { projectExtensions } from '../api/project-extensions';
import type {
  AddressBook,
  Calendar,
  CalendarEvent,
  CalendarEventsQuery,
  Contact,
  Conversation,
  CreateContactInput,
  CreateEventInput,
  CreateProjectInput,
  CreateTaskInput,
  DeleteRecordInput,
  DirectoryUser,
  HttpRequestInit,
  HttpResponse,
  HttpResponseData,
  Meeting,
  Message,
  PostCardInput,
  Project,
  ProjectDetail,
  ProjectListResult,
  ProjectTask,
  ProjectTaskStatus,
  UpdateContactInput,
  UpdateEventInput,
  UpdateTaskInput,
  ProjectConfig,
  ProjectConfigSetOptions,
} from '../api/types';

export type { AnyAppEvent, EventType, JsonValue } from '@olan-app/schema';
export type { DbData, DbPatch } from '../api/db';

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/** Who a backend invocation runs as (§8.1): the caller for `backend.call`, the app identity otherwise. */
export interface BackendIdentity {
  /** `user` for `backend.call` (with the caller's consented permissions), `app` for schedules, events and hooks. */
  actor: 'user' | 'app';
  /** The calling person (`backend.call` only). */
  userId: string | null;
  permissions: string[];
}

export interface BackendContext {
  installationId: string;
  appId: string;
  identity: BackendIdentity;
  /**
   * Present for API compatibility, but it never aborts: when an invocation runs out of time
   * (10 s for `backend.call`, 30 s otherwise) Olan tears the sandbox down instead, so no code of
   * that invocation runs after the deadline. Keep work short; persist progress in `olan.db`.
   */
  signal: AbortSignal;
}

/** Context of a schedule handler (`schedules[name]`). */
export interface BackendScheduleContext extends BackendContext {
  /** The schedule's name. */
  schedule: string;
  /** ISO time the run was due. */
  scheduledAt: string;
}

/**
 * `olan.backend.call(name, args)` from the app's UI lands here (`args` is the JSON the UI sent).
 * The result must be JSON (`undefined` becomes `null`) and at most 256 KiB.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- args are untyped JSON from the UI; apps narrow them
export type BackendFunction = (args: any, context: BackendContext) => unknown;
export type BackendEventHandler<T extends EventType = EventType> = (event: Extract<AnyAppEvent, { type: T }>, context: BackendContext) => unknown;
export type BackendScheduleHandler = (context: BackendScheduleContext) => unknown;

/** A verified incoming webhook (`POST /api/v2/apps/hooks/<installationId>/<name>`, ≤ 1 MiB). */
export interface BackendHookRequest {
  method: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Raw body text. */
  body: string;
  query: Record<string, string>;
}

/**
 * Answered when the function returns it within 10 s with `status` 200–599; otherwise (no return
 * value, no valid `status`, or later) Olan answers `202`. Only `content-type`, `cache-control`,
 * `etag`, `last-modified` and `x-*` headers are kept.
 */
export interface BackendHookResponse {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as is (default `text/plain`); any other JSON value as JSON (default `application/json`). */
  body?: JsonValue;
}

export type BackendHookHandler = (request: BackendHookRequest, context: BackendContext) => BackendHookResponse | void | Promise<BackendHookResponse | void>;

export interface BackendDefinition {
  /**
   * Callable from the UI with `olan.backend.call(name, args)`. Names used as a trigger's fallback
   * (manifest `function` of a schedule or hook, a `server.events` value) are not: put trigger
   * handlers in `schedules`, `events` and `hooks` instead.
   */
  functions?: Record<string, BackendFunction>;
  /** By event type (else the manifest `server.events[type]` function). */
  events?: { [T in EventType]?: BackendEventHandler<T> };
  /** By schedule name (else the schedule's optional `function`). */
  schedules?: Record<string, BackendScheduleHandler>;
  /** By hook name (else the hook's optional `function`). Runs only after the request is verified. */
  hooks?: Record<string, BackendHookHandler>;
  /** Runs once after an update, before new invocations (`fromVersion` is the previous app version). */
  migrate?: (fromVersion: string, context: BackendContext) => unknown;
}

export interface BackendModule extends Readonly<BackendDefinition> {
  readonly $olanBackend: 1;
}

/** Declares the backend module (`export default defineBackend({ … })` in `server/index.ts`). */
export function defineBackend(definition: BackendDefinition): BackendModule {
  return Object.freeze({ ...definition, $olanBackend: 1 as const });
}

export function isBackendModule(value: unknown): value is BackendModule {
  return typeof value === 'object' && value !== null && (value as { $olanBackend?: unknown }).$olanBackend === 1;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failed `olan.*` call in backend code. `code` is the host's error code: the UI RPC codes
 * (`permission_denied`, `http_blocked`, `invalid_params`, `conflict`, `forbidden_record`,
 * `not_found`, `validation_failed`, `quota_exceeded`, `unknown_method`, `host_error`) or
 * `backend_unavailable` (no Olan backend runtime here).
 */
export class OlanBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OlanBackendError';
    this.code = code;
  }
}

/** `olan.*` used outside the backend runtime (e.g. imported into the UI bundle or a plain Node script). */
export class BackendUnavailableError extends OlanBackendError {
  constructor(what: string) {
    super('backend_unavailable', `${what} only works inside the Olan backend runtime (manifest "server"); from the UI use olan.backend.call`);
    this.name = 'BackendUnavailableError';
  }
}

/** Whether `error` is an `OlanBackendError` (optionally with this `code`), also by shape across realms. */
export function isOlanBackendError(error: unknown, code?: string): error is OlanBackendError {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const shaped =
    error instanceof OlanBackendError ||
    ((name === 'OlanBackendError' || name === 'BackendUnavailableError') && typeof (error as { code?: unknown }).code === 'string');
  return shaped && (code === undefined || (error as { code: string }).code === code);
}

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

interface OlanBridge {
  call(method: string, argsJson: string): Promise<string>;
}

function bridge(method: string): OlanBridge {
  const candidate = (globalThis as { __olan?: OlanBridge }).__olan;
  if (!candidate || typeof candidate.call !== 'function') throw new BackendUnavailableError(`olan.${method}`);
  return candidate;
}

/** Calls the host method `method` (the UI RPC name) with JSON `params`; host errors become `OlanBackendError`. */
async function call<T>(method: string, params: unknown): Promise<T> {
  const host = bridge(method);
  let text: string;
  try {
    text = await host.call(method, JSON.stringify(params ?? {}));
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown } | null;
    const code = typeof failure?.code === 'string' ? failure.code : 'host_error';
    const message = typeof failure?.message === 'string' ? failure.message : String(error);
    throw new OlanBackendError(code, message);
  }
  if (typeof text !== 'string' || text === '') return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OlanBackendError('host_error', `olan.${method}: the host answered with invalid JSON`);
  }
}

// ---------------------------------------------------------------------------
// olan.* (method names and params are the UI RPC ones, docs/api.md)
// ---------------------------------------------------------------------------

export interface BackendDbCollection<T extends DbData = Record<string, JsonValue>> {
  readonly name: string;
  insert(data: T): Promise<DbRow<T>>;
  get(id: string): Promise<DbRow<T> | null>;
  query(query?: DbQuery): Promise<{ rows: DbRow<T>[]; nextCursor: string | null }>;
  update(id: string, patch: DbPatch<T>, options: { revision: number }): Promise<DbRow<T>>;
  delete(id: string, options?: { revision?: number }): Promise<void>;
  count(where?: DbWhere): Promise<number>;
}

function collection<T extends DbData = Record<string, JsonValue>>(name: string): BackendDbCollection<T> {
  if (typeof name !== 'string' || name.length === 0) throw new OlanBackendError('invalid_params', 'olan.db.collection needs a collection name');
  return Object.freeze({
    name,
    insert: (data: T) => call<DbRow<T>>('db.insert', { collection: name, data }),
    get: (id: string) => call<DbRow<T> | null>('db.get', { collection: name, id }),
    query: (query: DbQuery = {}) => call<{ rows: DbRow<T>[]; nextCursor: string | null }>('db.query', { collection: name, ...query }),
    update: (id: string, patch: DbPatch<T>, options: { revision: number }) => call<DbRow<T>>('db.update', { collection: name, id, patch, revision: options?.revision }),
    delete: (id: string, options: { revision?: number } = {}) =>
      call<null>('db.delete', { collection: name, id, ...(options.revision === undefined ? {} : { revision: options.revision }) }).then(() => undefined),
    count: (where?: DbWhere) => call<number>('db.count', { collection: name, ...(where === undefined ? {} : { where }) }),
  });
}

const USERS_PER_CALL = 100;

const api = {
  secrets: Object.freeze({
    /**
     * A `secret: true` setting of the installation, or `null` when it is not set. Only backend
     * code can read secrets: for apps with `server`, `olan.settings.get()` in the UI (and here)
     * answers `null` for them. Host method `secrets.get` `{ name }`.
     */
    get: (name: string) => call<string | null>('secrets.get', { name }),
  }),
  settings: Object.freeze({
    /** The installation's settings; `secret: true` fields are `null` (use `olan.secrets.get`). */
    get: () => call<Record<string, JsonValue>>('settings.get', {}),
  }),
  /** The app database (manifest `data`, permission `db`); same API as the UI `olan.db`. */
  db: Object.freeze({ collection }),
  http: Object.freeze({
    /** A request through Olan; only granted `http:<host>` permissions are reachable (`http_blocked`). */
    async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
      const response = await call<HttpResponseData>('http.fetch', { url, ...init });
      return {
        ...response,
        json<T = JsonValue>(): T {
          try {
            return JSON.parse(response.body) as T;
          } catch {
            throw new OlanBackendError('invalid_params', 'The response body is not JSON');
          }
        },
      };
    },
  }),
  /** Phase 6: the app's configuration of a project it is enabled in (same API as the UI `olan.project`). */
  project: Object.freeze({
    config: Object.freeze({
      get: (projectId: string) => call<ProjectConfig>('project.config.get', { projectId }),
      set: (projectId: string, value: Record<string, JsonValue>, options: ProjectConfigSetOptions = {}) =>
        call<ProjectConfig>('project.config.set', { projectId, value, ...(options.revision === undefined ? {} : { revision: options.revision }) }),
    }),
    // Phase 6 (second wave): statuses, labels, custom fields, record links, calendar layer, feed lines, approvals.
    ...projectExtensions((method, params) => call(method, params) as never),
  }),
  projects: Object.freeze({
    list: (options: { limit?: number; cursor?: string } = {}) => call<ProjectListResult>('projects.list', options),
    get: (projectId: string) => call<ProjectDetail>('projects.get', { projectId }),
    tasks: (projectId: string, options: { status?: ProjectTaskStatus } = {}) => call<ProjectTask[]>('projects.tasks', { projectId, ...options }),
    updateTask: (projectId: string, taskId: string, change: UpdateTaskInput) => call<ProjectTask>('projects.updateTask', { projectId, taskId, ...change }),
    createTask: (projectId: string, task: CreateTaskInput) => call<ProjectTask>('projects.createTask', { projectId, ...task }),
    deleteTask: (projectId: string, taskId: string, options: DeleteRecordInput) =>
      call<null>('projects.deleteTask', { projectId, taskId, revision: options?.revision }).then(() => undefined),
    deleteList: (projectId: string, listId: string, options: DeleteRecordInput) =>
      call<null>('projects.deleteList', { projectId, listId, revision: options?.revision }).then(() => undefined),
    create: (input: CreateProjectInput) => call<Project>('projects.create', input),
    archive: (projectId: string) => call<null>('projects.archive', { projectId }).then(() => undefined),
  }),
  users: Object.freeze({
    /** Directory entries (`users:read`); duplicates asked once, more than 100 ids split into several calls. */
    async get(ids: readonly string[]): Promise<DirectoryUser[]> {
      const unique = [...new Set(ids)];
      const batches: string[][] = [];
      for (let start = 0; start < unique.length; start += USERS_PER_CALL) batches.push(unique.slice(start, start + USERS_PER_CALL));
      const results = await Promise.all(batches.map((batch) => call<{ users: DirectoryUser[] }>('users.get', { ids: batch })));
      return results.flatMap((result) => result.users);
    },
  }),
  chat: Object.freeze({
    conversations: () => call<Conversation[]>('chat.conversations', {}),
    messages: (conversationId: string, options: { limit?: number } = {}) => call<Message[]>('chat.messages', { conversationId, ...options }),
    postCard: (input: PostCardInput) => call<{ messageId: string }>('chat.postCard', input),
    updateCard: (messageId: string, card: AppCard) => call<{ messageId: string }>('chat.updateCard', { messageId, card }),
  }),
  calendar: Object.freeze({
    calendars: () => call<{ calendars: Calendar[] }>('calendar.calendars', {}).then((result) => result.calendars),
    events: (query: CalendarEventsQuery) => call<{ events: CalendarEvent[] }>('calendar.events', query).then((result) => result.events),
    createEvent: (input: CreateEventInput) => call<CalendarEvent>('calendar.createEvent', input),
    updateEvent: (eventId: string, patch: UpdateEventInput) => call<CalendarEvent>('calendar.updateEvent', { eventId, patch }),
    deleteEvent: (eventId: string) => call<null>('calendar.deleteEvent', { eventId }).then(() => undefined),
  }),
  contacts: Object.freeze({
    addressBooks: () => call<{ addressBooks: AddressBook[] }>('contacts.addressBooks', {}).then((result) => result.addressBooks),
    search: (query: string, options: { limit?: number } = {}) => call<{ contacts: Contact[] }>('contacts.search', { query, ...options }).then((result) => result.contacts),
    create: (input: CreateContactInput) => call<Contact>('contacts.create', input),
    update: (contactId: string, patch: UpdateContactInput) => call<Contact>('contacts.update', { contactId, patch }),
    delete: (contactId: string) => call<null>('contacts.delete', { contactId }).then(() => undefined),
  }),
  meetings: Object.freeze({
    get: (meetingId: string) => call<Meeting>('meetings.get', { meetingId }),
  }),
};

/**
 * Olan APIs inside backend code. Each call needs the same permission as in the UI (checked by
 * Olan against the invocation identity: the caller's for `backend.call`, the app's otherwise).
 * Not here: `ui.*`, `navigation.*` (no screen), `storage.*` (per person; use `db`),
 * `mail.getMessage` (bound to an opened mail surface) and `backend.call`.
 */
export const olan = Object.freeze(api);
export type BackendOlan = typeof olan;

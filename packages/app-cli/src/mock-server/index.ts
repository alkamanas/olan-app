import { randomUUID } from 'node:crypto';

import {
  acceptsFile,
  backendMethodAllowed,
  externalUrlProblem,
  isBackendHostMethod,
  isRpcMethod,
  methodAllowed,
  normalizePickOptions,
  parseRemoteAnswer,
  REMOTE_REQUEST_LIMITS,
  REQUIRED_PERMISSION,
  HTTP_PERMISSION_PATTERN,
  RPC_LIMITS,
  UPLOAD_FILE_NAME_HEADER,
  UPLOAD_RESPONSE_HEADERS,
  USERS_GET_MAX_IDS,
  isUuid,
  remoteRequestOutcome,
  uploadFileNameHeader,
  uploadTargetProblem,
  validateCard,
  validateRecordCard,
  validateRemoteRequest,
  validateUploadParams,
  type AppCard,
  type DataSchema,
  type DbRow,
  type FileHandle,
  type RemoteAnswer,
  type RemoteErrorReason,
  type RemoteRequestEnvelope,
} from '@olan-app/schema';
import type {
  CalendarEvent,
  Contact,
  ExternalFlowResult,
  Project,
  ProjectApproval,
  ProjectCalendarItem,
  ProjectDetail,
  ProjectField,
  ProjectFieldValue,
  ProjectLabel,
  ProjectStatus,
  ProjectStatusCategory,
  ProjectTask,
  ProjectTaskList,
  RecordLink,
  RecordTarget,
  RpcMethodName,
  RpcParams,
  RpcResult,
} from '@olan-app/sdk';
import type { HostToSandboxMessage, JsonValue } from '@olan-app/sdk/protocol';
import { createMemoryDb, isMemoryDbError, type MemoryDb, type MemoryDbQuota } from '@olan-app/sdk/memory-db';
import { runRemoteRoute, type RemoteRequestHandler, type RemoteRoutes } from '@olan-app/sdk/server';

import { CliError } from '../errors';
import {
  dbFixtureIssues,
  dbSeed,
  DEFAULT_MOCK_APP,
  DEFAULT_USER_ID,
  defaultStatusFor,
  FIELD_TYPES_WITH_OPTIONS,
  fieldSlug,
  fieldTargetKey,
  FIXTURE_NOW,
  isoInstant,
  LABEL_COLORS,
  MOCK_INSTALLATION_ID,
  normalizeFiles,
  normalizeFieldValue,
  normalizeFixtures,
  PROJECT_FIELD_TYPES,
  sortStatuses,
  STATUS_CATEGORY_COLORS,
  STATUS_CATEGORY_ORDER,
  statusCalDav,
  userFixtureIssues,
  type FixtureFile,
  type Fixtures,
  type MockFile,
  type MockProjectActivity,
  type MockProjectIssue,
  type NormalizedFixtures,
} from './fixtures';

export * from './fixtures';

/** Throw from a mock method to answer with a contract error code (and optional `details`). */
export class MockHostError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = 'MockHostError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** The app server in tests: `handleRequest`-style routes or one handler (Phase 5a `olan.remote.request`). */
export type MockRemoteHandler = RemoteRoutes | RemoteRequestHandler;

/** One `olan.remote.request` as the mock app server got it, with its answer. */
export interface MockRemoteRequest {
  envelope: RemoteRequestEnvelope;
  /** The wrapped answer, or null when there was none (timeout, no handler). */
  answer: RemoteAnswer | null;
}

/** What a `remoteTransport` got back: the app server's wrapper, or why there was no usable answer. */
export type RemoteTransportResult = { ok: true; answer: unknown } | { ok: false; reason: RemoteErrorReason; message: string };

/** A file upload (`olan.files.upload`) with the request the target received. */
export interface MockUpload {
  uploadId: string;
  /** The picked file; `content` is its text (`fixtures/files.json` `content`, else `''`). */
  file: FileHandle & { content: string };
  url: string;
  method: 'PUT' | 'POST';
  /** Request headers as sent (lowercase): `content-type`, `x-olan-file-name`, the app's. */
  headers: Record<string, string>;
  /** POST: the file's multipart field. */
  formField: string | null;
  fields: Record<string, string>;
  status: 'running' | 'done' | 'cancelled' | 'failed';
}

/** What the upload target answers (default 200, no body). */
export interface MockUploadAnswer {
  status?: number;
  /** Only `content-type`, `etag` and `location` reach the app (lower-cased). */
  headers?: Record<string, string>;
  body?: JsonValue;
}

/**
 * The upload target in tests (`renderApp({ upload })`): answer, throw (`upload_failed`) or return a
 * promise that has not settled yet (the upload stays `running`; `cancel()` makes it `cancelled`).
 */
export type MockUploadHandler = (upload: MockUpload) => MockUploadAnswer | Promise<MockUploadAnswer>;

/** A URL the app opened (`olan.ui.openUrl` / `openExternal`). */
export interface MockOpenedUrl {
  url: string;
  external: boolean;
  expectReturn: boolean;
}

/** Issuer, installation and organization of mock `remote/requests` envelopes. */
export const MOCK_ISSUER = 'https://olan.test';
export const DEFAULT_ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000a1';

type Answer<T> = T | ((params: never) => T | Promise<T>);

/** Answers for the platform dialogs (`olan.ui.*`). */
export interface MockUi {
  /** `olan.ui.confirm`; default `true` (the user confirms). */
  confirm?: Answer<boolean>;
  /** `olan.ui.prompt`; default `null` (the user cancels). */
  prompt?: Answer<string | null>;
  /** `olan.ui.menu`; the chosen key, default `null` (dismissed). */
  menu?: Answer<string | null>;
  /** `olan.ui.datePicker`; default `null` (dismissed). */
  datePicker?: Answer<string | null>;
  /**
   * `olan.files.pick`: the files the person picks, by `fixtures/files.json` name or inline. Default:
   * the fixture files `accept` and `maxBytes` allow, up to `maxFiles`. `null` or `[]` = cancelled.
   */
  files?: Answer<(string | FixtureFile)[] | null>;
  /** `olan.ui.openExternal(…, { expectReturn: true })`; default `{ returned: false }`. */
  openExternal?: Answer<ExternalFlowResult>;
}

export interface MockHostOptions {
  fixtures?: Fixtures;
  /** Granted permissions; calls needing others fail with `permission_denied` / `http_blocked`. */
  permissions?: readonly string[];
  /** Overrides `fixtures.settings` (what `olan.settings.get()` returns). */
  settings?: Record<string, JsonValue>;
  ui?: MockUi;
  /** The manifest's `data` (the `olan.db` collections). Without it every `db.*` call fails with `invalid_params`. */
  data?: DataSchema | null;
  /**
   * The signed-in user (`context.user.id`, `createdBy`, owner of `user` rows, `owner` rules).
   * Default `DEFAULT_USER_ID` (`00000000-0000-4000-8000-000000000001`, "Utku").
   */
  userId?: string;
  /** `olan.db` limits (installation `db_row_limit` / `db_byte_limit`); defaults 100 000 rows, 100 MiB. */
  quota?: MemoryDbQuota;
  /** The app's manifest id: `createdByApp` of the tasks it creates. Default `com.example.app`. */
  appId?: string;
  /** The app's name in its record links, calendar items and approvals (Phase 6). Default `Örnek uygulama`. */
  appName?: string;
  /**
   * The admin's "only delete records it created" switch (`delete_own_records_only`): the app may
   * then delete only tasks it created, and no work packages. Default `false`.
   */
  deleteOwnRecordsOnly?: boolean;
  /**
   * The surface's `init.params`: `mail.getMessage` answers only for its `messageId` (like the host,
   * which reads only the message the surface was opened on), and `chat.postCard` accepts its
   * `conversationId` even without a `fixtures/chat.json` entry.
   */
  surfaceParams?: JsonValue;
  /** Whether the manifest has `remote` (cards with `submit` buttons need it). Default `false`. */
  remote?: boolean;
  /**
   * Start of the host clock (timestamps of `olan.db` rows and task changes). With it the clock
   * advances one second per write, so test results do not depend on the real time. Default: the
   * real clock. Fixture rows without times get this value (else `FIXTURE_NOW`).
   */
  now?: string | number | Date;
  /**
   * Settings fields `settings.get` answers with `null`: the `secret: true` fields of apps that
   * declare `server` (Phase 3 §15.1; only backend code reads them, with `secrets.get`).
   */
  secretSettings?: readonly string[];
  /** Values for `secrets.get` (backend only); default: the settings values of `secretSettings`. */
  secrets?: Record<string, string | null>;
  /**
   * Answers `backend.call` (the app's backend in `@olan-app/runtime`, see `createBackendHarness`).
   * Without it `backend.call` fails with `backend_unavailable`.
   */
  backend?: (name: string, args: JsonValue, caller: { userId: string; permissions: string[] }) => Promise<RpcOutcome>;
  /** The manifest `remote.url`: uploads and images may go to its origin. */
  remoteUrl?: string | null;
  /** The manifest `remote.requests`: without it `remote.request` fails with `permission_denied`. */
  remoteRequests?: boolean;
  /** The app server behind `remote.request`; default: the `fixtures/remote.json` routes. */
  remoteHandler?: MockRemoteHandler | null;
  /**
   * Sends `remote.request` envelopes somewhere real instead (`olan-app dev --remote live`: signed to
   * `remote.url`); its answer goes through the same checks and error mapping. Wins over the handler.
   */
  remoteTransport?: ((envelope: RemoteRequestEnvelope) => Promise<RemoteTransportResult>) | null;
  /** The upload target's answer (default 200, no body). */
  upload?: MockUploadHandler;
  /** A development installation: `http:` to localhost is allowed for uploads and links. Default `true`. */
  development?: boolean;
  /** `user.role` in `remote/requests` envelopes with `profile:read` (default `member`). */
  profileRole?: 'admin' | 'member';
  /** `user.organizationId` of envelopes (default `DEFAULT_ORGANIZATION_ID`). */
  organizationId?: string;
  locale?: string;
  timeZone?: string;
}

/** Options of one `MockHost.handle` call. */
export interface MockHandleOptions {
  /** Check against these permissions instead of the host's (the backend's invocation identity). */
  permissions?: readonly string[];
  /**
   * A call from backend code (`__olan.call`): only `BACKEND_HOST_METHODS` (with `secrets.get`)
   * are served, everything else is `unknown_method`.
   */
  backend?: boolean;
}

export interface MockCall {
  method: string;
  params: JsonValue;
  ok: boolean;
  result?: JsonValue;
  error?: { code: string; message: string; details?: JsonValue };
  /**
   * `'ui'` for calls of the app's UI, `'backend'` for calls its backend code made (`__olan.call`).
   * Backend records never hold secret values: a `secrets.get` result and every occurrence of a
   * secret value in params, results or errors read `"[secret]"`.
   */
  source: 'ui' | 'backend';
}

/** What recorded calls show instead of a secret value. */
export const REDACTED_SECRET = '[secret]';

export interface NavigationRecord {
  action: 'push' | 'pop' | 'replace';
  screen?: string;
  params?: JsonValue;
}

/** One line of the mock audit log (deletions and refused deletions, as in Olan's audit log). */
export interface MockAuditEntry {
  action: 'db.delete' | 'record.delete' | 'record.delete_denied';
  detail: Record<string, JsonValue>;
}

/** A card the app posted with `olan.chat.postCard` (and maybe changed with `updateCard`). */
export interface MockCard {
  messageId: string;
  conversationId: string;
  threadRootId: string | null;
  card: AppCard;
  postedAt: string;
  updatedAt: string;
}

export type RpcOutcome = { ok: true; result: JsonValue } | { ok: false; error: { code: string; message: string; details?: JsonValue } };

export interface MockHost {
  /** Answers one RPC like the Olan host: permission check first, then the fixture data. */
  handle(method: string, params: JsonValue, options?: MockHandleOptions): Promise<RpcOutcome>;
  /** Every call in order, with its outcome. */
  readonly calls: MockCall[];
  readonly toasts: { text: string; tone?: string }[];
  readonly navigation: NavigationRecord[];
  readonly shares: { text: string; url?: string }[];
  /** The live (mutable) data: storage writes, task changes and `olan.db` rows (`data.db`, a fresh snapshot per read) show up here. */
  readonly data: NormalizedFixtures;
  /** The in-memory app database behind `olan.db` (`db.as(userId)` acts as another user). */
  readonly db: MemoryDb;
  /** The signed-in user's id (`context.user.id`). */
  readonly userId: string;
  /** Deletions and refused deletions, oldest first. */
  audit(): MockAuditEntry[];
  /** Cards posted by the app (`olan.chat.postCard`), oldest first, with their latest content. */
  readonly cards: MockCard[];
  /** The surface params the host enforces (`mail.getMessage`); `renderApp().setParams` changes them. */
  surfaceParams: JsonValue;
  permissions: string[];
  ui: MockUi;
  /** The `backend.call` handler (set by `renderApp` and `olan-app dev` for apps with `server`). */
  backend: MockHostOptions['backend'] | null;
  /** What `secrets.get` answers for `name` (hook verification reads the secret setting with it). */
  secret(name: string): string | null;
  /** The app server behind `remote.request` (null: the `fixtures/remote.json` routes). */
  remote: MockRemoteHandler | null;
  /** `remote.request` calls that reached the app server, oldest first. */
  readonly remoteRequests: MockRemoteRequest[];
  /** File uploads, oldest first. */
  readonly uploads: MockUpload[];
  /** URLs opened with `olan.ui.openUrl` / `openExternal`. */
  readonly opened: MockOpenedUrl[];
  /** Running `useQuery` refetch timers (`timers.set`). */
  timers(): { timerId: string; intervalMs: number }[];
  /** Where host → sandbox messages go (`upload-progress`); `renderApp` and `olan-app dev` set it. */
  emit: ((message: HostToSandboxMessage) => void) | null;
  /**
   * An approver decides one of the app's approval requests (Phase 6), as a person does in their
   * approval box: `any` ends it on the first decision, `all` on a rejection or the last approval.
   * Throws `MockHostError` (`not_found`, `permission_denied` for someone who is not an approver,
   * `conflict` when it is no longer pending or they already decided).
   */
  decideApproval(projectId: string, approvalId: string, decision: 'approve' | 'reject', options?: { userId?: string; note?: string }): ProjectApproval;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function answer<T>(value: Answer<T> | undefined, fallback: T, params: unknown): Promise<T> {
  if (value === undefined) return fallback;
  if (typeof value === 'function') return (value as (params: unknown) => T | Promise<T>)(params);
  return value;
}

const TASK_STATUSES = new Set(['needs-action', 'in-process', 'completed', 'cancelled']);
const MAX_STORAGE_VALUE = 64 * 1024;
const MAX_STORAGE_KEYS = 1000;
/** Largest `olan.project.config` value (Phase 6), as on the server. */
const PROJECT_CONFIG_MAX_BYTES = 64 * 1024;
const MAX_TASK_TITLE = 500;
/** Keys of the app's statuses and labels (Phase 6), as on the server. */
const CONTRIBUTION_KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Status categories a project always keeps one status of. */
const REQUIRED_STATUS_CATEGORIES: readonly ProjectStatusCategory[] = ['unstarted', 'started', 'completed', 'cancelled'];
const APPROVAL_STATES = new Set(['pending', 'approved', 'rejected', 'cancelled']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type MockApi = { [M in RpcMethodName]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

function toMillis(now: string | number | Date): number {
  const value = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(value)) throw new Error(`createMockHost: invalid now ${String(now)}`);
  return value;
}

/**
 * An in-memory Olan host for headless runs (`olan-app test`, `validate --strict`, `dev`, MCP).
 * Mirrors the web host's `rpc-host.ts` checks: unknown method → `unknown_method`, non-object
 * params → `invalid_params`, `http.fetch` to a host without an `http:<host>` permission →
 * `http_blocked`, any other missing permission → `permission_denied` (`methodAllowed`).
 * `olan.db` runs on `@olan-app/sdk/memory-db`; task and work package deletions apply the
 * server's record protection (§4.6) and are written to `audit()`.
 */
export function createMockHost(options: MockHostOptions = {}): MockHost {
  const appId = options.appId ?? DEFAULT_MOCK_APP.id;
  const appName = options.appName ?? DEFAULT_MOCK_APP.name;
  const data = normalizeFixtures(structuredClone({ ...(options.fixtures ?? {}), db: {} }), { id: appId, name: appName });
  if (options.settings) data.settings = { ...data.settings, ...options.settings };
  const userId = options.userId ?? DEFAULT_USER_ID;
  const calls: MockCall[] = [];
  const toasts: { text: string; tone?: string }[] = [];
  const navigation: NavigationRecord[] = [];
  const shares: { text: string; url?: string }[] = [];
  const auditLog: MockAuditEntry[] = [];
  const host = { permissions: [...(options.permissions ?? [])], ui: { ...(options.ui ?? {}) }, backend: options.backend ?? null };
  const secretSettings = new Set(options.secretSettings ?? []);
  const secretValue = (name: string): string | null => {
    if (options.secrets && Object.prototype.hasOwnProperty.call(options.secrets, name)) return options.secrets[name] ?? null;
    if (!secretSettings.has(name)) return null;
    const value = data.settings[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const record = (method: string, params: JsonValue, outcome: RpcOutcome, source: MockCall['source']): MockCall =>
    outcome.ok ? { method, params, ok: true, result: outcome.result, source } : { method, params, ok: false, error: outcome.error, source };
  /**
   * A backend call as recorded: secret values (of 4+ characters, so short test values do not blank
   * out unrelated text) become `[secret]` wherever they appear, and a `secrets.get` result always
   * does, so tests and logs built from `calls()` cannot capture them.
   */
  const redactedRecord = (method: string, params: JsonValue, outcome: RpcOutcome): MockCall => {
    const values = new Set<string>();
    for (const name of new Set([...secretSettings, ...Object.keys(options.secrets ?? {})])) {
      const value = secretValue(name);
      if (value && value.length >= 4) values.add(value);
    }
    const scrub = (value: JsonValue): JsonValue => {
      if (typeof value === 'string') {
        let text = value;
        for (const secret of values) text = text.split(secret).join(REDACTED_SECRET);
        return text;
      }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
      return value;
    };
    const redacted: RpcOutcome = outcome.ok
      ? { ok: true, result: method === 'secrets.get' && typeof outcome.result === 'string' ? REDACTED_SECRET : scrub(outcome.result) }
      : { ok: false, error: { code: outcome.error.code, message: scrub(outcome.error.message) as string } };
    return record(method, scrub(structuredClone(params)), redacted, 'backend');
  };

  // Clock: with `now`, fixture rows get `now` and each write 1 s later than the previous one; else the real time.
  let ticks = 0;
  const start = options.now !== undefined ? toMillis(options.now) : null;
  const clock = () => (start === null ? new Date() : new Date(start + 1000 * ++ticks));
  const seedTime = start === null ? FIXTURE_NOW : new Date(start).toISOString();

  const fixtureIssues = [...userFixtureIssues(options.fixtures?.users), ...dbFixtureIssues(options.data, options.fixtures?.db)];
  if (fixtureIssues.length > 0) throw new CliError(fixtureIssues);
  let db: MemoryDb;
  try {
    db = createMemoryDb({
      data: options.data ?? null,
      userId,
      now: clock,
      ...(options.quota ? { quota: options.quota } : {}),
      rows: dbSeed(options.fixtures?.db, seedTime) as never,
      generateId: () => randomUUID(),
    });
  } catch (error) {
    if (isMemoryDbError(error)) throw new CliError({ code: 'fixtures.db_invalid', message: `fixtures/db.json: ${error.message}`, file: 'fixtures/db.json' });
    throw error;
  }
  Object.defineProperty(data, 'db', { enumerable: true, configurable: true, get: () => db.snapshot() });

  const projectEnabled = (projectId: string) => !data.disabledProjects.includes(projectId);
  /** A fixture project the app is enabled in (Phase 6: others answer `project_not_enabled`, as on a server). */
  const findProject = (projectId: string): ProjectDetail => {
    const detail = data.projects.find((candidate) => candidate.project.id === projectId);
    if (!detail) throw new MockHostError('invalid_params', `No project ${projectId} in the fixtures`);
    if (!projectEnabled(projectId)) {
      throw new MockHostError('project_not_enabled', `The app is not enabled in project ${projectId} (fixtures/projects.json "enabled": false); a member adds it under Uygulamalar on the project page`);
    }
    return detail;
  };
  const findTask = (detail: ProjectDetail, taskId: string): ProjectTask => {
    const task = detail.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new MockHostError('not_found', `No task ${taskId} in project ${detail.project.id}`);
    return task;
  };
  const requireRevision = (revision: unknown, what: string): number => {
    if (typeof revision !== 'number' || !Number.isInteger(revision)) throw new MockHostError('invalid_params', `${what} needs the current revision`);
    return revision;
  };
  const deny = (kind: 'task' | 'list' | 'project', projectId: string, recordId: string, reason: string, message: string): never => {
    auditLog.push({ action: 'record.delete_denied', detail: { kind, projectId, recordId, reason } });
    throw new MockHostError('forbidden_record', message);
  };
  /** Refused changes and deletions of calendar events and contacts (§7.3); deletions are audited. */
  const refuse = (kind: 'event' | 'contact', recordId: string, reason: string, message: string, deleting: boolean): never => {
    if (deleting) auditLog.push({ action: 'record.delete_denied', detail: { kind, recordId, reason } });
    throw new MockHostError('forbidden_record', `${message} (${reason})`);
  };
  const cards: MockCard[] = [];
  // ---- Phase 5a state: remote requests, files, opened URLs, timers ----
  const remoteRequests: MockRemoteRequest[] = [];
  const uploads: MockUpload[] = [];
  const opened: MockOpenedUrl[] = [];
  const timers = new Map<string, number>();
  const pickedFiles = new Map<string, MockFile>();
  const cancelUpload = new Map<string, () => void>();
  let pickCounter = 0;
  let remoteHandler: MockRemoteHandler | null = options.remoteHandler ?? null;
  let emit: ((message: HostToSandboxMessage) => void) | null = null;
  const development = options.development !== false;
  /** `fixtures/remote.json` as routes answering their canned `{ status, headers, body }`. */
  const fixtureRoutes = (): RemoteRoutes | null => {
    const entries = Object.entries(data.remote);
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([route, fixture]) => [route, () => ({ status: fixture.status ?? 200, ...(fixture.headers ? { headers: fixture.headers } : {}), body: fixture.body ?? null })]));
  };
  let currentParams: JsonValue = options.surfaceParams ?? null;
  const surfaceParamsOf = (): { [key: string]: JsonValue } => (isObject(currentParams) ? currentParams : {});
  const text = (value: unknown, what: string, max = 500): string => {
    if (typeof value !== 'string' || value.trim().length === 0) throw new MockHostError('invalid_params', `${what} must be a non-empty string`);
    if (value.length > max) throw new MockHostError('invalid_params', `${what} is limited to ${max} characters`);
    return value.trim();
  };
  const isoTime = (value: unknown, what: string): number => {
    const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time)) throw new MockHostError('invalid_params', `${what} must be an ISO date or date-time`);
    return time;
  };
  const checkCard = (card: unknown) => {
    const result = validateCard(card, { remote: options.remote === true });
    if (!result.ok) throw new MockHostError('validation_failed', `card: ${result.issues.map((problem) => `${problem.code}: ${problem.message}`).join('; ')}`);
    return result.card;
  };
  const findEvent = (eventId: string): CalendarEvent => {
    const event = data.calendarEvents.find((candidate) => candidate.id === eventId);
    if (!event) throw new MockHostError('not_found', `No event ${eventId} in the fixtures`);
    return event;
  };
  /** Olan meetings, project calendars, invitations, read-only calendars, the admin's own-records switch. */
  const protectEvent = (event: CalendarEvent, deleting: boolean) => {
    const calendar = data.calendars.find((candidate) => candidate.id === event.calendarId);
    if (event.uid.endsWith('@olan.app') || calendar?.projectId) refuse('event', event.id, 'system_record', 'Olan meetings and project calendar events cannot be changed by apps', deleting);
    if (!event.isOrganizer) refuse('event', event.id, 'not_organizer', 'The user does not organize this event (an invitation)', deleting);
    if (calendar && !calendar.mayWrite) refuse('event', event.id, 'permission_denied', 'The calendar is read-only', deleting);
    if (deleting && options.deleteOwnRecordsOnly && event.createdByApp !== appId) refuse('event', event.id, 'not_created_by_app', 'This app may delete only the events it created', deleting);
  };
  const findContact = (contactId: string): Contact => {
    const contact = data.contacts.find((candidate) => candidate.id === contactId);
    if (!contact) throw new MockHostError('not_found', `No contact ${contactId} in the fixtures`);
    return contact;
  };
  const protectContact = (contact: Contact, deleting: boolean) => {
    const book = data.addressBooks.find((candidate) => candidate.id === contact.addressBookId);
    if (book?.shared) refuse('contact', contact.id, 'system_record', 'Contacts in shared or directory address books cannot be changed by apps', deleting);
    if (deleting && options.deleteOwnRecordsOnly && contact.createdByApp !== appId) refuse('contact', contact.id, 'not_created_by_app', 'This app may delete only the contacts it created', deleting);
  };
  const stringList = (value: unknown, what: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new MockHostError('invalid_params', `${what} must be an array of strings`);
    return value as string[];
  };
  /** ISO 8601 durations such as PT30M, PT1H30M, P1D. */
  const durationMs = (value: string): number => {
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
    if (!match || value === 'P' || value.endsWith('T')) throw new MockHostError('invalid_params', `duration must be an ISO 8601 duration such as PT30M (got ${value})`);
    const [, d, h, m, s] = match.map((part) => Number(part ?? 0));
    return (((d! * 24 + h!) * 60 + m!) * 60 + s!) * 1000;
  };
  /**
   * `ref:*` fields of `db.insert` / `db.update` (Phase 3 §9): the referenced project, task or user
   * must exist in the fixtures. Missing and invisible look the same (`ref.not_found`).
   */
  const checkRefs = async (method: string, params: unknown) => {
    if (method !== 'db.insert' && method !== 'db.update') return;
    const { collection, data: rowData, patch, id } = (params ?? {}) as { collection?: string; data?: Record<string, JsonValue>; patch?: Record<string, JsonValue>; id?: string };
    const schema = options.data && collection && Object.prototype.hasOwnProperty.call(options.data.collections, collection) ? options.data.collections[collection] : undefined;
    if (!schema) return;
    const values = method === 'db.insert' ? rowData : patch;
    if (!isObject((values ?? null) as JsonValue)) return;
    let previous: Record<string, JsonValue> | null = null;
    if (method === 'db.update' && typeof id === 'string') {
      try {
        previous = ((await db.call('db.get', { collection, id })) as DbRow | null)?.data ?? null;
      } catch {
        return; // the update itself reports the problem
      }
    }
    const refs: { field: string; type: string; value: string }[] = [];
    for (const [field, definition] of Object.entries(schema.fields)) {
      if (!definition.type.startsWith('ref:')) continue;
      const value = values![field];
      // Malformed values are row errors (`row.type`), reported by the database itself.
      if (typeof value !== 'string' || !isUuid(value)) continue;
      if (previous && previous[field] === value) continue;
      refs.push({ field, type: definition.type, value: value.toLowerCase() });
    }
    if (new Set(refs.map((ref) => `${ref.type}:${ref.value}`)).size > 20) throw new MockHostError('validation_failed', 'data: ref.too_many (at most 20 references per request)');
    const lower = (value: string | null | undefined) => (value ?? '').toLowerCase();
    for (const ref of refs) {
      const found =
        ref.type === 'ref:project'
          ? data.projects.some((detail) => lower(detail.project.id) === ref.value)
          : ref.type === 'ref:task'
            ? data.projects.some((detail) => detail.tasks.some((task) => lower(task.id) === ref.value))
            : data.users.some((user) => lower(user.id) === ref.value);
      if (!found) throw new MockHostError('validation_failed', `data.${ref.field}: ref.not_found`);
    }
  };
  /** Live tasks and child work packages: a work package with either is not empty. */
  const listIsEmpty = (detail: ProjectDetail, list: ProjectTaskList) =>
    !detail.tasks.some((task) => task.listId === list.id) && !detail.lists.some((candidate) => candidate.parentId === list.id);

  const dbCall = async (method: string, params: unknown) => {
    await checkRefs(method, params);
    try {
      const result = await db.call(method, params);
      if (method === 'db.delete') {
        const { collection, id } = params as { collection: string; id: string };
        auditLog.push({ action: 'db.delete', detail: { collection, rowId: id } });
      }
      return result;
    } catch (error) {
      if (isMemoryDbError(error)) throw new MockHostError(error.code, error.message);
      throw error;
    }
  };

  // ---- Phase 6 (second wave): what the app adds to the projects it is enabled in ----
  // Same checks and error codes as the server (`project-contributions.ts`), mapped like the host
  // maps them: link/issue/status/label/calendar/approval `_not_found` → `not_found`, `invalid_card` →
  // `validation_failed`, taken keys and names → `conflict`, limits → `quota_exceeded`, other 400s
  // → `invalid_params`. The server's code is in each message.
  const appSource = () => ({ installationId: MOCK_INSTALLATION_ID, appId, name: appName, active: true });
  const isOurs = (record: { appInstallationId: string | null }) => record.appInstallationId === MOCK_INSTALLATION_ID;
  const invalid = (code: string, message: string): never => {
    throw new MockHostError('invalid_params', `${message} (${code})`);
  };
  /** A project the app may add to: enabled in it, and not archived (`project_archived`). */
  const writableProject = (projectId: unknown): ProjectDetail => {
    const detail = findProject(text(projectId, 'projectId', 200));
    if (detail.project.archived) throw new MockHostError('conflict', 'The project is archived (project_archived)');
    return detail;
  };
  const listOf = <T>(map: Record<string, T[]>, projectId: string): T[] => (map[projectId] ??= []);
  const keyOf = (value: unknown, what: string): string =>
    typeof value === 'string' && CONTRIBUTION_KEY.test(value) ? value : invalid('invalid_key', `${what} must match ^[a-z0-9][a-z0-9._-]{0,62}$`);
  const colorOf = (value: unknown, code: string): string | null => {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' && HEX_COLOR.test(value) ? value.toUpperCase() : invalid(code, 'color must be #RRGGBB');
  };
  const nameOf = (value: unknown, max: number, code: string): string =>
    typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= max ? value.trim() : invalid(code, `name must be 1–${max} characters`);
  const externalIdOf = (value: unknown): string =>
    // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
    typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f]/.test(value)
      ? value
      : invalid('invalid_external_id', 'externalId must be 1–200 characters without control characters');
  const instantOf = (value: unknown, code: string): number => {
    const iso = isoInstant(value);
    return iso ? Date.parse(iso) : invalid(code, 'expected an ISO date (2026-11-02) or date-time');
  };
  const definitionsOf = (items: unknown, what: 'statuses' | 'labels' | 'fields'): Record<string, unknown>[] => {
    if (!Array.isArray(items) || items.length === 0 || items.length > RPC_LIMITS.projectDefinitions || !items.every(isRecord)) {
      invalid('invalid_definitions', `${what} must be 1–${RPC_LIMITS.projectDefinitions} objects`);
    }
    const list = items as Record<string, unknown>[];
    const keys = list.map((item) => keyOf(item.key, `${what}[].key`));
    if (new Set(keys).size !== keys.length) invalid('invalid_definitions', `${what} repeat a key`);
    return list;
  };
  /** A live task or issue of the project. */
  const resolveTarget = (detail: ProjectDetail, raw: unknown): { kind: 'task'; id: string; title: string; task: ProjectTask } | { kind: 'issue'; id: string; title: string; issue: MockProjectIssue } => {
    if (!isRecord(raw) || (raw.kind !== 'task' && raw.kind !== 'issue') || typeof raw.id !== 'string' || !raw.id) {
      return invalid('invalid_target', 'target must be { kind: "task" | "issue", id }');
    }
    if (raw.kind === 'task') {
      const task = detail.tasks.find((candidate) => candidate.id === raw.id);
      if (!task) throw new MockHostError('not_found', `No task ${raw.id} in project ${detail.project.id} (task_not_found)`);
      return { kind: 'task', id: task.id, title: task.title, task };
    }
    const issue = listOf(data.projectIssues, detail.project.id).find((candidate) => candidate.id === raw.id);
    if (!issue) throw new MockHostError('not_found', `No issue ${raw.id} in project ${detail.project.id} (issue_not_found; add it to "issues" in fixtures/projects.json)`);
    return { kind: 'issue', id: issue.id, title: issue.title, issue };
  };
  const isLive = (detail: ProjectDetail, target: RecordTarget) =>
    target.kind === 'task' ? detail.tasks.some((task) => task.id === target.id) : listOf(data.projectIssues, detail.project.id).some((issue) => issue.id === target.id);
  const feed = (projectId: string, type: MockProjectActivity['type'], line: string, target: RecordTarget | null) => {
    listOf(data.projectActivity, projectId).push({ type, text: line, target: target ? { kind: target.kind, id: target.id } : null, actorId: userId, at: clock().toISOString() });
  };
  const findLink = (projectId: string, linkId: unknown): RecordLink => {
    const link = listOf(data.recordLinks, projectId).find((candidate) => candidate.id === linkId);
    if (!link) throw new MockHostError('not_found', `No link ${String(linkId)} of the app in project ${projectId} (link_not_found)`);
    return link;
  };
  const findApproval = (projectId: string, approvalId: unknown): ProjectApproval => {
    const approval = listOf(data.projectApprovals, projectId).find((candidate) => candidate.id === approvalId);
    if (!approval) throw new MockHostError('not_found', `No approval ${String(approvalId)} of the app in project ${projectId} (approval_not_found)`);
    return approval;
  };
  const freshId = (prefix: string, taken: (id: string) => boolean): string => {
    let n = 1;
    while (taken(`${prefix}${n}`)) n += 1;
    return `${prefix}${n}`;
  };
  const sortLabels = (labels: ProjectLabel[]) => [...labels].sort((a, b) => a.position - b.position || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const sortFields = (fields: ProjectField[]) => [...fields].sort((a, b) => a.position - b.position || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  /** The options of a select field (names unique, ids kept by id or name, new ones a slug of the name), as on the server. */
  const fieldOptionsOf = (type: ProjectField['type'], value: unknown, existing: ProjectField['options'] = []): ProjectField['options'] => {
    if (!FIELD_TYPES_WITH_OPTIONS.has(type)) {
      if (value !== undefined && value !== null && !(Array.isArray(value) && !value.length)) invalid('invalid_field_options', `${type} fields have no options`);
      return [];
    }
    if (value === undefined) return existing;
    if (!Array.isArray(value) || value.length > 100) return invalid('invalid_field_options', 'options must be at most 100 { id?, name, color? }');
    const taken = new Set<string>();
    const names = new Set<string>();
    return value.map((raw, index) => {
      if (!isRecord(raw)) return invalid('invalid_field_options', 'options must be at most 100 { id?, name, color? }');
      const name = nameOf(raw.name, 60, 'invalid_field_options');
      if (names.has(name.toLowerCase())) invalid('field_option_name_taken', `Two options are named "${name}"`);
      names.add(name.toLowerCase());
      const known = typeof raw.id === 'string' ? existing.find((option) => option.id === raw.id) : existing.find((option) => sameName(option.name, name));
      let id: string;
      if (typeof raw.id === 'string' && raw.id) {
        if (!CONTRIBUTION_KEY.test(raw.id) || taken.has(raw.id)) invalid('invalid_field_options', 'option ids must match ^[a-z0-9][a-z0-9._-]{0,62}$ and be unique');
        id = raw.id;
      } else id = known?.id && !taken.has(known.id) ? known.id : fieldSlug(name, new Set([...taken, ...existing.map((option) => option.id)]));
      taken.add(id);
      return { id, name, color: colorOf(raw.color, 'invalid_field_options') ?? known?.color ?? LABEL_COLORS[index % LABEL_COLORS.length]! };
    });
  };
  const flagOf = (value: unknown, fallback: boolean): boolean => (value === undefined ? fallback : typeof value === 'boolean' ? value : invalid('invalid_boolean', 'expected true or false'));
  /** The field values of a task or issue, by field key (fields without one: by id). */
  const fieldValuesOf = (projectId: string, target: RecordTarget): { target: RecordTarget; values: Record<string, ProjectFieldValue> } => {
    const values: Record<string, ProjectFieldValue> = {};
    const mine = data.projectFieldValues[projectId]?.[fieldTargetKey(target)] ?? {};
    for (const field of sortFields(listOf(data.projectFields, projectId))) {
      if (Object.hasOwn(mine, field.id)) values[field.key ?? field.id] = structuredClone(mine[field.id]!);
    }
    return { target: { kind: target.kind, id: target.id }, values };
  };

  const api: MockApi = {
    'projects.list': async ({ limit = 50, cursor }) => {
      const all = data.projects.filter((detail) => projectEnabled(detail.project.id)).map((detail) => detail.project);
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + limit);
      return start + limit < all.length ? { items, nextCursor: String(start + limit) } : { items };
    },
    'projects.get': async ({ projectId }) => findProject(projectId),
    'projects.tasks': async ({ projectId, status }) => findProject(projectId).tasks.filter((task) => !status || task.status === status),
    'projects.createTask': async ({ projectId, title, listId, description, status, due, allDay, assigneeId }) => {
      const detail = findProject(projectId);
      if (typeof title !== 'string' || title.trim().length === 0) throw new MockHostError('invalid_params', 'createTask needs a title');
      if (title.length > MAX_TASK_TITLE) throw new MockHostError('invalid_params', `Task titles are limited to ${MAX_TASK_TITLE} characters`);
      if (status !== undefined && !TASK_STATUSES.has(status)) throw new MockHostError('invalid_params', `Unknown status ${status}`);
      let list: ProjectTaskList | undefined;
      if (listId !== undefined) {
        list = detail.lists.find((candidate) => candidate.id === listId);
        if (!list) throw new MockHostError('not_found', `No work package ${listId} in project ${projectId}`);
      } else {
        list = detail.lists.find((candidate) => candidate.isDefault) ?? detail.lists.find((candidate) => candidate.parentId === null) ?? detail.lists[0];
        if (!list) throw new MockHostError('invalid_params', `Project ${projectId} has no work package`);
      }
      const number = detail.tasks.reduce((max, task) => Math.max(max, task.number ?? 0), 0) + 1;
      const task: ProjectTask = {
        id: randomUUID(),
        projectId,
        listId: list.id,
        number,
        title: title.trim(),
        description: typeof description === 'string' ? description : '',
        status: status ?? 'needs-action',
        assigneeId: assigneeId ?? null,
        createdBy: userId,
        due: due ?? null,
        allDay: allDay ?? true,
        revision: 1,
        updatedAt: clock().toISOString(),
        createdByApp: appId,
      };
      detail.tasks.push(task);
      return task;
    },
    'projects.updateTask': async ({ projectId, taskId, revision, ...change }) => {
      const task = findTask(findProject(projectId), taskId);
      requireRevision(revision, 'updateTask');
      if (task.revision !== revision) throw new MockHostError('conflict', 'The task changed; reload it');
      if (change.status !== undefined && !TASK_STATUSES.has(change.status)) throw new MockHostError('invalid_params', `Unknown status ${change.status}`);
      const allowed: Partial<ProjectTask> = {};
      if (change.status !== undefined) allowed.status = change.status;
      if (change.due !== undefined) allowed.due = change.due;
      if (change.assigneeId !== undefined) allowed.assigneeId = change.assigneeId;
      Object.assign(task, allowed, { revision: task.revision + 1, updatedAt: clock().toISOString() });
      return task;
    },
    'projects.deleteTask': async ({ projectId, taskId, revision }) => {
      const detail = findProject(projectId);
      const task = findTask(detail, taskId);
      requireRevision(revision, 'deleteTask');
      if (task.revision !== revision) throw new MockHostError('conflict', 'The task changed; reload it');
      if (options.deleteOwnRecordsOnly && task.createdByApp !== appId) {
        deny('task', projectId, taskId, 'not_created_by_app', 'This app may delete only the tasks it created');
      }
      detail.tasks.splice(detail.tasks.indexOf(task), 1);
      auditLog.push({ action: 'record.delete', detail: { kind: 'task', projectId, recordId: taskId, title: task.title } });
      return null;
    },
    'projects.deleteList': async ({ projectId, listId, revision }) => {
      const detail = findProject(projectId);
      const list = detail.lists.find((candidate) => candidate.id === listId);
      if (!list) throw new MockHostError('not_found', `No work package ${listId} in project ${projectId}`);
      requireRevision(revision, 'deleteList');
      if (list.revision !== revision) throw new MockHostError('conflict', 'The work package changed; reload it');
      if (options.deleteOwnRecordsOnly) deny('list', projectId, listId, 'not_created_by_app', 'This app may delete only the records it created');
      if (list.isDefault) deny('list', projectId, listId, 'default_record', 'The default work package cannot be removed');
      if (!listIsEmpty(detail, list)) deny('list', projectId, listId, 'not_empty', 'The work package is not empty');
      // Olan archives work packages; an archived one is no longer listed.
      detail.lists.splice(detail.lists.indexOf(list), 1);
      auditLog.push({ action: 'record.delete', detail: { kind: 'list', projectId, recordId: listId, title: list.name } });
      return null;
    },
    'users.get': async ({ ids }) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new MockHostError('invalid_params', 'users.get needs { ids: string[] }');
      if (ids.length > USERS_GET_MAX_IDS) throw new MockHostError('invalid_params', `users.get takes at most ${USERS_GET_MAX_IDS} ids`);
      // Like the server: unknown ids are left out, each user once, in the order asked.
      const wanted = new Set(ids);
      return { users: [...wanted].flatMap((id) => data.users.filter((user) => user.id === id)) };
    },
    'chat.conversations': async () => data.conversations,
    'chat.messages': async ({ conversationId, limit = 50 }) => (data.messages[conversationId] ?? []).slice(-limit),
    'storage.get': async ({ key }) => (Object.prototype.hasOwnProperty.call(data.storage, key) ? data.storage[key]! : null),
    'storage.set': async ({ key, value }) => {
      if (typeof key !== 'string' || key.length === 0) throw new MockHostError('invalid_params', 'Storage keys must be non-empty strings');
      if (JSON.stringify(value ?? null).length > MAX_STORAGE_VALUE) throw new MockHostError('invalid_params', 'Values are limited to 64 KiB');
      if (!(key in data.storage) && Object.keys(data.storage).length >= MAX_STORAGE_KEYS) throw new MockHostError('invalid_params', 'At most 1000 keys per user');
      data.storage[key] = value;
      return null;
    },
    'storage.remove': async ({ key }) => {
      delete data.storage[key];
      return null;
    },
    'storage.keys': async () => Object.keys(data.storage),
    'db.insert': async (params) => (await dbCall('db.insert', params)) as unknown as DbRow,
    'db.get': async (params) => (await dbCall('db.get', params)) as unknown as DbRow | null,
    'db.query': async (params) => (await dbCall('db.query', params)) as unknown as RpcResult<'db.query'>,
    'db.update': async (params) => (await dbCall('db.update', params)) as unknown as DbRow,
    'db.delete': async (params) => {
      await dbCall('db.delete', params);
      return null;
    },
    'db.count': async (params) => (await dbCall('db.count', params)) as number,
    'settings.get': async () => Object.fromEntries(Object.entries(data.settings).map(([key, value]) => [key, secretSettings.has(key) ? null : value])),
    'http.fetch': async ({ url, method = 'GET' }) => {
      const withoutQuery = url.split('?')[0]!;
      const fixture = data.http[`${method} ${url}`] ?? data.http[url] ?? data.http[`${method} ${withoutQuery}`] ?? data.http[withoutQuery];
      if (!fixture) {
        throw new MockHostError('http_blocked', `No HTTP fixture for ${method} ${url}; add it to fixtures/http.json (the mock server never goes to the network)`);
      }
      const body = fixture.body ?? (fixture.json !== undefined ? JSON.stringify(fixture.json) : '');
      const headers = { ...(fixture.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(fixture.headers ?? {}) };
      return { status: fixture.status ?? 200, headers, body };
    },
    'ui.confirm': async (params) => answer(host.ui.confirm, true, params),
    'ui.prompt': async (params) => answer(host.ui.prompt, null, params),
    'ui.toast': async (params) => {
      toasts.push(params.tone ? { text: params.text, tone: params.tone } : { text: params.text });
      return null;
    },
    'ui.menu': async (params) => answer(host.ui.menu, null, params),
    'ui.datePicker': async (params) => answer(host.ui.datePicker, null, params),
    'ui.share': async (params) => {
      shares.push(params);
      return null;
    },
    'navigation.push': async ({ screen, params }) => {
      navigation.push({ action: 'push', screen, params: params ?? null });
      return null;
    },
    'navigation.pop': async () => {
      navigation.push({ action: 'pop' });
      return null;
    },
    'navigation.replace': async ({ screen, params }) => {
      navigation.push({ action: 'replace', screen, params: params ?? null });
      return null;
    },
    // ---- Phase 3 ----
    'chat.postCard': async ({ conversationId, card, threadRootId }) => {
      const id = text(conversationId, 'conversationId', 200);
      if (!data.conversations.some((conversation) => conversation.id === id) && surfaceParamsOf().conversationId !== id) {
        throw new MockHostError('not_found', `No conversation ${id} in fixtures/chat.json (the user must be in it)`);
      }
      const checked = checkCard(card);
      const now = clock().toISOString();
      const entry: MockCard = { messageId: randomUUID(), conversationId: id, threadRootId: threadRootId ?? null, card: checked, postedAt: now, updatedAt: now };
      cards.push(entry);
      return { messageId: entry.messageId };
    },
    'chat.updateCard': async ({ messageId, card }) => {
      const entry = cards.find((candidate) => candidate.messageId === messageId);
      if (!entry) throw new MockHostError('not_found', `Message ${String(messageId)} is not a card this installation posted`);
      entry.card = checkCard(card);
      entry.updatedAt = clock().toISOString();
      return { messageId: entry.messageId };
    },
    'calendar.calendars': async () => ({ calendars: data.calendars.map(({ projectId: _projectId, ...calendar }) => calendar) }),
    'calendar.events': async ({ from, to, calendarId, limit = RPC_LIMITS.calendarEvents }) => {
      const start = isoTime(from, 'from');
      const end = isoTime(to, 'to');
      if (end < start) throw new MockHostError('invalid_params', 'to must not be before from');
      if (end - start > RPC_LIMITS.calendarRangeDays * 86_400_000) throw new MockHostError('invalid_params', `The range is limited to ${RPC_LIMITS.calendarRangeDays} days`);
      if (!Number.isInteger(limit) || limit < 1 || limit > RPC_LIMITS.calendarEvents) throw new MockHostError('invalid_params', `limit must be 1–${RPC_LIMITS.calendarEvents}`);
      const events = data.calendarEvents
        .filter((event) => (calendarId === undefined || event.calendarId === calendarId) && Date.parse(event.start) < end && Date.parse(event.end) >= start)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { events: events.slice(0, limit) };
    },
    'calendar.createEvent': async (input) => {
      if ((input as unknown as Record<string, unknown>).participants !== undefined) throw new MockHostError('invalid_params', 'Apps cannot invite participants (no invitations are sent)');
      const calendar = input.calendarId !== undefined ? data.calendars.find((candidate) => candidate.id === input.calendarId) : (data.calendars.find((candidate) => candidate.isDefault && candidate.mayWrite) ?? data.calendars.find((candidate) => candidate.mayWrite));
      if (!calendar) throw new MockHostError('not_found', input.calendarId !== undefined ? `No calendar ${input.calendarId}` : 'The user has no writable calendar');
      if (!calendar.mayWrite) throw new MockHostError('forbidden_record', 'The calendar is read-only (permission_denied)');
      if (calendar.projectId) throw new MockHostError('forbidden_record', 'Project calendars cannot be changed by apps (system_record)');
      const title = text(input.title, 'title');
      const startTime = isoTime(input.start, 'start');
      const isAllDay = input.isAllDay ?? !String(input.start).includes('T');
      let end: string;
      if (input.end !== undefined) {
        if (isoTime(input.end, 'end') < startTime) throw new MockHostError('invalid_params', 'end must not be before start');
        end = input.end;
      } else {
        const span = input.duration !== undefined ? durationMs(input.duration) : isAllDay ? 86_400_000 : 3_600_000;
        end = isAllDay ? new Date(startTime + span).toISOString().slice(0, 10) : new Date(startTime + span).toISOString();
      }
      const id = randomUUID();
      const event: CalendarEvent = {
        id,
        calendarId: calendar.id,
        uid: `${id}@olan-app.example`,
        title,
        start: input.start,
        end,
        timeZone: input.timeZone ?? null,
        isAllDay,
        location: input.location ?? null,
        description: input.description ?? null,
        isOrganizer: true,
        createdByApp: appId,
        updatedAt: clock().toISOString(),
      };
      data.calendarEvents.push(event);
      return event;
    },
    'calendar.updateEvent': async ({ eventId, patch }) => {
      const event = findEvent(eventId);
      protectEvent(event, false);
      if (!isObject((patch ?? null) as JsonValue)) throw new MockHostError('invalid_params', 'patch must be an object');
      if ((patch as unknown as Record<string, unknown>).participants !== undefined) throw new MockHostError('invalid_params', 'Apps cannot invite participants');
      if (patch.title !== undefined) event.title = text(patch.title, 'title');
      if (patch.start !== undefined) {
        isoTime(patch.start, 'start');
        event.start = patch.start;
      }
      if (patch.end !== undefined) {
        isoTime(patch.end, 'end');
        event.end = patch.end;
      } else if (patch.duration !== undefined) {
        event.end = new Date(Date.parse(event.start) + durationMs(patch.duration)).toISOString();
      }
      if (Date.parse(event.end) < Date.parse(event.start)) throw new MockHostError('invalid_params', 'end must not be before start');
      if (patch.timeZone !== undefined) event.timeZone = patch.timeZone;
      if (patch.isAllDay !== undefined) event.isAllDay = patch.isAllDay;
      if (patch.location !== undefined) event.location = patch.location;
      if (patch.description !== undefined) event.description = patch.description;
      event.updatedAt = clock().toISOString();
      return event;
    },
    'calendar.deleteEvent': async ({ eventId }) => {
      const event = findEvent(eventId);
      protectEvent(event, true);
      data.calendarEvents.splice(data.calendarEvents.indexOf(event), 1);
      auditLog.push({ action: 'record.delete', detail: { kind: 'event', recordId: event.id, title: event.title } });
      return null;
    },
    'contacts.addressBooks': async () => ({ addressBooks: data.addressBooks }),
    'contacts.search': async ({ query, limit = RPC_LIMITS.contactsSearch }) => {
      if (typeof query !== 'string') throw new MockHostError('invalid_params', 'query must be a string');
      if (!Number.isInteger(limit) || limit < 1 || limit > RPC_LIMITS.contactsSearch) throw new MockHostError('invalid_params', `limit must be 1–${RPC_LIMITS.contactsSearch}`);
      const needle = query.trim().toLocaleLowerCase('tr');
      const matches = data.contacts.filter((contact) => [contact.name, contact.organization ?? '', ...contact.emails].some((value) => value.toLocaleLowerCase('tr').includes(needle)));
      return { contacts: matches.slice(0, limit) };
    },
    'contacts.create': async (input) => {
      const book = input.addressBookId !== undefined ? data.addressBooks.find((candidate) => candidate.id === input.addressBookId) : data.addressBooks.find((candidate) => candidate.isDefault && !candidate.shared);
      if (!book) throw new MockHostError('not_found', input.addressBookId !== undefined ? `No address book ${input.addressBookId}` : 'The user has no default address book');
      if (book.shared) throw new MockHostError('forbidden_record', 'Shared and directory address books are read-only for apps (system_record)');
      const contact: Contact = {
        id: randomUUID(),
        addressBookId: book.id,
        name: text(input.name, 'name', 200),
        emails: stringList(input.emails, 'emails'),
        phones: stringList(input.phones, 'phones'),
        organization: input.organization ?? null,
        title: input.title ?? null,
        note: input.note ?? null,
        createdByApp: appId,
        updatedAt: clock().toISOString(),
      };
      data.contacts.push(contact);
      return contact;
    },
    'contacts.update': async ({ contactId, patch }) => {
      const contact = findContact(contactId);
      protectContact(contact, false);
      if (!isObject((patch ?? null) as JsonValue)) throw new MockHostError('invalid_params', 'patch must be an object');
      if (patch.name !== undefined) contact.name = text(patch.name, 'name', 200);
      if (patch.emails !== undefined) contact.emails = stringList(patch.emails, 'emails');
      if (patch.phones !== undefined) contact.phones = stringList(patch.phones, 'phones');
      if (patch.organization !== undefined) contact.organization = patch.organization;
      if (patch.title !== undefined) contact.title = patch.title;
      if (patch.note !== undefined) contact.note = patch.note;
      contact.updatedAt = clock().toISOString();
      return contact;
    },
    'contacts.delete': async ({ contactId }) => {
      const contact = findContact(contactId);
      protectContact(contact, true);
      data.contacts.splice(data.contacts.indexOf(contact), 1);
      auditLog.push({ action: 'record.delete', detail: { kind: 'contact', recordId: contact.id, title: contact.name } });
      return null;
    },
    'mail.getMessage': async ({ messageId }) => {
      const opened = surfaceParamsOf().messageId;
      if (typeof opened !== 'string' || opened !== messageId) {
        throw new MockHostError('permission_denied', 'mail.getMessage reads only the message the mail.sidebar / mail.action surface was opened on');
      }
      const message = data.mail.find((candidate) => candidate.id === messageId);
      if (!message) throw new MockHostError('not_found', `No message ${messageId} in fixtures/mail.json`);
      const { threadId: _threadId, ...rest } = message;
      return rest;
    },
    'meetings.get': async ({ meetingId }) => {
      const meeting = data.meetings.find((candidate) => candidate.id === meetingId);
      if (!meeting) throw new MockHostError('not_found', `No meeting ${String(meetingId)} in fixtures/meetings.json`);
      const { projectId: _projectId, ...rest } = meeting;
      return rest;
    },
    'projects.create': async ({ title, description }) => {
      const name = text(title, 'title', 200);
      const id = randomUUID();
      const now = clock().toISOString();
      const project: Project = {
        id,
        name,
        description: typeof description === 'string' ? description : '',
        timeZone: 'Europe/Istanbul',
        archived: false,
        revision: 1,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
        createdByApp: appId,
      };
      data.projects.push({ project, members: [{ userId, displayName: data.users.find((user) => user.id === userId)?.displayName ?? 'Utku', role: 'owner' }], lists: [{ id: `${id}-l0`, name: 'Görevler', isDefault: true, revision: 1, parentId: null }], tasks: [] });
      return project;
    },
    // ---- Phase 6: the app's configuration of a project ----
    'project.config.get': async ({ projectId }) => {
      findProject(text(projectId, 'projectId', 200));
      return structuredClone(data.projectConfigs[projectId] ?? { projectId, value: {}, revision: 0, updatedBy: null, updatedAt: null });
    },
    'project.config.set': async ({ projectId, value, revision }) => {
      const detail = findProject(text(projectId, 'projectId', 200));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MockHostError('invalid_params', 'value must be a JSON object');
      if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)) {
        throw new MockHostError('invalid_params', 'revision must be a whole number of 0 or more');
      }
      if (new TextEncoder().encode(JSON.stringify(value)).length > PROJECT_CONFIG_MAX_BYTES) {
        throw new MockHostError('payload_too_large', `The project configuration is limited to ${PROJECT_CONFIG_MAX_BYTES / 1024} KiB`);
      }
      if (detail.project.archived) throw new MockHostError('conflict', 'The project is archived (project_archived)');
      const current = data.projectConfigs[projectId];
      if (revision !== undefined && revision !== (current?.revision ?? 0)) {
        throw new MockHostError('conflict', `The project configuration changed meanwhile (stored revision ${current?.revision ?? 0}, sent ${revision})`);
      }
      const next = { projectId, value: structuredClone(value), revision: (current?.revision ?? 0) + 1, updatedBy: userId, updatedAt: clock().toISOString() };
      data.projectConfigs[projectId] = next;
      return structuredClone(next);
    },
    // ---- Phase 6 (second wave): statuses and labels the app defines ----
    'project.statuses.list': async ({ projectId }) => {
      findProject(text(projectId, 'projectId', 200));
      return sortStatuses(listOf(data.projectStatuses, projectId));
    },
    'project.statuses.define': async ({ projectId, statuses }) => {
      writableProject(projectId);
      const items = definitionsOf(statuses, 'statuses');
      // Like the server's transaction: nothing changes unless every definition is accepted.
      const list = structuredClone(listOf(data.projectStatuses, projectId));
      const changed: string[] = [];
      for (const item of items) {
        const key = item.key as string;
        const name = nameOf(item.name, 60, 'invalid_status_name');
        const category = item.category as ProjectStatusCategory;
        if (!STATUS_CATEGORY_ORDER.includes(category)) invalid('invalid_status_category', `category must be one of ${STATUS_CATEGORY_ORDER.join(', ')}`);
        const color = colorOf(item.color, 'invalid_status_color');
        const position = item.position === undefined || item.position === null ? undefined
          : Number.isInteger(item.position) && Math.abs(item.position as number) <= 1_000_000 ? (item.position as number) : invalid('invalid_position', 'position must be a whole number');
        const existing = list.find((status) => status.key === key);
        const clash = list.some((status) => status !== existing && sameName(status.name, name));
        if (existing) {
          if (!isOurs(existing)) throw new MockHostError('conflict', `The key "${key}" belongs to another status of the project (status_key_taken)`);
          if (existing.category !== category) invalid('status_category_immutable', `The status "${key}" keeps its category ${existing.category}`);
          const next = { name, color: color ?? existing.color, position: position ?? existing.position };
          if (next.name === existing.name && next.color === existing.color && next.position === existing.position) continue;
          if (clash) throw new MockHostError('conflict', `The project already has a status named "${name}" (status_name_taken)`);
          Object.assign(existing, next, { revision: existing.revision + 1 });
        } else {
          if (clash) throw new MockHostError('conflict', `The project already has a status named "${name}" (status_name_taken)`);
          const inCategory = list.filter((status) => status.category === category);
          list.push({
            id: `${projectId}-status-${key}`,
            projectId,
            name,
            color: color ?? STATUS_CATEGORY_COLORS[category],
            category,
            position: position ?? (inCategory.length ? Math.max(...inCategory.map((status) => status.position)) + 1 : 0),
            key,
            createdByApp: appId,
            appInstallationId: MOCK_INSTALLATION_ID,
            revision: 1,
          });
        }
        changed.push(name);
      }
      data.projectStatuses[projectId] = sortStatuses(list);
      if (changed.length) feed(projectId, 'PROJECT_UPDATED', changed.join(', '), null);
      return sortStatuses(list.filter(isOurs));
    },
    'project.statuses.remove': async ({ projectId, key, replacementKey }) => {
      const detail = writableProject(projectId);
      const list = listOf(data.projectStatuses, projectId);
      const old = list.find((status) => status.key === keyOf(key, 'key'));
      if (!old || !isOurs(old)) throw new MockHostError('not_found', `The app has no status "${key}" in project ${projectId} (status_not_found)`);
      let replacementId: string | null = null;
      if (replacementKey !== undefined && replacementKey !== '') {
        replacementId = list.find((status) => status.key === keyOf(replacementKey, 'replacementKey'))?.id ?? invalid('invalid_replacement_status', `No status "${replacementKey}" in the project`);
      }
      const others = sortStatuses(list.filter((status) => status.id !== old.id));
      const last = () => new MockHostError('conflict', `"${old.name}" is the project's last ${old.category} status (last_status_in_category)`);
      if (REQUIRED_STATUS_CATEGORIES.includes(old.category) && !others.some((status) => status.category === old.category)) throw last();
      const sameValue = others.filter((status) => statusCalDav(status.category) === statusCalDav(old.category));
      const replacement =
        replacementId === null
          ? (sameValue.find((status) => status.category === old.category) ?? sameValue.find((status) => status.category !== 'backlog') ?? sameValue[0])
          : (sameValue.find((status) => status.id === replacementId) ?? invalid('invalid_replacement_status', 'The replacement must stand for the same task status (open, in progress, done, cancelled)'));
      if (!replacement) throw last();
      let movedTasks = 0;
      for (const task of detail.tasks) {
        if (data.taskStatusIds[task.id] !== old.id) continue;
        data.taskStatusIds[task.id] = replacement.id;
        Object.assign(task, { revision: task.revision + 1, updatedAt: clock().toISOString() });
        movedTasks += 1;
      }
      list.splice(list.indexOf(old), 1);
      feed(projectId, 'PROJECT_UPDATED', old.name, null);
      return { movedTasks };
    },
    'project.labels.list': async ({ projectId }) => {
      findProject(text(projectId, 'projectId', 200));
      return sortLabels(listOf(data.projectLabels, projectId));
    },
    'project.labels.define': async ({ projectId, labels }) => {
      writableProject(projectId);
      const items = definitionsOf(labels, 'labels');
      const list = structuredClone(listOf(data.projectLabels, projectId));
      const changed: string[] = [];
      for (const item of items) {
        const key = item.key as string;
        const name = nameOf(item.name, 50, 'invalid_label_name');
        const groupName = item.groupName === undefined || item.groupName === null ? null : nameOf(item.groupName, 50, 'invalid_label_group');
        const description = item.description === undefined ? '' : typeof item.description === 'string' && item.description.length <= 500 ? item.description : invalid('invalid_label_description', 'description must be at most 500 characters');
        const color = colorOf(item.color, 'invalid_label_color');
        // A label the app brought with a project template (no key yet) and the same name is taken over.
        const existing = list.find((label) => label.key === key) ?? list.find((label) => label.key === null && isOurs(label) && sameName(label.name, name));
        const clash = list.some((label) => label !== existing && sameName(label.name, name));
        if (existing) {
          if (!isOurs(existing)) throw new MockHostError('conflict', `The key "${key}" belongs to another label of the project (label_key_taken)`);
          const next = { key, name, color: color ?? existing.color, groupName, description };
          if (existing.key === key && next.name === existing.name && next.color === existing.color && next.groupName === existing.groupName && next.description === existing.description) continue;
          if (clash) throw new MockHostError('conflict', `The project already has a label named "${name}" (label_name_taken)`);
          Object.assign(existing, next, { revision: existing.revision + 1 });
        } else {
          if (clash) throw new MockHostError('conflict', `The project already has a label named "${name}" (label_name_taken)`);
          list.push({
            id: `${projectId}-label-${key}`,
            projectId,
            name,
            color: color ?? LABEL_COLORS[list.length % LABEL_COLORS.length]!,
            groupName,
            description,
            position: list.length ? Math.max(...list.map((label) => label.position)) + 1 : 0,
            key,
            createdByApp: appId,
            appInstallationId: MOCK_INSTALLATION_ID,
            revision: 1,
          });
        }
        changed.push(name);
      }
      data.projectLabels[projectId] = list;
      if (changed.length) feed(projectId, 'PROJECT_UPDATED', changed.join(', '), null);
      return sortLabels(list.filter(isOurs));
    },
    'project.labels.remove': async ({ projectId, key }) => {
      writableProject(projectId);
      const list = listOf(data.projectLabels, projectId);
      const old = list.find((label) => label.key === keyOf(key, 'key'));
      if (!old || !isOurs(old)) throw new MockHostError('not_found', `The app has no label "${key}" in project ${projectId} (label_not_found)`);
      list.splice(list.indexOf(old), 1);
      feed(projectId, 'PROJECT_UPDATED', old.name, null);
      return null;
    },
    // ---- Custom fields: the app's own by key; members fill them in on tasks and issues ----
    'project.fields.list': async ({ projectId }) => {
      findProject(text(projectId, 'projectId', 200));
      return sortFields(listOf(data.projectFields, projectId));
    },
    'project.fields.define': async ({ projectId, fields }) => {
      writableProject(projectId);
      const items = definitionsOf(fields, 'fields');
      const list = structuredClone(listOf(data.projectFields, projectId));
      const changed: string[] = [];
      for (const item of items) {
        const key = item.key as string;
        const existing = list.find((field) => field.key === key);
        if (existing && !isOurs(existing)) throw new MockHostError('conflict', `The key "${key}" belongs to another field of the project (field_key_taken)`);
        if (existing && item.type !== undefined && item.type !== existing.type) invalid('field_type_immutable', `The field "${key}" keeps its type ${existing.type}`);
        const type = existing?.type ?? (PROJECT_FIELD_TYPES.includes(item.type as ProjectField['type']) ? (item.type as ProjectField['type']) : invalid('invalid_field_type', `type must be one of ${PROJECT_FIELD_TYPES.join(', ')}`));
        const name = item.name === undefined && existing ? existing.name : nameOf(item.name, 60, 'invalid_field_name');
        const description = item.description === undefined ? (existing?.description ?? '') : item.description === null ? ''
          : typeof item.description === 'string' && item.description.length <= 500 ? item.description : invalid('invalid_field_description', 'description must be at most 500 characters');
        const appliesTo = item.appliesTo === undefined ? (existing?.appliesTo ?? ['task'])
          : Array.isArray(item.appliesTo) && item.appliesTo.length && item.appliesTo.every((kind) => kind === 'task' || kind === 'issue')
            ? (['task', 'issue'] as const).filter((kind) => (item.appliesTo as unknown[]).includes(kind))
            : invalid('invalid_field_targets', 'appliesTo must list "task" and/or "issue"');
        const position = item.position === undefined || item.position === null ? existing?.position
          : Number.isInteger(item.position) && Math.abs(item.position as number) <= 1_000_000 ? (item.position as number) : invalid('invalid_position', 'position must be a whole number');
        const next = {
          name,
          description,
          options: fieldOptionsOf(type, item.options, existing?.options),
          required: flagOf(item.required, existing?.required ?? false),
          appliesTo: [...appliesTo],
          showOnCard: flagOf(item.showOnCard, existing?.showOnCard ?? false),
        };
        if (list.some((field) => field !== existing && sameName(field.name, name))) throw new MockHostError('conflict', `The project already has a field named "${name}" (field_name_taken)`);
        if (existing) {
          const same = JSON.stringify({ ...next, position: position ?? existing.position }) === JSON.stringify({ name: existing.name, description: existing.description, options: existing.options, required: existing.required, appliesTo: existing.appliesTo, showOnCard: existing.showOnCard, position: existing.position });
          if (same) continue;
          Object.assign(existing, next, { position: position ?? existing.position, revision: existing.revision + 1 });
          // Values of removed options, or of a kind the field no longer applies to, go (as on the server).
          const values = (data.projectFieldValues[projectId] ??= {});
          for (const [ref, stored] of Object.entries(values)) {
            if (!Object.hasOwn(stored, existing.id)) continue;
            const kind = ref.split(':')[0] as RecordTarget['kind'];
            const value = existing.appliesTo.includes(kind) ? normalizeFieldValue(existing, stored[existing.id]) : null;
            if (value === null) delete stored[existing.id];
            else stored[existing.id] = value;
          }
        } else {
          if (list.length >= 50) throw new MockHostError('quota_exceeded', 'A project has at most 50 fields (fields_limit)');
          list.push({
            id: `${projectId}-field-${key}`,
            projectId,
            type,
            ...next,
            position: position ?? (list.length ? Math.max(...list.map((field) => field.position)) + 1 : 0),
            key,
            createdByApp: appId,
            appInstallationId: MOCK_INSTALLATION_ID,
            appName,
            readOnly: false,
            revision: 1,
          });
        }
        changed.push(name);
      }
      data.projectFields[projectId] = list;
      if (changed.length) feed(projectId, 'PROJECT_UPDATED', changed.join(', '), null);
      return sortFields(list.filter(isOurs));
    },
    'project.fields.remove': async ({ projectId, key }) => {
      writableProject(projectId);
      const list = listOf(data.projectFields, projectId);
      const old = list.find((field) => field.key === keyOf(key, 'key'));
      if (!old || !isOurs(old)) throw new MockHostError('not_found', `The app has no field "${key}" in project ${projectId} (field_not_found)`);
      list.splice(list.indexOf(old), 1);
      for (const stored of Object.values(data.projectFieldValues[projectId] ?? {})) delete stored[old.id];
      feed(projectId, 'PROJECT_UPDATED', old.name, null);
      return null;
    },
    'project.fields.values': async ({ projectId, target }) => {
      const resolved = resolveTarget(findProject(text(projectId, 'projectId', 200)), target);
      return fieldValuesOf(projectId, resolved);
    },
    'project.fields.setValues': async ({ projectId, target, values }) => {
      const detail = writableProject(projectId);
      const resolved = resolveTarget(detail, target);
      if (!isRecord(values) || Object.keys(values).length > 50) invalid('invalid_field_values', 'values must be { <field key or id>: value | null }');
      const fields = listOf(data.projectFields, projectId).filter((field) => field.appliesTo.includes(resolved.kind));
      const stored = { ...((data.projectFieldValues[projectId] ??= {})[fieldTargetKey(resolved)] ?? {}) };
      const cleared = new Set<string>();
      for (const [ref, raw] of Object.entries(values)) {
        const field = fields.find((candidate) => candidate.id === ref) ?? fields.find((candidate) => candidate.key === ref);
        if (!field) invalid('invalid_field', `The project has no field "${ref}" for a ${resolved.kind}`);
        const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
        const value = empty ? null : (normalizeFieldValue(field!, raw) ?? invalid('invalid_field_value', `Not a value of the ${field!.type} field "${field!.name}"`));
        if (value !== null && field!.type === 'person' && !detail.members.some((member) => member.userId.toLowerCase() === value)) {
          invalid('invalid_field_value', `${String(value)} is not a member of the project`);
        }
        if (JSON.stringify(stored[field!.id] ?? null) === JSON.stringify(value)) continue;
        if (field!.readOnly) throw new MockHostError('conflict', `The app that defines "${field!.name}" was removed from the project (field_read_only)`);
        if (value === null) {
          delete stored[field!.id];
          cleared.add(field!.id);
        } else stored[field!.id] = value;
      }
      const required = fields.find((field) => field.required && !field.readOnly && cleared.has(field.id));
      if (required) invalid('field_required', `"${required.name}" needs a value`);
      data.projectFieldValues[projectId]![fieldTargetKey(resolved)] = stored;
      return fieldValuesOf(projectId, resolved);
    },
    // ---- Record links: the app's records on tasks and issues, with the card it draws ----
    'project.links.list': async ({ projectId, target }) => {
      const detail = findProject(text(projectId, 'projectId', 200));
      if (target !== undefined && (!isRecord(target) || (target.kind !== 'task' && target.kind !== 'issue') || typeof target.id !== 'string')) {
        invalid('invalid_target', 'target must be { kind: "task" | "issue", id }');
      }
      return listOf(data.recordLinks, projectId).filter(
        (link) => isLive(detail, link.target) && (!target || (link.target.kind === target.kind && link.target.id === target.id)),
      );
    },
    'project.links.upsert': async ({ projectId, target, externalId, card }) => {
      findProject(text(projectId, 'projectId', 200));
      const checked = validateRecordCard(card);
      if (!checked.ok) throw new MockHostError('validation_failed', `card (invalid_card): ${checked.issues.map((problem) => `${problem.code}: ${problem.message}`).join('; ')}`);
      const record = externalIdOf(externalId);
      const detail = writableProject(projectId);
      const resolved = resolveTarget(detail, target);
      const links = listOf(data.recordLinks, projectId);
      const onTarget = links.filter((link) => link.target.kind === resolved.kind && link.target.id === resolved.id);
      const existing = onTarget.find((link) => link.externalId === record);
      if (!existing && onTarget.length >= RPC_LIMITS.recordLinksPerTarget) {
        throw new MockHostError('quota_exceeded', `An app links at most ${RPC_LIMITS.recordLinksPerTarget} records to one ${resolved.kind} (record_links_limit)`);
      }
      const now = clock().toISOString();
      const title = checked.card.fallbackText.trim();
      if (existing) {
        Object.assign(existing, { title, card: checked.card, updatedBy: userId, revision: existing.revision + 1, updatedAt: now });
        return existing;
      }
      const link: RecordLink = {
        ...appSource(),
        id: freshId('link-', (id) => Object.values(data.recordLinks).some((list) => list.some((candidate) => candidate.id === id))),
        projectId,
        target: { kind: resolved.kind, id: resolved.id },
        externalId: record,
        title,
        card: checked.card,
        createdBy: userId,
        updatedBy: userId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      links.push(link);
      feed(projectId, 'APP_RECORD_LINKED', title, link.target);
      return link;
    },
    'project.links.remove': async ({ projectId, linkId }) => {
      writableProject(projectId);
      const link = findLink(projectId, linkId);
      const links = listOf(data.recordLinks, projectId);
      links.splice(links.indexOf(link), 1);
      feed(projectId, 'APP_RECORD_UNLINKED', link.title, link.target);
      return null;
    },
    'project.links.setStatus': async ({ projectId, linkId, statusKey, statusId, status, state, stateReason }) => {
      const detail = writableProject(projectId);
      const resolved = resolveTarget(detail, findLink(projectId, linkId).target);
      const now = clock().toISOString();
      if (resolved.kind === 'task') {
        const statuses = listOf(data.projectStatuses, projectId);
        let chosen: ProjectStatus | undefined;
        if (statusKey !== undefined) chosen = statuses.find((candidate) => candidate.key === keyOf(statusKey, 'statusKey'));
        else if (statusId !== undefined) chosen = statuses.find((candidate) => candidate.id === statusId);
        else if (typeof status === 'string' && TASK_STATUSES.has(status)) chosen = defaultStatusFor(statuses, status);
        else invalid('invalid_status', 'A linked task moves with statusKey, statusId or status (needs-action, in-process, completed, cancelled)');
        if (!chosen) return invalid('invalid_status', `No such status in project ${projectId}`);
        const task = resolved.task;
        if (data.taskStatusIds[task.id] !== chosen.id) {
          data.taskStatusIds[task.id] = chosen.id;
          Object.assign(task, { status: statusCalDav(chosen.category), revision: task.revision + 1, updatedAt: now });
          feed(projectId, 'TASK_STATUS_CHANGED', chosen.name, { kind: 'task', id: task.id });
        }
        return { target: { kind: 'task', id: task.id }, status: task.status, statusId: chosen.id, statusKey: chosen.key ?? null };
      }
      if (state !== 'open' && state !== 'closed') return invalid('invalid_state', 'A linked issue opens or closes with state "open" | "closed"');
      const issue = resolved.issue;
      if (issue.state !== state) {
        Object.assign(issue, { state, stateReason: state === 'closed' ? (stateReason === 'not_planned' ? 'not_planned' : 'completed') : null });
        feed(projectId, 'ISSUE_STATE_CHANGED', state, { kind: 'issue', id: issue.id });
      }
      return { target: { kind: 'issue', id: issue.id }, state };
    },
    // ---- The app's calendar layer and feed lines ----
    'project.calendar.list': async ({ projectId, from, to }) => {
      findProject(text(projectId, 'projectId', 200));
      const items = listOf(data.projectCalendarItems, projectId);
      let range: [number, number] | null = null;
      if (from !== undefined || to !== undefined) {
        const start = instantOf(from, 'invalid_range');
        const end = instantOf(to, 'invalid_range');
        if (end < start || end - start > RPC_LIMITS.projectCalendarRangeDays * DAY_MS) invalid('invalid_range', `to must follow from by at most ${RPC_LIMITS.projectCalendarRangeDays} days`);
        range = [start, end];
      }
      return items
        .filter((item) => !range || (Date.parse(item.end) >= range[0] && Date.parse(item.start) < range[1]))
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .slice(0, RPC_LIMITS.projectCalendarItems);
    },
    'project.calendar.upsert': async ({ projectId, externalId, title, start, end, allDay, color, linkId }) => {
      findProject(text(projectId, 'projectId', 200));
      const record = externalIdOf(externalId);
      const name = typeof title === 'string' && title.trim().length >= 1 && title.trim().length <= 200 ? title.trim() : invalid('invalid_title', 'title must be 1–200 characters');
      const whole = allDay === undefined ? false : typeof allDay === 'boolean' ? allDay : invalid('invalid_all_day', 'allDay must be a boolean');
      const from = instantOf(start, 'invalid_start');
      const until = end === undefined || end === null ? from : instantOf(end, 'invalid_end');
      if (until < from || until - from > RPC_LIMITS.projectCalendarRangeDays * DAY_MS) invalid('invalid_end', 'end must follow start by at most 366 days');
      const itemColor = colorOf(color, 'invalid_color');
      writableProject(projectId);
      const link = linkId === undefined || linkId === null ? null : findLink(projectId, linkId);
      const items = listOf(data.projectCalendarItems, projectId);
      const existing = items.find((item) => item.externalId === record);
      if (!existing && items.length >= RPC_LIMITS.projectCalendarItems) {
        throw new MockHostError('quota_exceeded', `An app keeps at most ${RPC_LIMITS.projectCalendarItems} calendar items per project (calendar_items_limit)`);
      }
      const fields = {
        title: name,
        start: new Date(from).toISOString(),
        end: new Date(until).toISOString(),
        allDay: whole,
        color: itemColor,
        linkId: link?.id ?? null,
        target: link ? { ...link.target } : null,
        updatedAt: clock().toISOString(),
      };
      if (existing) return Object.assign(existing, fields);
      const item: ProjectCalendarItem = {
        ...appSource(),
        id: freshId(`${projectId}-calendar-`, (id) => items.some((candidate) => candidate.id === id)),
        projectId,
        externalId: record,
        ...fields,
      };
      items.push(item);
      return item;
    },
    'project.calendar.remove': async ({ projectId, externalId }) => {
      findProject(text(projectId, 'projectId', 200));
      const record = externalIdOf(externalId);
      const items = listOf(data.projectCalendarItems, projectId);
      const index = items.findIndex((item) => item.externalId === record);
      if (index < 0) throw new MockHostError('not_found', `No calendar item ${record} of the app in project ${projectId} (calendar_item_not_found)`);
      items.splice(index, 1);
      return null;
    },
    'project.activity.post': async ({ projectId, text: value, target }) => {
      findProject(text(projectId, 'projectId', 200));
      const line = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      if (!line || line.length > RPC_LIMITS.projectActivityText) invalid('invalid_text', `text must be 1–${RPC_LIMITS.projectActivityText} characters`);
      const detail = writableProject(projectId);
      const resolved = target === undefined || target === null ? null : resolveTarget(detail, target);
      feed(projectId, 'APP_ACTIVITY', line, resolved);
      return null;
    },
    // ---- Approval requests ----
    'project.approvals.list': async ({ projectId, state }) => {
      findProject(text(projectId, 'projectId', 200));
      if (state !== undefined && state !== 'all' && !APPROVAL_STATES.has(state)) invalid('invalid_state', 'state must be pending, approved, rejected, cancelled or all');
      return listOf(data.projectApprovals, projectId)
        .filter((approval) => state === undefined || state === 'all' || approval.state === state)
        .reverse()
        .slice(0, 200);
    },
    'project.approvals.request': async ({ projectId, title, approverIds, mode, externalId, linkId, card, dueAt }) => {
      findProject(text(projectId, 'projectId', 200));
      const name = typeof title === 'string' && title.trim().length >= 1 && title.trim().length <= 200 ? title.trim() : invalid('invalid_title', 'title must be 1–200 characters');
      const chosenMode = mode === undefined ? 'all' : mode === 'all' || mode === 'any' ? mode : invalid('invalid_mode', 'mode must be "all" or "any"');
      if (!Array.isArray(approverIds) || approverIds.some((id) => typeof id !== 'string' || id.length === 0)) invalid('invalid_approvers', 'approverIds must be user ids');
      const approvers = [...new Set(approverIds)];
      if (approvers.length === 0 || approvers.length > RPC_LIMITS.projectApprovers) invalid('invalid_approvers', `approverIds must name 1–${RPC_LIMITS.projectApprovers} people`);
      const record = externalId === undefined || externalId === null ? null : externalIdOf(externalId);
      let checkedCard: ProjectApproval['card'] = null;
      if (card !== undefined && card !== null) {
        const checked = validateRecordCard(card);
        if (!checked.ok) throw new MockHostError('validation_failed', `card (invalid_card): ${checked.issues.map((problem) => `${problem.code}: ${problem.message}`).join('; ')}`);
        checkedCard = checked.card;
      }
      const due = dueAt === undefined || dueAt === null ? null : new Date(instantOf(dueAt, 'invalid_due')).toISOString();
      const detail = writableProject(projectId);
      // Approvers are members who may change the project.
      const writers = new Set(detail.members.filter((member) => member.role !== 'guest').map((member) => member.userId));
      if (approvers.some((id) => !writers.has(id))) invalid('invalid_approvers', 'Every approver must be a member who may change the project (fixtures/projects.json "members")');
      const link = linkId === undefined || linkId === null ? null : findLink(projectId, linkId);
      const approvals = listOf(data.projectApprovals, projectId);
      const now = clock().toISOString();
      const approval: ProjectApproval = {
        ...appSource(),
        id: freshId('approval-', (id) => Object.values(data.projectApprovals).some((list) => list.some((candidate) => candidate.id === id))),
        projectId,
        projectName: detail.project.name,
        externalId: record,
        linkId: link?.id ?? null,
        target: link ? { ...link.target } : null,
        title: name,
        card: checkedCard,
        approvers,
        mode: chosenMode,
        state: 'pending',
        dueAt: due,
        requestedBy: userId,
        decisions: [],
        createdAt: now,
        decidedAt: null,
      };
      approvals.push(approval);
      feed(projectId, 'APP_APPROVAL_REQUESTED', name, approval.target);
      return approval;
    },
    'project.approvals.cancel': async ({ projectId, approvalId }) => {
      findProject(text(projectId, 'projectId', 200));
      const approval = findApproval(projectId, approvalId);
      if (approval.state !== 'pending') throw new MockHostError('conflict', `The approval is ${approval.state} (approval_not_pending)`);
      Object.assign(approval, { state: 'cancelled', decidedAt: clock().toISOString() });
      return approval;
    },
    'projects.archive': async ({ projectId }) => {
      const detail = findProject(projectId);
      if (detail.project.createdByApp !== appId) deny('project', projectId, projectId, 'not_created_by_app', 'This app may remove only the projects it created');
      if (detail.project.archived) throw new MockHostError('conflict', 'The project is already archived (project_archived)');
      detail.project.archived = true;
      detail.project.revision += 1;
      detail.project.updatedAt = clock().toISOString();
      auditLog.push({ action: 'record.delete', detail: { kind: 'project', projectId, recordId: projectId, title: detail.project.name } });
      return null;
    },
    'backend.call': async ({ name, args }) => {
      if (!host.backend) throw new MockHostError('backend_unavailable', 'The app has no backend: declare "server" in olan-app.json and build it (olan-app build)');
      if (typeof name !== 'string' || name.length === 0) throw new MockHostError('invalid_params', 'backend.call needs a function name');
      const outcome = await host.backend(name, (args ?? null) as JsonValue, { userId, permissions: [...host.permissions] });
      if (!outcome.ok) throw new MockHostError(outcome.error.code, outcome.error.message);
      return outcome.result;
    },
    // ---- Phase 5a ----
    'remote.request': async (params) => {
      if (options.remoteRequests !== true) {
        throw new MockHostError('permission_denied', 'olan.remote.request needs "remote": { …, "requests": true } in olan-app.json', { status: 403 });
      }
      const checked = validateRemoteRequest(params);
      if (!checked.ok) throw new MockHostError(checked.code, checked.message, { status: checked.code === 'payload_too_large' ? 413 : 400 });
      const handler = remoteHandler ?? fixtureRoutes();
      const profile = host.permissions.includes('profile:read');
      const person = data.users.find((user) => user.id === userId);
      const envelope: RemoteRequestEnvelope = {
        id: `req_${randomUUID()}`,
        issuer: MOCK_ISSUER,
        installationId: MOCK_INSTALLATION_ID,
        appId,
        user: {
          id: userId,
          organizationId: options.organizationId ?? DEFAULT_ORGANIZATION_ID,
          locale: options.locale ?? 'tr',
          timeZone: options.timeZone ?? 'Europe/Istanbul',
          ...(profile && person ? { email: person.email, displayName: person.displayName } : {}),
          ...(profile ? { role: options.profileRole ?? 'member' } : {}),
        },
        request: checked.request,
        token: { accessToken: `mock-token.${userId}`, expiresIn: 300 },
      };
      const entry: MockRemoteRequest = { envelope: structuredClone(envelope), answer: null };
      remoteRequests.push(entry);
      const transport = options.remoteTransport ?? null;
      if (!handler && !transport) {
        throw new MockHostError('remote_unavailable', `No app server for ${checked.request.method} ${checked.request.path}: pass renderApp({ remote }) or add it to fixtures/remote.json`, { status: 0, reason: 'network' });
      }
      const { request } = envelope;
      let raw: unknown;
      if (transport) {
        // A real app server (dev --remote live): its own timeout, HTTP status and size checks.
        const sent = await transport(structuredClone(envelope));
        if (!sent.ok) throw new MockHostError('remote_unavailable', sent.message, { status: 0, reason: sent.reason });
        raw = sent.answer;
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<null>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(null), request.timeoutMs);
        });
        try {
          raw = await Promise.race([
            runRemoteRoute(handler!, { id: envelope.id, issuer: envelope.issuer, installationId: envelope.installationId, appId, user: envelope.user ?? null, method: request.method, path: request.path, query: request.query, headers: request.headers, body: request.body, token: envelope.token, timeoutMs: request.timeoutMs }),
            timedOut,
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (raw === null) throw new MockHostError('remote_unavailable', `The app server did not answer within ${request.timeoutMs} ms`, { status: 0, reason: 'timeout' });
      }
      let text: string;
      try {
        text = JSON.stringify(raw);
      } catch {
        throw new MockHostError('remote_unavailable', 'The app server answered something that is not JSON', { status: 0, reason: 'invalid_response' });
      }
      if (new TextEncoder().encode(text).length > REMOTE_REQUEST_LIMITS.responseBytes) {
        throw new MockHostError('remote_unavailable', `The app server's answer is larger than ${REMOTE_REQUEST_LIMITS.responseBytes} bytes`, { status: 0, reason: 'response_too_large' });
      }
      const answer = parseRemoteAnswer(JSON.parse(text));
      if (!answer) throw new MockHostError('remote_unavailable', 'The app server answered without { status (200–599), headers?, body? }', { status: 0, reason: 'invalid_response' });
      entry.answer = structuredClone(answer);
      const outcome = remoteRequestOutcome(answer);
      if (!outcome.ok) throw new MockHostError(outcome.error.code, outcome.error.message, outcome.error.details as unknown as JsonValue);
      return outcome.result;
    },
    'files.pick': async (params) => {
      const checked = normalizePickOptions(params);
      if (!checked.ok) throw new MockHostError('invalid_params', checked.message);
      const { accept, maxBytes, maxFiles } = checked.options;
      const fromFixtures = (name: string) => {
        const found = data.files.find((file) => file.name === name);
        if (!found) throw new MockHostError('invalid_params', `ui.files picked "${name}", which is not in fixtures/files.json`);
        return found;
      };
      const chosen =
        host.ui.files === undefined
          ? data.files
          : ((await answer(host.ui.files, null, checked.options)) ?? []).map((file) => (typeof file === 'string' ? fromFixtures(file) : normalizeFiles([file])[0]!));
      const allowed = chosen.filter((file) => acceptsFile(accept, file) && file.size <= maxBytes).slice(0, maxFiles);
      return allowed.map((file) => {
        pickCounter += 1;
        const id = `file_${pickCounter}`;
        pickedFiles.set(id, file);
        return { id, name: file.name, size: file.size, type: file.type, ...(file.lastModified !== undefined ? { lastModified: file.lastModified } : {}) };
      });
    },
    'files.upload': async (params) => {
      const checked = validateUploadParams(params);
      if (!checked.ok) throw new MockHostError('invalid_params', checked.message);
      const { uploadId, fileId, url, method, headers, formField, fields } = checked.params;
      const file = pickedFiles.get(fileId);
      if (!file) throw new MockHostError('invalid_params', `${fileId} is not a file picked in this session (olan.files.pick)`);
      const problem = uploadTargetProblem(url, { remoteUrl: options.remoteUrl ?? null, permissions: host.permissions, development });
      if (problem) {
        throw new MockHostError('http_blocked', `Uploads go only to the origin of remote.url or a host granted as "http:<host>" (${problem}): ${url}`);
      }
      const sent: Record<string, string> =
        method === 'PUT'
          ? { 'content-type': file.type, 'content-length': String(file.size), [UPLOAD_FILE_NAME_HEADER]: uploadFileNameHeader(file.name), ...headers }
          : { 'content-type': 'multipart/form-data; boundary=olan-mock-boundary', [UPLOAD_FILE_NAME_HEADER]: uploadFileNameHeader(file.name), ...headers };
      const record: MockUpload = {
        uploadId,
        file: { id: fileId, name: file.name, size: file.size, type: file.type, content: file.content },
        url,
        method,
        headers: sent,
        formField: method === 'POST' ? formField : null,
        fields,
        status: 'running',
      };
      uploads.push(record);
      emit?.({ type: 'upload-progress', uploadId, loaded: 0, total: file.size });
      const cancelled = new Promise<'cancelled'>((resolveCancel) => cancelUpload.set(uploadId, () => resolveCancel('cancelled')));
      let reply: MockUploadAnswer | 'cancelled';
      try {
        reply = await Promise.race([Promise.resolve(options.upload ? options.upload(structuredClone(record)) : {}), cancelled]);
      } catch (error) {
        record.status = 'failed';
        throw new MockHostError('upload_failed', error instanceof Error ? error.message : 'The upload failed');
      } finally {
        cancelUpload.delete(uploadId);
      }
      if (reply === 'cancelled') {
        record.status = 'cancelled';
        throw new MockHostError('cancelled', 'The upload was cancelled');
      }
      record.status = 'done';
      emit?.({ type: 'upload-progress', uploadId, loaded: file.size, total: file.size });
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        if ((UPLOAD_RESPONSE_HEADERS as readonly string[]).includes(name.toLowerCase())) responseHeaders[name.toLowerCase()] = value;
      }
      return { status: reply.status ?? 200, headers: responseHeaders, body: reply.body ?? null };
    },
    'files.cancel': async ({ uploadId }) => {
      cancelUpload.get(uploadId)?.();
      return null;
    },
    'ui.openUrl': async ({ url }) => {
      const problem = externalUrlProblem(url, { development });
      if (problem) throw new MockHostError('invalid_params', `openUrl takes https addresses (${problem}): ${String(url)}`);
      opened.push({ url, external: false, expectReturn: false });
      return null;
    },
    'ui.openExternal': async (params) => {
      const problem = externalUrlProblem(params.url, { development });
      if (problem) throw new MockHostError('invalid_params', `openExternal takes https addresses (${problem}): ${String(params.url)}`);
      const expectReturn = params.expectReturn === true;
      opened.push({ url: params.url, external: true, expectReturn });
      return expectReturn ? answer(host.ui.openExternal, { returned: false }, params) : { returned: false };
    },
    'timers.set': async ({ timerId, intervalMs }) => {
      if (typeof timerId !== 'string' || timerId.length === 0) throw new MockHostError('invalid_params', 'timers.set needs a timerId');
      if (!Number.isInteger(intervalMs) || intervalMs < RPC_LIMITS.timerMinIntervalMs) throw new MockHostError('invalid_params', `intervalMs must be at least ${RPC_LIMITS.timerMinIntervalMs}`);
      if (!timers.has(timerId) && timers.size >= RPC_LIMITS.timersPerSandbox) throw new MockHostError('invalid_params', `At most ${RPC_LIMITS.timersPerSandbox} timers`);
      timers.set(timerId, intervalMs);
      return null;
    },
    'timers.clear': async ({ timerId }) => {
      timers.delete(timerId);
      return null;
    },
  };

  const check = (method: string, params: JsonValue, handleOptions: MockHandleOptions): RpcOutcome | null => {
    const known = handleOptions.backend ? isBackendHostMethod(method) : isRpcMethod(method);
    if (!known) {
      const where = handleOptions.backend ? ' for backend code (ui.*, navigation.*, storage.*, mail.getMessage and backend.call are UI-only)' : '';
      return { ok: false, error: { code: 'unknown_method', message: `Unknown method ${method}${where}` } };
    }
    if (!isObject(params)) return { ok: false, error: { code: 'invalid_params', message: 'params must be an object' } };
    const url = typeof params.url === 'string' ? params.url : undefined;
    const granted = handleOptions.permissions ?? host.permissions;
    if (handleOptions.backend ? backendMethodAllowed(method, granted, url) : methodAllowed(method, granted, url)) return null;
    const required = REQUIRED_PERMISSION[method];
    if (required === HTTP_PERMISSION_PATTERN) {
      let target = 'this address';
      try {
        const parsed = new URL(url ?? '');
        target = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      } catch {
        // keep the generic text
      }
      return { ok: false, error: { code: 'http_blocked', message: `The app may not send requests to ${target}; add "http:${target}" to permissions` } };
    }
    return { ok: false, error: { code: 'permission_denied', message: `The app needs the ${required} permission` } };
  };

  return {
    get permissions() {
      return host.permissions;
    },
    set permissions(value: string[]) {
      host.permissions = [...value];
    },
    get ui() {
      return host.ui;
    },
    set ui(value: MockUi) {
      host.ui = value;
    },
    get surfaceParams() {
      return currentParams;
    },
    set surfaceParams(value: JsonValue) {
      currentParams = value;
    },
    calls,
    toasts,
    navigation,
    shares,
    data,
    db,
    userId,
    audit: () => structuredClone(auditLog),
    cards,
    secret: secretValue,
    get backend() {
      return host.backend;
    },
    set backend(value: MockHostOptions['backend'] | null) {
      host.backend = value ?? null;
    },
    get remote() {
      return remoteHandler;
    },
    set remote(value: MockRemoteHandler | null) {
      remoteHandler = value ?? null;
    },
    remoteRequests,
    uploads,
    opened,
    timers: () => [...timers].map(([timerId, intervalMs]) => ({ timerId, intervalMs })),
    get emit() {
      return emit;
    },
    set emit(value: ((message: HostToSandboxMessage) => void) | null) {
      emit = value;
    },
    decideApproval(projectId, approvalId, decision, decideOptions = {}) {
      const approver = decideOptions.userId ?? userId;
      const approval = findApproval(projectId, approvalId);
      if (decision !== 'approve' && decision !== 'reject') throw new MockHostError('invalid_params', 'decision must be "approve" or "reject" (invalid_decision)');
      if (!approval.approvers.includes(approver)) throw new MockHostError('permission_denied', `${approver} is not an approver of ${approvalId} (not_an_approver)`);
      if (approval.state !== 'pending') throw new MockHostError('conflict', `The approval is ${approval.state} (approval_not_pending)`);
      if (approval.decisions.some((entry) => entry.userId === approver)) throw new MockHostError('conflict', `${approver} already decided (approval_already_decided)`);
      const decidedAt = clock().toISOString();
      approval.decisions.push({ userId: approver, decision, note: (decideOptions.note ?? '').trim(), decidedAt });
      const state =
        approval.mode === 'any' || decision === 'reject'
          ? decision === 'approve' ? 'approved' : 'rejected'
          : approval.approvers.every((id) => approval.decisions.some((entry) => entry.userId === id && entry.decision === 'approve')) ? 'approved' : null;
      if (state) Object.assign(approval, { state, decidedAt });
      listOf(data.projectActivity, projectId).push({ type: 'APP_APPROVAL_DECIDED', text: approval.title, target: approval.target ? { ...approval.target } : null, actorId: approver, at: decidedAt });
      return structuredClone(approval);
    },
    async handle(method, params, handleOptions = {}) {
      let outcome = check(method, params, handleOptions);
      if (!outcome) {
        try {
          const call =
            method === 'secrets.get'
              ? async ({ name }: { name?: unknown }) => {
                  if (typeof name !== 'string' || name.length === 0) throw new MockHostError('invalid_params', 'secrets.get needs { name }');
                  return secretValue(name);
                }
              : (api[method as RpcMethodName] as (params: unknown) => Promise<unknown>);
          const result = await call(structuredClone(params) as never);
          outcome = { ok: true, result: structuredClone((result ?? null) as JsonValue) };
        } catch (error) {
          outcome =
            error instanceof MockHostError
              ? { ok: false, error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }
              : { ok: false, error: { code: 'host_error', message: error instanceof Error ? error.message : 'The mock host failed' } };
        }
      }
      calls.push(handleOptions.backend ? redactedRecord(method, params, outcome) : record(method, params, outcome, 'ui'));
      return outcome;
    },
  };
}

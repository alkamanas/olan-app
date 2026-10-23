/**
 * `@olan-app/cli/testing`: render an Olan app headlessly against the mock Olan host.
 *
 * ```ts
 * import { test } from 'node:test';
 * import { renderApp } from '@olan-app/cli/testing';
 *
 * test('lists projects', async () => {
 *   const app = await renderApp({ surface: 'app' });
 *   app.expectText('Web sitesi');
 *   await app.press('Web sitesi');
 *   app.expectText('Görev 2');
 *   await app.dispose();
 * });
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { defaultSettings, requestedPermissions, validateManifest, type OlanAppManifest } from '@olan-app/schema';
// The transport module alone (the `@olan-app/sdk/runtime` index pulls in react-reconciler, which
// stays external in dist/). Extensionless so packages without allowImportingTsExtensions
// (services/marketplace typecheck) can compile this file too.
import { createMemoryChannel } from '../../../app-sdk/src/runtime/transport';
import { applyPatches, createUiTree, snapshotTree, type UiTreeSnapshot } from '@olan-app/sdk/tree';
import type { HostToSandboxMessage, JsonValue, SandboxToHostMessage, Surface, UiNode, UiPatch } from '@olan-app/sdk/protocol';

import type { LogLine } from '@olan-app/runtime';

import { createBackendHarness, secretSettingKeys, type BackendHarness } from '../backend/harness';
import type { BackendEngine } from '../backend/runner';
import { CliError } from '../errors';
import {
  createMockHost,
  defaultFixtures,
  DEFAULT_USER_ID,
  FIXTURE_NOW,
  loadProjectFixtures,
  mergeFixtures,
  normalizeFixtures,
  type Fixtures,
  type NormalizedFixtures,
  type MockCall,
  type MockHost,
  type MockRemoteHandler,
  type MockUi,
  type MockUploadHandler,
  type NavigationRecord,
} from '../mock-server';
import { APP_SOURCE } from '../project';
import { documentOrder, fieldValue, fields, matches, normalizeText, pressables, visibleLines, type FieldValues, type Pressable } from './queries';
import { bundleForTest, evaluateApp } from './sandbox';

export { createMockHost, defaultFixtures, DEFAULT_USER, DEFAULT_USER_ID, DEFAULT_ORGANIZATION_ID, MOCK_INSTALLATION_ID, MOCK_ISSUER, MockHostError, normalizeFixtures, loadProjectFixtures } from '../mock-server';
export { RequestError } from '@olan-app/sdk/server';
export { createBackendHarness } from '../backend/harness';
export type { BackendCallOptions, BackendHarness, BackendHarnessOptions, BackendResult, EmitInput, HookInput, HookResult } from '../backend/harness';
export { signHookRequest, verifyHookSignature } from '@olan-app/sdk/server';
export { createTestIssuer, signRemoteRequest } from './issuer';
export type { RemoteRequestSignInput, RemoteRequestSignOptions, SignedRemoteRequest, TestIssuer, TestIssuerOptions } from './issuer';
export type {
  Fixtures,
  FixtureDbRow,
  FixtureTaskList,
  FixtureUser,
  FixtureCalendar,
  FixtureCalendarEvent,
  FixtureAddressBook,
  FixtureContact,
  FixtureMailMessage,
  FixtureMeeting,
  FixtureFile,
  FixtureProjectApp,
  FixtureProjectStatus,
  FixtureProjectLabel,
  FixtureProjectField,
  FixtureFieldValues,
  FixtureIssue,
  FixtureRecordLink,
  FixtureCalendarItem,
  FixtureApproval,
  MockProjectIssue,
  MockProjectActivity,
  MockAuditEntry,
  MockCall,
  MockCard,
  MockFile,
  MockHost,
  MockHostOptions,
  MockOpenedUrl,
  MockRemoteHandler,
  MockRemoteRequest,
  MockUi,
  MockUpload,
  MockUploadAnswer,
  MockUploadHandler,
  NavigationRecord,
  HttpFixture,
  NormalizedFixtures,
  RemoteFixture,
} from '../mock-server';

/**
 * The app's server for `olan.remote.request` in tests (`renderApp({ remote: remote({ … }) })` or
 * `app.remote(…)`): `handleRequest`-style routes (`"GET /brands/:brandId"`) or one handler. Routes
 * run like `@olan-app/sdk/server` `handleRequest` (unknown route 404, `RequestError` its status).
 */
export function remote(handler: MockRemoteHandler): MockRemoteHandler {
  return handler;
}

export interface RenderAppOptions {
  /** App directory (default: `OLAN_APP_ROOT`, set by `olan-app test`, else the current directory). */
  root?: string;
  /** App module relative to `root` (default `src/app.tsx`). */
  entry?: string;
  /** Surface to open (default `app`). */
  surface?: Surface;
  /**
   * `init.params`. Default: `defaultSurfaceParams(surface, fixtures)`, e.g. `{ projectId: <first project> }`
   * for the project surfaces, the first `fixtures/mail.json` message for `mail.sidebar`, `null` for `app`.
   */
  params?: JsonValue;
  /** Fixture data, key by key over `fixtures/*.json` over the built-in defaults. */
  fixtures?: Fixtures;
  /**
   * Granted permissions (default: the manifest's `permissions` plus the implied `remote` / `ai:tools`).
   * An explicit list replaces them, except that `remote` stays granted for a manifest with
   * `remote.requests` (it is implied, never listed); `remote: false` takes it away.
   */
  permissions?: string[];
  /** App settings, over the manifest defaults and `fixtures/settings.json`. */
  settings?: Record<string, JsonValue>;
  /** Answers for `olan.ui.confirm/prompt/menu/datePicker` (defaults: `true`, `null`, `null`, `null`). */
  ui?: MockUi;
  locale?: string;
  theme?: 'light' | 'dark';
  platform?: 'web' | 'desktop' | 'ios' | 'android';
  /** Freezes the app's clock (`Date.now()`, `new Date()`): an ISO string, a Date or milliseconds. */
  now?: string | number | Date;
  /**
   * The signed-in user: `context.user.id` (`useUser().id`) and, on the mock host, `createdBy` of new
   * rows and tasks, owner of `user` rows, `owner` rules. Default `DEFAULT_USER_ID`
   * (`00000000-0000-4000-8000-000000000001`, "Utku"). Add the person to `fixtures/users.json` when
   * the app looks them up with `users.get`.
   */
  userId?: string;
  /** `olan.db` limits for this run (default 100 000 rows, 100 MiB). */
  quota?: { rows?: number; bytes?: number };
  /** The admin's "only delete records it created" switch (default `false`). */
  deleteOwnRecordsOnly?: boolean;
  /** Do not throw when the app reports an error (inspect them with `errors()`). Default `false`. */
  allowErrors?: boolean;
  /** How long an action may take to settle (default 5000 ms). */
  timeoutMs?: number;
  /**
   * Apps with `server`: `olan.backend.call` runs the real backend (bundled from `server.entry`)
   * on the same mock host and database (default). `false` leaves it unanswered
   * (`backend_unavailable`); an object picks the engine.
   */
  backend?: boolean | { engine?: BackendEngine };
  /** `olan.secrets.get` values for the backend (default: the `secret: true` settings values). */
  secrets?: Record<string, string | null>;
  /**
   * The app server behind `olan.remote.request` (default: the `fixtures/remote.json` routes).
   * `false`: the implied `remote` permission is not granted (an admin blocked it): every call fails
   * with `permission_denied`.
   */
  remote?: MockRemoteHandler | false;
  /** The upload target's answer to `olan.files.upload` (default 200, no body). */
  upload?: MockUploadHandler;
  /** `user.role` in `remote.request` envelopes when `profile:read` is granted (default `member`). */
  profileRole?: 'admin' | 'member';
  /** Open on a screen, as a permanent app address does (`/apps/a/<appId>/<screen>?…`, `init.navigation`). */
  navigation?: { screen: string; params?: Record<string, string> };
}

export interface LogEntry {
  level: string;
  args: JsonValue[];
}

export interface AppErrorEntry {
  message: string;
  stack?: string;
  fatal?: boolean;
}

export interface RenderedApp {
  /** Presses a Button, a List item (by title), a Table row (by a cell), a Menu item, a Screen/Card action, an EmptyState action or a Form's submit/cancel label. */
  press(label: string | RegExp): Promise<void>;
  /** Types into a TextField (or sets a DatePicker / Select) found by label or name. */
  fill(label: string | RegExp, value: string): Promise<void>;
  /**
   * Chooses an option of a Select (by option value or label). On a MultiSelect a string toggles that
   * option and an array sets the selection.
   */
  select(label: string | RegExp, value: string | string[]): Promise<void>;
  /** Flips a Switch found by label. */
  toggle(label: string | RegExp): Promise<void>;
  /** Presses a Banner's close button (`onDismiss`): the Banner whose title or text matches, else the first. */
  dismiss(banner?: string | RegExp): Promise<void>;
  /** Sends one tick of every running `useQuery({ refetchIntervalMs })` timer, as the host does. */
  fireTimers(): Promise<void>;
  /** Replaces the app server behind `olan.remote.request` (null: the `fixtures/remote.json` routes). */
  remote(handler: MockRemoteHandler | null): void;
  /** Submits a Form (the one whose submitLabel matches, else the first) with the current field values. */
  submit(label?: string | RegExp): Promise<void>;
  /** The host's back control (pops the app's navigation stack). */
  back(): Promise<void>;
  /** Changes theme/locale/settings like the host does. */
  setContext(context: { theme?: 'light' | 'dark'; locale?: string; settings?: Record<string, JsonValue> }): Promise<void>;
  /** New surface params, as a host sends them to a panel (`mail.sidebar`, `meeting.panel`) when the person opens another object. */
  setParams(params: JsonValue): Promise<void>;
  expectText(text: string | RegExp): void;
  expectNoText(text: string | RegExp): void;
  /** Resolves when `predicate(app)` is true; rejects after `ms` (default 2000). */
  waitFor(predicate: (app: RenderedApp) => boolean | Promise<boolean>, ms?: number): Promise<void>;
  waitForText(text: string | RegExp, ms?: number): Promise<void>;
  /** Visible nodes in document order (JSON). */
  tree(): UiNode[];
  /** The nested tree (`{ type, props, children }`), or `null` before the first render. */
  snapshot(): UiTreeSnapshot | null;
  /** All visible text, one piece per line. */
  text(): string;
  /** Nodes of a component type, optionally filtered. */
  find(type: string, predicate?: (node: UiNode) => boolean): UiNode[];
  /**
   * `olan.*` calls in order (optionally of one method), with their outcome. With a backend the
   * calls its code made are included (`source: 'backend'`, secret values redacted);
   * `{ source: 'ui' }` keeps only the UI's.
   */
  calls(method?: string, filter?: { source?: MockCall['source'] }): MockCall[];
  toasts(): { text: string; tone?: string }[];
  navigation(): NavigationRecord[];
  logs(): LogEntry[];
  errors(): AppErrorEntry[];
  /** The mock host (live data: `host.data.storage`, `host.data.projects`, `host.data.db`, `host.audit()`, `host.permissions`). */
  readonly host: MockHost;
  /** Console lines of the app's backend (`olan.backend.call`), oldest first. */
  backendLogs(): LogLine[];
  /** Waits until rendering and `olan.*` calls are idle. */
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

function readManifest(root: string): OlanAppManifest | null {
  const path = join(root, 'olan-app.json');
  if (!existsSync(path)) return null;
  const result = validateManifest(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  return result.ok ? result.manifest : null;
}

const SAMPLE_CONVERSATION = 'conversation-0';

/**
 * The `init.params` a host would send for a surface, built from the fixtures: `project.widget`,
 * `project.tab`, `project.settings` → `{ projectId }` of the first project the app is enabled in;
 * `task.action` → its first task, `issue.action` → its first issue, `record.card` → the app's first
 * record link in it (Phase 6); `chat.*` → the first conversation (or `conversation-0`) and
 * its last message; `mail.*` → the first `fixtures/mail.json` message; `calendar.event.action` → the
 * first event the user organizes; `meeting.panel` → the first meeting; `app`/`settings` → `null`.
 */
export function defaultSurfaceParams(surface: Surface, data: NormalizedFixtures, userId: string = DEFAULT_USER_ID): JsonValue {
  const conversation = data.conversations[0];
  const conversationId = conversation?.id ?? SAMPLE_CONVERSATION;
  const message = (data.messages[conversationId] ?? []).at(-1);
  // The first project the app is enabled in (Phase 6).
  const project = data.projects.find((detail) => !data.disabledProjects.includes(detail.project.id)) ?? data.projects[0];
  const projectId = project?.project.id ?? null;
  switch (surface) {
    case 'project.widget':
    case 'project.tab':
    case 'project.settings':
      return { projectId };
    case 'task.action': {
      const task = project?.tasks[0];
      const status = task ? (data.projectStatuses[project!.project.id] ?? []).find((candidate) => candidate.id === data.taskStatusIds[task.id]) : undefined;
      return {
        projectId,
        task: task
          ? { id: task.id, key: task.key ?? null, title: task.title, status: task.status, statusId: status?.id ?? null, statusCategory: status?.category ?? null, assigneeId: task.assigneeId, due: task.due }
          : { id: 'task-0', key: null, title: 'Görev', status: 'needs-action', statusId: null, statusCategory: null, assigneeId: null, due: null },
      };
    }
    case 'issue.action': {
      const issue = projectId ? data.projectIssues[projectId]?.[0] : undefined;
      return {
        projectId,
        issue: issue
          ? { id: issue.id, key: issue.key, number: issue.number, title: issue.title, kind: issue.kind, state: issue.state, stateReason: issue.stateReason, inTriage: issue.inTriage }
          : { id: 'issue-0', key: null, number: 1, title: 'Sorun', kind: null, state: 'open', stateReason: null, inTriage: false },
      };
    }
    case 'record.card': {
      const link = projectId ? data.recordLinks[projectId]?.[0] : undefined;
      if (link) return { projectId, linkId: link.id, target: { ...link.target }, externalId: link.externalId, payload: null };
      return { projectId, linkId: 'link-0', target: { kind: 'task', id: project?.tasks[0]?.id ?? 'task-0' }, externalId: 'record-0', payload: null };
    }
    case 'chat.action':
      return {
        conversationId,
        message: message
          ? { id: message.id, body: message.body, senderId: message.sender.id, senderKind: 'user', createdAt: message.createdAt, threadRootId: null }
          : { id: 'message-0', body: 'Yarın 10:00 standup', senderId: userId, senderKind: 'user', createdAt: FIXTURE_NOW, threadRootId: null },
      };
    case 'chat.command':
      return { conversationId, text: '', threadRootId: null };
    case 'chat.card':
      return { conversationId, messageId: 'card-message-0', payload: null };
    case 'mail.sidebar':
    case 'mail.action': {
      const mail = data.mail[0];
      if (!mail) return { messageId: 'mail-0', threadId: null, subject: '', from: { name: null, email: 'someone@example.com' }, to: [], cc: [], receivedAt: FIXTURE_NOW };
      return { messageId: mail.id, threadId: mail.threadId, subject: mail.subject, from: mail.from, to: mail.to, cc: mail.cc, receivedAt: mail.receivedAt };
    }
    case 'calendar.event.action': {
      const event = data.calendarEvents.find((candidate) => candidate.isOrganizer) ?? data.calendarEvents[0];
      if (!event) return { calendarId: 'cal-0', eventId: 'event-0', uid: 'event-0@example.com', title: '', start: FIXTURE_NOW, end: FIXTURE_NOW, timeZone: null, isAllDay: false, location: null, isOrganizer: true };
      return { calendarId: event.calendarId, eventId: event.id, uid: event.uid, title: event.title, start: event.start, end: event.end, timeZone: event.timeZone, isAllDay: event.isAllDay, location: event.location, isOrganizer: event.isOrganizer };
    }
    case 'meeting.panel': {
      const meeting = data.meetings[0];
      if (!meeting) return { meetingId: 'meeting-0', slug: 'meeting-0', title: '', startsAt: FIXTURE_NOW, endsAt: null, role: 'organizer', projectId: null };
      return { meetingId: meeting.id, slug: meeting.slug, title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt, role: meeting.organizerId === userId ? 'organizer' : 'participant', projectId: meeting.projectId };
    }
    default:
      return null;
  }
}

function toMillis(now: string | number | Date | undefined): number | undefined {
  if (now === undefined) return undefined;
  const value = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(value)) throw new Error(`renderApp: invalid now ${String(now)}`);
  return value;
}

const tick = () => new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));
/** Calls that may stay pending on purpose in a test (an unsettled `upload`, a slow `remote` route). */
const LONG_RUNNING_METHODS: ReadonlySet<string> = new Set(['files.upload', 'remote.request', 'backend.call']);
const SELECT_TYPES: ReadonlySet<string> = new Set(['Select', 'MultiSelect', 'TextField', 'DatePicker']);
const SWITCH_TYPES: ReadonlySet<string> = new Set(['Switch']);

/**
 * Bundles the app (cached), starts its runtime in a `node:vm` context over an in-memory channel,
 * sends `init` and resolves once the first render and its `olan.*` calls have settled.
 */
export async function renderApp(options: RenderAppOptions = {}): Promise<RenderedApp> {
  const root = resolve(options.root ?? process.env.OLAN_APP_ROOT ?? process.cwd());
  const manifest = readManifest(root);
  const surface: Surface = options.surface ?? 'app';
  const timeoutMs = options.timeoutMs ?? 5000;
  const fixtures = mergeFixtures(defaultFixtures(), loadProjectFixtures(root), options.fixtures);
  const settings = { ...(manifest ? defaultSettings(manifest) : {}), ...(fixtures.settings ?? {}), ...(options.settings ?? {}) };
  // Phase 3 §15.1: for apps with `server`, `secret: true` settings never reach the UI.
  const secretKeys = manifest?.server ? secretSettingKeys(manifest) : [];
  const uiSettings = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, secretKeys.includes(key) ? null : value]));
  let host: MockHost;
  // Params need the normalized fixtures; a first pass without the app database is enough for them.
  const preview = normalizeFixtures(structuredClone({ ...fixtures, db: {} }));
  const params: JsonValue = options.params !== undefined ? options.params : defaultSurfaceParams(surface, preview, options.userId);
  // Implied permissions (`remote`, `ai:tools`) are part of the effective permissions, as on the host.
  // An explicit list keeps `remote` for `remote.requests` apps (it is never listed in a manifest);
  // `remote: false` blocks it.
  let permissions = options.permissions ? [...options.permissions] : manifest ? requestedPermissions(manifest) : [];
  if (options.permissions && manifest?.remote?.requests === true && !permissions.includes('remote')) permissions.push('remote');
  if (options.remote === false) permissions = permissions.filter((permission) => permission !== 'remote');
  try {
    host = createMockHost({
      surfaceParams: params,
      remote: manifest?.remote !== undefined,
      remoteUrl: manifest?.remote?.url ?? null,
      remoteRequests: manifest?.remote?.requests === true,
      ...(options.remote ? { remoteHandler: options.remote } : {}),
      ...(options.upload ? { upload: options.upload } : {}),
      ...(options.profileRole ? { profileRole: options.profileRole } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      fixtures: { ...fixtures, settings },
      permissions,
      ui: options.ui,
      data: manifest?.data ?? null,
      appId: manifest?.id,
      ...(manifest?.name ? { appName: manifest.name } : {}),
      ...(options.userId !== undefined ? { userId: options.userId } : {}),
      ...(options.quota ? { quota: options.quota } : {}),
      ...(options.deleteOwnRecordsOnly !== undefined ? { deleteOwnRecordsOnly: options.deleteOwnRecordsOnly } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      secretSettings: secretKeys,
      ...(options.secrets ? { secrets: options.secrets } : {}),
    });
  } catch (error) {
    if (error instanceof CliError) throw new Error(`renderApp: the fixtures are invalid:\n${error.issues.map((item) => item.message).join('\n')}`);
    throw error;
  }

  // `olan.backend.call` → the app's backend on the same host (started on the first call).
  let backend: Promise<BackendHarness> | null = null;
  const backendLogLines: LogLine[] = [];
  if (manifest?.server && options.backend !== false) {
    const engine = typeof options.backend === 'object' ? options.backend.engine : undefined;
    const mock = host;
    host.backend = async (name, args, caller) => {
      backend ??= createBackendHarness({ root, host: mock, ...(engine ? { engine } : {}) });
      let harness: BackendHarness;
      try {
        harness = await backend;
      } catch (error) {
        return { ok: false, error: { code: 'backend_unavailable', message: error instanceof Error ? error.message : String(error) } };
      }
      const result = await harness.call(name, args, caller);
      backendLogLines.push(...result.logs);
      return result.ok ? { ok: true, result: (result.value ?? null) as JsonValue } : { ok: false, error: { code: result.error!.code, message: result.error!.message } };
    };
  }

  let code: string;
  try {
    code = await bundleForTest(root, options.entry ?? APP_SOURCE);
  } catch (error) {
    if (error instanceof CliError) {
      throw new Error(`The app does not build:\n${error.issues.map((item) => `${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`);
    }
    throw error;
  }
  const sandbox = evaluateApp(code, { now: toMillis(options.now) });
  if (!sandbox.app || (sandbox.app as { $olanApp?: unknown }).$olanApp !== 1) {
    sandbox.dispose();
    throw new Error(`${options.entry ?? APP_SOURCE} must \`export default defineApp({ ... })\``);
  }

  const tree = createUiTree();
  const values: FieldValues = new Map();
  const logs: LogEntry[] = [];
  const errors: AppErrorEntry[] = [];
  let activity = 0;
  let pending = 0;
  /** Methods of the `olan.*` calls still waiting for the mock host (for the settle message). */
  const pendingMethods = new Map<number, string>();
  let ready = false;
  let disposed = false;
  const channel = createMemoryChannel();
  const post = (message: HostToSandboxMessage) => channel.host.post(message);
  host.emit = (message) => {
    if (!disposed) post(message);
  };

  channel.host.onMessage((message: SandboxToHostMessage) => {
    activity++;
    switch (message.type) {
      case 'ready':
        ready = true;
        break;
      case 'patches':
        applyPatches(tree, message.patches as UiPatch[]);
        break;
      case 'rpc':
        pending++;
        pendingMethods.set(message.id, message.method);
        void host.handle(message.method, message.params).then((outcome) => {
          pending--;
          pendingMethods.delete(message.id);
          activity++;
          if (disposed) return;
          post(outcome.ok ? { type: 'rpc-result', id: message.id, ok: true, result: outcome.result } : { type: 'rpc-result', id: message.id, ok: false, error: outcome.error });
          activity++;
        });
        break;
      case 'log':
        logs.push({ level: message.level, args: message.args });
        if (process.env.OLAN_APP_TEST_LOGS) process.stderr.write(`[app ${message.level}] ${message.args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
        break;
      case 'error':
        errors.push({ message: message.message, ...(message.stack ? { stack: message.stack } : {}), ...(message.fatal ? { fatal: true } : {}) });
        break;
      default:
        break;
    }
  });

  const runtime = sandbox.start(channel.sandbox as never);

  const settle = async () => {
    const deadline = Date.now() + timeoutMs;
    let idle = 0;
    let seen = activity;
    while (idle < 3) {
      await tick();
      const busy = pending > 0 || sandbox.pendingShortTimers() > 0 || activity !== seen;
      seen = activity;
      idle = busy ? 0 : idle + 1;
      if (Date.now() > deadline) throw new Error(unsettledMessage());
    }
    for (const error of sandbox.timerErrors.splice(0)) {
      errors.push({ message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) });
    }
  };

  /** Why `settle` gave up: a call that is still running (an upload, a remote call), or a render loop. */
  const unsettledMessage = () => {
    const methods = [...pendingMethods.values()];
    const waiting = [...new Set(methods.filter((method) => LONG_RUNNING_METHODS.has(method)))];
    if (waiting.length > 0) {
      return [
        `The app did not settle within ${timeoutMs} ms: ${waiting.join(', ')} is still pending (an upload or remote call that has not finished, e.g. an \`upload\` handler whose promise has not settled yet).`,
        'An action that starts such a call settles only when the call ends: start it without awaiting (`const pressing = app.press(...)`),',
        '`await app.waitFor(...)` for the in-progress UI, finish or cancel the call, then `await pressing` (testing.md#remote-requests-files-and-links).',
      ].join(' ');
    }
    if (methods.length > 0) return `The app did not settle within ${timeoutMs} ms: ${methods.length} olan.* call(s) still pending (${[...new Set(methods)].join(', ')}).`;
    return `The app did not settle within ${timeoutMs} ms with no olan.* call pending: is it re-rendering in a loop, or starting short timers without end?`;
  };

  const describeErrors = (list: AppErrorEntry[]) => list.map((entry) => `${entry.fatal ? '[fatal] ' : ''}${entry.message}`).join('\n');

  /** Runs an interaction, waits for it to settle and fails on new app errors (unless allowed). */
  const act = async (what: string, run: () => void) => {
    if (disposed) throw new Error(`${what}: the app was disposed`);
    const before = errors.length;
    run();
    await settle();
    const fresh = errors.slice(before);
    if (fresh.length > 0 && !options.allowErrors) {
      throw new Error(`${what}: the app reported an error:\n${describeErrors(fresh)}\n(pass allowErrors: true to renderApp to inspect errors() instead)`);
    }
  };

  const sendEvent = (handlerId: number, payload: JsonValue) => post({ type: 'event', handlerId, payload });

  const labelText = (label: string | RegExp) => (label instanceof RegExp ? String(label) : `"${label}"`);

  const findPressable = (label: string | RegExp): Pressable => {
    const all = pressables(tree);
    const found = all.find((candidate) => matches(candidate.label, label)) ?? all.find((candidate) => matches(candidate.label, label, true));
    if (!found) {
      const available = [...new Set(all.map((candidate) => `${candidate.label} (${candidate.kind})`))];
      throw new Error(`press(${labelText(label)}): nothing to press with that label. Pressable: ${available.length ? available.join(', ') : 'none'}.\nVisible text:\n${visibleLines(tree, values).join('\n')}`);
    }
    if (found.disabled) throw new Error(`press(${labelText(label)}): the ${found.kind} is disabled`);
    if (found.handlerId === null && !found.submitForm) throw new Error(`press(${labelText(label)}): the ${found.kind} has no handler`);
    return found;
  };

  const findField = (label: string | RegExp, method: string, types?: ReadonlySet<string>): UiNode => {
    const all = types ? documentOrder(tree).filter((node) => types.has(node.type)) : fields(tree);
    const found =
      all.find((node) => matches(node.props.label as string | undefined, label)) ??
      all.find((node) => matches(node.props.name as string | undefined, label)) ??
      all.find((node) => matches(node.props.label as string | undefined, label, true));
    if (!found) {
      const available = all.map((node) => `${String(node.props.label)} (${node.type} ${String(node.props.name)})`);
      throw new Error(`${method}(${labelText(label)}): no field with that label or name. Fields: ${available.length ? available.join(', ') : 'none'}`);
    }
    return found;
  };

  const setField = (node: UiNode, value: string) => {
    values.set(node.id, { value, propAtFill: node.props.value });
    const handler = node.props.onChange as { $handler?: number } | undefined;
    if (handler && typeof handler.$handler === 'number') sendEvent(handler.$handler, { value });
  };

  const submitForm = (form: UiNode) => {
    const handler = form.props.onSubmit as { $handler?: number } | undefined;
    if (!handler || typeof handler.$handler !== 'number') throw new Error('submit(): the Form has no onSubmit handler');
    const formValues: Record<string, string> = {};
    for (const field of fields(tree, form.id)) formValues[String(field.props.name)] = fieldValue(field, values);
    sendEvent(handler.$handler, { values: formValues });
  };

  const text = () => visibleLines(tree, values).join('\n');
  const hasText = (wanted: string | RegExp) => {
    const lines = visibleLines(tree, values);
    if (wanted instanceof RegExp) return lines.some((line) => wanted.test(line)) || wanted.test(lines.join('\n'));
    const needle = normalizeText(wanted);
    return lines.some((line) => normalizeText(line).includes(needle)) || normalizeText(lines.join(' ')).includes(needle);
  };

  const app: RenderedApp = {
    host,
    settle,
    async press(label) {
      await act(`press(${labelText(label)})`, () => {
        const target = findPressable(label);
        if (target.submitForm) {
          const form = tree.nodes.get(target.nodeId)!;
          submitForm(form);
        } else {
          sendEvent(target.handlerId!, target.payload);
        }
      });
    },
    async fill(label, value) {
      await act(`fill(${labelText(label)})`, () => setField(findField(label, 'fill'), value));
    },
    async select(label, value) {
      await act(`select(${labelText(label)})`, () => {
        const node = findField(label, 'select', SELECT_TYPES);
        const options = Array.isArray(node.props.options) ? (node.props.options as { value: string; label: string }[]) : [];
        const optionOf = (wanted: string) => {
          const option = options.find((candidate) => candidate.value === wanted) ?? options.find((candidate) => matches(candidate.label, wanted));
          if (!option) throw new Error(`select(${labelText(label)}): no option ${JSON.stringify(wanted)}. Options: ${options.map((candidate) => `${candidate.value} (${candidate.label})`).join(', ')}`);
          return option.value;
        };
        if (node.type === 'MultiSelect') {
          if (node.props.disabled === true) throw new Error(`select(${labelText(label)}): the MultiSelect is disabled`);
          const current = Array.isArray(node.props.value) ? (node.props.value as string[]) : [];
          let next: string[];
          if (Array.isArray(value)) next = value.map(optionOf);
          else {
            const picked = optionOf(value);
            next = current.includes(picked) ? current.filter((item) => item !== picked) : [...current, picked];
          }
          const handler = node.props.onChange as { $handler?: number } | undefined;
          if (!handler || typeof handler.$handler !== 'number') throw new Error(`select(${labelText(label)}): the MultiSelect has no onChange handler`);
          sendEvent(handler.$handler, { value: next });
          return;
        }
        if (Array.isArray(value)) throw new Error(`select(${labelText(label)}): a Select takes one value`);
        setField(node, optionOf(value));
      });
    },
    async toggle(label) {
      await act(`toggle(${labelText(label)})`, () => {
        const node = findField(label, 'toggle', SWITCH_TYPES);
        if (node.props.disabled === true) throw new Error(`toggle(${labelText(label)}): the Switch is disabled`);
        const handler = node.props.onChange as { $handler?: number } | undefined;
        if (!handler || typeof handler.$handler !== 'number') throw new Error(`toggle(${labelText(label)}): the Switch has no onChange handler`);
        sendEvent(handler.$handler, { value: node.props.value !== true });
      });
    },
    async dismiss(banner) {
      const what = banner === undefined ? 'dismiss()' : `dismiss(${labelText(banner)})`;
      await act(what, () => {
        const banners = documentOrder(tree).filter((node) => node.type === 'Banner');
        const node =
          banner === undefined
            ? banners[0]
            : (banners.find((candidate) => [candidate.props.title, candidate.props.text].some((value) => matches(value as string | undefined, banner))) ??
              banners.find((candidate) => [candidate.props.title, candidate.props.text].some((value) => matches(value as string | undefined, banner, true))));
        if (!node) {
          const available = banners.map((candidate) => JSON.stringify(String(candidate.props.title ?? candidate.props.text)));
          throw new Error(`${what}: no Banner${banner === undefined ? ' on screen' : ' with that title or text'}. Banners: ${available.length ? available.join(', ') : 'none'}`);
        }
        const handler = node.props.onDismiss as { $handler?: number } | undefined;
        if (!handler || typeof handler.$handler !== 'number') throw new Error(`${what}: the Banner has no onDismiss (no close button)`);
        sendEvent(handler.$handler, null);
      });
    },
    async fireTimers() {
      await act('fireTimers()', () => {
        for (const { timerId } of host.timers()) post({ type: 'timer', timerId });
      });
    },
    remote(handler) {
      host.remote = handler;
    },
    async submit(label) {
      await act('submit()', () => {
        const forms = documentOrder(tree).filter((node) => node.type === 'Form');
        const form = label === undefined ? forms[0] : forms.find((node) => matches(node.props.submitLabel as string | undefined, label));
        if (!form) throw new Error(label === undefined ? 'submit(): there is no Form on screen' : `submit(${labelText(label)}): no Form with that submitLabel`);
        submitForm(form);
      });
    },
    async back() {
      await act('back()', () => post({ type: 'navigation', action: 'back' }));
    },
    async setContext(context) {
      await act('setContext()', () => post({ type: 'context', context }));
    },
    async setParams(next) {
      await act('setParams()', () => {
        host.surfaceParams = next;
        post({ type: 'context', context: {}, params: next });
      });
    },
    expectText(wanted) {
      if (!hasText(wanted)) {
        const problems = errors.length ? `\nApp errors:\n${describeErrors(errors)}` : '';
        throw new Error(`expectText(${labelText(wanted)}): not on screen.\nVisible text:\n${text() || '(nothing)'}${problems}`);
      }
    },
    expectNoText(wanted) {
      if (hasText(wanted)) throw new Error(`expectNoText(${labelText(wanted)}): it is on screen.\nVisible text:\n${text()}`);
    },
    async waitFor(predicate, ms = 2000) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (await predicate(app)) return;
        if (Date.now() > deadline) throw new Error(`waitFor: the condition was not met within ${ms} ms.\nVisible text:\n${text()}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    },
    async waitForText(wanted, ms = 2000) {
      await app.waitFor(() => hasText(wanted), ms).catch(() => {
        throw new Error(`waitForText(${labelText(wanted)}): not on screen after ${ms} ms.\nVisible text:\n${text() || '(nothing)'}`);
      });
    },
    tree: () => structuredClone(documentOrder(tree)),
    snapshot: () => structuredClone(snapshotTree(tree)),
    text,
    find: (type, predicate) => structuredClone(documentOrder(tree).filter((node) => node.type === type && (!predicate || predicate(node)))),
    calls: (method, filter = {}) =>
      structuredClone(host.calls.filter((call) => (!method || call.method === method) && (!filter.source || call.source === filter.source))),
    toasts: () => structuredClone(host.toasts),
    navigation: () => structuredClone(host.navigation),
    logs: () => structuredClone(logs),
    backendLogs: () => structuredClone(backendLogLines),
    errors: () => structuredClone(errors),
    async dispose() {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
      sandbox.dispose();
      if (backend) await backend.then((harness) => harness.dispose()).catch(() => undefined);
      await tick();
    },
  };

  // Boot: wait for `ready`, send `init`, wait for the first render to settle.
  const bootDeadline = Date.now() + timeoutMs;
  while (!ready) {
    await tick();
    if (Date.now() > bootDeadline) {
      await app.dispose();
      throw new Error('The app runtime did not send `ready`');
    }
  }
  post({
    type: 'init',
    app: { id: manifest?.id ?? 'com.example.app', version: manifest?.version ?? '0.0.0', installationId: null },
    surface,
    params,
    context: {
      theme: options.theme ?? 'light',
      locale: options.locale ?? 'tr',
      platform: options.platform ?? 'web',
      permissions: [...host.permissions],
      settings: uiSettings,
      development: true,
      user: { id: host.userId },
    },
    ...(options.navigation ? { navigation: { screen: options.navigation.screen, params: options.navigation.params ?? {} } } : {}),
  });
  await settle();
  const fatal = errors.filter((entry) => entry.fatal);
  if ((fatal.length > 0 || errors.length > 0) && !options.allowErrors) {
    const list = errors.slice();
    await app.dispose();
    throw new Error(`The ${surface} surface failed to render:\n${describeErrors(list)}`);
  }
  return app;
}

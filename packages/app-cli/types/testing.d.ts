/**
 * Public types of `@olan-app/cli/testing` (self-contained: no Node or React types needed).
 * The implementation is `src/testing/index.ts`; `test/types.test.ts` keeps them in step.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PropValue = JsonValue | { $handler: number } | PropValue[] | { [key: string]: PropValue };
export type Surface =
  | 'app'
  | 'project.widget'
  | 'settings'
  | 'chat.action'
  | 'chat.command'
  | 'chat.card'
  | 'mail.sidebar'
  | 'mail.action'
  | 'calendar.event.action'
  | 'meeting.panel'
  | 'project.tab'
  | 'project.settings'
  | 'task.action'
  | 'issue.action'
  | 'record.card';

export interface UiNode {
  id: number;
  type: string;
  props: Record<string, PropValue>;
  children: number[];
}

export interface UiTreeSnapshot {
  type: string;
  props: Record<string, PropValue>;
  children: UiTreeSnapshot[];
}

export type ProjectTaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';

/** A loose task: only `id` and `title` are required; the rest gets defaults. */
export interface FixtureTask {
  id: string;
  title: string;
  projectId?: string;
  listId?: string;
  key?: string;
  number?: number;
  description?: string;
  status?: ProjectTaskStatus;
  assigneeId?: string | null;
  createdBy?: string;
  start?: string | null;
  due?: string | null;
  allDay?: boolean;
  revision?: number;
  updatedAt?: string;
  /** Manifest id of the app that created the task (mock host: the app under test), null for people. */
  createdByApp?: string | null;
}

/** A loose work package: `isDefault` (first list of the project), `revision` (1), `parentId` (null) get defaults. */
export interface FixtureTaskList {
  id: string;
  name: string;
  isDefault?: boolean;
  revision?: number;
  parentId?: string | null;
}

/** A work package as the mock host serves it. */
export interface TaskList {
  id: string;
  name: string;
  isDefault: boolean;
  revision: number;
  parentId: string | null;
}

/** An `olan.db` row. */
export interface DbRow<T = Record<string, JsonValue>> {
  id: string;
  data: T;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** A person in the directory (`olan.users.get`; `fixtures/users.json` entries). */
export interface FixtureUser {
  id: string;
  displayName: string;
  email: string;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  avatarUrl?: string | null;
}

/** A `fixtures/db.json` row: `createdBy` defaults to `DEFAULT_USER_ID`, times to the test clock, `revision` to 1, `id` to a UUID. */
export interface FixtureDbRow {
  id?: string;
  data: Record<string, JsonValue>;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
}

/**
 * Phase 6: `enabled` (default `true`) says whether the app was added to the project; `false` hides it
 * from `olan.projects.list` and makes calls naming it fail with `project_not_enabled`. `config` is the
 * stored `olan.project.config` value.
 */
export interface FixtureProjectApp {
  enabled?: boolean;
  config?: Record<string, JsonValue>;
  /** Phase 6 (second wave): statuses beyond the four defaults (`todo`, `in_progress`, `done`, `cancelled`); the app's own unless `"app": false`. */
  statuses?: FixtureProjectStatus[];
  /** Labels of the project; the app's own unless `"app": false`. */
  labels?: FixtureProjectLabel[];
  /** Custom fields of the project (SDK 1.8); the app's own unless `"app": false`. */
  fields?: FixtureProjectField[];
  /** Values of the fields on tasks and issues, by field key (or id). */
  fieldValues?: FixtureFieldValues[];
  /** Issues (targets of `issue.action` and of record links with `kind: "issue"`). */
  issues?: FixtureIssue[];
  /** The app's record links (`olan.project.links.*`). */
  links?: FixtureRecordLink[];
  /** The app's calendar layer (`olan.project.calendar.*`). */
  calendarItems?: FixtureCalendarItem[];
  /** The app's approval requests (`olan.project.approvals.*`). */
  approvals?: FixtureApproval[];
}

export type ProjectStatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

/** A record card (`olan.project.links.upsert`): a chat card whose buttons only `{ kind: 'open', payload? }`. */
export interface RecordCard {
  version: 1;
  root: number;
  nodes: UiNode[];
  fallbackText: string;
}

export interface RecordTarget {
  kind: 'task' | 'issue';
  id: string;
}

/** A `projects.json` status: `name`, `category` and (for the app's own) `key`. */
export interface FixtureProjectStatus {
  key?: string | null;
  name: string;
  category: ProjectStatusCategory;
  color?: string;
  position?: number;
  id?: string;
  /** Defined by the app under test (default `true`). */
  app?: boolean;
}

/** A `projects.json` label. */
export interface FixtureProjectLabel {
  key?: string | null;
  name: string;
  color?: string;
  groupName?: string | null;
  description?: string;
  id?: string;
  app?: boolean;
}

export type ProjectFieldType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'person' | 'url' | 'checkbox';
/** Text, url, date (`YYYY-MM-DD`), select option id and person id are strings. */
export type ProjectFieldValue = string | number | boolean | string[];

/** A `projects.json` custom field: `name`, `type` and (for the app's own) `key`. */
export interface FixtureProjectField {
  key?: string | null;
  name: string;
  type: ProjectFieldType;
  description?: string;
  /** Select and multi-select fields; an option without `id` gets a slug of its name. */
  options?: { id?: string; name: string; color?: string }[];
  required?: boolean;
  /** Default: tasks only. */
  appliesTo?: ('task' | 'issue')[];
  showOnCard?: boolean;
  id?: string;
  /** Defined by the app under test (default `true`). */
  app?: boolean;
  /** Values are read-only (the app was removed from the project). */
  readOnly?: boolean;
}

/** A `projects.json` task's or issue's field values. */
export interface FixtureFieldValues {
  target: RecordTarget;
  values: Record<string, ProjectFieldValue>;
}

/** A `projects.json` issue: `id` and `title` are required. */
export interface FixtureIssue {
  id: string;
  title: string;
  number?: number;
  key?: string | null;
  kind?: string | null;
  state?: 'open' | 'closed';
  stateReason?: string | null;
  inTriage?: boolean;
}

/** A `projects.json` record link of the app (its card's `fallbackText` is the title). */
export interface FixtureRecordLink {
  id: string;
  target: RecordTarget;
  externalId: string;
  card: RecordCard;
  createdAt?: string;
}

/** A `projects.json` item of the app's calendar layer. */
export interface FixtureCalendarItem {
  externalId: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  color?: string | null;
  linkId?: string | null;
  id?: string;
}

/** A `projects.json` approval request of the app (default pending, mode `all`). */
export interface FixtureApproval {
  id: string;
  title: string;
  approverIds: string[];
  mode?: 'all' | 'any';
  state?: 'pending' | 'approved' | 'rejected' | 'cancelled';
  externalId?: string | null;
  linkId?: string | null;
  card?: RecordCard | null;
  dueAt?: string | null;
  decisions?: { userId: string; decision: 'approve' | 'reject'; note?: string; decidedAt?: string }[];
  createdAt?: string;
}

/** The app behind a contribution, and whether it is still enabled in the project. */
export interface ContributionSource {
  installationId: string;
  appId: string;
  name: string;
  active: boolean;
}

export interface ProjectStatus {
  id: string;
  projectId: string;
  name: string;
  color: string;
  category: ProjectStatusCategory;
  position: number;
  key: string | null;
  createdByApp: string | null;
  /** `MOCK_INSTALLATION_ID` on the app's own statuses. */
  appInstallationId: string | null;
  revision: number;
}

export interface ProjectLabel {
  id: string;
  projectId: string;
  name: string;
  color: string;
  groupName: string | null;
  description: string;
  position: number;
  key: string | null;
  createdByApp: string | null;
  appInstallationId: string | null;
  revision: number;
}

export interface ProjectField {
  id: string;
  projectId: string;
  name: string;
  description: string;
  type: ProjectFieldType;
  position: number;
  options: { id: string; name: string; color: string }[];
  required: boolean;
  appliesTo: ('task' | 'issue')[];
  showOnCard: boolean;
  key: string | null;
  createdByApp: string | null;
  /** `MOCK_INSTALLATION_ID` on the app's own fields. */
  appInstallationId: string | null;
  appName?: string | null;
  readOnly?: boolean;
  revision: number;
}

export interface RecordLink extends ContributionSource {
  id: string;
  projectId: string;
  target: RecordTarget;
  externalId: string;
  title: string;
  card: RecordCard;
  createdBy: string | null;
  updatedBy: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCalendarItem extends ContributionSource {
  id: string;
  projectId: string;
  externalId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  color: string | null;
  linkId: string | null;
  target: RecordTarget | null;
  updatedAt: string;
}

export interface ProjectApproval extends ContributionSource {
  id: string;
  projectId: string;
  projectName: string;
  externalId: string | null;
  linkId: string | null;
  target: RecordTarget | null;
  title: string;
  card: RecordCard | null;
  approvers: string[];
  mode: 'all' | 'any';
  state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  dueAt: string | null;
  requestedBy: string | null;
  decisions: { userId: string; decision: 'approve' | 'reject'; note: string; decidedAt: string }[];
  createdAt: string;
  decidedAt: string | null;
}

/** An issue as the mock host keeps it. */
export interface MockProjectIssue {
  id: string;
  projectId: string;
  number: number;
  key: string | null;
  title: string;
  kind: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  inTriage: boolean;
}

/** What the app put in a project's activity feed (its lines, links, approvals, status changes through a link). */
export interface MockProjectActivity {
  type: 'APP_ACTIVITY' | 'APP_RECORD_LINKED' | 'APP_RECORD_UNLINKED' | 'APP_APPROVAL_REQUESTED' | 'APP_APPROVAL_DECIDED' | 'TASK_STATUS_CHANGED' | 'ISSUE_STATE_CHANGED' | 'PROJECT_UPDATED';
  text: string;
  target: RecordTarget | null;
  actorId: string | null;
  at: string;
}

/** A loose project: `{ id, name, tasks? }`, or a full `{ project, members, lists, tasks }`. */
export type FixtureProject =
  | (FixtureProjectApp & {
      id: string;
      name: string;
      description?: string;
      timeZone?: string;
      archived?: boolean;
      revision?: number;
      role?: string;
      createdAt?: string;
      updatedAt?: string;
      lastActivityAt?: string;
      taskKeyPrefix?: string;
      tasks?: FixtureTask[];
      lists?: FixtureTaskList[];
      members?: { userId: string; displayName: string; role: string }[];
    })
  | (FixtureProjectApp & {
      project: { id: string; name: string; [field: string]: JsonValue | undefined };
      members?: { userId: string; displayName: string; role: string }[];
      lists?: FixtureTaskList[];
      tasks?: FixtureTask[];
    });

/** `olan.project.config` of a project (Phase 6). */
export interface ProjectConfig {
  projectId: string;
  value: Record<string, JsonValue>;
  revision: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface HttpFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Shortcut for a JSON body (sets content-type). */
  json?: JsonValue;
}

/** A `fixtures/calendar.json` calendar; `projectId` marks a project calendar (its events are protected). */
export interface FixtureCalendar {
  id: string;
  name: string;
  color?: string | null;
  isDefault?: boolean;
  mayWrite?: boolean;
  projectId?: string | null;
}

/** A `fixtures/calendar.json` event. A UID ending in `@olan.app` is an Olan meeting (protected); `isOrganizer: false` an invitation. */
export interface FixtureCalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  calendarId?: string;
  uid?: string;
  timeZone?: string | null;
  isAllDay?: boolean;
  location?: string | null;
  description?: string | null;
  isOrganizer?: boolean;
  createdByApp?: string | null;
  updatedAt?: string | null;
}

/** A `fixtures/contacts.json` address book (`shared` ones are read-only for apps). */
export interface FixtureAddressBook {
  id: string;
  name: string;
  isDefault?: boolean;
  shared?: boolean;
}

export interface FixtureContact {
  id: string;
  name: string;
  addressBookId?: string;
  emails?: string[];
  phones?: string[];
  organization?: string | null;
  title?: string | null;
  note?: string | null;
  createdByApp?: string | null;
  updatedAt?: string | null;
}

export interface MailAddress {
  name: string | null;
  email: string;
}

/** A `fixtures/mail.json` message: what `mail.getMessage` returns and the mail surfaces open on. */
export interface FixtureMailMessage {
  id: string;
  subject: string;
  threadId?: string | null;
  from?: MailAddress;
  to?: MailAddress[];
  cc?: MailAddress[];
  receivedAt?: string;
  textBody?: string;
  attachments?: { name: string; type: string; size: number }[];
}

export interface FixtureMeeting {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  slug?: string;
  status?: string;
  organizerId?: string;
  participants?: { userId?: string | null; displayName: string; role: string }[];
  projectId?: string | null;
}

export interface Fixtures {
  projects?: FixtureProject[];
  conversations?: { id: string; kind?: 'direct' | 'group'; title?: string | null; projectId?: string | null; createdAt?: string; updatedAt?: string; unreadCount?: number }[];
  messages?: Record<string, { id: string; body: string | null; sender?: { id: string; displayName: string }; replyToId?: string | null; createdAt?: string; editedAt?: string | null; deletedAt?: string | null }[]>;
  settings?: Record<string, JsonValue>;
  storage?: Record<string, JsonValue>;
  /** Responses by URL, or by `"METHOD url"`. */
  http?: Record<string, HttpFixture>;
  /** Initial `olan.db` rows by collection (`fixtures/db.json`); rows must match the manifest `data`. */
  db?: Record<string, FixtureDbRow[]>;
  /** Extra directory entries (`fixtures/users.json`); `DEFAULT_USER` is always there. */
  users?: FixtureUser[];
  /** `fixtures/calendar.json` `calendars`. */
  calendars?: FixtureCalendar[];
  /** `fixtures/calendar.json` `events`. */
  calendarEvents?: FixtureCalendarEvent[];
  /** `fixtures/contacts.json` `addressBooks`. */
  addressBooks?: FixtureAddressBook[];
  /** `fixtures/contacts.json` `contacts`. */
  contacts?: FixtureContact[];
  /** `fixtures/mail.json` messages. */
  mail?: FixtureMailMessage[];
  /** `fixtures/meetings.json` meetings. */
  meetings?: FixtureMeeting[];
  /** `fixtures/remote.json`: the app server's answers to `olan.remote.request` by route (`"GET /brands/:id"`). */
  remote?: Record<string, RemoteFixture>;
  /** `fixtures/files.json`: what the file picker offers. */
  files?: FixtureFile[];
}

/** A canned `{ status, headers, body }` answer of the app's server (`fixtures/remote.json`). */
export interface RemoteFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: JsonValue;
}

/** A file `olan.files.pick` can return; `content` is what an upload sends. */
export interface FixtureFile {
  name: string;
  /** Default from the extension, else `application/octet-stream`. */
  type?: string;
  /** Default the length of `content`, else 1024. */
  size?: number;
  content?: string;
  lastModified?: number;
}

/** A picker file with defaults applied. */
export interface MockFile {
  name: string;
  type: string;
  size: number;
  content: string;
  lastModified?: number;
}

/** A picked file as the app sees it. */
export interface FileHandle {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
}

/** What a `remote` route gets (`@olan-app/sdk/server` `RemoteRequestContext`). */
export interface RemoteRequestContext {
  id: string;
  issuer: string;
  installationId: string;
  appId: string;
  /** `email`, `displayName`, `role` only with `profile:read`. */
  user: { id: string; organizationId: string; locale: string; timeZone: string; email?: string; displayName?: string; role?: 'admin' | 'member' } | null;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: JsonValue;
  token: { accessToken: string; expiresIn: number } | null;
  timeoutMs: number;
}

export type RemoteRequestHandler = (context: RemoteRequestContext) => { status?: number; headers?: Record<string, string>; body?: JsonValue } | void | Promise<{ status?: number; headers?: Record<string, string>; body?: JsonValue } | void>;
/** The app server in tests: routes by `"METHOD /path/:param"` or one handler. */
export type MockRemoteHandler = Readonly<Record<string, RemoteRequestHandler>> | RemoteRequestHandler;

/** One `olan.remote.request` the mock app server got (the signed envelope) and its wrapped answer. */
export interface MockRemoteRequest {
  envelope: {
    id: string;
    issuer: string;
    installationId: string;
    appId: string;
    user?: RemoteRequestContext['user'] & {};
    request: { method: string; path: string; query: Record<string, string | string[]>; headers: Record<string, string>; body: JsonValue; timeoutMs: number };
    token: { accessToken: string; expiresIn: number };
  };
  answer: { status: number; headers: Record<string, string>; body: JsonValue } | null;
}

/** A file upload with the request the target received (`host.uploads`, the `upload` handler's argument). */
export interface MockUpload {
  /** `upl_…` */
  uploadId: string;
  /** The picked file; `content` is its text (`fixtures/files.json` `content`, else `''`). */
  file: FileHandle & { content: string };
  url: string;
  method: 'PUT' | 'POST';
  /** As sent (lowercase): `content-type`, `content-length` (PUT), `x-olan-file-name` (URL-encoded name), the app's headers. */
  headers: Record<string, string>;
  /** POST: the file's multipart field; PUT: `null`. */
  formField: string | null;
  /** POST: the string fields sent before the file. */
  fields: Record<string, string>;
  status: 'running' | 'done' | 'cancelled' | 'failed';
}

/** The upload target's answer (default 200, no body). */
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

/** What a `remoteTransport` got back: the app server's wrapper, or why there was no usable answer. */
export type RemoteTransportResult =
  | { ok: true; answer: unknown }
  | { ok: false; reason: 'timeout' | 'network' | 'http_status' | 'invalid_response' | 'response_too_large'; message: string };

/** A URL the app opened. */
export interface MockOpenedUrl {
  url: string;
  external: boolean;
  expectReturn: boolean;
}

/** Throw from a `remote` route to answer that status (4xx reaches the app as `remote_rejected`). */
export class RequestError extends Error {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
  constructor(status: number, body?: JsonValue, headers?: Record<string, string>);
}

/** The app's server for `olan.remote.request` in tests (`renderApp({ remote: remote({ … }) })`). */
export function remote(handler: MockRemoteHandler): MockRemoteHandler;

/** Fixtures with defaults applied (the mock host's live data). */
export interface NormalizedFixtures {
  projects: { project: { id: string; name: string; [field: string]: JsonValue | undefined }; members: { userId: string; displayName: string; role: string }[]; lists: TaskList[]; tasks: (FixtureTask & { status: ProjectTaskStatus; revision: number; due: string | null })[] }[];
  /** Phase 6: ids of fixture projects the app is not enabled in. */
  disabledProjects: string[];
  /** Phase 6: `olan.project.config` by project id. */
  projectConfigs: Record<string, ProjectConfig>;
  /** Phase 6 (second wave): every project's statuses (the four defaults and the fixture's) by project id. */
  projectStatuses: Record<string, ProjectStatus[]>;
  projectLabels: Record<string, ProjectLabel[]>;
  /** Custom fields by project id (SDK 1.8). */
  projectFields: Record<string, ProjectField[]>;
  /** Field values by project id, then `<kind>:<id>` of the task or issue, then field id. */
  projectFieldValues: Record<string, Record<string, Record<string, ProjectFieldValue>>>;
  projectIssues: Record<string, MockProjectIssue[]>;
  /** Task id → status id (tasks start on the default status of their `status`). */
  taskStatusIds: Record<string, string>;
  /** The app's record links by project id. */
  recordLinks: Record<string, RecordLink[]>;
  projectCalendarItems: Record<string, ProjectCalendarItem[]>;
  /** The app's approval requests by project id, oldest first. */
  projectApprovals: Record<string, ProjectApproval[]>;
  /** What the app added to each project's feed, oldest first. */
  projectActivity: Record<string, MockProjectActivity[]>;
  conversations: { id: string; [field: string]: JsonValue | undefined }[];
  messages: Record<string, { id: string; body: string | null; [field: string]: JsonValue | undefined }[]>;
  settings: Record<string, JsonValue>;
  storage: Record<string, JsonValue>;
  http: Record<string, HttpFixture>;
  /** `olan.db` rows by collection (every user's); on a mock host each read is a fresh snapshot. */
  db: Record<string, DbRow[]>;
  /** The directory `users.get` reads: `DEFAULT_USER`, then `fixtures/users.json`. */
  users: FixtureUser[];
  calendars: (Required<Omit<FixtureCalendar, 'projectId'>> & { projectId: string | null })[];
  calendarEvents: Required<FixtureCalendarEvent>[];
  addressBooks: Required<FixtureAddressBook>[];
  contacts: Required<FixtureContact>[];
  mail: Required<FixtureMailMessage>[];
  meetings: Required<FixtureMeeting>[];
  remote: Record<string, RemoteFixture>;
  files: MockFile[];
}

/** One line of the mock audit log: deletions and refused deletions, as in Olan's audit log. */
export interface MockAuditEntry {
  action: 'db.delete' | 'record.delete' | 'record.delete_denied';
  /**
   * `db.delete`: `{ collection, rowId }`; `record.delete`: `{ kind, projectId?, recordId, title }`;
   * `record.delete_denied`: `{ kind, projectId?, recordId, reason }`. `kind`: task, list, project, event, contact.
   */
  detail: Record<string, JsonValue>;
}

/** A card the app posted (`olan.chat.postCard`), with its latest content. */
export interface MockCard {
  messageId: string;
  conversationId: string;
  threadRootId: string | null;
  card: { version: 1; root: number; nodes: UiNode[]; fallbackText: string };
  postedAt: string;
  updatedAt: string;
}

/** The in-memory app database behind `olan.db` (`@olan-app/sdk/memory-db`). */
export interface MockDb {
  readonly userId: string;
  /** The same database seen by another user. */
  as(userId: string): MockDb;
  /** Runs a `db.*` RPC as this user; rejects with an error carrying `code`. */
  call(method: string, params: unknown): Promise<JsonValue>;
  /** Every row (all users), oldest first, with its collection and owner. */
  rows(collection?: string): (DbRow & { collection: string; ownerUserId: string | null })[];
  /** Rows per collection (all users). */
  snapshot(): Record<string, DbRow[]>;
  usage(): { rows: number; bytes: number; rowLimit: number; byteLimit: number };
}

type Answer<T> = T | ((params: never) => T | Promise<T>);

export interface MockUi {
  /** `olan.ui.confirm`; default `true`. */
  confirm?: Answer<boolean>;
  /** `olan.ui.prompt`; default `null`. */
  prompt?: Answer<string | null>;
  /** `olan.ui.menu`; default `null`. */
  menu?: Answer<string | null>;
  /** `olan.ui.datePicker`; default `null`. */
  datePicker?: Answer<string | null>;
  /** `olan.files.pick`: picked files by `fixtures/files.json` name or inline; default the fixture files `accept` allows. `null`/`[]`: cancelled. */
  files?: Answer<(string | FixtureFile)[] | null>;
  /** `olan.ui.openExternal(…, { expectReturn: true })`; default `{ returned: false }`. */
  openExternal?: Answer<{ returned: true; params: Record<string, string> } | { returned: false }>;
}

export interface MockCall {
  method: string;
  params: JsonValue;
  ok: boolean;
  result?: JsonValue;
  /** `details`: e.g. `{ status, body }` of a failed `remote.request`. */
  error?: { code: string; message: string; details?: JsonValue };
  /**
   * `'ui'` for calls of the app's UI, `'backend'` for calls its backend code made. Backend records
   * never hold secret values: a `secrets.get` result and every occurrence of a secret value (4+
   * characters) in params, results or errors read `"[secret]"`.
   */
  source: 'ui' | 'backend';
}

export interface NavigationRecord {
  action: 'push' | 'pop' | 'replace';
  screen?: string;
  params?: JsonValue;
}

export interface MockHostOptions {
  fixtures?: Fixtures;
  permissions?: readonly string[];
  settings?: Record<string, JsonValue>;
  ui?: MockUi;
  /** The manifest's `data` (`olan.db` collections). */
  data?: JsonValue;
  /**
   * The signed-in user: `context.user.id` (`useUser().id`), `createdBy` of new rows and tasks,
   * owner of `user` rows, `owner` rules. Default `DEFAULT_USER_ID` ("Utku").
   */
  userId?: string;
  /** `olan.db` limits; defaults 100 000 rows, 100 MiB. */
  quota?: { rows?: number; bytes?: number };
  /** `createdByApp` of the tasks the app creates. */
  appId?: string;
  /** The app's name in its record links, calendar items and approvals (default `Örnek uygulama`). */
  appName?: string;
  /** The admin's "only delete records it created" switch; default `false`. */
  deleteOwnRecordsOnly?: boolean;
  /** The surface's `init.params` (`mail.getMessage` reads only its `messageId`; `chat.postCard` accepts its `conversationId`). */
  surfaceParams?: JsonValue;
  /** Whether the manifest has `remote` (cards with `submit` buttons need it); default `false`. */
  remote?: boolean;
  /** Start of the host clock (advances 1 s per write); default the real clock. */
  now?: string | number | Date;
  /** Settings `settings.get` answers with `null` (the `secret: true` fields of apps with `server`). */
  secretSettings?: readonly string[];
  /** `secrets.get` values for backend code (default: the values of `secretSettings`). */
  secrets?: Record<string, string | null>;
  /** Answers `backend.call`; without it the call fails with `backend_unavailable`. */
  backend?: (name: string, args: JsonValue, caller: { userId: string; permissions: string[] }) => Promise<RpcOutcome>;
  /** The manifest `remote.url` (uploads may go to its origin). */
  remoteUrl?: string | null;
  /** The manifest `remote.requests`; without it `remote.request` fails with `permission_denied`. */
  remoteRequests?: boolean;
  /** The app server behind `remote.request` (default: the `fixtures/remote.json` routes). */
  remoteHandler?: MockRemoteHandler | null;
  /** Sends `remote.request` envelopes somewhere real instead (`olan-app dev --remote live`); wins over the handler. */
  remoteTransport?: ((envelope: MockRemoteRequest['envelope']) => Promise<RemoteTransportResult>) | null;
  /** The upload target's answer (default 200, no body). */
  upload?: MockUploadHandler;
  /** A development installation (`http:` to localhost allowed); default `true`. */
  development?: boolean;
  /** `user.role` of envelopes with `profile:read` (default `member`). */
  profileRole?: 'admin' | 'member';
  organizationId?: string;
  locale?: string;
  timeZone?: string;
}

export type RpcOutcome = { ok: true; result: JsonValue } | { ok: false; error: { code: string; message: string; details?: JsonValue } };

export interface MockHost {
  /** `{ backend: true }`: a call from backend code (only the backend host methods, `secrets.get` included); `permissions` overrides the host's. */
  handle(method: string, params: JsonValue, options?: { permissions?: readonly string[]; backend?: boolean }): Promise<RpcOutcome>;
  readonly calls: MockCall[];
  readonly toasts: { text: string; tone?: string }[];
  readonly navigation: NavigationRecord[];
  readonly shares: { text: string; url?: string }[];
  /** Live data: `projects`, `storage`, `db` (fresh snapshot per read), `http`, `settings`, … */
  readonly data: NormalizedFixtures;
  /** The app database behind `olan.db`. */
  readonly db: MockDb;
  /** The signed-in user's id (`context.user.id`). */
  readonly userId: string;
  /** Deletions and refused deletions, oldest first. */
  audit(): MockAuditEntry[];
  /** Cards the app posted, oldest first. */
  readonly cards: MockCard[];
  /** The surface params the host enforces (`mail.getMessage`); `setParams` changes them. */
  surfaceParams: JsonValue;
  permissions: string[];
  ui: MockUi;
  /** The `backend.call` handler (`renderApp` sets it for apps with `server`). */
  backend: MockHostOptions['backend'] | null;
  /** What `secrets.get` answers for `name`. */
  secret(name: string): string | null;
  /** The app server behind `remote.request` (null: the `fixtures/remote.json` routes). */
  remote: MockRemoteHandler | null;
  /** `remote.request` calls that reached the app server. */
  readonly remoteRequests: MockRemoteRequest[];
  /** File uploads, oldest first. */
  readonly uploads: MockUpload[];
  /** URLs opened with `olan.ui.openUrl` / `openExternal`. */
  readonly opened: MockOpenedUrl[];
  /** Running `useQuery({ refetchIntervalMs })` timers. */
  timers(): { timerId: string; intervalMs: number }[];
  /** Where host → sandbox messages (`upload-progress`) go; `renderApp` sets it. */
  emit: ((message: { type: string; [field: string]: JsonValue }) => void) | null;
  /**
   * An approver (default the signed-in user) decides one of the app's approval requests, as in the
   * approval box: `any` ends it on the first decision, `all` on a rejection or the last approval.
   * Throws (`code` `not_found`, `permission_denied`, `conflict`) like the server.
   */
  decideApproval(projectId: string, approvalId: string, decision: 'approve' | 'reject', options?: { userId?: string; note?: string }): ProjectApproval;
}

export interface RenderAppOptions {
  /** App directory (default: `OLAN_APP_ROOT`, set by `olan-app test`, else the current directory). */
  root?: string;
  /** App module relative to `root` (default `src/app.tsx`). */
  entry?: string;
  /** Surface to open (default `app`). */
  surface?: Surface;
  /** `init.params` (default `defaultSurfaceParams(surface, fixtures)`: `{ projectId }` for `project.widget`, the first email for `mail.sidebar`, …; `null` for `app`). */
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
   * The signed-in user: `context.user.id` (`useUser().id`), `createdBy` of new rows and tasks,
   * owner of `user` rows, `owner` rules. Default `DEFAULT_USER_ID` ("Utku").
   */
  userId?: string;
  /** `olan.db` limits for this run (default 100 000 rows, 100 MiB). */
  quota?: { rows?: number; bytes?: number };
  /** The admin's "only delete records it created" switch (default `false`). */
  deleteOwnRecordsOnly?: boolean;
  /** Do not throw when the app reports an error (inspect them with `errors()`). */
  allowErrors?: boolean;
  /** How long an action may take to settle (default 5000 ms). */
  timeoutMs?: number;
  /**
   * Apps with `server`: `olan.backend.call` runs the real backend on the same mock host and database
   * (default). `false`: unanswered (`backend_unavailable`); an object picks the engine.
   */
  backend?: boolean | { engine?: BackendEngine };
  /** `olan.secrets.get` values for the backend (default: the `secret: true` settings values). */
  secrets?: Record<string, string | null>;
  /**
   * The app server behind `olan.remote.request` (default: the `fixtures/remote.json` routes).
   * `false`: the implied `remote` permission is not granted: every call fails with `permission_denied`.
   */
  remote?: MockRemoteHandler | false;
  /** The upload target's answer to `olan.files.upload` (default 200, no body). */
  upload?: MockUploadHandler;
  /** `user.role` in `remote.request` envelopes when `profile:read` is granted (default `member`). */
  profileRole?: 'admin' | 'member';
  /** Open on a screen, as a permanent app address does (`init.navigation`). */
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
  press(label: string | RegExp): Promise<void>;
  fill(label: string | RegExp, value: string): Promise<void>;
  /** A Select's option; on a MultiSelect a string toggles that option and an array sets the selection. */
  select(label: string | RegExp, value: string | string[]): Promise<void>;
  /** Flips a Switch found by label. */
  toggle(label: string | RegExp): Promise<void>;
  /** Presses a Banner's close button (`onDismiss`): the Banner whose title or text matches, else the first. */
  dismiss(banner?: string | RegExp): Promise<void>;
  /** Sends one tick of every running `useQuery({ refetchIntervalMs })` timer. */
  fireTimers(): Promise<void>;
  /** Replaces the app server behind `olan.remote.request`. */
  remote(handler: MockRemoteHandler | null): void;
  submit(label?: string | RegExp): Promise<void>;
  back(): Promise<void>;
  setContext(context: { theme?: 'light' | 'dark'; locale?: string; settings?: Record<string, JsonValue> }): Promise<void>;
  /** New surface params, as the host sends them to a panel when the person opens another object. */
  setParams(params: JsonValue): Promise<void>;
  expectText(text: string | RegExp): void;
  expectNoText(text: string | RegExp): void;
  waitFor(predicate: (app: RenderedApp) => boolean | Promise<boolean>, ms?: number): Promise<void>;
  waitForText(text: string | RegExp, ms?: number): Promise<void>;
  tree(): UiNode[];
  snapshot(): UiTreeSnapshot | null;
  text(): string;
  find(type: string, predicate?: (node: UiNode) => boolean): UiNode[];
  /** UI and backend calls in order; `{ source: 'ui' | 'backend' }` keeps one side. */
  calls(method?: string, filter?: { source?: 'ui' | 'backend' }): MockCall[];
  toasts(): { text: string; tone?: string }[];
  navigation(): NavigationRecord[];
  logs(): LogEntry[];
  errors(): AppErrorEntry[];
  readonly host: MockHost;
  /** Console lines of the app's backend (`olan.backend.call`), oldest first. */
  backendLogs(): BackendLogLine[];
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend (manifest `server`; docs/backend.md)
// ---------------------------------------------------------------------------

export type BackendEngine = 'auto' | 'isolated-vm' | 'quickjs';

export interface BackendLogLine {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

/** The manifest fields the backend harness uses (the rest of `olan-app.json` is there too). */
export interface BackendManifest {
  id: string;
  version: string;
  permissions: string[];
  server?: {
    entry: string;
    schedules?: { name: string; cron: string; timeZone?: string; function?: string }[];
    events?: Record<string, string>;
    hooks?: { name: string; function?: string; verify: HookVerifyConfig }[];
  };
  [field: string]: unknown;
}

export interface BackendHarnessOptions {
  /** App directory (default: `OLAN_APP_ROOT`, set by `olan-app test`, else the current directory). */
  root?: string;
  /** Fields over `olan-app.json` (e.g. another `server` or `permissions` for one test). */
  manifest?: Record<string, JsonValue>;
  /** Settings over the manifest defaults and `fixtures/settings.json` (`secret: true` fields included). */
  settings?: Record<string, JsonValue>;
  /** `olan.secrets.get` values (default: the `secret: true` settings values). */
  secrets?: Record<string, string | null>;
  /** `olan.db` rows by collection (like `fixtures/db.json`). */
  db?: Fixtures['db'];
  /** Fixture data over `fixtures/*.json` and the defaults (projects, calendar, `http` responses, …). */
  fixtures?: Fixtures;
  /** `auto` (default; `OLAN_APP_BACKEND_ENGINE` or `olan-app test --engine` change it), `isolated-vm` or `quickjs`. */
  engine?: BackendEngine;
  /** The app identity's permissions (schedules, events, hooks) and the default caller's; default the manifest's. */
  permissions?: string[];
  /** The `backend.call` caller (default `DEFAULT_USER_ID`). */
  userId?: string;
  /** Start of the host clock (row timestamps). */
  now?: string | number | Date;
  /** `true` (default): bundle `server.entry` now; `false`: load the existing `dist/server.js`. */
  build?: boolean;
  /** Per-invocation limits over the defaults (cpuMs 1000, wallMs 10 000 for calls / 30 000 otherwise, memoryMb 64, concurrency 4). */
  limits?: { cpuMs?: number; wallMs?: number; memoryMb?: number; concurrency?: number };
  /** Share a mock host (and its database) with `renderApp`. */
  host?: MockHost;
  /** Engine notices (e.g. the QuickJS fallback); default: printed to stderr once. */
  onWarning?: (message: string) => void;
}

export interface BackendResult<T = JsonValue> {
  ok: boolean;
  /** The handler's JSON result (`ok`). */
  value?: T;
  /** `code`: what `olan.backend.call` rejects with (`backend_error`, `backend_limit`, …); `runtimeCode`: the runtime's (`handler_error`, `cpu_limit`, …). */
  error?: { code: string; runtimeCode: string; message: string };
  /** `console.*` lines of this invocation. */
  logs: BackendLogLine[];
  cpuMs: number;
  wallMs: number;
}

export interface HookResult extends BackendResult {
  /** Whether the request passed `verify` (the function only runs when it did). */
  verified: boolean;
  /** The HTTP answer: the function's `{ status, headers?, body? }`, else 202; 401/413/503 when verification fails; 500 when the function throws. */
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HookInput {
  method?: string;
  headers?: Record<string, string>;
  /** Raw body; any other JSON value is sent as `JSON.stringify(body)` with `content-type: application/json`. */
  body?: string | JsonValue;
  query?: Record<string, string>;
  /** Add a valid signature when the request has none (default `true`; `false` sends it unsigned). */
  sign?: boolean;
}

export interface EmitInput {
  type: string;
  /** Event `data` (default: a sample built from the fixtures). */
  data?: JsonValue;
  actor?: JsonValue;
  id?: string;
  occurredAt?: string;
}

export interface BackendCallOptions {
  userId?: string;
  /** The caller's consented permissions (default the manifest's). */
  permissions?: string[];
}

export interface BackendHarness {
  readonly engine: 'isolated-vm' | 'quickjs';
  /** The manifest in use (`olan-app.json` with the `manifest` option over it). */
  readonly manifest: BackendManifest;
  /** The mock Olan host behind `__olan.call`. */
  readonly host: MockHost;
  /** The in-memory `olan.db`. */
  readonly db: MockDb;
  /** `olan.backend.call(name, args)` as the caller (actor `user`). */
  call<T = JsonValue>(name: string, args?: JsonValue, options?: BackendCallOptions): Promise<BackendResult<T>>;
  /** Runs `server.schedules[name]` now (actor `app`). */
  runSchedule<T = JsonValue>(name: string, options?: { scheduledAt?: string }): Promise<BackendResult<T>>;
  /** Delivers an event listed in `server.events` (actor `app`); a string is the event type. */
  emit<T = JsonValue>(event: string | EmitInput): Promise<BackendResult<T>>;
  /** `POST /api/v2/apps/hooks/<installationId>/<name>`: verification, then the hook function. */
  hook(name: string, request?: HookInput): Promise<HookResult>;
  /** Runs `migrate(fromVersion)`. */
  migrate(fromVersion: string): Promise<BackendResult>;
  /** Host calls the backend made (`olan.*` from backend code, `source: 'backend'`, secrets redacted), oldest first. */
  calls(method?: string): MockCall[];
  /** Every console line so far. */
  logs(): BackendLogLine[];
  dispose(): Promise<void>;
}

/** A headless backend: bundles `server.entry` and runs it in `@olan-app/runtime` against the mock host. Call `dispose()`. */
export function createBackendHarness(options?: BackendHarnessOptions): Promise<BackendHarness>;

export interface HookVerifyConfig {
  kind: 'hmac-sha256' | 'standard-webhooks' | 'none';
  header?: string;
  secretSetting?: string;
}
/** Headers that make `body` pass `verify` with `secret`. */
/**
 * Headers that make `body` (the exact bytes you send) pass `verify` with `secret`; async (WebCrypto).
 * `hmac-sha256`: `{ [verify.header]: 'sha256=<lower-case hex>' }`; `standard-webhooks`: `webhook-id`,
 * `webhook-timestamp`, `webhook-signature`; `none`: `{}`.
 */
export function signHookRequest(verify: HookVerifyConfig, body: string | Uint8Array, secret: string, options?: { now?: number; id?: string }): Promise<Record<string, string>>;
/** The check the Olan server runs before a hook function sees the request. */
export function verifyHookSignature(
  verify: HookVerifyConfig,
  request: { headers: Record<string, string | string[] | undefined>; body: string | Uint8Array },
  secret: string | null | undefined,
  options?: { development?: boolean; now?: number },
): Promise<{ ok: true } | { ok: false; status: 401 | 413 | 503; code: string; message: string }>;

export function renderApp(options?: RenderAppOptions): Promise<RenderedApp>;
export function createMockHost(options?: MockHostOptions): MockHost;
/** The `init.params` a host would send for `surface`, built from the (normalized) fixtures. */
export function defaultSurfaceParams(surface: Surface, data: NormalizedFixtures, userId?: string): JsonValue;
/** The built-in data: projects p0 "Web sitesi", p1 "Mobil uygulama", p2 "Ofis taşınması", 4 tasks each. */
export function defaultFixtures(): Fixtures;
/** The mock host's signed-in user id: `00000000-0000-4000-8000-000000000001`. */
export const DEFAULT_USER_ID: string;
/** The default user's directory entry ("Utku", `utku@example.com`). */
export const DEFAULT_USER: Readonly<FixtureUser>;
export function normalizeFixtures(fixtures: Fixtures, app?: { id: string; name: string }): NormalizedFixtures;
export function loadProjectFixtures(projectDir: string): Fixtures;
export class MockHostError extends Error {
  readonly code: string;
  readonly details?: JsonValue;
  constructor(code: string, message: string, details?: JsonValue);
}
/** `user.organizationId` of mock `remote.request` envelopes. */
export const DEFAULT_ORGANIZATION_ID: string;
/** `issuer` and `installationId` of mock `remote.request` envelopes. */
export const MOCK_ISSUER: string;
export const MOCK_INSTALLATION_ID: string;

// ---------------------------------------------------------------------------
// The app's own server (manifest `remote`; docs/remote-requests.md#testing-the-app-server)
// ---------------------------------------------------------------------------

export interface TestIssuerOptions {
  /** Port on 127.0.0.1 (default `0`: a free port). */
  port?: number;
  /** `webOrigin` of its `/.well-known/olan` (default: the issuer itself); `null` leaves it out, as an Olan before 1.5 does. */
  webOrigin?: string | null;
  /** `kid` of its key (default `olan-test-<random>`). */
  keyId?: string;
}

/** A local Olan issuer: `/.well-known/olan` and the JWKS on 127.0.0.1, signing with its own Ed25519 key. */
export interface TestIssuer {
  /** `http://127.0.0.1:<port>`: list it in `createOlanServer({ issuers })`. */
  readonly issuer: string;
  readonly keyId: string;
  /** The public key it serves at `<issuer>/api/v2/apps/jwks.json`. */
  readonly jwk: Record<string, string>;
  /** Its `/.well-known/olan` document (server.md). */
  wellKnown(): Record<string, JsonValue>;
  /** Base64 Ed25519 signature of `content` (`<webhook-id>.<webhook-timestamp>.<raw body>`). */
  sign(content: string): string;
  /** Stops the server (always call it, e.g. in `after()`). */
  close(): Promise<void>;
}

/** Starts a `TestIssuer` (a fresh key, a free port unless `port` is given). */
export function createTestIssuer(options?: TestIssuerOptions): Promise<TestIssuer>;

/** The person in a `remote.request` envelope; `email`, `displayName` and `role` only with `profile:read`. */
export interface RemoteRequestUser {
  id: string;
  organizationId: string;
  locale: string;
  timeZone: string;
  email?: string;
  displayName?: string;
  role?: 'admin' | 'member';
}

/** What the app passes to `olan.remote.request`. */
export interface RemoteRequestInit {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | (string | number | boolean)[]>;
  headers?: Record<string, string>;
  body?: JsonValue;
  timeoutMs?: number;
}

/** What `signRemoteRequest` builds the envelope from (the body of `POST {remote.url}/requests`). */
export interface RemoteRequestSignInput {
  appId: string;
  /** Default `MOCK_INSTALLATION_ID` (`mock-installation`). */
  installationId?: string;
  /**
   * The person. Default `{ id: DEFAULT_USER_ID, organizationId: DEFAULT_ORGANIZATION_ID, locale: 'tr',
   * timeZone: 'Europe/Istanbul' }` (no profile fields); `null`: no `user` (an app-identity envelope).
   */
  user?: RemoteRequestUser | null;
  /** Normalised as Olan does (query values to strings, headers allowlisted); invalid params throw. */
  request: RemoteRequestInit;
  /** Default `{ accessToken: 'olan-app-dev-token', expiresIn: 300 }`. */
  token?: { accessToken: string; expiresIn: number };
  /** `req_…`, also the `webhook-id` (default a new one: a repeated id is a replay, HTTP 409). */
  id?: string;
}

/** Options for forged requests. */
export interface RemoteRequestSignOptions {
  /** `webhook-timestamp` in Unix seconds (default now): more than 300 s away → `timestamp_out_of_range` (401). */
  timestamp?: number;
  /** Sign with a key the issuer does not publish → `invalid_signature` (401). */
  badSignature?: boolean;
  /** `olan-key-id` header → `unknown_key` (401) for a kid the issuer does not publish. */
  keyId?: string;
  /** `olan-issuer` header and envelope `issuer` → `issuer_not_allowed` (401) for one the server does not list. */
  issuer?: string;
  /** `webhook-id` header (default the envelope `id`) → HTTP 400 `invalid_body` when it differs. */
  webhookId?: string;
}

export interface SignedRemoteRequest {
  /** Lower-case: `content-type`, `webhook-id`, `webhook-timestamp`, `webhook-signature`, `olan-issuer`, `olan-key-id`, `olan-installation-id`. */
  headers: Record<string, string>;
  /** The exact JSON text that was signed: send it unchanged. */
  body: string;
  envelope: MockRemoteRequest['envelope'];
}

/**
 * Signs a `remote.request` envelope as Olan does: `olan.handleRequest({ headers, body }, routes)` or
 * `fetch(`${remoteUrl}/requests`, { method: 'POST', headers, body })`.
 */
export function signRemoteRequest(issuer: Pick<TestIssuer, 'issuer' | 'keyId' | 'sign'>, input: RemoteRequestSignInput, options?: RemoteRequestSignOptions): SignedRemoteRequest;

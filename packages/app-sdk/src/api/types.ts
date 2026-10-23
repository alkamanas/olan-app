import type { AppCard, DbQuery, DbQueryResult, DbRow, DbWhere, FileHandle, FilePickOptions, FileUploadParams, FileUploadResult, RemoteRequestInit, RemoteResponse } from '@olan-app/schema';

import type { JsonValue } from '../protocol';

export type { DbCondition, DbOrderBy, DbQuery, DbQueryResult, DbRangeCondition, DbRow, DbScalar, DbWhere } from '@olan-app/schema';
export type {
  AppCard,
  CardButtonAction,
  CardButtonProps,
  ChatActionParams,
  ChatCardParams,
  ChatCommandParams,
  CalendarEventActionParams,
  MailAddress,
  MailSurfaceParams,
  MeetingPanelParams,
  SurfaceParams,
  AppSurfaceParams,
  // Phase 6
  ProjectSurfaceParams,
  TaskActionParams,
  IssueActionParams,
  RecordCardParams,
  // Phase 5a
  RemoteRequestInit,
  RemoteRequestMethod,
  RemoteQueryValue,
  RemoteResponse,
  RemoteErrorReason,
  RemoteRequestEnvelope,
  RemoteRequestUser,
  ProfileRole,
  FileHandle,
  FilePickOptions,
  FileUploadParams,
  FileUploadResult,
} from '@olan-app/schema';

/*
 * Data types the SDK hands to apps (contract §9). They are narrowed copies of the Platform
 * types: field names match `@olan/contracts`, but only stable fields are listed, so a server-side
 * change does not break app type-checks. Everything is JSON (the values cross the sandbox).
 */

export type ProjectTaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';
export type ProjectRole = 'owner' | 'manager' | 'member' | 'guest' | (string & {});

export interface Project {
  id: string;
  name: string;
  description: string;
  timeZone: string;
  archived: boolean;
  revision: number;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  /** Manifest id of the app that created the project (`olan.projects.create`), else null. Phase 3. */
  createdByApp?: string | null;
  taskKeyPrefix?: string;
}

export interface ProjectMember {
  userId: string;
  displayName: string;
  role: ProjectRole;
}

export interface ProjectTaskList {
  id: string;
  name: string;
  /** The project's default work package (created with the project). It cannot be removed. */
  isDefault: boolean;
  revision: number;
  /** The parent work package, or null for a top-level one. */
  parentId: string | null;
}

export interface ProjectTask {
  id: string;
  projectId: string;
  listId: string;
  key?: string;
  number?: number;
  title: string;
  description: string;
  status: ProjectTaskStatus;
  assigneeId: string | null;
  createdBy: string;
  start?: string | null;
  due: string | null;
  allDay: boolean;
  revision: number;
  updatedAt?: string;
  /** Manifest id of the app that created the task (`'dev'` from Studio), or null when a person did. */
  createdByApp?: string | null;
}

export interface ProjectDetail {
  project: Project;
  members: ProjectMember[];
  lists: ProjectTaskList[];
  tasks: ProjectTask[];
}

export interface ProjectListResult {
  items: Project[];
  nextCursor?: string;
}

export interface UpdateTaskInput {
  status?: ProjectTaskStatus;
  due?: string | null;
  assigneeId?: string | null;
  /** The task revision the change is based on (optimistic concurrency). */
  revision: number;
}

export interface CreateTaskInput {
  title: string;
  /** Work package; defaults to the project's default work package. */
  listId?: string;
  description?: string;
  status?: ProjectTaskStatus;
  /** ISO date (all-day) or date-time. */
  due?: string | null;
  allDay?: boolean;
  assigneeId?: string | null;
  priority?: number;
}

/** `revision` is the record's current revision (optimistic concurrency). */
export interface DeleteRecordInput {
  revision: number;
}

/**
 * A person in the organization's directory (`olan.users.get`, `useUsers`; needs `users:read`).
 * `id` is the central Olan user id: the same value as `useUser().id`, `DbRow.createdBy`,
 * `ProjectTask.assigneeId` and `ProjectMember.userId`.
 */
export interface DirectoryUser {
  id: string;
  displayName: string;
  email: string;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  avatarUrl?: string | null;
}

export interface UsersGetResult {
  users: DirectoryUser[];
}

export interface ChatUser {
  id: string;
  displayName: string;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
  unreadCount?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: ChatUser;
  body: string | null;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface HttpRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | null;
}

/** Wire shape of `http.fetch`; `olan.http.fetch` adds `json()`. */
export interface HttpResponseData {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse extends HttpResponseData {
  json<T = JsonValue>(): T;
}

export type ToastTone = 'default' | 'success' | 'warning' | 'danger';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
}

export interface MenuItemOption {
  key: string;
  label: string;
  icon?: string;
  destructive?: boolean;
  disabled?: boolean;
}

export interface DatePickerOptions {
  value?: string;
  mode?: 'date' | 'datetime';
}

// ---------------------------------------------------------------------------
// Phase 3: projects, chat cards, calendar, contacts, mail, meetings, backend
// ---------------------------------------------------------------------------

/** `olan.projects.create` (`projects:create`; on behalf of the person). */
export interface CreateProjectInput {
  title: string;
  description?: string;
}

export interface PostCardInput {
  conversationId: string;
  card: AppCard;
  /** Post into this thread. */
  threadRootId?: string | null;
}

export interface Calendar {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  /** Whether the person may create and change events in it. */
  mayWrite: boolean;
}

/** An event (`CalendarEventSummary`). */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  uid: string;
  title: string;
  /** ISO date (all-day) or date-time. */
  start: string;
  end: string;
  timeZone: string | null;
  isAllDay: boolean;
  location: string | null;
  description: string | null;
  /** Whether the person organizes it (false for invitations, which apps cannot change). */
  isOrganizer: boolean;
  /** Manifest id of the app that created it, else null. */
  createdByApp: string | null;
  updatedAt: string | null;
}

export interface CalendarEventsQuery {
  /** ISO date or date-time; `to - from` ≤ 366 days. */
  from: string;
  to: string;
  calendarId?: string;
  /** ≤ 200. */
  limit?: number;
}

export interface CreateEventInput {
  /** Default: the default calendar, else the first writable one. */
  calendarId?: string;
  title: string;
  start: string;
  /** `end`, or `duration` (ISO 8601 such as `PT30M`). */
  end?: string;
  duration?: string;
  timeZone?: string;
  isAllDay?: boolean;
  location?: string | null;
  description?: string | null;
}

export type UpdateEventInput = Partial<Omit<CreateEventInput, 'calendarId'>>;

export interface AddressBook {
  id: string;
  name: string;
  isDefault: boolean;
  /** Shared and directory address books are read-only for apps. */
  shared: boolean;
}

/** A contact (`ContactSummary`). */
export interface Contact {
  id: string;
  addressBookId: string;
  name: string;
  emails: string[];
  phones: string[];
  organization: string | null;
  title: string | null;
  note: string | null;
  createdByApp: string | null;
  updatedAt: string | null;
}

export interface CreateContactInput {
  /** Default: the default address book. */
  addressBookId?: string;
  name: string;
  emails?: string[];
  phones?: string[];
  organization?: string | null;
  title?: string | null;
  note?: string | null;
}

export type UpdateContactInput = Partial<Omit<CreateContactInput, 'addressBookId'>>;

/** `olan.mail.getMessage`: the message the surface was opened on (`mail:read`). */
export interface MailMessage {
  id: string;
  subject: string;
  from: { name: string | null; email: string };
  to: Array<{ name: string | null; email: string }>;
  cc: Array<{ name: string | null; email: string }>;
  receivedAt: string;
  textBody: string;
  attachments: Array<{ name: string; type: string; size: number }>;
}

export interface Meeting {
  id: string;
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  status: string;
  organizerId: string;
  participants: Array<{ userId?: string | null; displayName: string; role: string }>;
}

// ---------------------------------------------------------------------------
// Phase 5a: remote requests, files, external flows
// ---------------------------------------------------------------------------

/** `olan.files.upload` options (the wire params add `uploadId` and `fileId`). */
export interface UploadOptions {
  /** `https:` on the origin of `remote.url` or a host granted as `http:<host>`. */
  url: string;
  /** Default `PUT` (raw body); `POST` sends `multipart/form-data`. */
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
  /** POST: the file's field name (default `file`). */
  formField?: string;
  /** POST: form fields sent before the file. */
  fields?: Record<string, string>;
  /** Called at most every 250 ms and once at the end. */
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

/** A running upload: await it for the result; `cancel()` stops it (it then rejects with `cancelled`). */
export type UploadTask = Promise<FileUploadResult> & {
  readonly uploadId: string;
  cancel(): Promise<void>;
};

/** `olan.ui.openExternal` result: the return address's query parameters, if the flow came back. */
export type ExternalFlowResult = { returned: true; params: Record<string, string> } | { returned: false };

/**
 * The app's configuration of one project (Phase 6, `olan.project.config`), kept per installation and
 * project. Before the first `set` it is `{ value: {}, revision: 0, updatedBy: null, updatedAt: null }`.
 */
export interface ProjectConfig {
  projectId: string;
  value: Record<string, JsonValue>;
  /** Increases with every `set`; pass it back to `set` to refuse a write over someone else's change. */
  revision: number;
  /** Who wrote it last: a user id, or `app:<installationId>` for the app's own server. */
  updatedBy: string | null;
  updatedAt: string | null;
}

/** `olan.project.config.set` options. */
export interface ProjectConfigSetOptions {
  /**
   * The `revision` this write is based on (0: only when nothing is stored yet). When the stored one
   * differs, the call fails with `conflict` and nothing is written. Without it the write always wins.
   */
  revision?: number;
}

// ---------------------------------------------------------------------------------------------
// Phase 6 (second wave): what the app adds to projects it is enabled in
// ---------------------------------------------------------------------------------------------

export type ProjectStatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

/** A task status of a project. `appInstallationId` is set on statuses an app defined (members cannot change them). */
export interface ProjectStatus {
  id: string;
  projectId: string;
  name: string;
  /** `#RRGGBB`. */
  color: string;
  category: ProjectStatusCategory;
  position: number;
  /** Stable key: the app's own for statuses it defined, `todo`/`in_progress`/`done`/`cancelled` for the defaults. */
  key: string | null;
  createdByApp: string | null;
  appInstallationId: string | null;
  revision: number;
}

/** A label of the project catalog. */
export interface ProjectLabel {
  id: string;
  projectId: string;
  name: string;
  color: string;
  /** Group shown above it ("Kanal"). */
  groupName: string | null;
  description: string;
  position: number;
  key: string | null;
  createdByApp: string | null;
  appInstallationId: string | null;
  revision: number;
}

/** A status the app defines (`olan.project.statuses.define`); `key` is the app's id for it. */
export interface ProjectStatusDefinition {
  key: string;
  name: string;
  /** Fixed once the status exists. */
  category: ProjectStatusCategory;
  color?: string;
  position?: number;
}

/** A label the app defines (`olan.project.labels.define`). */
export interface ProjectLabelDefinition {
  key: string;
  name: string;
  color?: string;
  groupName?: string | null;
  description?: string;
}

/** The type of a custom field; fixed for the field's life. */
export type ProjectFieldType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'person' | 'url' | 'checkbox';

/**
 * A custom field value: text, url, date (`YYYY-MM-DD`), select option id and person (user) id are
 * strings; numbers, checkboxes (`boolean`) and multi-select option ids (`string[]`).
 */
export type ProjectFieldValue = string | number | boolean | string[];

/** An option of a select or multi-select field. */
export interface ProjectFieldOption {
  /** Stable id (a slug); values carry it. */
  id: string;
  name: string;
  /** `#RRGGBB`. */
  color: string;
}

/** A custom field of the project. `appInstallationId` is set on fields an app defined (members fill them in but do not change them). */
export interface ProjectField {
  id: string;
  projectId: string;
  name: string;
  description: string;
  type: ProjectFieldType;
  position: number;
  /** Select and multi-select fields; empty for other types. */
  options: ProjectFieldOption[];
  /** New tasks/issues need a value, and a value cannot be cleared. */
  required: boolean;
  appliesTo: RecordTargetKind[];
  /** Shown on list rows and board cards. */
  showOnCard: boolean;
  /** Stable key: the app's own for fields it defined (or a project template brought). */
  key: string | null;
  createdByApp: string | null;
  appInstallationId: string | null;
  appName?: string | null;
  /** The app that defines it was removed from the project: its values are read-only. */
  readOnly?: boolean;
  revision: number;
}

/** A field the app defines (`olan.project.fields.define`); `key` is the app's id for it. */
export interface ProjectFieldDefinition {
  key: string;
  name: string;
  /** Fixed once the field exists. */
  type: ProjectFieldType;
  description?: string;
  /** Select and multi-select fields: options keep their `id`; a new one may leave it out. Removing one clears it from values. */
  options?: Array<{ id?: string; name: string; color?: string }>;
  required?: boolean;
  /** Default: tasks only. */
  appliesTo?: RecordTargetKind[];
  showOnCard?: boolean;
  position?: number;
}

/** A task's or issue's custom field values, keyed by field key (fields without a key: by field id). */
export interface ProjectFieldValues {
  target: RecordTarget;
  values: Record<string, ProjectFieldValue>;
}

export type RecordTargetKind = 'task' | 'issue';

/** A task or issue of the project. */
export interface RecordTarget {
  kind: RecordTargetKind;
  id: string;
}

/** The app behind a contribution, and whether it is still enabled in the project (`active`). */
export interface ContributionSource {
  installationId: string;
  appId: string;
  name: string;
  active: boolean;
}

/** One of the app's records linked to a task or issue, with the card the app draws on it. */
export interface RecordLink extends ContributionSource {
  id: string;
  projectId: string;
  target: RecordTarget;
  /** The app's own id of the record. */
  externalId: string;
  /** The card's `fallbackText`. */
  title: string;
  card: AppCard;
  createdBy: string | null;
  updatedBy: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** `olan.project.links.upsert`: one link per record and target; the same `externalId` again replaces its card. */
export interface UpsertRecordLinkInput {
  target: RecordTarget;
  externalId: string;
  /** A card (`Card`, `Stack`, `Text`, `Badge`, `Table`, `Button`, `EmptyState`) whose buttons only `{ kind: 'open', payload? }`: they open the `record.card` surface. */
  card: AppCard;
}

/**
 * `olan.project.links.setStatus`: a linked task moves to `statusKey` (a key of the project's
 * statuses, e.g. one the app defined), `statusId` or the CalDAV `status`; a linked issue opens or
 * closes with `state` (`stateReason` `completed` or `not_planned`).
 */
export interface SetLinkedStatusInput {
  statusKey?: string;
  statusId?: string;
  status?: ProjectTaskStatus;
  state?: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned';
}

export interface SetLinkedStatusResult {
  target: RecordTarget;
  status?: ProjectTaskStatus;
  statusId?: string;
  statusKey?: string | null;
  state?: 'open' | 'closed';
}

/** An item of the app's layer in the project calendar. */
export interface ProjectCalendarItem extends ContributionSource {
  id: string;
  projectId: string;
  externalId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  color: string | null;
  /** The linked record it opens. */
  linkId: string | null;
  target: RecordTarget | null;
  updatedAt: string;
}

/** `olan.project.calendar.upsert`: one item per `externalId`. All-day items take dates (`2026-11-02`). */
export interface ProjectCalendarItemInput {
  externalId: string;
  title: string;
  start: string;
  /** Defaults to `start`. */
  end?: string;
  allDay?: boolean;
  /** `#RRGGBB`; the app's colour when absent. */
  color?: string | null;
  linkId?: string | null;
}

export type ProjectApprovalState = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** An approval the app asked for (`olan.project.approvals.request`). */
export interface ProjectApproval extends ContributionSource {
  id: string;
  projectId: string;
  projectName: string;
  externalId: string | null;
  linkId: string | null;
  target: RecordTarget | null;
  title: string;
  card: AppCard | null;
  approvers: string[];
  mode: 'all' | 'any';
  state: ProjectApprovalState;
  dueAt: string | null;
  requestedBy: string | null;
  decisions: Array<{ userId: string; decision: 'approve' | 'reject'; note: string; decidedAt: string }>;
  createdAt: string;
  decidedAt: string | null;
}

/** `olan.project.approvals.request`. */
export interface RequestApprovalInput {
  title: string;
  /** Project members (1–10) who may change the project. */
  approverIds: string[];
  /** `all` (default): every approver approves, one rejection rejects. `any`: the first decision decides. */
  mode?: 'all' | 'any';
  externalId?: string | null;
  linkId?: string | null;
  card?: AppCard | null;
  dueAt?: string | null;
}

/**
 * Every RPC method with its params and result (wire types). The host implements the same map
 * (`HostApi` in `modules/olan-apps-host`), so both sides type-check against one definition.
 */
export interface RpcMethods {
  'projects.list': { params: { limit?: number; cursor?: string }; result: ProjectListResult };
  'projects.get': { params: { projectId: string }; result: ProjectDetail };
  'projects.tasks': { params: { projectId: string; status?: ProjectTaskStatus }; result: ProjectTask[] };
  'projects.updateTask': { params: { projectId: string; taskId: string } & UpdateTaskInput; result: ProjectTask };
  'projects.createTask': { params: { projectId: string } & CreateTaskInput; result: ProjectTask };
  'projects.deleteTask': { params: { projectId: string; taskId: string; revision: number }; result: null };
  'projects.deleteList': { params: { projectId: string; listId: string; revision: number }; result: null };
  'users.get': { params: { ids: string[] }; result: UsersGetResult };
  'chat.conversations': { params: Record<string, never>; result: Conversation[] };
  'chat.messages': { params: { conversationId: string; limit?: number }; result: Message[] };
  'storage.get': { params: { key: string }; result: JsonValue };
  'storage.set': { params: { key: string; value: JsonValue }; result: null };
  'storage.remove': { params: { key: string }; result: null };
  'storage.keys': { params: Record<string, never>; result: string[] };
  'db.insert': { params: { collection: string; data: Record<string, JsonValue> }; result: DbRow };
  'db.get': { params: { collection: string; id: string }; result: DbRow | null };
  'db.query': { params: { collection: string } & DbQuery; result: DbQueryResult };
  'db.update': { params: { collection: string; id: string; patch: Record<string, JsonValue>; revision: number }; result: DbRow };
  'db.delete': { params: { collection: string; id: string; revision?: number }; result: null };
  'db.count': { params: { collection: string; where?: DbWhere }; result: number };
  'settings.get': { params: Record<string, never>; result: Record<string, JsonValue> };
  'http.fetch': { params: { url: string } & HttpRequestInit; result: HttpResponseData };
  'ui.confirm': { params: ConfirmOptions; result: boolean };
  'ui.prompt': { params: PromptOptions; result: string | null };
  'ui.toast': { params: { text: string; tone?: ToastTone }; result: null };
  'ui.menu': { params: { items: MenuItemOption[] }; result: string | null };
  'ui.datePicker': { params: DatePickerOptions; result: string | null };
  'ui.share': { params: { text: string; url?: string }; result: null };
  'navigation.push': { params: { screen: string; params?: JsonValue }; result: null };
  'navigation.pop': { params: Record<string, never>; result: null };
  'navigation.replace': { params: { screen: string; params?: JsonValue }; result: null };
  // Phase 3
  'chat.postCard': { params: PostCardInput; result: { messageId: string } };
  'chat.updateCard': { params: { messageId: string; card: AppCard }; result: { messageId: string } };
  'calendar.calendars': { params: Record<string, never>; result: { calendars: Calendar[] } };
  'calendar.events': { params: CalendarEventsQuery; result: { events: CalendarEvent[] } };
  'calendar.createEvent': { params: CreateEventInput; result: CalendarEvent };
  'calendar.updateEvent': { params: { eventId: string; patch: UpdateEventInput }; result: CalendarEvent };
  'calendar.deleteEvent': { params: { eventId: string }; result: null };
  'contacts.addressBooks': { params: Record<string, never>; result: { addressBooks: AddressBook[] } };
  'contacts.search': { params: { query: string; limit?: number }; result: { contacts: Contact[] } };
  'contacts.create': { params: CreateContactInput; result: Contact };
  'contacts.update': { params: { contactId: string; patch: UpdateContactInput }; result: Contact };
  'contacts.delete': { params: { contactId: string }; result: null };
  'mail.getMessage': { params: { messageId: string }; result: MailMessage };
  'meetings.get': { params: { meetingId: string }; result: Meeting };
  'projects.create': { params: CreateProjectInput; result: Project };
  'projects.archive': { params: { projectId: string }; result: null };
  'backend.call': { params: { name: string; args?: JsonValue }; result: JsonValue };
  // Phase 5a
  'remote.request': { params: RemoteRequestInit; result: RemoteResponse };
  'files.pick': { params: FilePickOptions; result: FileHandle[] };
  'files.upload': { params: FileUploadParams; result: FileUploadResult };
  'files.cancel': { params: { uploadId: string }; result: null };
  'ui.openUrl': { params: { url: string }; result: null };
  'ui.openExternal': { params: { url: string; expectReturn?: boolean }; result: ExternalFlowResult };
  'timers.set': { params: { timerId: string; intervalMs: number }; result: null };
  'timers.clear': { params: { timerId: string }; result: null };
  // Phase 6
  'project.config.get': { params: { projectId: string }; result: ProjectConfig };
  'project.config.set': { params: { projectId: string; value: Record<string, JsonValue>; revision?: number }; result: ProjectConfig };
  // Phase 6 (second wave)
  'project.statuses.list': { params: { projectId: string }; result: ProjectStatus[] };
  'project.statuses.define': { params: { projectId: string; statuses: ProjectStatusDefinition[] }; result: ProjectStatus[] };
  'project.statuses.remove': { params: { projectId: string; key: string; replacementKey?: string }; result: { movedTasks: number } };
  'project.labels.list': { params: { projectId: string }; result: ProjectLabel[] };
  'project.labels.define': { params: { projectId: string; labels: ProjectLabelDefinition[] }; result: ProjectLabel[] };
  'project.labels.remove': { params: { projectId: string; key: string }; result: null };
  'project.fields.list': { params: { projectId: string }; result: ProjectField[] };
  'project.fields.define': { params: { projectId: string; fields: ProjectFieldDefinition[] }; result: ProjectField[] };
  'project.fields.remove': { params: { projectId: string; key: string }; result: null };
  'project.fields.values': { params: { projectId: string; target: RecordTarget }; result: ProjectFieldValues };
  'project.fields.setValues': { params: { projectId: string; target: RecordTarget; values: Record<string, ProjectFieldValue | null> }; result: ProjectFieldValues };
  'project.links.list': { params: { projectId: string; target?: RecordTarget }; result: RecordLink[] };
  'project.links.upsert': { params: { projectId: string } & UpsertRecordLinkInput; result: RecordLink };
  'project.links.remove': { params: { projectId: string; linkId: string }; result: null };
  'project.links.setStatus': { params: { projectId: string; linkId: string } & SetLinkedStatusInput; result: SetLinkedStatusResult };
  'project.calendar.list': { params: { projectId: string; from?: string; to?: string }; result: ProjectCalendarItem[] };
  'project.calendar.upsert': { params: { projectId: string } & ProjectCalendarItemInput; result: ProjectCalendarItem };
  'project.calendar.remove': { params: { projectId: string; externalId: string }; result: null };
  'project.activity.post': { params: { projectId: string; text: string; target?: RecordTarget | null }; result: null };
  'project.approvals.list': { params: { projectId: string; state?: ProjectApprovalState | 'all' }; result: ProjectApproval[] };
  'project.approvals.request': { params: { projectId: string } & RequestApprovalInput; result: ProjectApproval };
  'project.approvals.cancel': { params: { projectId: string; approvalId: string }; result: ProjectApproval };
}

export type RpcMethodName = keyof RpcMethods;
/** `db.*` methods (contract §3.1). */
export type DbMethodName = Extract<RpcMethodName, `db.${string}`>;
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]['result'];

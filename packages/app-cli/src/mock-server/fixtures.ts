import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateRow, type DataSchema, type DbRow } from '@olan-app/schema';
import type {
  AddressBook,
  Calendar,
  CalendarEvent,
  Contact,
  Conversation,
  DirectoryUser,
  MailMessage,
  Meeting,
  Message,
  Project,
  ProjectApproval,
  ProjectCalendarItem,
  ProjectConfig,
  ProjectDetail,
  ProjectField,
  ProjectFieldType,
  ProjectFieldValue,
  ProjectLabel,
  ProjectMember,
  ProjectStatus,
  ProjectStatusCategory,
  ProjectTask,
  ProjectTaskList,
  RecordLink,
  RecordTarget,
} from '@olan-app/sdk';
import type { AppCard } from '@olan-app/schema';
import type { JsonValue } from '@olan-app/sdk/protocol';

import { CliError, issue, type Issue } from '../errors';
import { offsetToPosition } from '../json-locate';

/** A canned `http.fetch` response. `json` is a shortcut for a JSON `body`. */
export interface HttpFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: JsonValue;
}

/**
 * A canned answer of the app's server to `olan.remote.request` (`fixtures/remote.json`, keyed by
 * `"METHOD /path/:param"` like `handleRequest` routes): the wrapped `{ status, headers, body }`.
 */
export interface RemoteFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: JsonValue;
}

/** A file `olan.files.pick` can return (`fixtures/files.json`); `content` is what an upload sends. */
export interface FixtureFile {
  name: string;
  /** MIME type; default from the extension, else `application/octet-stream`. */
  type?: string;
  /** Bytes; default the length of `content`, else 1024. */
  size?: number;
  content?: string;
  lastModified?: number;
}

/** A loose task: only `id` and `title` are required, the rest gets defaults. */
export type FixtureTask = Partial<ProjectTask> & { id: string; title: string };

/** A loose work package: `isDefault` (the first list), `revision` (1) and `parentId` (null) get defaults. */
export type FixtureTaskList = Partial<ProjectTaskList> & { id: string; name: string };

/** A `fixtures/users.json` entry (a person in the directory, `olan.users.get`). */
export interface FixtureUser {
  id: string;
  displayName: string;
  email: string;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  avatarUrl?: string | null;
}

/** A `fixtures/db.json` row: missing fields get defaults (`createdBy` = `DEFAULT_USER_ID`, times = the test clock, `revision` 1, a UUID `id`). */
export interface FixtureDbRow {
  id?: string;
  data: Record<string, JsonValue>;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
}

/**
 * Phase 6: whether the app is enabled in the fixture project (default `true`: fixture projects are
 * the ones a member added the app to) and its stored `olan.project.config` value (default none).
 * A project with `enabled: false` is left out of `projects.list`, and calls naming it fail with
 * `project_not_enabled`, as on a real server.
 */
export interface FixtureProjectApp {
  enabled?: boolean;
  config?: Record<string, JsonValue>;
  /**
   * Phase 6 (second wave): statuses beyond the four defaults every project has (`todo`, `in_progress`,
   * `done`, `cancelled`). They are the app's own (`olan.project.statuses.define`) unless `"app": false`.
   */
  statuses?: FixtureProjectStatus[];
  /** Labels of the project; the app's own unless `"app": false`. */
  labels?: FixtureProjectLabel[];
  /** Custom fields of the project (SDK 1.8); the app's own unless `"app": false`. */
  fields?: FixtureProjectField[];
  /** Values of the fields on tasks and issues of the project, by field key (or id). */
  fieldValues?: FixtureFieldValues[];
  /** Issues of the project (targets of `issue.action` and of record links with `kind: "issue"`). */
  issues?: FixtureIssue[];
  /** The app's record links (`olan.project.links.*`) on tasks and issues of the project. */
  links?: FixtureRecordLink[];
  /** The app's calendar layer (`olan.project.calendar.*`). */
  calendarItems?: FixtureCalendarItem[];
  /** The app's approval requests (`olan.project.approvals.*`). */
  approvals?: FixtureApproval[];
}

/** A `projects.json` status: `name` and `category` are required; `key` too unless `"app": false`. */
export interface FixtureProjectStatus {
  key?: string | null;
  name: string;
  category: ProjectStatusCategory;
  color?: string;
  position?: number;
  id?: string;
  /** Defined by the app under test (default `true`): members cannot change it, the app can. */
  app?: boolean;
}

/** A `projects.json` label: `name` is required; `key` too unless `"app": false`. */
export interface FixtureProjectLabel {
  key?: string | null;
  name: string;
  color?: string;
  groupName?: string | null;
  description?: string;
  id?: string;
  app?: boolean;
}

/** A `projects.json` custom field: `name` and `type` are required; `key` too unless `"app": false`. */
export interface FixtureProjectField {
  key?: string | null;
  name: string;
  type: ProjectFieldType;
  description?: string;
  /** Select and multi-select fields; an option without `id` gets a slug of its name. */
  options?: { id?: string; name: string; color?: string }[];
  required?: boolean;
  /** Default: tasks only (as on the server). */
  appliesTo?: RecordTarget['kind'][];
  showOnCard?: boolean;
  id?: string;
  app?: boolean;
  /** The app's field after the app was removed from the project: values are read-only. */
  readOnly?: boolean;
}

/** A `projects.json` task's or issue's field values (`{ <field key or id>: value }`). */
export interface FixtureFieldValues {
  target: RecordTarget;
  values: Record<string, ProjectFieldValue>;
}

/** A `projects.json` issue: `id` and `title` are required. */
export interface FixtureIssue {
  id: string;
  title: string;
  number?: number;
  /** Default `<PREFIX>-#<number>` when the project has a `taskKeyPrefix`, else null. */
  key?: string | null;
  kind?: string | null;
  state?: 'open' | 'closed';
  stateReason?: string | null;
  inTriage?: boolean;
}

/** A `projects.json` record link of the app: the card's `fallbackText` is its title. */
export interface FixtureRecordLink {
  id: string;
  target: RecordTarget;
  externalId: string;
  card: AppCard;
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

/** A `projects.json` approval request of the app (default: pending, mode `all`). */
export interface FixtureApproval {
  id: string;
  title: string;
  approverIds: string[];
  mode?: 'all' | 'any';
  state?: 'pending' | 'approved' | 'rejected' | 'cancelled';
  externalId?: string | null;
  linkId?: string | null;
  card?: AppCard | null;
  dueAt?: string | null;
  decisions?: { userId: string; decision: 'approve' | 'reject'; note?: string; decidedAt?: string }[];
  createdAt?: string;
}

/** An issue as the mock host keeps it (the `issue.action` params' `issue`, with its project). */
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

/**
 * What the app put in a project's activity feed (Phase 6): its own lines (`olan.project.activity.post`,
 * `APP_ACTIVITY`), linked and unlinked records, approval requests and status changes made through a link.
 */
export interface MockProjectActivity {
  type: 'APP_ACTIVITY' | 'APP_RECORD_LINKED' | 'APP_RECORD_UNLINKED' | 'APP_APPROVAL_REQUESTED' | 'APP_APPROVAL_DECIDED' | 'TASK_STATUS_CHANGED' | 'ISSUE_STATE_CHANGED' | 'PROJECT_UPDATED';
  /** The line (`APP_ACTIVITY`), the link or approval title, or the new status / state. */
  text: string;
  target: RecordTarget | null;
  actorId: string | null;
  at: string;
}

/** Installation id of the app under test (record links, calendar items, approvals, its statuses and labels). */
export const MOCK_INSTALLATION_ID = 'mock-installation';

/**
 * A loose project. Either a `ProjectDetail` (`{ project, members, lists, tasks }`) or a flat
 * project with optional inline `tasks`, `lists` and `members`; missing fields get defaults.
 */
export type FixtureProject =
  | (Partial<Omit<ProjectDetail, 'project' | 'tasks' | 'lists'>> & FixtureProjectApp & { project: Partial<Project> & { id: string; name: string }; tasks?: FixtureTask[]; lists?: FixtureTaskList[] })
  | (Partial<Project> & FixtureProjectApp & { id: string; name: string; tasks?: FixtureTask[]; lists?: FixtureTaskList[]; members?: ProjectMember[] });

/** A `fixtures/calendar.json` calendar; `projectId` marks a project calendar (its events are protected). */
export type FixtureCalendar = Partial<Calendar> & { id: string; name: string; projectId?: string | null };

/** A `fixtures/calendar.json` event: `id`, `title` and `start` are required. */
export type FixtureCalendarEvent = Partial<CalendarEvent> & { id: string; title: string; start: string };

/** A `fixtures/contacts.json` address book (`shared` ones are read-only). */
export type FixtureAddressBook = Partial<AddressBook> & { id: string; name: string };

/** A `fixtures/contacts.json` contact. */
export type FixtureContact = Partial<Contact> & { id: string; name: string };

/** A `fixtures/mail.json` message (what `mail.getMessage` returns and the mail surfaces open on). */
export type FixtureMailMessage = Partial<MailMessage> & { id: string; subject: string; threadId?: string | null };

/** A `fixtures/meetings.json` meeting (`projectId` links it to a project). */
export type FixtureMeeting = Partial<Meeting> & { id: string; title: string; startsAt: string; projectId?: string | null };

/** What `fixtures/*.json` may contain (all optional; defaults fill the rest). */
export interface Fixtures {
  /** `fixtures/projects.json`: an array, or `{ "projects": [...] }`. */
  projects?: FixtureProject[];
  /** `fixtures/chat.json`: `{ "conversations": [...], "messages": { "<conversationId>": [...] } }`. */
  conversations?: (Partial<Conversation> & { id: string })[];
  messages?: Record<string, (Partial<Message> & { id: string; body: string | null })[]>;
  /** `fixtures/settings.json`: the app's settings values (merged over the manifest defaults). */
  settings?: Record<string, JsonValue>;
  /** `fixtures/storage.json`: initial `olan.storage` content. */
  storage?: Record<string, JsonValue>;
  /** `fixtures/http.json`: responses by URL (or `"METHOD url"`). */
  http?: Record<string, HttpFixture>;
  /** `fixtures/db.json`: initial `olan.db` rows by collection (must match the manifest `data`). */
  db?: Record<string, FixtureDbRow[]>;
  /** `fixtures/users.json`: extra directory entries (an array, or `{ "users": [...] }`); the default user is always there. */
  users?: FixtureUser[];
  /** `fixtures/calendar.json` `calendars` (Phase 3). */
  calendars?: FixtureCalendar[];
  /** `fixtures/calendar.json` `events`. */
  calendarEvents?: FixtureCalendarEvent[];
  /** `fixtures/contacts.json` `addressBooks`. */
  addressBooks?: FixtureAddressBook[];
  /** `fixtures/contacts.json` `contacts`. */
  contacts?: FixtureContact[];
  /** `fixtures/mail.json`: messages (an array, or `{ "messages": [...] }`). */
  mail?: FixtureMailMessage[];
  /** `fixtures/meetings.json`: meetings (an array, or `{ "meetings": [...] }`). */
  meetings?: FixtureMeeting[];
  /** `fixtures/remote.json`: answers of the app's server by route (Phase 5a `olan.remote.request`). */
  remote?: Record<string, RemoteFixture>;
  /** `fixtures/files.json`: what the file picker offers (an array, or `{ "files": [...] }`). */
  files?: FixtureFile[];
}

/** A calendar as the mock host keeps it (`projectId` marks a project calendar). */
export type MockCalendar = Calendar & { projectId: string | null };
/** A mail message with its thread (the mail surface params carry `threadId`). */
export type MockMailMessage = MailMessage & { threadId: string | null };
/** A meeting with its project link (`meeting.panel` params). */
export type MockMeeting = Meeting & { projectId: string | null };

/** Fixtures with every default applied: what the mock server serves. */
export interface NormalizedFixtures {
  projects: ProjectDetail[];
  /** Phase 6: ids of fixture projects the app is not enabled in (`enabled: false`). */
  disabledProjects: string[];
  /** Phase 6: `olan.project.config` by project id (only projects that have one stored). */
  projectConfigs: Record<string, ProjectConfig>;
  /** Phase 6 (second wave): every project's statuses (the four defaults, then the fixture's), by project id. */
  projectStatuses: Record<string, ProjectStatus[]>;
  /** The project's labels by project id. */
  projectLabels: Record<string, ProjectLabel[]>;
  /** The project's custom fields by project id (SDK 1.8). */
  projectFields: Record<string, ProjectField[]>;
  /** Field values by project id, then `<kind>:<id>` of the task or issue, then field id. */
  projectFieldValues: Record<string, Record<string, Record<string, ProjectFieldValue>>>;
  /** The project's issues by project id. */
  projectIssues: Record<string, MockProjectIssue[]>;
  /** The status id of each task (task id → status id); tasks start on the default status of their `status`. */
  taskStatusIds: Record<string, string>;
  /** The app's record links by project id. */
  recordLinks: Record<string, RecordLink[]>;
  /** The app's calendar layer by project id. */
  projectCalendarItems: Record<string, ProjectCalendarItem[]>;
  /** The app's approval requests by project id (newest last). */
  projectApprovals: Record<string, ProjectApproval[]>;
  /** What the app added to each project's activity feed, oldest first. */
  projectActivity: Record<string, MockProjectActivity[]>;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  settings: Record<string, JsonValue>;
  storage: Record<string, JsonValue>;
  http: Record<string, HttpFixture>;
  /** `olan.db` rows by collection (every user's). On a mock host this is live: each read is a fresh snapshot. */
  db: Record<string, DbRow[]>;
  /** The directory `users.get` reads: `DEFAULT_USER` (unless a fixture entry has its id) and `fixtures/users.json`. */
  users: DirectoryUser[];
  calendars: MockCalendar[];
  calendarEvents: CalendarEvent[];
  addressBooks: AddressBook[];
  contacts: Contact[];
  mail: MockMailMessage[];
  meetings: MockMeeting[];
  remote: Record<string, RemoteFixture>;
  files: MockFile[];
}

/** A picker file with its defaults applied. */
export interface MockFile {
  name: string;
  type: string;
  size: number;
  content: string;
  lastModified?: number;
}

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
};

/** `fixtures/files.json` entries with defaults (type from the extension, size from the content). */
export function normalizeFiles(files: Fixtures['files']): MockFile[] {
  return (files ?? []).map((file) => {
    const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
    const content = file.content ?? '';
    return {
      name: file.name,
      type: file.type ?? EXTENSION_TYPES[extension] ?? 'application/octet-stream',
      size: file.size ?? (file.content !== undefined ? new TextEncoder().encode(content).length : 1024),
      content,
      ...(file.lastModified !== undefined ? { lastModified: file.lastModified } : {}),
    };
  });
}

export const FIXTURE_NOW = '2026-10-16T09:00:00.000Z';
/**
 * The signed-in user of the mock host (Phase 2 server contract §10.1): `context.user.id`,
 * `createdBy` of fixture rows and tasks, the default project member and message sender.
 */
export const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_USER: Readonly<DirectoryUser> = Object.freeze({
  id: DEFAULT_USER_ID,
  displayName: 'Utku',
  email: 'utku@example.com',
  title: 'Ürün yöneticisi',
  department: 'Ürün',
  team: 'Olan',
});
const DEFAULT_MEMBER: ProjectMember = { userId: DEFAULT_USER_ID, displayName: DEFAULT_USER.displayName, role: 'owner' };

function sampleProject(index: number): FixtureProject {
  const id = `p${index}`;
  return {
    id,
    name: ['Web sitesi', 'Mobil uygulama', 'Ofis taşınması'][index % 3]! + (index >= 3 ? ` ${index}` : ''),
    // Phase 6 (second wave): one open issue per project (the `issue.action` sample).
    issues: [{ id: `${id}-i1`, title: ['Giriş sayfası yavaş açılıyor', 'Bildirimler gecikiyor', 'Toplantı odası rezervasyonu'][index % 3]!, number: 1 }],
    tasks: Array.from({ length: 4 }, (_, n) => ({
      id: `${id}-t${n}`,
      title: `Görev ${n + 1}`,
      status: n === 0 ? ('completed' as const) : ('needs-action' as const),
      due: `2026-10-${String(10 + n).padStart(2, '0')}`,
    })),
  };
}

/**
 * The built-in data (same as the web host's fixture API): three projects (`p0` "Web sitesi",
 * `p1` "Mobil uygulama", `p2` "Ofis taşınması"), each with four tasks due 2026-10-10…13, the
 * first one completed; no chats, settings, storage or HTTP responses; the directory holds only
 * `DEFAULT_USER` ("Utku", `DEFAULT_USER_ID`). Phase 3 data: the default calendar `cal-0` with an
 * event the user organizes (`ev-0`), an Olan meeting (`ev-meeting`, UID `mt-0@olan.app`) and an
 * invitation (`ev-invite`); the project calendar `cal-p0` (event `ev-p0`); address books `ab-0`
 * (own, default) and `ab-company` (shared) with `ct-0` and `ct-company`; the email `mail-0`; the
 * meeting `mt-0`.
 */
export function defaultFixtures(): Fixtures {
  return {
    projects: [0, 1, 2].map(sampleProject),
    conversations: [],
    messages: {},
    settings: {},
    storage: {},
    http: {},
    db: {},
    users: [],
    calendars: [
      { id: 'cal-0', name: 'Takvim', color: '#3b82f6', isDefault: true, mayWrite: true },
      { id: 'cal-p0', name: 'Web sitesi', color: '#10b981', isDefault: false, mayWrite: true, projectId: 'p0' },
    ],
    calendarEvents: [
      { id: 'ev-0', calendarId: 'cal-0', uid: 'ev-0@example.com', title: 'Haftalık planlama', start: '2026-10-19T09:00:00+03:00', end: '2026-10-19T10:00:00+03:00', timeZone: 'Europe/Istanbul' },
      { id: 'ev-meeting', calendarId: 'cal-0', uid: 'mt-0@olan.app', title: 'Ürün toplantısı', start: '2026-10-19T14:00:00+03:00', end: '2026-10-19T15:00:00+03:00', timeZone: 'Europe/Istanbul' },
      { id: 'ev-invite', calendarId: 'cal-0', uid: 'invite-1@partner.example', title: 'Müşteri görüşmesi', start: '2026-10-20T11:00:00+03:00', end: '2026-10-20T12:00:00+03:00', timeZone: 'Europe/Istanbul', isOrganizer: false },
      { id: 'ev-p0', calendarId: 'cal-p0', uid: 'ev-p0@olan.example', title: 'Yayın günü', start: '2026-10-24', end: '2026-10-25', isAllDay: true },
    ],
    addressBooks: [
      { id: 'ab-0', name: 'Kişiler', isDefault: true, shared: false },
      { id: 'ab-company', name: 'Şirket dizini', isDefault: false, shared: true },
    ],
    contacts: [
      { id: 'ct-0', addressBookId: 'ab-0', name: 'Ayşe Yılmaz', emails: ['ayse@example.com'], phones: ['+90 555 000 0000'], organization: 'Örnek A.Ş.' },
      { id: 'ct-company', addressBookId: 'ab-company', name: 'Destek Ekibi', emails: ['destek@example.com'] },
    ],
    mail: [
      {
        id: 'mail-0',
        threadId: 'thread-0',
        subject: 'Teklif hakkında',
        from: { name: 'Ayşe Yılmaz', email: 'ayse@example.com' },
        to: [{ name: 'Utku', email: 'utku@example.com' }],
        textBody: 'Merhaba, teklifimizi ekte bulabilirsiniz.',
        attachments: [{ name: 'teklif.pdf', type: 'application/pdf', size: 48213 }],
      },
    ],
    meetings: [{ id: 'mt-0', slug: 'urun-toplantisi', title: 'Ürün toplantısı', startsAt: '2026-10-19T14:00:00+03:00', endsAt: '2026-10-19T15:00:00+03:00' }],
    remote: {},
    files: [
      { name: 'kampanya.jpg', type: 'image/jpeg', size: 245_760, content: 'jpeg-bytes' },
      { name: 'tanitim.mp4', type: 'video/mp4', size: 5_242_880, content: 'mp4-bytes' },
      { name: 'brief.pdf', type: 'application/pdf', size: 48_213, content: 'pdf-bytes' },
    ],
  };
}

function normalizeTask(task: FixtureTask, projectId: string, listId: string): ProjectTask {
  return {
    projectId,
    listId,
    description: '',
    status: 'needs-action',
    assigneeId: null,
    createdBy: DEFAULT_MEMBER.userId,
    due: null,
    allDay: true,
    revision: 1,
    ...task,
  };
}

export function normalizeProject(input: FixtureProject): ProjectDetail {
  const flat = 'project' in input && input.project ? null : (input as Extract<FixtureProject, { id: string }>);
  const detail = flat ? null : (input as Extract<FixtureProject, { project: unknown }>);
  const base = (flat ?? detail!.project) as Partial<Project> & { id: string; name: string };
  const {
    tasks: _tasks,
    lists: _lists,
    members: _members,
    enabled: _enabled,
    config: _config,
    statuses: _statuses,
    labels: _labels,
    fields: _fields,
    fieldValues: _fieldValues,
    issues: _issues,
    links: _links,
    calendarItems: _calendarItems,
    approvals: _approvals,
    ...projectFields
  } = base as Record<string, unknown>;
  const project: Project = {
    description: '',
    timeZone: 'Europe/Istanbul',
    archived: false,
    revision: 1,
    role: 'owner',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...(projectFields as Partial<Project>),
    id: base.id,
    name: base.name,
  };
  const looseLists: FixtureTaskList[] = (flat?.lists ?? detail?.lists) ?? [{ id: `${project.id}-l0`, name: 'Görevler' }];
  // The first work package is the project's default one, unless the fixture marks another.
  const marked = looseLists.some((list) => list.isDefault === true);
  const lists: ProjectTaskList[] = looseLists.map((list, index) => ({
    revision: 1,
    parentId: null,
    ...list,
    isDefault: marked ? list.isDefault === true : index === 0,
  }));
  const members = (flat?.members ?? detail?.members) ?? [DEFAULT_MEMBER];
  const tasks = ((flat?.tasks ?? detail?.tasks) ?? []).map((task) => normalizeTask(task, project.id, task.listId ?? lists[0]?.id ?? `${project.id}-l0`));
  return { project, members, lists, tasks };
}

/** Phase 6: `enabled` and `config` of the fixture projects (flat or `{ project, … }` form). */
export function normalizeProjectApps(projects: Fixtures['projects']): Pick<NormalizedFixtures, 'disabledProjects' | 'projectConfigs'> {
  const disabledProjects: string[] = [];
  const projectConfigs: Record<string, ProjectConfig> = {};
  for (const input of projects ?? []) {
    const id = 'project' in input && input.project ? input.project.id : (input as { id: string }).id;
    if (input.enabled === false) disabledProjects.push(id);
    if (input.config && typeof input.config === 'object' && !Array.isArray(input.config)) {
      projectConfigs[id] = { projectId: id, value: { ...input.config }, revision: 1, updatedBy: DEFAULT_USER_ID, updatedAt: FIXTURE_NOW };
    }
  }
  return { disabledProjects, projectConfigs };
}

/** The app under test as the mock host names it in record links, calendar items and approvals. */
export interface MockAppIdentity {
  id: string;
  name: string;
}

export const DEFAULT_MOCK_APP: Readonly<MockAppIdentity> = Object.freeze({ id: 'com.example.app', name: 'Örnek uygulama' });

/** Board order of status categories (as the server sorts statuses). */
export const STATUS_CATEGORY_ORDER: readonly ProjectStatusCategory[] = Object.freeze(['backlog', 'unstarted', 'started', 'completed', 'cancelled']);
/** Colour of a status defined without one, by category (Olan's defaults). */
export const STATUS_CATEGORY_COLORS: Readonly<Record<ProjectStatusCategory, string>> = Object.freeze({
  backlog: '#B4BAC4',
  unstarted: '#8A94A6',
  started: '#E0A526',
  completed: '#2F9E6E',
  cancelled: '#A1A7B3',
});
/** Colours of labels defined without one, in turn. */
export const LABEL_COLORS: readonly string[] = Object.freeze(['#00CE9D', '#5B8DEF', '#A78BFA', '#F59E0B', '#F472B6', '#22B8CF', '#EF767A', '#84CC16', '#8A94A6', '#E0A526', '#2F9E6E', '#6366F1']);
/** The statuses every new Olan project has (Turkish names, as for a Turkish-speaking maker). */
const DEFAULT_STATUSES: readonly { key: string; name: string; category: ProjectStatusCategory }[] = [
  { key: 'todo', name: 'Yapılacak', category: 'unstarted' },
  { key: 'in_progress', name: 'Devam ediyor', category: 'started' },
  { key: 'done', name: 'Tamamlandı', category: 'completed' },
  { key: 'cancelled', name: 'İptal', category: 'cancelled' },
];

/** The CalDAV task status a status category stands for. */
export function statusCalDav(category: ProjectStatusCategory): ProjectTask['status'] {
  return category === 'started' ? 'in-process' : category === 'completed' ? 'completed' : category === 'cancelled' ? 'cancelled' : 'needs-action';
}

/** Statuses in board order: category, then position. */
export function sortStatuses(statuses: ProjectStatus[]): ProjectStatus[] {
  return [...statuses].sort((a, b) => STATUS_CATEGORY_ORDER.indexOf(a.category) - STATUS_CATEGORY_ORDER.indexOf(b.category) || a.position - b.position);
}

/** The status a CalDAV value lands on: the first of its categories (unstarted before backlog), as on the server. */
export function defaultStatusFor(statuses: ProjectStatus[], status: ProjectTask['status']): ProjectStatus | undefined {
  return sortStatuses(statuses)
    .filter((candidate) => statusCalDav(candidate.category) === status)
    .sort((a, b) => Number(a.category === 'backlog') - Number(b.category === 'backlog'))[0];
}

/** An ISO date (`2026-11-02`, midnight UTC) or date-time as the server stores it, or null. */
export function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Field types whose values pick from the field's `options`. */
export const FIELD_TYPES_WITH_OPTIONS: ReadonlySet<ProjectFieldType> = new Set(['select', 'multi_select']);
export const PROJECT_FIELD_TYPES: readonly ProjectFieldType[] = Object.freeze(['text', 'number', 'date', 'select', 'multi_select', 'person', 'url', 'checkbox']);

/** A slug for option ids made from a name ("Instagram Reels" → "instagram-reels"), as on the server. */
export function fieldSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'option';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

/** The key of a task's or issue's field values (`task:t1`). */
export const fieldTargetKey = (target: RecordTarget) => `${target.kind}:${target.id}`;

/**
 * A value checked against its field like the server (`normalizeProjectFieldValue` of Olan's
 * contracts): the normalized value, or null when it is not a value of the field.
 */
export function normalizeFieldValue(field: Pick<ProjectField, 'type' | 'options'>, value: unknown): ProjectFieldValue | null {
  const optionIds = new Set(field.options.map((option) => option.id));
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string' || value.length > 2000) return null;
      return value.trim() || null;
    }
    case 'url': {
      if (typeof value !== 'string' || value.length > 2000) return null;
      try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value.trim() : null;
      } catch {
        return null;
      }
    }
    case 'number': {
      const number = typeof value === 'string' && value.trim() ? Number(value.trim().replace(',', '.')) : value;
      return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) < 1e15 ? number : null;
    }
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
    case 'select':
      return typeof value === 'string' && optionIds.has(value) ? value : null;
    case 'multi_select': {
      if (!Array.isArray(value) || value.length > 50 || !value.every((entry) => typeof entry === 'string' && optionIds.has(entry))) return null;
      // Option order, not the order the person clicked.
      const chosen = new Set(value as string[]);
      const ordered = field.options.map((option) => option.id).filter((id) => chosen.has(id));
      return ordered.length ? ordered : null;
    }
    case 'person':
      return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
    case 'checkbox':
      return typeof value === 'boolean' ? value : null;
  }
}

type ContributionFixtures = Pick<
  NormalizedFixtures,
  'projectStatuses' | 'projectLabels' | 'projectFields' | 'projectFieldValues' | 'projectIssues' | 'taskStatusIds' | 'recordLinks' | 'projectCalendarItems' | 'projectApprovals' | 'projectActivity'
>;

/**
 * Phase 6 (second wave): statuses, labels, issues and the app's links, calendar items and approvals
 * of the fixture projects. Every project gets the four default statuses; its tasks start on the
 * default status of their CalDAV `status`.
 */
export function normalizeProjectContributions(inputs: Fixtures['projects'], details: ProjectDetail[], app: MockAppIdentity = DEFAULT_MOCK_APP): ContributionFixtures {
  const out: ContributionFixtures = {
    projectStatuses: {},
    projectLabels: {},
    projectFields: {},
    projectFieldValues: {},
    projectIssues: {},
    taskStatusIds: {},
    recordLinks: {},
    projectCalendarItems: {},
    projectApprovals: {},
    projectActivity: {},
  };
  const source = { installationId: MOCK_INSTALLATION_ID, appId: app.id, name: app.name, active: true };
  (inputs ?? []).forEach((input, index) => {
    const detail = details[index];
    if (!detail) return;
    const projectId = detail.project.id;
    const ours = (fixture: { app?: boolean }) => fixture.app !== false;
    const statuses: ProjectStatus[] = DEFAULT_STATUSES.map((status, position) => ({
      id: `${projectId}-status-${status.key}`,
      projectId,
      name: status.name,
      color: STATUS_CATEGORY_COLORS[status.category],
      category: status.category,
      position,
      key: status.key,
      createdByApp: null,
      appInstallationId: null,
      revision: 1,
    }));
    (input.statuses ?? []).forEach((status, n) => {
      const key = status.key ?? null;
      statuses.push({
        id: status.id ?? `${projectId}-status-${key ?? n}`,
        projectId,
        name: status.name,
        color: status.color ?? STATUS_CATEGORY_COLORS[status.category],
        category: status.category,
        position: status.position ?? statuses.filter((candidate) => candidate.category === status.category).length + DEFAULT_STATUSES.length,
        key,
        createdByApp: ours(status) ? app.id : null,
        appInstallationId: ours(status) ? MOCK_INSTALLATION_ID : null,
        revision: 1,
      });
    });
    out.projectStatuses[projectId] = sortStatuses(statuses);
    out.projectLabels[projectId] = (input.labels ?? []).map((label, n) => ({
      id: label.id ?? `${projectId}-label-${label.key ?? n}`,
      projectId,
      name: label.name,
      color: label.color ?? LABEL_COLORS[n % LABEL_COLORS.length]!,
      groupName: label.groupName ?? null,
      description: label.description ?? '',
      position: n,
      key: label.key ?? null,
      createdByApp: ours(label) ? app.id : null,
      appInstallationId: ours(label) ? MOCK_INSTALLATION_ID : null,
      revision: 1,
    }));
    const fields = (input.fields ?? []).map((field, n): ProjectField => {
      const taken = new Set<string>();
      const options = FIELD_TYPES_WITH_OPTIONS.has(field.type)
        ? (field.options ?? []).map((option, m) => {
            const id = option.id ?? fieldSlug(option.name, taken);
            taken.add(id);
            return { id, name: option.name, color: option.color ?? LABEL_COLORS[m % LABEL_COLORS.length]! };
          })
        : [];
      return {
        id: field.id ?? `${projectId}-field-${field.key ?? n}`,
        projectId,
        name: field.name,
        description: field.description ?? '',
        type: field.type,
        position: n,
        options,
        required: field.required ?? false,
        appliesTo: field.appliesTo ?? ['task'],
        showOnCard: field.showOnCard ?? false,
        key: field.key ?? null,
        createdByApp: ours(field) ? app.id : null,
        appInstallationId: ours(field) ? MOCK_INSTALLATION_ID : null,
        appName: ours(field) ? app.name : null,
        readOnly: field.readOnly ?? false,
        revision: 1,
      };
    });
    out.projectFields[projectId] = fields;
    const values: Record<string, Record<string, ProjectFieldValue>> = {};
    for (const entry of input.fieldValues ?? []) {
      const stored = (values[fieldTargetKey(entry.target)] ??= {});
      for (const [ref, value] of Object.entries(entry.values)) {
        const field = fields.find((candidate) => candidate.key === ref || candidate.id === ref);
        if (field) stored[field.id] = value;
      }
    }
    out.projectFieldValues[projectId] = values;
    const prefix = typeof detail.project.taskKeyPrefix === 'string' && detail.project.taskKeyPrefix ? detail.project.taskKeyPrefix : null;
    out.projectIssues[projectId] = (input.issues ?? []).map((issue, n) => {
      const number = issue.number ?? n + 1;
      return {
        id: issue.id,
        projectId,
        number,
        key: issue.key !== undefined ? issue.key : prefix ? `${prefix}-#${number}` : null,
        title: issue.title,
        kind: issue.kind ?? null,
        state: issue.state ?? 'open',
        stateReason: issue.stateReason ?? null,
        inTriage: issue.inTriage ?? false,
      };
    });
    for (const task of detail.tasks) {
      const status = defaultStatusFor(out.projectStatuses[projectId]!, task.status);
      if (status) out.taskStatusIds[task.id] = status.id;
    }
    const links = (input.links ?? []).map(
      (link): RecordLink => ({
        ...source,
        id: link.id,
        projectId,
        target: { kind: link.target.kind, id: link.target.id },
        externalId: link.externalId,
        title: typeof link.card?.fallbackText === 'string' ? link.card.fallbackText.trim() : '',
        card: link.card,
        createdBy: DEFAULT_USER_ID,
        updatedBy: DEFAULT_USER_ID,
        revision: 1,
        createdAt: link.createdAt ?? FIXTURE_NOW,
        updatedAt: link.createdAt ?? FIXTURE_NOW,
      }),
    );
    out.recordLinks[projectId] = links;
    out.projectCalendarItems[projectId] = (input.calendarItems ?? []).map((item): ProjectCalendarItem => {
      const start = isoInstant(item.start) ?? item.start;
      const link = item.linkId ? links.find((candidate) => candidate.id === item.linkId) : undefined;
      return {
        ...source,
        id: item.id ?? `${projectId}-calendar-${item.externalId}`,
        projectId,
        externalId: item.externalId,
        title: item.title,
        start,
        end: item.end !== undefined ? (isoInstant(item.end) ?? item.end) : start,
        allDay: item.allDay ?? !item.start.includes('T'),
        color: item.color ?? null,
        linkId: item.linkId ?? null,
        target: link ? { ...link.target } : null,
        updatedAt: FIXTURE_NOW,
      };
    });
    out.projectApprovals[projectId] = (input.approvals ?? []).map((approval): ProjectApproval => {
      const link = approval.linkId ? links.find((candidate) => candidate.id === approval.linkId) : undefined;
      const state = approval.state ?? 'pending';
      const createdAt = approval.createdAt ?? FIXTURE_NOW;
      return {
        ...source,
        id: approval.id,
        projectId,
        projectName: detail.project.name,
        externalId: approval.externalId ?? null,
        linkId: approval.linkId ?? null,
        target: link ? { ...link.target } : null,
        title: approval.title,
        card: approval.card ?? null,
        approvers: [...approval.approverIds],
        mode: approval.mode ?? 'all',
        state,
        dueAt: approval.dueAt ?? null,
        requestedBy: DEFAULT_USER_ID,
        decisions: (approval.decisions ?? []).map((decision) => ({ userId: decision.userId, decision: decision.decision, note: decision.note ?? '', decidedAt: decision.decidedAt ?? createdAt })),
        createdAt,
        decidedAt: state === 'pending' ? null : createdAt,
      };
    });
    out.projectActivity[projectId] = [];
  });
  return out;
}

export function normalizeFixtures(fixtures: Fixtures, app: MockAppIdentity = DEFAULT_MOCK_APP): NormalizedFixtures {
  const conversations = (fixtures.conversations ?? []).map(
    (conversation): Conversation => ({ kind: 'group', title: null, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, ...conversation }),
  );
  const messages: Record<string, Message[]> = {};
  for (const [conversationId, list] of Object.entries(fixtures.messages ?? {})) {
    messages[conversationId] = list.map(
      (message): Message => ({
        conversationId,
        sender: { id: DEFAULT_MEMBER.userId, displayName: DEFAULT_MEMBER.displayName },
        replyToId: null,
        createdAt: FIXTURE_NOW,
        editedAt: null,
        deletedAt: null,
        ...message,
      }),
    );
  }
  const projects = (fixtures.projects ?? []).map(normalizeProject);
  return {
    projects,
    ...normalizeProjectApps(fixtures.projects),
    ...normalizeProjectContributions(fixtures.projects, projects, app),
    conversations,
    messages,
    settings: { ...(fixtures.settings ?? {}) },
    storage: { ...(fixtures.storage ?? {}) },
    http: { ...(fixtures.http ?? {}) },
    db: normalizeDbFixtures(fixtures.db),
    users: normalizeUsers(fixtures.users),
    ...normalizePim(fixtures),
    remote: { ...(fixtures.remote ?? {}) },
    files: normalizeFiles(fixtures.files),
  };
}

/** Calendar, contacts, mail and meetings with defaults applied. */
export function normalizePim(fixtures: Fixtures): Pick<NormalizedFixtures, 'calendars' | 'calendarEvents' | 'addressBooks' | 'contacts' | 'mail' | 'meetings'> {
  const markedCalendar = (fixtures.calendars ?? []).some((calendar) => calendar.isDefault === true);
  const calendars = (fixtures.calendars ?? []).map(
    (calendar, index): MockCalendar => ({ color: null, mayWrite: true, projectId: null, ...calendar, isDefault: markedCalendar ? calendar.isDefault === true : index === 0 }),
  );
  const firstCalendar = calendars.find((calendar) => calendar.isDefault)?.id ?? 'cal-0';
  const calendarEvents = (fixtures.calendarEvents ?? []).map(
    (event): CalendarEvent => ({
      calendarId: firstCalendar,
      uid: `${event.id}@example.com`,
      end: event.start,
      timeZone: null,
      isAllDay: !event.start.includes('T'),
      location: null,
      description: null,
      isOrganizer: true,
      createdByApp: null,
      updatedAt: FIXTURE_NOW,
      ...event,
    }),
  );
  const markedBook = (fixtures.addressBooks ?? []).some((book) => book.isDefault === true);
  const addressBooks = (fixtures.addressBooks ?? []).map((book, index): AddressBook => ({ shared: false, ...book, isDefault: markedBook ? book.isDefault === true : index === 0 }));
  const firstBook = addressBooks.find((book) => book.isDefault)?.id ?? 'ab-0';
  const contacts = (fixtures.contacts ?? []).map(
    (contact): Contact => ({ addressBookId: firstBook, emails: [], phones: [], organization: null, title: null, note: null, createdByApp: null, updatedAt: FIXTURE_NOW, ...contact }),
  );
  const mail = (fixtures.mail ?? []).map(
    (message): MockMailMessage => ({
      threadId: null,
      from: { name: DEFAULT_USER.displayName, email: DEFAULT_USER.email },
      to: [],
      cc: [],
      receivedAt: FIXTURE_NOW,
      textBody: '',
      attachments: [],
      ...message,
    }),
  );
  const meetings = (fixtures.meetings ?? []).map(
    (meeting): MockMeeting => ({
      slug: meeting.id,
      endsAt: null,
      status: 'scheduled',
      organizerId: DEFAULT_USER_ID,
      participants: [{ userId: DEFAULT_USER_ID, displayName: DEFAULT_USER.displayName, role: 'organizer' }],
      projectId: null,
      ...meeting,
    }),
  );
  return { calendars, calendarEvents, addressBooks, contacts, mail, meetings };
}

/** `DEFAULT_USER` first (a fixture entry with its id replaces it), then the fixture users; later duplicates win. */
export function normalizeUsers(users: Fixtures['users']): DirectoryUser[] {
  const byId = new Map<string, DirectoryUser>([[DEFAULT_USER_ID, { ...DEFAULT_USER }]]);
  for (const user of users ?? []) byId.set(user.id, { ...user });
  return [...byId.values()];
}

/** Checks `fixtures/users.json` entries (`fixtures.users_invalid`). */
export function userFixtureIssues(users: unknown): Issue[] {
  const file = 'fixtures/users.json';
  if (users === undefined) return [];
  if (!Array.isArray(users)) return [issue('fixtures.users_invalid', `${file} must be an array of users (or { "users": [...] })`, { file })];
  const issues: Issue[] = [];
  const hint = 'Users look like { "id": "<uuid>", "displayName": "Ayşe", "email": "ayse@example.com", "title"?, "department"?, "team"? }.';
  users.forEach((user: unknown, index) => {
    const where = `${file}: users[${index}]`;
    if (typeof user !== 'object' || user === null || Array.isArray(user)) {
      issues.push(issue('fixtures.users_invalid', `${where} must be an object`, { file, hint }));
      return;
    }
    const entry = user as Record<string, unknown>;
    for (const key of ['id', 'displayName', 'email'] as const) {
      if (typeof entry[key] !== 'string' || (entry[key] as string).length === 0) issues.push(issue('fixtures.users_invalid', `${where}.${key} must be a non-empty string`, { file, hint }));
    }
    for (const key of ['title', 'department', 'team', 'avatarUrl'] as const) {
      if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'string') issues.push(issue('fixtures.users_invalid', `${where}.${key} must be a string`, { file, hint }));
    }
    for (const key of Object.keys(entry)) {
      if (!['id', 'displayName', 'email', 'title', 'department', 'team', 'avatarUrl'].includes(key)) {
        issues.push(issue('fixtures.users_invalid', `${where}: unknown field "${key}"`, { file, hint }));
      }
    }
  });
  return issues;
}

/**
 * `fixtures/db.json` rows with defaults: `createdBy` `DEFAULT_USER_ID`, times `now` (default `FIXTURE_NOW`),
 * `revision` 1. Missing ids stay missing (the database generates UUIDs).
 */
export function dbSeed(rows: Fixtures['db'], now: string = FIXTURE_NOW): Record<string, FixtureDbRow[]> {
  const out: Record<string, FixtureDbRow[]> = {};
  for (const [collection, list] of Object.entries(rows ?? {})) {
    out[collection] = (Array.isArray(list) ? list : []).map((row) => ({
      ...row,
      createdBy: row.createdBy ?? DEFAULT_MEMBER.userId,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? row.createdAt ?? now,
      revision: row.revision ?? 1,
    }));
  }
  return out;
}

function normalizeDbFixtures(rows: Fixtures['db']): Record<string, DbRow[]> {
  const out: Record<string, DbRow[]> = {};
  for (const [collection, list] of Object.entries(dbSeed(rows))) {
    out[collection] = list.map((row, index) => ({
      id: row.id ?? `${collection}-${index}`,
      data: row.data,
      revision: row.revision!,
      createdAt: row.createdAt!,
      updatedAt: row.updatedAt!,
      createdBy: row.createdBy!,
    }));
  }
  return out;
}

/**
 * Checks `fixtures/db.json` rows against the manifest `data`: `fixtures.db_unknown_collection`
 * for a collection the manifest does not declare, `fixtures.db_invalid` for a row `validateRow`
 * rejects (or a malformed / repeated `id`).
 */
export function dbFixtureIssues(schema: DataSchema | null | undefined, rows: Fixtures['db']): Issue[] {
  const issues: Issue[] = [];
  const file = 'fixtures/db.json';
  for (const [collection, list] of Object.entries(rows ?? {})) {
    const declared = schema && Object.prototype.hasOwnProperty.call(schema.collections, collection) ? schema.collections[collection] : undefined;
    if (!declared) {
      issues.push(
        issue('fixtures.db_unknown_collection', `${file}: "${collection}" is not a collection in olan-app.json "data"`, {
          file,
          hint: schema ? `Collections: ${Object.keys(schema.collections).join(', ')}.` : 'Declare it in olan-app.json "data.collections" (docs/database.md), or remove it.',
        }),
      );
      continue;
    }
    if (!Array.isArray(list)) {
      issues.push(issue('fixtures.db_invalid', `${file}: "${collection}" must be an array of rows`, { file, hint: 'Rows look like { "data": { … } } (docs/testing.md#fixtures).' }));
      continue;
    }
    const ids = new Set<string>();
    list.forEach((row, index) => {
      const where = `${collection}[${index}]`;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        issues.push(issue('fixtures.db_invalid', `${file}: ${where} must be an object with "data"`, { file }));
        return;
      }
      if (row.id !== undefined) {
        if (typeof row.id !== 'string' || row.id.length === 0) issues.push(issue('fixtures.db_invalid', `${file}: ${where}.id must be a non-empty string`, { file }));
        else if (ids.has(row.id)) issues.push(issue('fixtures.db_invalid', `${file}: ${where}.id ${JSON.stringify(row.id)} repeats`, { file }));
        else ids.add(row.id);
      }
      const checked = validateRow(declared, row.data);
      if (!checked.ok) {
        for (const problem of checked.issues) {
          issues.push(
            issue('fixtures.db_invalid', `${file}: ${where}.${problem.path}: ${problem.code} (${problem.message})`, {
              file,
              hint: 'Make the row match the collection in olan-app.json "data" (ref:* fields hold UUIDs, dates are YYYY-MM-DD).',
            }),
          );
        }
      }
    });
  }
  return issues;
}

/** Overlays fixture sets key by key (a later `projects` replaces an earlier one entirely). */
export function mergeFixtures(...sets: (Fixtures | undefined)[]): Fixtures {
  const out: Fixtures = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [key, value] of Object.entries(set)) {
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function readJson(path: string, display: string): unknown {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offset = /position (\d+)/.exec(message);
    const position = offset ? offsetToPosition(text, Number(offset[1])) : undefined;
    throw new CliError(issue('fixtures.invalid_json', `${display} is not valid JSON: ${message}`, { file: display, line: position?.line, column: position?.column }));
  }
}

function expectArray(value: unknown, display: string, what: string): unknown[] {
  if (!Array.isArray(value)) throw new CliError(issue('fixtures.invalid', `${display} ${what} must be an array`, { file: display }));
  return value;
}

function expectObject(value: unknown, display: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(issue('fixtures.invalid', `${display} must contain a JSON object`, { file: display }));
  }
  return value as Record<string, unknown>;
}

/**
 * Reads `fixtures/*.json` of a project: `projects.json`, `chat.json`, `settings.json`,
 * `storage.json`, `http.json`, `db.json`, `users.json` and (Phase 3) `calendar.json`
 * (`{ calendars, events }`), `contacts.json` (`{ addressBooks, contacts }`), `mail.json` and
 * `meetings.json`. Unknown files are ignored. Missing files leave the key unset, so
 * the built-in defaults apply.
 */
export function loadProjectFixtures(projectDir: string): Fixtures {
  const dir = join(projectDir, 'fixtures');
  if (!existsSync(dir)) return {};
  const fixtures: Fixtures = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const display = `fixtures/${name}`;
    const value = readJson(join(dir, name), display);
    switch (name) {
      case 'projects.json': {
        const list = Array.isArray(value) ? value : (expectObject(value, display).projects as unknown);
        if (!Array.isArray(list)) throw new CliError(issue('fixtures.invalid', `${display} must be an array of projects (or { "projects": [...] })`, { file: display }));
        fixtures.projects = list as FixtureProject[];
        break;
      }
      case 'chat.json': {
        const chat = expectObject(value, display);
        if (chat.conversations !== undefined) fixtures.conversations = chat.conversations as Fixtures['conversations'];
        if (chat.messages !== undefined) fixtures.messages = chat.messages as Fixtures['messages'];
        break;
      }
      case 'settings.json':
        fixtures.settings = expectObject(value, display) as Record<string, JsonValue>;
        break;
      case 'storage.json':
        fixtures.storage = expectObject(value, display) as Record<string, JsonValue>;
        break;
      case 'http.json':
        fixtures.http = expectObject(value, display) as Record<string, HttpFixture>;
        break;
      case 'db.json':
        fixtures.db = expectObject(value, display) as Record<string, FixtureDbRow[]>;
        break;
      case 'calendar.json': {
        const calendar = expectObject(value, display);
        if (calendar.calendars !== undefined) fixtures.calendars = expectArray(calendar.calendars, display, '"calendars"') as FixtureCalendar[];
        if (calendar.events !== undefined) fixtures.calendarEvents = expectArray(calendar.events, display, '"events"') as FixtureCalendarEvent[];
        break;
      }
      case 'contacts.json': {
        const contacts = expectObject(value, display);
        if (contacts.addressBooks !== undefined) fixtures.addressBooks = expectArray(contacts.addressBooks, display, '"addressBooks"') as FixtureAddressBook[];
        if (contacts.contacts !== undefined) fixtures.contacts = expectArray(contacts.contacts, display, '"contacts"') as FixtureContact[];
        break;
      }
      case 'mail.json':
        fixtures.mail = expectArray(Array.isArray(value) ? value : expectObject(value, display).messages, display, '(an array, or { "messages": [...] })') as FixtureMailMessage[];
        break;
      case 'meetings.json':
        fixtures.meetings = expectArray(Array.isArray(value) ? value : expectObject(value, display).meetings, display, '(an array, or { "meetings": [...] })') as FixtureMeeting[];
        break;
      case 'remote.json':
        fixtures.remote = expectObject(value, display) as Record<string, RemoteFixture>;
        break;
      case 'files.json': {
        const list = expectArray(Array.isArray(value) ? value : expectObject(value, display).files, display, '(an array, or { "files": [...] })');
        if (list.some((file) => typeof file !== 'object' || file === null || typeof (file as { name?: unknown }).name !== 'string')) {
          throw new CliError(issue('fixtures.invalid', `${display}: every file needs a "name"`, { file: display }));
        }
        fixtures.files = list as FixtureFile[];
        break;
      }
      case 'users.json': {
        const list = Array.isArray(value) ? value : (expectObject(value, display).users as unknown);
        const problems = userFixtureIssues(list);
        if (problems.length > 0) throw new CliError(problems);
        fixtures.users = list as FixtureUser[];
        break;
      }
      default:
        break;
    }
  }
  return fixtures;
}

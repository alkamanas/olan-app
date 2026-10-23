import type { JsonValue } from '../protocol';
import { getActiveSession } from '../runtime/session';
import { db } from './db';
import { onUploadProgress } from './host-events';
import { projectExtensions } from './project-extensions';
import { OlanError, rpc } from './rpc-client';
import type { AppCard } from '@olan-app/schema';

import type {
  ExternalFlowResult,
  FileHandle,
  FilePickOptions,
  RemoteRequestInit,
  RemoteResponse,
  UploadOptions,
  UploadTask,
  AddressBook,
  Calendar,
  CalendarEvent,
  CalendarEventsQuery,
  ConfirmOptions,
  Contact,
  CreateContactInput,
  CreateEventInput,
  CreateProjectInput,
  Conversation,
  CreateTaskInput,
  DeleteRecordInput,
  DatePickerOptions,
  DirectoryUser,
  HttpRequestInit,
  HttpResponse,
  MailMessage,
  Meeting,
  MenuItemOption,
  Message,
  PostCardInput,
  Project,
  ProjectConfig,
  ProjectConfigSetOptions,
  ProjectDetail,
  ProjectListResult,
  ProjectTask,
  ProjectTaskStatus,
  PromptOptions,
  ToastTone,
  UpdateContactInput,
  UpdateEventInput,
  UpdateTaskInput,
} from './types';

/**
 * The project the app is enabled in (Phase 6). An app shows its project surfaces (`project.widget`,
 * `project.tab`, `project.settings`) only in projects a member added it to ("Uygulamalar" on the
 * project page), and `olan.projects.*` on the person's behalf reaches only those projects; others
 * fail with `project_not_enabled`.
 */
const project = {
  config: {
    /**
     * The app's configuration of the project (e.g. which brand or account the project uses). No
     * permission needed; any member of the project may read it. `{}` with `revision: 0` until set.
     */
    get(projectId: string): Promise<ProjectConfig> {
      return rpc('project.config.get', { projectId });
    },
    /**
     * Replaces the configuration (a JSON object, at most 64 KiB). Members who may change the project
     * may set it; read-only members get `permission_denied`, archived projects `conflict`. With
     * `{ revision }` the write is refused with `conflict` when someone changed it meanwhile.
     */
    set(projectId: string, value: Record<string, JsonValue>, options: ProjectConfigSetOptions = {}): Promise<ProjectConfig> {
      return rpc('project.config.set', { projectId, value, ...(options.revision === undefined ? {} : { revision: options.revision }) });
    },
  },
  ...projectExtensions((method, params) => rpc(method, params as never)),
};

const projects = {
  /** Projects the user can see that the app is enabled in. Needs `projects:read`. */
  list(options: { limit?: number; cursor?: string } = {}): Promise<ProjectListResult> {
    return rpc('projects.list', options);
  },
  /** One project with members, lists and tasks. Needs `projects:read`. */
  get(projectId: string): Promise<ProjectDetail> {
    return rpc('projects.get', { projectId });
  },
  /** Tasks of a project, optionally by status. Needs `projects:read`. */
  tasks(projectId: string, options: { status?: ProjectTaskStatus } = {}): Promise<ProjectTask[]> {
    return rpc('projects.tasks', { projectId, ...options });
  },
  /** Changes a task's status, due date or assignee. Needs `tasks:write` (or the older `projects:write`). */
  updateTask(projectId: string, taskId: string, change: UpdateTaskInput): Promise<ProjectTask> {
    return rpc('projects.updateTask', { projectId, taskId, ...change });
  },
  /** Creates a task (in the project's default work package unless `listId` is given). Needs `tasks:write`. */
  createTask(projectId: string, task: CreateTaskInput): Promise<ProjectTask> {
    return rpc('projects.createTask', { projectId, ...task });
  },
  /** Deletes a task at its current `revision`. Needs `tasks:delete`. Protected tasks fail with `forbidden_record`. */
  deleteTask(projectId: string, taskId: string, options: DeleteRecordInput): Promise<void> {
    return rpc('projects.deleteTask', { projectId, taskId, revision: options?.revision }).then(() => undefined);
  },
  /**
   * Removes (archives) an empty work package at its current `revision`. Needs `projects:delete`.
   * The default work package and non-empty ones fail with `forbidden_record`.
   */
  deleteList(projectId: string, listId: string, options: DeleteRecordInput): Promise<void> {
    return rpc('projects.deleteList', { projectId, listId, revision: options?.revision }).then(() => undefined);
  },
  /**
   * Creates a project on behalf of the person (with its own chat, calendar and default work package).
   * Needs `projects:create`; the project remembers that this app created it.
   */
  create(input: CreateProjectInput): Promise<Project> {
    return rpc('projects.create', input);
  },
  /**
   * Removes (archives) a project. Needs `projects:archive`; only projects this app created, others fail
   * with `forbidden_record` (`not_created_by_app`).
   */
  archive(projectId: string): Promise<void> {
    return rpc('projects.archive', { projectId }).then(() => undefined);
  },
};

/** Most ids per `users.get` call; `olan.users.get` splits longer lists. */
const USERS_PER_CALL = 100;

const users = {
  /**
   * Directory entries of these people (name, email, title, department, team), in the order the
   * host returns them. Unknown or inaccessible ids are left out. Duplicate ids are asked once;
   * lists longer than 100 are split into several calls. Needs `users:read`. The current user's
   * id needs no permission: `useUser().id`.
   */
  async get(ids: readonly string[]): Promise<DirectoryUser[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const batches: string[][] = [];
    for (let start = 0; start < unique.length; start += USERS_PER_CALL) batches.push(unique.slice(start, start + USERS_PER_CALL));
    const results = await Promise.all(batches.map((batch) => rpc('users.get', { ids: batch })));
    return results.flatMap((result) => result.users);
  },
};

const chat = {
  /** Conversations the user is in. Needs `chat:read`. */
  conversations(): Promise<Conversation[]> {
    return rpc('chat.conversations', {});
  },
  /** Latest messages of a conversation. Needs `chat:read`. */
  messages(conversationId: string, options: { limit?: number } = {}): Promise<Message[]> {
    return rpc('chat.messages', { conversationId, ...options });
  },
  /**
   * Posts a static card as the app (`chat.card`, docs/cards.md) to a conversation the person is in.
   * Needs `chat:write`. Invalid cards fail with `validation_failed`.
   */
  postCard(input: PostCardInput): Promise<{ messageId: string }> {
    return rpc('chat.postCard', input);
  },
  /** Replaces the card of a message this installation posted. Needs `chat:write`. */
  updateCard(messageId: string, card: AppCard): Promise<{ messageId: string }> {
    return rpc('chat.updateCard', { messageId, card });
  },
};

/** The person's calendars (Phase 3 §7). Apps never send invitations. */
const calendar = {
  /** Calendars with `isDefault` and `mayWrite`. Needs `calendar:read`. */
  calendars(): Promise<Calendar[]> {
    return rpc('calendar.calendars', {}).then((result) => result.calendars);
  },
  /** Events between `from` and `to` (≤ 366 days, ≤ 200 events). Needs `calendar:read`. */
  events(query: CalendarEventsQuery): Promise<CalendarEvent[]> {
    return rpc('calendar.events', query).then((result) => result.events);
  },
  /** Creates an event (default calendar unless `calendarId`). Needs `calendar:write`. */
  createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    return rpc('calendar.createEvent', input);
  },
  /**
   * Changes an event the person organizes. Needs `calendar:write`. Olan meetings and project
   * calendar events fail with `forbidden_record` (`system_record`), invitations with `not_organizer`.
   */
  updateEvent(eventId: string, patch: UpdateEventInput): Promise<CalendarEvent> {
    return rpc('calendar.updateEvent', { eventId, patch });
  },
  /** Deletes an event (same protections as `updateEvent`; audited). Needs `calendar:delete`. */
  deleteEvent(eventId: string): Promise<void> {
    return rpc('calendar.deleteEvent', { eventId }).then(() => undefined);
  },
};

/** The person's address books (Phase 3 §7). */
const contacts = {
  /** Address books (`shared` ones are read-only). Needs `contacts:read`. */
  addressBooks(): Promise<AddressBook[]> {
    return rpc('contacts.addressBooks', {}).then((result) => result.addressBooks);
  },
  /** Contacts whose name, email or organization matches (≤ 50). Needs `contacts:read`. */
  search(query: string, options: { limit?: number } = {}): Promise<Contact[]> {
    return rpc('contacts.search', { query, ...options }).then((result) => result.contacts);
  },
  /** Creates a contact (default address book unless `addressBookId`). Needs `contacts:write`. */
  create(input: CreateContactInput): Promise<Contact> {
    return rpc('contacts.create', input);
  },
  /** Changes a contact in one of the person's own address books. Needs `contacts:write`. */
  update(contactId: string, patch: UpdateContactInput): Promise<Contact> {
    return rpc('contacts.update', { contactId, patch });
  },
  /** Deletes a contact (shared address books fail with `forbidden_record`; audited). Needs `contacts:delete`. */
  delete(contactId: string): Promise<void> {
    return rpc('contacts.delete', { contactId }).then(() => undefined);
  },
};

const mail = {
  /**
   * The full message the `mail.sidebar` / `mail.action` surface was opened on (`useSurfaceParams().messageId`).
   * Needs `mail:read`; any other message fails with `permission_denied`.
   */
  getMessage(messageId: string): Promise<MailMessage> {
    return rpc('mail.getMessage', { messageId });
  },
};

const meetings = {
  /** A meeting the person can see, with participants. Needs `meetings:read`. */
  get(meetingId: string): Promise<Meeting> {
    return rpc('meetings.get', { meetingId });
  },
};

/** The app's own backend code (manifest `server`, Phase 3 §8, §15; docs/backend.md). */
const backend = {
  /**
   * Runs `functions[name]` of the app's backend (`defineBackend`) with the person's consented
   * permissions and resolves with its JSON result. No permission needed; the manifest must declare
   * `server`. Fails with `OlanError` codes: `backend_function_not_found` (no `functions[name]`, or a trigger's fallback function),
   * `backend_error` (the function threw; `message` is its error), `backend_limit` (CPU, time or
   * memory limit), `backend_busy` (too many calls at once), `payload_too_large` (args or result
   * over 256 KiB), `backend_unavailable` (no `server`, or backends are turned off on this server).
   */
  call<T = JsonValue>(name: string, args: JsonValue = null): Promise<T> {
    return rpc('backend.call', { name, args }) as Promise<T>;
  },
};

const storage = {
  /** The stored value, or `null`. Needs `storage` (per app installation and user). */
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | null> {
    return rpc('storage.get', { key }) as Promise<T | null>;
  },
  set(key: string, value: JsonValue): Promise<void> {
    return rpc('storage.set', { key, value }).then(() => undefined);
  },
  remove(key: string): Promise<void> {
    return rpc('storage.remove', { key }).then(() => undefined);
  },
  keys(): Promise<string[]> {
    return rpc('storage.keys', {});
  },
};

const settings = {
  /** The app's own settings (manifest `settings`); no permission needed. */
  get(): Promise<Record<string, JsonValue>> {
    return rpc('settings.get', {});
  },
};

const http = {
  /**
   * A request through the host. Only hosts granted as `http:<host>` permissions are reachable;
   * others fail with `http_blocked`. The sandbox itself has no network access.
   */
  async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const response = await rpc('http.fetch', { url, ...init });
    return {
      ...response,
      json<T = JsonValue>(): T {
        try {
          return JSON.parse(response.body) as T;
        } catch {
          throw new OlanError('invalid_params', 'The response body is not JSON');
        }
      },
    };
  },
};

/** Platform interactions: each opens the platform's own control (native dialog, menu, picker). */
const ui = {
  confirm(options: ConfirmOptions): Promise<boolean> {
    return rpc('ui.confirm', options);
  },
  prompt(options: PromptOptions): Promise<string | null> {
    return rpc('ui.prompt', options);
  },
  toast(options: { text: string; tone?: ToastTone }): Promise<void> {
    return rpc('ui.toast', options).then(() => undefined);
  },
  menu(options: { items: MenuItemOption[] }): Promise<string | null> {
    return rpc('ui.menu', options);
  },
  datePicker(options: DatePickerOptions = {}): Promise<string | null> {
    return rpc('ui.datePicker', options);
  },
  share(options: { text: string; url?: string }): Promise<void> {
    return rpc('ui.share', options).then(() => undefined);
  },
  /** Opens an `https:` address in the platform browser (a new tab on the web). No permission. */
  openUrl(url: string): Promise<void> {
    return rpc('ui.openUrl', { url }).then(() => undefined);
  },
  /**
   * Opens an external flow (sign-in, account connection) in the system browser
   * (`ASWebAuthenticationSession` on iOS, Custom Tabs on Android, a new tab on the web). With
   * `expectReturn` it resolves when the flow comes back to `https://<Olan web>/apps/return/<installationId>?…`
   * with those query parameters; `{ returned: false }` when the person closes it or after 30 minutes.
   * Check `params.state` with your server.
   */
  openExternal(url: string, options: { expectReturn?: boolean } = {}): Promise<ExternalFlowResult> {
    return rpc('ui.openExternal', { url, ...(options.expectReturn !== undefined ? { expectReturn: options.expectReturn } : {}) });
  },
};

/**
 * The app's own server (manifest `remote` with `"requests": true`, Phase 5a §1). Olan signs each
 * request and posts it to `{remote.url}/requests` with the person's identity (`profile:read` adds
 * their name, email and role) and a 300 s token; the sandbox never sees a token.
 */
const remote = {
  /**
   * Resolves with `{ status, headers, body }` for answers 200–399. Rejects with `RemoteError`:
   * `remote_rejected` (4xx; `details` is the server's body), `remote_unavailable` (5xx, timeout,
   * unreachable), `consent_required`, `payload_too_large` (body over 1 MiB), `rate_limited`.
   */
  request(init: RemoteRequestInit): Promise<RemoteResponse> {
    return rpc('remote.request', init);
  },
};

let uploadCounter = 0;

/** Picked files and their direct uploads (Phase 5a §3). Needs `files:pick`. */
const files = {
  /** Opens the platform's file or photo picker; `[]` when the person cancels. Files over `maxBytes` are left out. */
  pick(options: FilePickOptions = {}): Promise<FileHandle[]> {
    return rpc('files.pick', options);
  },
  /**
   * Uploads a picked file straight to `options.url` (the app server's origin or an `http:<host>`),
   * not through Olan. PUT sends the raw bytes, POST `multipart/form-data` with the file in
   * `formField` (default `file`); both send the name in `x-olan-file-name` (URL-encoded). Resolves
   * with every HTTP status; rejects with `cancelled`, `upload_failed` or `http_blocked`.
   */
  upload(file: FileHandle | string, options: UploadOptions): UploadTask {
    uploadCounter += 1;
    const uploadId = `upl_${uploadCounter.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const fileId = typeof file === 'string' ? file : file.id;
    const { onProgress, ...rest } = options;
    const stop = onProgress ? onUploadProgress(uploadId, onProgress) : () => undefined;
    const promise = rpc('files.upload', { uploadId, fileId, ...rest }).finally(stop);
    return Object.assign(promise, {
      uploadId,
      cancel: () => rpc('files.cancel', { uploadId }).then(() => undefined),
    });
  },
  /** Stops a running upload by id (`UploadTask.uploadId`); unknown or finished ids are ignored. */
  cancel(uploadId: string): Promise<void> {
    return rpc('files.cancel', { uploadId }).then(() => undefined);
  },
};

function requireSession() {
  const session = getActiveSession();
  if (!session) throw new OlanError('host_error', 'olan.navigation was used before the app runtime started');
  return session;
}

/**
 * Screen navigation inside a surface. The stack lives in the sandbox (`useNavigation()` reads
 * it); the host is told so it can show its own title bar and back control.
 */
const navigation = {
  push(screen: string, params: JsonValue = null): Promise<void> {
    requireSession().push({ screen, params });
    return rpc('navigation.push', { screen, params }).then(() => undefined);
  },
  pop(): Promise<void> {
    // On the first screen the stack stays; the host is still told, so it can close a modal (Phase 3 §3.1).
    requireSession().pop();
    return rpc('navigation.pop', {}).then(() => undefined);
  },
  replace(screen: string, params: JsonValue = null): Promise<void> {
    requireSession().replace({ screen, params });
    return rpc('navigation.replace', { screen, params }).then(() => undefined);
  },
};

export const olan = Object.freeze({ project, projects, users, chat, calendar, contacts, mail, meetings, storage, db, settings, http, ui, navigation, backend, remote, files });
export type Olan = typeof olan;

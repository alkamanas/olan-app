# `olan.*` API

```ts
import { olan, OlanError, RemoteError, isRemoteError } from '@olan-app/sdk';
```

Every call is asynchronous: the sandbox sends it to Olan, Olan checks the permission and answers.
A failed call rejects with an `OlanError` whose `code` is one of `permission_denied`,
`not_installed`, `invalid_params`, `unknown_method`, `host_error`, `http_blocked`, `cancelled`,
`validation_failed`, `conflict`, `not_found`, `forbidden_record`, `quota_exceeded`, `project_not_enabled`
(SDK 1.6: the call names a project the app was not added to); `olan.remote.request`
rejects with a `RemoteError` (`remote_rejected`, `remote_unavailable`, `consent_required`, `rate_limited`, …),
uploads also with `upload_failed` (errors.md). Call `olan.*` from event handlers, effects or `useQuery` — not during render.

| Call | Returns | Permission |
|---|---|---|
| `olan.projects.list({ limit?, cursor? })` | `{ items: Project[]; nextCursor?: string }` (projects the app is enabled in) | `projects:read` |
| `olan.projects.get(projectId)` | `ProjectDetail` | `projects:read` |
| `olan.projects.tasks(projectId, { status? })` | `ProjectTask[]` | `projects:read` |
| `olan.projects.updateTask(projectId, taskId, { status?, due?, assigneeId?, revision })` | `ProjectTask` | `tasks:write` (or the older `projects:write`) |
| `olan.projects.createTask(projectId, { title, listId?, description?, status?, due?, allDay?, assigneeId?, priority? })` | `ProjectTask` | `tasks:write` |
| `olan.projects.deleteTask(projectId, taskId, { revision })` | `void` | `tasks:delete` |
| `olan.projects.deleteList(projectId, listId, { revision })` | `void` | `projects:delete` |
| `olan.users.get(ids)` | `DirectoryUser[]` | `users:read` |
| `olan.chat.conversations()` | `Conversation[]` | `chat:read` |
| `olan.chat.messages(conversationId, { limit? })` | `Message[]` | `chat:read` |
| `olan.storage.get<T>(key)` | `T \| null` | `storage` |
| `olan.storage.set(key, value)` | `void` | `storage` |
| `olan.storage.remove(key)` | `void` | `storage` |
| `olan.storage.keys()` | `string[]` | `storage` |
| `olan.db.collection<T>(name)` → `insert(data)`, `get(id)`, `query({ where?, orderBy?, limit?, cursor? })`, `update(id, patch, { revision })`, `delete(id, { revision? })`, `count(where?)` | `DbRow<T>`, `DbRow<T> \| null`, `{ rows, nextCursor }`, `DbRow<T>`, `void`, `number` | `db` (database.md) |
| `olan.settings.get()` | `Record<string, JsonValue>` | none |
| `olan.project.config.get(projectId)` | `ProjectConfig` (SDK 1.6) | none; the app is enabled in the project |
| `olan.project.config.set(projectId, value, { revision? })` | `ProjectConfig` | none; members who may change the project |
| `olan.project.statuses.list(projectId)` | `ProjectStatus[]` (SDK 1.7) | `projects:read` |
| `olan.project.statuses.define(projectId, statuses)` | the app's `ProjectStatus[]` | `projects:extend` |
| `olan.project.statuses.remove(projectId, key, { replacementKey? })` | `{ movedTasks }` | `projects:extend` |
| `olan.project.labels.list(projectId)` | `ProjectLabel[]` | `projects:read` |
| `olan.project.labels.define(projectId, labels)` | the app's `ProjectLabel[]` | `projects:extend` |
| `olan.project.labels.remove(projectId, key)` | `void` | `projects:extend` |
| `olan.project.fields.list(projectId)` | `ProjectField[]` (SDK 1.8) | `projects:read` |
| `olan.project.fields.define(projectId, fields)` | the app's `ProjectField[]` | `projects:extend` |
| `olan.project.fields.remove(projectId, key)` | `void` | `projects:extend` |
| `olan.project.fields.values(projectId, target)` | `{ target, values }` | `projects:read` |
| `olan.project.fields.setValues(projectId, target, values)` | `{ target, values }` | `tasks:write` |
| `olan.project.links.list(projectId, target?)` | `RecordLink[]` | `projects:read` |
| `olan.project.links.upsert(projectId, { target, externalId, card })` | `RecordLink` | `tasks:write` |
| `olan.project.links.remove(projectId, linkId)` | `void` | `tasks:write` |
| `olan.project.links.setStatus(projectId, linkId, input)` | `{ target, status?, statusId?, statusKey?, state? }` | `tasks:write` (or `projects:write`) |
| `olan.project.calendar.list(projectId, { from?, to? })` | `ProjectCalendarItem[]` | `projects:read` |
| `olan.project.calendar.upsert(projectId, item)` | `ProjectCalendarItem` | `projects:extend` |
| `olan.project.calendar.remove(projectId, externalId)` | `void` | `projects:extend` |
| `olan.project.activity.post(projectId, text, { target? })` | `void` | `projects:extend` |
| `olan.project.approvals.list(projectId, { state? })` | `ProjectApproval[]` | `projects:read` |
| `olan.project.approvals.request(projectId, input)` | `ProjectApproval` | `projects:extend` |
| `olan.project.approvals.cancel(projectId, approvalId)` | `ProjectApproval` | `projects:extend` |
| `olan.http.fetch(url, { method?, headers?, body? })` | `HttpResponse` | `http:<host of url>` |
| `olan.ui.confirm({ title, message?, confirmLabel?, cancelLabel?, destructive? })` | `boolean` | none |
| `olan.ui.prompt({ title, message?, placeholder?, defaultValue? })` | `string \| null` | none |
| `olan.ui.toast({ text, tone? })` | `void` | none |
| `olan.ui.menu({ items })` | chosen `key` or `null` | none |
| `olan.ui.datePicker({ value?, mode? })` | ISO string or `null` | none |
| `olan.ui.share({ text, url? })` | `void` | none |
| `olan.navigation.push(screen, params?)` | `void` | none |
| `olan.navigation.pop()` | `void` | none |
| `olan.navigation.replace(screen, params?)` | `void` | none |
| `olan.projects.create({ title, description? })` | `Project` | `projects:create` |
| `olan.projects.archive(projectId)` | `void` | `projects:archive` |
| `olan.chat.postCard({ conversationId, card, threadRootId? })` | `{ messageId }` | `chat:write` |
| `olan.chat.updateCard(messageId, card)` | `{ messageId }` | `chat:write` |
| `olan.calendar.calendars()` | `Calendar[]` | `calendar:read` |
| `olan.calendar.events({ from, to, calendarId?, limit? })` | `CalendarEvent[]` | `calendar:read` |
| `olan.calendar.createEvent({ title, start, end?, duration?, calendarId?, timeZone?, isAllDay?, location?, description? })` | `CalendarEvent` | `calendar:write` |
| `olan.calendar.updateEvent(eventId, patch)` | `CalendarEvent` | `calendar:write` |
| `olan.calendar.deleteEvent(eventId)` | `void` | `calendar:delete` |
| `olan.contacts.addressBooks()` | `AddressBook[]` | `contacts:read` |
| `olan.contacts.search(query, { limit? })` | `Contact[]` | `contacts:read` |
| `olan.contacts.create({ name, addressBookId?, emails?, phones?, organization?, title?, note? })` | `Contact` | `contacts:write` |
| `olan.contacts.update(contactId, patch)` | `Contact` | `contacts:write` |
| `olan.contacts.delete(contactId)` | `void` | `contacts:delete` |
| `olan.mail.getMessage(messageId)` | `MailMessage` | `mail:read` (only the email the surface was opened on) |
| `olan.meetings.get(meetingId)` | `Meeting` | `meetings:read` |
| `olan.backend.call<T>(name, args?)` | `T` (the function's JSON result) | none; the manifest declares `server` (backend.md) |
| `olan.remote.request({ method, path, query?, headers?, body?, timeoutMs? })` | `{ status, headers, body }` | none (implied `remote`); the manifest declares `remote.requests` (remote-requests.md) |
| `olan.files.pick({ accept?, multiple?, maxFiles?, maxBytes? })` | `FileHandle[]` | `files:pick` (files.md) |
| `olan.files.upload(file, { url, method?, headers?, formField?, fields?, onProgress? })` | `UploadTask`: a promise of `{ status, headers, body }` with `uploadId` and `cancel()` | `files:pick` |
| `olan.files.cancel(uploadId)` | `void` | `files:pick` |
| `olan.ui.openUrl(url)` | `void` | none (links.md) |
| `olan.ui.openExternal(url, { expectReturn? })` | `{ returned: true, params } \| { returned: false }` | none (links.md) |

## olan.projects

**Enabled projects (SDK 1.6, Olan Apps phase 6).** A project stays generic until a member adds an
app to it (project page → Uygulamalar). On the person's behalf an installed app reaches only those
projects: `list` leaves the others out, and every call naming one fails with `project_not_enabled`.
The project surfaces (`project.widget`, `project.tab`, `project.settings`) show only there too.
Projects the app creates (`projects.create`) have it enabled. Studio previews without an
installation keep the person's own reach.

```ts
const { items, nextCursor } = await olan.projects.list({ limit: 50 });     // limit default 50
const detail = await olan.projects.get('p0');                              // { project, members, lists, tasks }
const open = await olan.projects.tasks('p0', { status: 'needs-action' });
const updated = await olan.projects.updateTask('p0', task.id, { status: 'completed', revision: task.revision });
const created = await olan.projects.createTask('p0', { title: 'Follow up', due: '2026-10-20' });
await olan.projects.deleteTask('p0', created.id, { revision: created.revision });
await olan.projects.deleteList('p0', list.id, { revision: list.revision });   // empty, non-default work packages only
```

- Pass `cursor: nextCursor` to get the next page; `nextCursor` is absent on the last page.
- `updateTask` needs the task's current `revision` (optimistic concurrency). If the task changed in
  the meantime the call fails with `conflict` (`invalid_params` on Olan servers before 1b); reload
  the task and retry. The result is the updated task (with a new `revision`). Only `status`, `due`
  (ISO date or `null`) and `assigneeId` (user id or `null`) can be changed. New apps request
  `tasks:write`; `projects:write` keeps working for `updateTask` only.
- `createTask` puts the task in `listId`, or else in the project's default work package
  (`lists[].isDefault`). The task's `createdByApp` is your app id. Needs `tasks:write`.
- `deleteTask` needs the task's current `revision` and `tasks:delete`. Every deletion is written
  to the organization's audit log. Tasks with a delivery/approval workflow, and (when the admin
  turned on "only records the app created") tasks the app did not create, fail with
  `forbidden_record`.
- `deleteList` removes (archives) an **empty** work package: no live tasks or sub-packages. The
  project's default work package is never removed. Both fail with `forbidden_record`. Needs
  `projects:delete`. Apps cannot change or delete projects, nor create work packages; creating
  and archiving projects is `projects.create` / `projects.archive` (below).
- Protected records: projects, the default work package, task statuses and fields (fixed by
  Olan), project chats and calendars, members, accounts. Show a toast such as "Bu kayıt korunuyor"
  on `forbidden_record`.

Types (all exported from `@olan-app/sdk`):

```ts
type ProjectTaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';

interface Project {
  id: string; name: string; description: string; timeZone: string; archived: boolean;
  revision: number; role: ProjectRole; createdAt: string; updatedAt: string;
  lastActivityAt?: string; taskKeyPrefix?: string;
}
interface ProjectTask {
  id: string; projectId: string; listId: string; key?: string; number?: number;
  title: string; description: string; status: ProjectTaskStatus; assigneeId: string | null;
  createdBy: string; start?: string | null; due: string | null; allDay: boolean;
  revision: number; updatedAt?: string;
  createdByApp?: string | null;      // app id when an app created it
}
interface ProjectDetail { project: Project; members: ProjectMember[]; lists: ProjectTaskList[]; tasks: ProjectTask[] }
interface ProjectMember { userId: string; displayName: string; role: ProjectRole }
interface ProjectTaskList { id: string; name: string; isDefault: boolean; revision: number; parentId: string | null }
type ProjectRole = 'owner' | 'manager' | 'member' | 'guest' | string;
interface UpdateTaskInput { status?: ProjectTaskStatus; due?: string | null; assigneeId?: string | null; revision: number }
interface CreateTaskInput { title: string; listId?: string; description?: string; status?: ProjectTaskStatus; due?: string | null; allDay?: boolean; assigneeId?: string | null; priority?: number }
```

`due` is an ISO date (`2026-10-16`) or date-time, or `null`. Compare dates as strings of the same
length (`task.due.slice(0, 10) < today`) or with `Date`.

## olan.project.config

The app's own configuration of one project (SDK 1.6), kept per installation and project: which
brand, account or pipeline the project uses, the app's choices for it. No permission is needed; the
app must be enabled in the project (else `project_not_enabled`). Any member reads it; members who
may change the project set it (read-only members get `permission_denied`, archived projects
`conflict`). The value is a JSON object of at most 64 KiB (`payload_too_large`).

```ts
const config = await olan.project.config.get(projectId);
// { projectId, value: { brandId: 'b1' }, revision: 3, updatedBy: '<user id>', updatedAt: '2026-10-22T09:00:00Z' }
// Before the first set: { value: {}, revision: 0, updatedBy: null, updatedAt: null }
await olan.project.config.set(projectId, { ...config.value, brandId: 'b2' }, { revision: config.revision });
```

- `set` replaces the whole value. With `{ revision }` it is refused with `conflict` when someone
  changed it meanwhile (`revision: 0`: only if nothing is stored yet); without it the write wins.
- The configuration stays when the app is removed from the project, and answers again once a member
  adds it back. It goes with the installation (uninstall) or the project.
- The app's server reads and writes it too: `GET`/`PUT /api/v2/apps/installations/:id/projects/:projectId/config`
  with the app's own token (server.md), and backend code with the same `olan.project.config`.
- In React, `useProjectConfig(projectId?)` (hooks.md) loads it and saves on the loaded revision.

```ts
interface ProjectConfig {
  projectId: string;
  value: Record<string, JsonValue>;
  revision: number;                 // 0 until the first set
  updatedBy: string | null;         // a user id, or 'app:<installationId>' (the app's server)
  updatedAt: string | null;
}
```

## olan.project: records, statuses, calendar, feed, approvals

SDK 1.7 (Olan Apps phase 6): what the app adds to the projects it is enabled in — the same calls in
the UI and in backend code; the app's server uses the routes under
`/api/v2/apps/installations/:id/projects/:projectId/` (`links`, `statuses`, `labels`, `fields`,
`field-values`, `calendar`, `activity`, `approvals`) with its own token. Projects without the app fail with
`project_not_enabled`; archived projects refuse changes with `conflict`.

**Record links.** One of the app's records (`externalId`, the app's own id) attached to a task or an
issue, with a card the app draws on it. The card is a chat card (cards.md) whose buttons only
`{ kind: 'open', payload? }`: they open the app's `record.card` surface (surfaces.md). Any other
button fails with `validation_failed` (`invalid_card`). The same `externalId` on the same target
replaces the card; an app links at most 10 records to one task or issue (`quota_exceeded`).

```ts
const link = await olan.project.links.upsert(projectId, {
  target: { kind: 'task', id: task.id },
  externalId: 'SAT-12',
  card: { version: 1, root: 1, fallbackText: 'SAT-12 · Toplantı masası', nodes: [
    { id: 1, type: 'Card', props: { title: 'Toplantı masası', subtitle: 'SAT-12' }, children: [2] },
    { id: 2, type: 'Button', props: { label: 'Kaydı aç', action: { kind: 'open', payload: { id: 'SAT-12' } } }, children: [] },
  ] },
});
await olan.project.links.setStatus(projectId, link.id, { statusKey: 'awaiting-approval' }); // a task
await olan.project.links.setStatus(projectId, issueLink.id, { state: 'closed', stateReason: 'completed' }); // an issue
const onTask = await olan.project.links.list(projectId, { kind: 'task', id: task.id });
```

`setStatus` moves a linked task by `statusKey` (a key of the project's statuses: the defaults
`todo`, `in_progress`, `done`, `cancelled` or one the app defined), `statusId`, or the CalDAV
`status` (its first status of that kind); a linked issue opens or closes with `state`. The change is
an ordinary edit of the person the app acts for: the project feed shows it under the app and other
apps hear `project.task.updated` / `project.task.completed`. Members may take a link off
(the card disappears); a link of an app removed from the project stays read-only.

**Statuses and labels.** The app defines its own by stable keys (`^[a-z0-9][a-z0-9._-]{0,62}$`,
≤ 20 per call); `define` adds or updates and returns all of the app's. Members put them on tasks
but cannot rename, recolour or remove them. A key or a name the project already uses is `conflict`;
a status keeps its category. Removing a status moves its tasks to `replacementKey` (a status of the
same kind) or the first status of its kind; the last status of a required kind cannot go (`conflict`).

```ts
await olan.project.statuses.define(projectId, [{ key: 'awaiting-approval', name: 'Onay bekliyor', category: 'started' }]);
await olan.project.labels.define(projectId, [{ key: 'hardware', name: 'Donanım', groupName: 'Tür' }]);
```

**Custom fields** (needs `"sdk": "^1.8.0"`). The project's own fields and the app's, defined by stable keys like
statuses (≤ 20 per call, ≤ 50 fields per project); `define` returns all of the app's. Members fill them in on tasks
and issues (`appliesTo`, default tasks) but cannot change or remove them; a taken key or name is `conflict`, the
`type` is fixed (`invalid_params`). Options keep their `id` (a new one gets a slug of its name); removing an option
or the field clears its values. Values are keyed by field key (the project's own fields: by id): text, url, date
(`YYYY-MM-DD`), select option id and person (a member's user id) are strings, then numbers, `boolean` checkboxes and
lists of option ids. `setValues` changes the fields it names; `null` clears one (not a `required` one:
`invalid_params`); an app's field removed with its app from the project is read-only (`conflict`).

```ts
await olan.project.fields.define(projectId, [{ key: 'channel', name: 'Kanal', type: 'select', options: [{ id: 'ig', name: 'Instagram' }], showOnCard: true }]);
await olan.project.fields.setValues(projectId, { kind: 'task', id: task.id }, { channel: 'ig' });
const { values } = await olan.project.fields.values(projectId, { kind: 'task', id: task.id });   // { channel: 'ig', … }
```

**Calendar layer and feed lines.** Calendar items (one per `externalId`, ≤ 500 per project; all-day
items take dates) show in the project calendar while the app is enabled in the project; `linkId`
makes the item open its record. `list` takes a range of at most 366 days. `activity.post` writes a
line (1–280 characters) in the project feed under the app, optionally about a task or issue.

```ts
await olan.project.calendar.upsert(projectId, { externalId: 'SAT-12', title: 'Teslim: Toplantı masası', start: '2026-11-05', allDay: true, linkId: link.id });
await olan.project.activity.post(projectId, 'SAT-12 bağlandı, onay bekliyor', { target: { kind: 'task', id: task.id } });
```

**Approvals.** `request` asks 1–10 project members who may change the project; they find it in
their approval box (with the record card, if given). `mode: 'all'` (default): every approver
approves, one rejection rejects; `'any'`: the first decision decides. The app hears the outcome as
`project.approval.decided` (server.md#events) and can `cancel` a pending request (`conflict` once
decided).

```ts
const approval = await olan.project.approvals.request(projectId, { title: 'SAT-12 onayı', approverIds: [managerId], mode: 'any', linkId: link.id, card: link.card });
const pending = await olan.project.approvals.list(projectId, { state: 'pending' });   // newest first
```

```ts
type ProjectStatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
interface ProjectStatus { id: string; projectId: string; name: string; color: string; category: ProjectStatusCategory; position: number; key: string | null; createdByApp: string | null; appInstallationId: string | null; revision: number }
interface ProjectLabel { id: string; projectId: string; name: string; color: string; groupName: string | null; description: string; position: number; key: string | null; createdByApp: string | null; appInstallationId: string | null; revision: number }
type ProjectFieldType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'person' | 'url' | 'checkbox';
type ProjectFieldValue = string | number | boolean | string[];
interface ProjectField { id: string; projectId: string; name: string; description: string; type: ProjectFieldType; position: number; options: { id: string; name: string; color: string }[]; required: boolean; appliesTo: ('task' | 'issue')[]; showOnCard: boolean; key: string | null; createdByApp: string | null; appInstallationId: string | null; appName?: string | null; readOnly?: boolean; revision: number }
interface ProjectFieldDefinition { key: string; name: string; type: ProjectFieldType; description?: string; options?: { id?: string; name: string; color?: string }[]; required?: boolean; appliesTo?: ('task' | 'issue')[]; showOnCard?: boolean; position?: number }
interface ProjectFieldValues { target: RecordTarget; values: Record<string, ProjectFieldValue> }
type RecordTarget = { kind: 'task' | 'issue'; id: string };
// RecordLink, ProjectCalendarItem and ProjectApproval also carry the app: installationId, appId, name, active.
interface RecordLink { id: string; projectId: string; target: RecordTarget; externalId: string; title: string; card: AppCard; createdBy: string | null; updatedBy: string | null; revision: number; createdAt: string; updatedAt: string }
interface ProjectCalendarItem { id: string; projectId: string; externalId: string; title: string; start: string; end: string; allDay: boolean; color: string | null; linkId: string | null; target: RecordTarget | null; updatedAt: string }
interface ProjectApproval { id: string; projectId: string; projectName: string; externalId: string | null; linkId: string | null; target: RecordTarget | null; title: string; card: AppCard | null; approvers: string[]; mode: 'all' | 'any'; state: 'pending' | 'approved' | 'rejected' | 'cancelled'; dueAt: string | null; requestedBy: string | null; decisions: { userId: string; decision: 'approve' | 'reject'; note: string; decidedAt: string }[]; createdAt: string; decidedAt: string | null }
```

## olan.users

```ts
const people = await olan.users.get([task.assigneeId, row.createdBy]);   // DirectoryUser[]
```

`DirectoryUser`: `{ id, displayName, email, title?, department?, team?, avatarUrl? }`. Ids are the
central Olan user ids (`useUser().id`, `createdBy`, `assigneeId`, `member.userId`). Unknown ids and
people outside the organization are left out; duplicates are asked once and lists over 100 are
split into several calls. The current user's id needs no permission (`useUser()`); their name
does. `users:read` is all it needs: no other permission is required alongside it. In components
use `useUsers(ids)` (hooks.md).

There is **no lookup by email or name** (no directory search). To relate an email address (e.g. a
`mail.sidebar` sender) to Olan people or tasks, collect the ids you already have (`member.userId`
of `olan.projects.get`, `task.assigneeId`, `createdBy`), call `olan.users.get(ids)` and compare
`user.email.toLowerCase()` with the address; for people outside the organization use
`olan.contacts.search(email)`.

## olan.chat

```ts
const conversations = await olan.chat.conversations();
const messages = await olan.chat.messages(conversations[0].id, { limit: 20 }); // the latest messages (limit default 50)
```

```ts
interface Conversation { id: string; kind: 'direct' | 'group'; title: string | null; projectId?: string | null; createdAt: string; updatedAt: string; unreadCount?: number }
interface Message { id: string; conversationId: string; sender: { id: string; displayName: string }; body: string | null; replyToId: string | null; createdAt: string; editedAt: string | null; deletedAt: string | null }
```

Apps cannot send messages. With `chat:write` they post **cards** as the app:
`olan.chat.postCard({ conversationId, card })` and `olan.chat.updateCard(messageId, card)` (cards.md).

## olan.projects.create / archive

```ts
const project = await olan.projects.create({ title: 'Standup', description: 'Günlük' });   // projects:create
await olan.projects.archive(project.id);                                                  // projects:archive
```

`create` opens the project with its own chat, calendar and default work package, on behalf of the
person; `project.createdByApp` is your app id. `archive` removes (archives) only projects your app
created (others: `forbidden_record`, reason `not_created_by_app`); an archived one answers `conflict`.

## olan.calendar

```ts
const calendars = await olan.calendar.calendars();     // [{ id, name, color, isDefault, mayWrite }]
const events = await olan.calendar.events({ from: '2026-10-19', to: '2026-10-26' });   // ≤ 366 days, limit ≤ 200
const event = await olan.calendar.createEvent({ title: 'Standup notu', start: '2026-10-20T09:00:00+03:00', duration: 'PT15M' });
await olan.calendar.updateEvent(event.id, { location: 'Toplantı odası' });
await olan.calendar.deleteEvent(event.id);
```

```ts
interface CalendarEvent { id: string; calendarId: string; uid: string; title: string; start: string; end: string; timeZone: string | null; isAllDay: boolean; location: string | null; description: string | null; isOrganizer: boolean; createdByApp: string | null; updatedAt: string | null }
```

- Without `calendarId` the default calendar is used (else the first writable one). Pass `end` or an
  ISO 8601 `duration`; neither means one hour (one day for all-day events).
- Apps never send invitations: there is no `participants`.
- `updateEvent` / `deleteEvent` fail with `forbidden_record` for Olan meetings (UID `…@olan.app`) and
  project calendar events (`system_record`), invitations (`not_organizer`), read-only calendars
  (`permission_denied`) and, when the admin requires it, events the app did not create
  (`not_created_by_app`). Calendars themselves cannot be created or deleted. Deletions are audited.

## olan.contacts

```ts
const books = await olan.contacts.addressBooks();        // [{ id, name, isDefault, shared }]
const found = await olan.contacts.search('ayşe');        // name, email or organization; limit ≤ 50
const contact = await olan.contacts.create({ name: 'Ayşe Yılmaz', emails: ['ayse@example.com'] });
await olan.contacts.update(contact.id, { phones: ['+90 555 000 0000'] });
await olan.contacts.delete(contact.id);
```

`Contact`: `{ id, addressBookId, name, emails, phones, organization, title, note, createdByApp, updatedAt }`.
Contacts in shared or directory address books are read-only (`forbidden_record`, `system_record`);
address books cannot be created or deleted.

## olan.mail and olan.meetings

```ts
const { messageId } = useSurfaceParams<'mail.sidebar'>();
const message = await olan.mail.getMessage(messageId);   // { id, subject, from, to, cc, receivedAt, textBody, attachments: [{ name, type, size }] }
const meeting = await olan.meetings.get(meetingId);      // { id, slug, title, startsAt, endsAt, status, organizerId, participants: [{ userId?, displayName, role }] }
```

`mail.getMessage` reads only the email a `mail.sidebar` / `mail.action` surface was opened on (other
ids: `permission_denied`); Olan reads it with the person's own mail session. There is no other
mail access.

## olan.storage

Private key–value storage per app installation **and** user. Values are JSON (≤ 64 KiB each, at
most 1000 keys).

```ts
const favorites = (await olan.storage.get<string[]>('favorites')) ?? [];
await olan.storage.set('favorites', [...favorites, id]);
await olan.storage.remove('favorites');
const keys = await olan.storage.keys();
```

`get` returns `null` for a missing key.

## olan.db

The app's own database: collections declared in the manifest's `data`, rows with revisions,
indexed queries and cursors. Needs `db`. Everything about it is in database.md.

```ts
const decisions = olan.db.collection<{ title: string; status?: 'open' | 'done' }>('decisions');
const row = await decisions.insert({ title: 'Ship 1.1', status: 'open' });
const { rows, nextCursor } = await decisions.query({ where: { status: 'open' }, orderBy: { field: 'title' }, limit: 20 });
await decisions.update(row.id, { status: 'done' }, { revision: row.revision });
```

## olan.settings

```ts
const settings = await olan.settings.get();   // e.g. { threshold: 3, currency: 'TRY' }
```

The values of the manifest `settings` fields (manifest.md), with defaults applied. Admins (or the
user, for a personal installation) edit them in Olan → Ayarlar → Uygulamalar. Apps cannot write
settings. In components prefer `useSettings()` (hooks.md), which re-renders when they change.

## olan.http

The sandbox has no network. `olan.http.fetch` asks Olan to make the request; Olan only reaches
hosts listed as `http:<host>` permissions (permissions.md).

```ts
const response = await olan.http.fetch('https://api.example.com/v1/rates?base=USD', {
  method: 'GET',                         // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers: { accept: 'application/json' },
  body: null,                            // string | null; JSON.stringify(...) for JSON bodies
});
if (response.status !== 200) throw new Error(`API answered ${response.status}`);
const data = response.json<{ rates: Record<string, number> }>();
```

`HttpResponse`: `{ status: number; headers: Record<string, string>; body: string; json<T>(): T }`.
`json()` throws `OlanError('invalid_params')` when the body is not JSON. Non-2xx statuses do
**not** reject; check `status`. Redirects are returned, not followed. Request bodies ≤ 512 KiB,
response bodies ≤ 2 MiB (text). Cookies of the user are never sent; put API keys in `headers`
(store them in a `secret` setting). Rejections: `http_blocked` (host not permitted, or a private
address), `host_error`.

## olan.ui

Each call opens the platform's own control and resolves when the user answers.

```ts
if (await olan.ui.confirm({ title: 'Görev silinsin mi?', confirmLabel: 'Sil', destructive: true })) { … }
const name = await olan.ui.prompt({ title: 'Yeni ad', defaultValue: 'Rapor' });   // null = cancelled
await olan.ui.toast({ text: 'Kaydedildi', tone: 'success' });                       // tone: 'default' | 'success' | 'warning' | 'danger'
const key = await olan.ui.menu({ items: [{ key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil', destructive: true }] }); // null = dismissed
const day = await olan.ui.datePicker({ value: '2026-10-16', mode: 'date' });        // ISO string or null
await olan.ui.share({ text: 'Rapor hazır', url: 'https://example.com/r/1' });
```

`olan.ui.menu` items: `{ key: string; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean }`.
For a menu attached to a button, use the `Menu` component instead.

Links and sign-in flows (SDK 1.5, links.md):

```ts
await olan.ui.openUrl('https://media.example.com/items/7');                      // the platform browser; resolves at once
const flow = await olan.ui.openExternal(authorizeUrl, { expectReturn: true });  // system browser / ASWebAuthenticationSession / Custom Tabs
if (flow.returned) await finishConnection(flow.params);                         // the query of https://<Olan web>/apps/return/<installationId>?…
```

Both take `https:` URLs (`http:` only to local addresses in development). `openExternal` resolves
`{ returned: false }` at once without `expectReturn`, and when the person closes the flow or after
30 minutes; check `params.state` on your server.

## olan.remote

The app's own server, as the person (SDK 1.5; manifest `remote` with `"requests": true`; everything
in remote-requests.md):

```ts
const page = await olan.remote.request({ method: 'GET', path: '/items', query: { status: 'ready' } });
const created = await olan.remote.request({ method: 'POST', path: '/items', body: { title: 'Lansman' }, timeoutMs: 60_000 });
```

The result is `{ status, headers: { 'content-type'?, etag? }, body }` for answers 200–399. Failures
reject with `RemoteError` (`code`, `status`, `details` = the server's body for `remote_rejected` and
`remote_unavailable`, `reason?`, `retryAfterSeconds?`); `isRemoteError(error, 'remote_rejected')`
narrows it. Body ≤ 1 MiB, answer ≤ 4 MiB, timeout 1–60 s (default 30 s), 300 requests a minute.

## olan.files

Pick files with the platform picker and upload them straight to the app's server (SDK 1.5,
`files:pick`; everything in files.md):

```ts
const [file] = await olan.files.pick({ accept: ['image/*', 'video/*'], maxBytes: 300 * 1024 * 1024 });   // [] = cancelled
if (file) {
  const task = olan.files.upload(file, { url: uploadUrl, onProgress: ({ loaded, total }) => setProgress(loaded / total) });
  // task.uploadId; task.cancel() (or olan.files.cancel(task.uploadId)) makes it reject with `cancelled`
  const { status, headers, body } = await task;    // every HTTP status resolves: check `status`
}
```

`url` must be on the origin of `remote.url` or a host granted as `http:<host>` (`http_blocked`
otherwise). PUT (default) sends the raw bytes, POST `multipart/form-data`; both send the name in
`x-olan-file-name`.

## olan.navigation

```ts
await olan.navigation.push('task', { taskId: 't1' });
await olan.navigation.replace('done', null);
await olan.navigation.pop();
```

The stack lives in the app; read it with `useNavigation()` (navigation.md). `pop()` on the first
screen keeps the stack and tells Olan, which closes a modal surface.

## olan.backend

`olan.backend.call(name, args?)` runs `functions[name]` of the app's backend code (`server`,
backend.md) with the person's consented permissions and resolves with its JSON result (≤ 256 KiB).
Failures: `backend_function_not_found`, `backend_error` (the function threw; `message` is its
error), `backend_limit`, `backend_busy`, `payload_too_large`, `backend_unavailable`, `backend_migrating` (errors.md).

```tsx
const summary = useQuery(() => olan.backend.call<Summary>('summary'), []);
```

## OlanError

```ts
try {
  await olan.projects.updateTask(projectId, task.id, { status: 'completed', revision: task.revision });
} catch (error) {
  if (isOlanError(error, 'conflict')) { /* reload and retry */ }
  else if (error instanceof OlanError && error.code === 'permission_denied') { /* … */ }
}
```

`error.code` (`OlanErrorCode`: the codes above, or a newer host's) and `error.message`.
`isOlanError(error, code?)` narrows an unknown error. `useQuery` puts the error in
`query.error`, `useCollection` in `list.error`. `error.hostDetails` holds machine-readable extras the
host sent, if any. `RemoteError` (a subclass, from `olan.remote.request`) adds `status`, `details`,
`reason?` and `retryAfterSeconds?` (remote-requests.md#errors-remoteerror).

## Other exports

`defineApp`, `isAppDefinition`, `isOlanError`, `isRemoteError`, `RemoteError`, `SDK_VERSION` (`'1.8.1'`), `PROTOCOL_VERSION` (`1`), `SURFACE_NAMES`, and types
`SurfaceParams`, `AppCard`, `Calendar`, `CalendarEvent`, `Contact`, `AddressBook`, `MailMessage`, `Meeting`,
`AppDefinition`, `AppSurfaces`, `SurfaceComponent`, `SurfaceProps`, `JsonValue`, `Surface`,
`Theme`, `Platform`, `AppContext`, `AppUser`, `DirectoryUser`, `RpcMethods`, `OlanErrorCode`, `DbRow`, `DbWhere`,
`DbCondition`, `DbOrderBy`, `DbQuery`, `DbCollection`, `DbPatch`, `CreateTaskInput`,
`DeleteRecordInput`, `RemoteRequestInit`, `RemoteResponse`, `RemoteErrorReason`, `FileHandle`,
`FilePickOptions`, `FileUploadResult`, `UploadOptions`, `UploadTask`, `ExternalFlowResult`,
`AppSurfaceParams`, `QueryOptions`, (SDK 1.7) `ProjectStatus`, `ProjectLabel`, `RecordLink`, `RecordTarget`,
`ProjectCalendarItem`, `ProjectApproval`, `TaskActionParams`, `IssueActionParams`, `RecordCardParams`, and (SDK 1.8)
`ProjectField`, `ProjectFieldDefinition`, `ProjectFieldType`, `ProjectFieldValue`, `ProjectFieldValues`. The runtime exports (`startRuntime`,
`workerTransport`, `createMemoryChannel`, `createUiRoot`, tree helpers) are used by the CLI and
the Olan host; apps do not call them. `@olan-app/sdk/server` is for the app's own server
(server.md), `@olan-app/sdk/backend` for backend code Olan runs (`defineBackend`, the server-side
`olan`, `OlanBackendError`; backend.md).

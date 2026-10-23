# Testing

`olan-app test` runs `tests/**/*.test.ts` with Node's test runner (`node:test`). Each test renders
the app headlessly with `renderApp` from `@olan-app/cli/testing`: your real `src/app.tsx`, the real
SDK runtime and React reconciler, against a mock Olan host that answers `olan.*` from fixtures and
enforces permissions exactly like Olan. No browser, no screenshots: you assert on text, the UI
tree and the recorded `olan.*` calls.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

test('lists projects and opens one', async () => {
  const app = await renderApp({ surface: 'app' });
  app.expectText('Web sitesi');
  await app.press('Web sitesi');                       // List item title
  assert.deepEqual(app.navigation(), [{ action: 'push', screen: 'project', params: { projectId: 'p0' } }]);
  app.expectText('Görev 2');
  await app.dispose();
});
```

Run: `npx olan-app test` (all), `npx olan-app test overdue` (files whose path contains
`overdue`), `--json` for a summary `{ files, tests, passed, failed, skipped, durationMs, failures }`.
Set `OLAN_APP_TEST_LOGS=1` to print the app's `console.*` output. Always `await app.dispose()`.

For Olan Marketplace: `npx olan-app test --report test-report.json` packs the app **first** (like
`pack`, into `.olan-app/report/`), runs the whole suite (no pattern) and writes a report bound to
that package's `digest.package` and signed with your development key; failing runs write it too
and exit 1. Make it after your last source change and attach it with `publish --marketplace
--test-report test-report.json` (marketplace.md#signed-test-reports).

## renderApp(options?)

Bundles the app (cached per run), boots the runtime, opens the surface and resolves after the
first render and its `olan.*` calls have settled. It **throws** if the surface reports an error
(unless `allowErrors: true`).

| Option | Default | Notes |
|---|---|---|
| `surface` | `'app'` | Any surface (surfaces.md) |
| `params` | built from the fixtures ("Surface params in tests" below); `null` for `app`/`settings` | Surface params (`useSurfaceParams`); a given value replaces the default entirely (no merge) |
| `fixtures` | — | Overrides per key over `fixtures/*.json` over the built-in data |
| `permissions` | the manifest's `permissions` plus the implied `remote` / `ai:tools` | Granted permissions; `[]` to test denial. An explicit list replaces the manifest's, but `remote` stays granted when the manifest has `remote.requests` (it is implied, never listed): `permissions: ['files:pick']` still reaches the app server. Block it with `remote: false` |
| `settings` | — | Over the manifest defaults and `fixtures/settings.json` |
| `ui` | `confirm → true`, `prompt/menu/datePicker → null`, `files` → the `fixtures/files.json` files `accept` allows, `openExternal` → `{ returned: false }` | Answers for `olan.ui.*` and the file picker: a value or `(params) => value` (below) |
| `remote` | the `fixtures/remote.json` routes | The app server behind `olan.remote.request`: `remote({ 'GET /items': (ctx) => ({ body: […] }) })` or one handler (below). `false`: the implied `remote` permission is not granted (an admin blocked it): every call fails with `permission_denied` |
| `upload` | `200`, no body | `MockUploadHandler` = `(upload: MockUpload) => MockUploadAnswer \| Promise<MockUploadAnswer>`: the upload target's answer to `olan.files.upload`; throw to fail it (`upload_failed`), never settle to keep it running (cancel recipe below) |
| `profileRole` | `'member'` | `user.role` of remote envelopes when `profile:read` is granted |
| `navigation` | — | `{ screen, params? }`: open on a screen as a permanent app address does (`/apps/a/<appId>/<screen>?…`, links.md) |
| `now` | real clock | Freezes `Date.now()`/`new Date()` in the app: ISO string, `Date` or ms. Also starts the host clock: `olan.db`/task timestamps are `now` + 1 s per write |
| `userId` | `'00000000-0000-4000-8000-000000000001'` ("Utku") | The signed-in user: `useUser().id` and the mock host's user (`createdBy` of new rows and tasks, owner of `user` rows, `owner` rules) |
| `quota` | `{ rows: 100000, bytes: 104857600 }` | `olan.db` limits `{ rows?, bytes? }` (bytes = rows as UTF-8 JSON); over it → `quota_exceeded` |
| `deleteOwnRecordsOnly` | `false` | Admin switch "only delete records it created": `deleteTask` works only on tasks this app created, `deleteList` never (`forbidden_record`) |
| `locale` / `theme` / `platform` | `'tr'` / `'light'` / `'web'` | Host context |
| `allowErrors` | `false` | Keep going on app errors; read them with `errors()` |
| `timeoutMs` | `5000` | Max time for an action to settle |
| `backend` | `true` with `server` | `olan.backend.call` runs the real backend (`server.entry`) on the same mock host and database; `false` → `backend_unavailable`; `{ engine }` picks the engine. `secret: true` settings are `null` for the UI (`backendLogs()` has the backend's console lines) |
| `secrets` | the secret settings' values | `olan.secrets.get` values for the backend. Precedence: `secrets[name]` (even `null`), else the `secret: true` setting from `settings` over `fixtures/settings.json` over the manifest default |
| `root` / `entry` | app dir / `src/app.tsx` | Rarely needed (`olan-app test` sets the root) |

## The rendered app

| Method | What it does |
|---|---|
| `await press(label)` | Presses a `Button` (label), `List` item (title), `Table` row (any cell text), `Menu` item (label), `Screen`/`Card` action (label), `EmptyState` action (label), `Form` submit/cancel label. Exact text first, then case-insensitive; a `RegExp` also works. Several targets with the label: the **first in document order** is pressed (a `Screen` action comes before the screen's content); if it is disabled/loading, `press` fails instead of trying the next, so give targets distinct labels. No match: it lists what can be pressed |
| `await fill(label, value)` | Types into a `TextField` (or sets a `DatePicker`/`Select`) found by `label`, else `name`; fires `onChange({ value })` |
| `await select(label, value)` | Picks a `Select` option by `value` or option label; fires `onChange`. On a `MultiSelect` a string toggles that option and an array sets the whole selection (`onChange({ value: string[] })`) |
| `await toggle(label)` | Flips a `Switch` found by label (`onChange({ value: !value })`); fails when it is disabled |
| `await dismiss(text?)` | Presses a `Banner`'s close button (`onDismiss`): the `Banner` whose `title` or `text` matches (exact, then case-insensitive; or a `RegExp`), else the first on screen. Fails when there is none or it has no `onDismiss` |
| `await fireTimers()` | One tick of every running `useQuery(…, { refetchIntervalMs })` timer, as the host sends them (the mock host never ticks on its own) |
| `remote(handler)` | Replaces the app server behind `olan.remote.request` for the next calls (`null`: back to `fixtures/remote.json`) |
| `await submit(submitLabel?)` | Submits a `Form` (first one, or the one with that `submitLabel`) with the current field values |
| `await back()` | The host's back control (pops the navigation stack) |
| `await setParams(params)` | New surface params, as the host sends them to an open panel (`mail.sidebar`, `meeting.panel`) |
| `await setContext({ theme?, locale?, settings? })` | Context change from the host |
| `expectText(text)` / `expectNoText(text)` | Visible text contains / does not contain (`string` = substring, whitespace-normalised; or `RegExp`). Failure messages list the visible text |
| `await waitForText(text, ms = 2000)` / `await waitFor(predicate, ms)` | For timers and slow chains; usually not needed (actions already settle) |
| `text()` | All visible text as **one string**, pieces joined with `\n` (`app.text().split('\n')` for lines) |
| `tree()` | Visible nodes in document order: `UiNode[]` = `{ id, type, props: Record<string, PropValue>, children: NodeId[] }[]`. Prop values are `PropValue` (JSON or handler refs): cast with `as unknown as` (below) |
| `snapshot()` | Nested `{ type, props, children }` (handlers appear as `{ $handler: n }`) |
| `find(type, predicate?)` | Nodes of a component type, e.g. `app.find('Badge')`; same `UiNode` shape as `tree()` |
| `calls(method?, { source? })` | `olan.*` calls: `MockCall[]` = `{ method, params, ok, result?, error?: { code, message, details? }, source: 'ui' \| 'backend' }[]` (`details`, e.g. `{ status, body?, reason? }` of a failed `remote.request`). With a backend, the `olan.*` calls its code made are included (`source: 'backend'`, secret values redacted; `{ source: 'ui' }` keeps only the UI's). `params` is the RPC's named object, not the positional arguments: `olan.projects.updateTask('p1', 't1', { status: 'completed', revision: 2 })` is recorded as `{ projectId: 'p1', taskId: 't1', status: 'completed', revision: 2 }`. `params`/`result` are typed `JsonValue`: cast them (below). Method names: below |
| `toasts()` | `{ text, tone? }[]` from `olan.ui.toast` |
| `navigation()` | `{ action: 'push' \| 'pop' \| 'replace', screen?, params? }[]` |
| `logs()` / `errors()` | Console output `{ level, args }[]` / app errors `{ message, stack?, fatal? }[]` |
| `host` | The mock host: `await host.handle(method, params)` → `{ ok: true, result } \| { ok: false, error: { code, message, details? } }` (an RPC as the UI sends it, permission-checked and recorded; `{ backend: true }` as backend code), `host.data` (live data, shapes below), `host.db` (the in-memory database; `host.db.as('u2').insert({ collection, data })` writes as another user), `host.permissions`, `host.ui`, `host.shares`, `host.audit()` (`{ action, detail }[]`: deletions and refused deletions, as in Olan's audit log), `host.remoteRequests`, `host.uploads`, `host.opened`, `host.timers()` (below) |
| `await settle()` | Wait until rendering and calls are idle |
| `await dispose()` | Unmount and free timers |

"Visible text" includes `Text`, titles and subtitles, `List` titles/subtitles/meta/badges, empty
texts, `Table` headers and cells, `Badge`, `Button` and `Menu` labels, field labels and values,
`EmptyState` texts and `Chart` series names; also `Tabs` labels, `Switch` labels and descriptions,
the `MultiSelect` label and the selected options' labels (else its placeholder), `Stat` label, raw
value (`1250.5`, not the formatted text; `null` is "—") and caption, `Banner` title, text and action
label, and the `ProgressBar` label. `Image` and `Avatar` add no text (check them with `find`).
`Menu` items are not visible until opened, but `press('<item label>')` selects them; `press` also
selects a `Tabs` item (by label) and a `Banner` action; `dismiss(text?)` closes a `Banner`.

### Recorded method names

`calls(method)` filters by RPC name, the `olan.*` path without `olan.`:

| Area | Methods (params) |
|---|---|
| Projects | `projects.list` (`{ limit?, cursor? }`), `projects.get` (`{ projectId }`), `projects.tasks` (`{ projectId, status? }`), `projects.createTask` (`{ projectId, title, listId?, … }`), `projects.updateTask` (`{ projectId, taskId, revision, … }`), `projects.deleteTask` (`{ projectId, taskId, revision }`), `projects.deleteList` (`{ projectId, listId, revision }`) |
| Database | `db.insert` (`{ collection, data }`), `db.get` (`{ collection, id }`), `db.query` (`{ collection, where?, orderBy?, limit?, cursor? }`), `db.update` (`{ collection, id, patch, revision }`), `db.delete` (`{ collection, id, revision? }`), `db.count` (`{ collection, where? }`); `useCollection`/`useRecord` record `db.query`/`db.get` |
| Projects (Phase 3) | `projects.create` (`{ title, description? }`), `projects.archive` (`{ projectId }`) |
| Project extensions (SDK 1.6–1.7) | `project.config.get/set`, `project.statuses.list/define/remove`, `project.labels.list/define/remove`, `project.fields.list/define/remove/values/setValues` (SDK 1.8), `project.links.list/upsert/remove/setStatus`, `project.calendar.list/upsert/remove`, `project.activity.post`, `project.approvals.list/request/cancel` (`{ projectId, … }`: the call's arguments by name, e.g. `{ projectId, linkId, statusKey }`) |
| Users | `users.get` (`{ ids }`, one call per 100 ids) |
| Chat | `chat.conversations` (`{}`), `chat.messages` (`{ conversationId, limit? }`), `chat.postCard` (`{ conversationId, card, threadRootId? }`), `chat.updateCard` (`{ messageId, card }`) |
| Calendar | `calendar.calendars` (`{}`), `calendar.events` (`{ from, to, calendarId?, limit? }`), `calendar.createEvent` (the input object), `calendar.updateEvent` (`{ eventId, patch }`), `calendar.deleteEvent` (`{ eventId }`) |
| Contacts | `contacts.addressBooks` (`{}`), `contacts.search` (`{ query, limit? }`), `contacts.create` (the input object), `contacts.update` (`{ contactId, patch }`), `contacts.delete` (`{ contactId }`) |
| Mail, meetings, backend | `mail.getMessage` (`{ messageId }`), `meetings.get` (`{ meetingId }`), `backend.call` (`{ name, args }`) |
| Remote, files, links (SDK 1.5) | `remote.request` (`{ method, path, query?, headers?, body?, timeoutMs? }`; a failure's `error.details` is `{ status, body?, reason? }`), `files.pick` (the options), `files.upload` (`{ uploadId, fileId, url, method?, headers?, formField?, fields? }`), `files.cancel` (`{ uploadId }`), `ui.openUrl` (`{ url }`), `ui.openExternal` (`{ url, expectReturn? }`), `timers.set`/`timers.clear` (`useQuery` refresh) |
| Other | `storage.get/set/remove/keys`, `settings.get`, `http.fetch`, `ui.confirm/prompt/toast/menu/datePicker/share`, `navigation.push/pop/replace` (also from `useNavigation()`) |

```ts
const params = app.calls('db.insert')[0]!.params as { collection: string; data: { title: string } }; // JsonValue → cast
assert.equal(params.data.title, 'Rapor');
const task = app.calls('projects.createTask')[0]!.result as { id: string; title: string };
const items = app.find('List')[0]!.props.items as unknown as { key: string; title: string }[]; // PropValue → cast
assert.equal(items[0]!.title, 'Görev 1');
```

Tests are type-checked: `olan-app validate` (also with `--strict`) runs `tsc --noEmit` on
`tsconfig.json` and `tests/tsconfig.json`, so a missing cast is a `typescript.*` error there.
`olan-app test` only bundles the tests and does not type-check.

### `host.data`

| Key | Shape |
|---|---|
| `projects` | `ProjectDetail[]`: `{ project: Project, members: ProjectMember[], lists: ProjectTaskList[], tasks: ProjectTask[] }[]`, **not** the flat fixture shape: `host.data.projects[0]!.project.name`, `host.data.projects[0]!.tasks[1]!.status` |
| `db` | `{ "<collection>": DbRow[] }`, every user's rows, oldest first; a fresh copy on each read (write through the app or `host.db`) |
| `storage` / `settings` / `http` | `{ "<key>": value }` / `{ "<setting>": value }` / `{ "<url>": { status?, headers?, body?, json? } }` |
| `conversations` / `messages` | `Conversation[]` / `{ "<conversationId>": Message[] }` |
| `projectConfigs` | `{ "<projectId>": ProjectConfig }` (SDK 1.6) |
| `recordLinks`, `projectStatuses`, `projectLabels`, `projectIssues`, `projectCalendarItems`, `projectApprovals` | by project id (SDK 1.7): the app's links, every status (defaults included), labels, issues, the app's calendar items, its approval requests (oldest first) |
| `projectFields`, `projectFieldValues` | by project id (SDK 1.8): every custom field; values by `<kind>:<id>` of the task or issue, then field id |
| `taskStatusIds` | `{ "<taskId>": "<statusId>" }`: where each task stands (status ids are `<projectId>-status-<key>`) |
| `projectActivity` | `{ "<projectId>": { type, text, target, actorId, at }[] }`: what the app put in the feed (`APP_ACTIVITY`, `APP_RECORD_LINKED`, `APP_RECORD_UNLINKED`, `APP_APPROVAL_REQUESTED`, `APP_APPROVAL_DECIDED`, `TASK_STATUS_CHANGED`, `ISSUE_STATE_CHANGED`, `PROJECT_UPDATED`) |

Mutating `app.host.data` changes what the next `olan.*` call returns:

```ts
app.host.data.http[URL] = { status: 200, json: { services: [] } };
await app.press('Tekrar dene');
```

## Fixtures

The mock host serves, key by key: `renderApp({ fixtures })` over `fixtures/*.json` over the
built-in data. Built-in projects: `p0` "Web sitesi", `p1` "Mobil uygulama", `p2` "Ofis taşınması",
each with tasks `<id>-t0`…`<id>-t3` titled "Görev 1"…"Görev 4", due `2026-10-10`…`2026-10-13`, the
first `completed` and the rest `needs-action`. No chats, storage, settings or HTTP responses by
default. Calendar: `cal-0` (default) with `ev-0` (the user organizes it), `ev-meeting` (an Olan
meeting, UID `mt-0@olan.app`, protected) and `ev-invite` (an invitation), and the project calendar
`cal-p0` (`ev-p0`, protected). Contacts: `ab-0` (own, default) with `ct-0`, `ab-company` (shared,
read-only) with `ct-company`. Mail: `mail-0` "Teklif hakkında". Meetings: `mt-0`. A key you provide replaces the built-in one entirely (e.g. your `projects` replace all
three).

| File | Content |
|---|---|
| `fixtures/projects.json` | `[{ "id", "name", "description"?, "timeZone"? (IANA, default `"Europe/Istanbul"`), "archived"? (default `false`), "tasks"?: [{ "id", "title", "status"?, "due"?, "assigneeId"?, "description"?, "revision"? }] }]` or `{ "projects": [...] }` |
| `fixtures/chat.json` | `{ "conversations": [{ "id", "title"?, "kind"? }], "messages": { "<conversationId>": [{ "id", "body", "sender"?: { "id", "displayName" } }] } }` |
| `fixtures/settings.json` | `{ "<setting>": value }` |
| `fixtures/storage.json` | `{ "<key>": value }` (initial `olan.storage`) |
| `fixtures/http.json` | `{ "<url>": { "status"?: 200, "headers"?: {}, "body"?: "text" , "json"?: {} } }` |
| `fixtures/users.json` | `[{ "id", "displayName", "email", "title"?, "department"?, "team"? }]` or `{ "users": [...] }`: people `olan.users.get` knows besides the default user (`fixtures.users_invalid`) |
| `fixtures/calendar.json` | `{ "calendars": [{ "id", "name", "color"?, "isDefault"?, "mayWrite"?, "projectId"? }], "events": [{ "id", "title", "start", "end"?, "calendarId"?, "uid"?, "isAllDay"?, "isOrganizer"?, "location"?, "createdByApp"? }] }` (`projectId` = a project calendar) |
| `fixtures/contacts.json` | `{ "addressBooks": [{ "id", "name", "isDefault"?, "shared"? }], "contacts": [{ "id", "name", "addressBookId"?, "emails"?, "phones"?, "organization"? }] }` |
| `fixtures/mail.json` | `[{ "id", "subject", "threadId"?, "from"?: { "name", "email" }, "to"?: [{ "name", "email" }], "cc"?: [same], "receivedAt"?, "textBody"?, "attachments"?: [{ "name", "type", "size" }] }]` or `{ "messages": [...] }`. `name` may be `null`; `receivedAt` is an ISO date-time. Defaults: `threadId: null`, `from`: the default user (Utku, `utku@example.com`), `to`/`cc`/`attachments`: `[]`, `receivedAt: "2026-10-16T09:00:00.000Z"`, `textBody: ""` |
| `fixtures/meetings.json` | `[{ "id", "title", "startsAt", "endsAt"?, "slug"?, "organizerId"?, "participants"?, "projectId"? }]` or `{ "meetings": [...] }` |
| `fixtures/db.json` | `{ "<collection>": [{ "id"?, "data", "createdBy"?, "createdAt"?, "updatedAt"?, "revision"? }] }` (initial `olan.db` rows; `createdBy` defaults to the default user (also with another `userId`), times to `now` (else `2026-10-16T09:00:00Z`), `revision` to 1). Rows must match the manifest `data` schema (`fixtures.db_invalid`, `fixtures.db_unknown_collection`) |
| `fixtures/remote.json` | `{ "GET /items": { "status"?: 200, "headers"?: {}, "body"?: … }, "GET /items/:id": { … } }`: canned answers of the app server to `olan.remote.request`, keyed like `handleRequest` routes (the wrapper of remote-requests.md). Used when no `renderApp({ remote })` is given; `validate --strict` and `dev` use it too (`fixtures.remote_missing`) |
| `fixtures/files.json` | `[{ "name", "type"?, "size"?, "content"?, "lastModified"? }]` or `{ "files": [...] }`: what the file picker offers. `type` defaults from the extension (else `application/octet-stream`), `size` from `content` (else 1024). Built in: `kampanya.jpg` (image/jpeg), `tanitim.mp4` (video/mp4, 5 MiB), `brief.pdf` |

Missing task fields get defaults: `status: "needs-action"`, `due: null`, `revision: 1`,
`assigneeId: null`, `description: ""`, `createdBy`: the default user, `listId` = the first list. Projects
without `"members"` get `[{ "userId": <default user>, "displayName": "Utku", "role": "owner" }]`; without
`"lists"`, one list `{ "id": "<projectId>-l0", "name": "Görevler" }`. A `projects.json` entry may
give `"lists"` and `"members"`, or use the `ProjectDetail` shape `{ "project", "members", "lists", "tasks" }`.

SDK 1.6 (project extensions): every fixture project has the app enabled unless it says
`"enabled": false`: such a project is left out of `olan.projects.list`, and calls naming it fail with
`project_not_enabled`, as on a server. `"config": { … }` is the stored `olan.project.config` value
(revision 1); after a `set` the mock host keeps the new one in `app.host.data.projectConfigs[projectId]`.

SDK 1.7: every fixture project has the default statuses `todo` "Yapılacak", `in_progress` "Devam
ediyor", `done` "Tamamlandı" and `cancelled` "İptal" (ids `<projectId>-status-<key>`); its tasks
start on the one of their `status`. A project may add what the app already contributed — each the
app's own unless it says `"app": false`:

```json
{ "id": "office", "name": "Ofis", "taskKeyPrefix": "OFS",
  "issues": [{ "id": "i1", "title": "Klima bozuk", "number"?: 1, "state"?: "open", "inTriage"?: false }],
  "statuses": [{ "key": "awaiting-approval", "name": "Onay bekliyor", "category": "started", "color"?: "#E0A526" }],
  "labels": [{ "key": "hardware", "name": "Donanım", "groupName"?: "Tür" }],
  "fields": [{ "key": "size", "name": "Boyut", "type": "select", "options"?: [{ "id"?: "large", "name": "Büyük" }], "required"?: false, "appliesTo"?: ["task"] }],
  "fieldValues": [{ "target": { "kind": "task", "id": "t1" }, "values": { "size": "large" } }],
  "links": [{ "id": "link-1", "target": { "kind": "task", "id": "t1" }, "externalId": "SAT-7", "card": { …record card… } }],
  "calendarItems": [{ "externalId": "SAT-7", "title": "Teslim", "start": "2026-11-10", "linkId"?: "link-1" }],
  "approvals": [{ "id": "a1", "title": "SAT-7 onayı", "approverIds": ["<member id>"], "mode"?: "any", "state"?: "pending", "linkId"?: "link-1" }] }
```

The mock host answers `olan.project.*` with the server's checks and codes (keys, taken names,
record cards that only `open`, limits, approvers who are project members other than `guest`).
`app.host.decideApproval(projectId, approvalId, 'approve' | 'reject', { userId?, note? })` decides
as an approver would (`any`: the first decision; `all`: a rejection or the last approval).
Links, calendar items and approvals carry the manifest's `id` and `name` (`appId`, `name`) and
`installationId: MOCK_INSTALLATION_ID`.

### Surface params in tests

Without `params`, `renderApp` builds what the host would send from the (merged) fixtures:

| Surface | Default params |
|---|---|
| `project.widget`, `project.tab`, `project.settings` | `{ projectId }` of the first project the app is enabled in (`p0`) |
| `task.action` | that project's first task: `{ projectId, task: { id, key (default null), title, status, statusId, statusCategory, assigneeId, due } }` |
| `issue.action` | that project's first issue (built-in: `p0-i1`): `{ projectId, issue: { id, key, number, title, kind, state, stateReason, inTriage } }` |
| `record.card` | the app's first link in that project: `{ projectId, linkId, target, externalId, payload: null }` (none: a sample `link-0` on the first task) |
| `chat.action` | the first conversation (else `conversation-0`) and its last message `{ id, body, senderId: sender.id, senderKind: "user", createdAt, threadRootId: null }` (no messages: a sample `message-0` "Yarın 10:00 standup") |
| `chat.command` / `chat.card` | `{ conversationId, text: "", threadRootId: null }` / `{ conversationId, messageId: "card-message-0", payload: null }` |
| `mail.sidebar`, `mail.action` | the **first** `mail.json` entry with defaults applied: `id` → `messageId`; `threadId`, `subject`, `from`, `to`, `cc`, `receivedAt` copied (`textBody`/`attachments` only via `olan.mail.getMessage`). Built-in: `{ messageId: "mail-0", threadId: "thread-0", subject: "Teklif hakkında", from: { name: "Ayşe Yılmaz", email: "ayse@example.com" }, to: [{ name: "Utku", email: "utku@example.com" }], cc: [], receivedAt: "2026-10-16T09:00:00.000Z" }`. An empty `mail.json` (`[]`) gives `messageId: "mail-0"`, `subject: ""`, `from: { name: null, email: "someone@example.com" }` |
| `calendar.event.action` | the first event with `isOrganizer` (default `true`), else the first event: built-in `ev-0`; missing event fields default to `calendarId`: the default calendar, `uid: "<id>@example.com"`, `end = start`, `isAllDay`: `start` has no time, `timeZone`/`location`: `null` |
| `meeting.panel` | the first meeting (`mt-0`): `{ meetingId: id, slug (default: id), title, startsAt, endsAt (default null), role: "organizer" when `organizerId` (default `DEFAULT_USER_ID`) is the signed-in user, else "participant", projectId (default null) }` |

`mail.getMessage` answers only for the current `messageId` (others: `permission_denied`) and needs
the entry in `mail.json` (`not_found` otherwise). Test another email with
`renderApp({ surface: 'mail.sidebar', fixtures: { mail: [{ id: 'm1', subject: 'Fatura', from: { name: null, email: 'muhasebe@firma.com' } }] } })`
or, in an open panel, `await app.setParams({ ...params, messageId: 'm1' })`.

Users: the signed-in user is `DEFAULT_USER_ID` = `00000000-0000-4000-8000-000000000001`, "Utku"
(`utku@example.com`; exported with `DEFAULT_USER` from `@olan-app/cli/testing`); `renderApp({ userId })`
changes it (`useUser().id` follows). `olan.users.get` answers from the default user plus
`fixtures/users.json`; other ids are left out. Other people: add them to `users.json`, list them in a
project's `members`, seed rows with their `createdBy`, or act as them with `app.host.db.as(id)`.

Ids: the built-in project, task and list ids (`p0`, `p0-t0`, `p0-l0`) are **not UUIDs**, but
`ref:project`, `ref:task` and `ref:user` fields accept only UUIDs (`validation_failed`). If the app
stores such ids in `olan.db`, give `fixtures/projects.json` UUID ids (and `members` with UUID `userId`s). `fixtures/db.json` row ids may be any unique non-empty
string (`"d1"`); rows the app inserts get UUIDs, as in Olan, so do not depend on the id format.

HTTP fixtures match `"METHOD url"` first, then the exact `url`, then the URL without its query
string. A URL without a fixture answers `http_blocked` (the mock never touches the network);
`validate --strict` warns `fixtures.http_missing` for it. `json` sets the body to
`JSON.stringify(json)` and `content-type: application/json`.

The mock host also applies Olan's rules: missing permission → `permission_denied`, HTTP host not
in permissions → `http_blocked`, a stale `revision` → `conflict`, storage values > 64 KiB →
`invalid_params`. `olan.db` runs on the same in-memory database Studio uses
(`@olan-app/sdk/memory-db`), with the server's validation, rules, cursors, quota and error codes
(`renderApp({ userId, quota })` changes the signed-in user and the limits). The first work package
of each mock project is the default one (`isDefault: true`): `deleteList` on it, or on a non-empty
one, fails with `forbidden_record`, as on the server.

## Remote requests, files and links

`olan.remote.request` goes to a mock app server: `renderApp({ remote })` (or `app.remote(…)`), else
the `fixtures/remote.json` answers. Routes use the `handleRequest` format and rules
(remote-requests.md): `:name` and `/*` parameters, unknown route 404, other method 405, a thrown
`RequestError` its status, any other throw 500. The answer goes through the same mapping as in Olan:
200–399 resolve, 4xx reject `remote_rejected`, 5xx and no handler `remote_unavailable`, and the
call waits at most its `timeoutMs`. Without `"requests": true` in the manifest every call fails with
`permission_denied`.

```ts
import { remote, renderApp, RequestError } from '@olan-app/cli/testing';

const items = [{ id: 'm1', title: 'Lansman', status: 'ready', url: 'http://127.0.0.1:4419/olan/media/m1' }];
const app = await renderApp({
  remote: remote({
    'GET /items': () => ({ body: items }),
    'POST /items': (ctx) => ({ status: 201, body: { item: { id: 'm2', ...(ctx.body as object) }, upload: { url: 'http://127.0.0.1:4419/olan/uploads/m2?token=t' } } }),
    'DELETE /items/:id': (ctx) => { if (ctx.params.id !== 'm1') throw new RequestError(404, { error: 'item_not_found' }); },
  }),
  ui: { files: ['kampanya.jpg'] },                       // fixtures/files.json names or inline { name, type, size, content }
  upload: (upload) => ({ status: 201, headers: { etag: '"1"' }, body: { id: 'm2' } }),
  profileRole: 'admin',
});
await app.press('Yükle');                                // Tabs item
const [sent] = app.host.remoteRequests;                  // { envelope, answer }
assert.equal(sent!.envelope.user?.email, 'utku@example.com');   // only with profile:read
assert.equal(app.host.uploads[0]!.headers['x-olan-file-name'], 'kampanya.jpg');
await app.fireTimers();                                  // a useQuery refetchIntervalMs tick
```

- **Envelopes.** `host.remoteRequests` holds `{ envelope, answer }` per call: `envelope` is the
  signed body Olan would post (issuer `MOCK_ISSUER` `https://olan.test`, installation
  `MOCK_INSTALLATION_ID`, `user.organizationId` `DEFAULT_ORGANIZATION_ID`, `locale` `tr`, `timeZone`
  `Europe/Istanbul`, a placeholder token); with `profile:read` the user gets `email` and
  `displayName` from the users fixtures and `role` from `profileRole`. `answer` is the wrapper the
  route returned (`null` when there was none).
- **Errors in the app.** `app.calls('remote.request')[0]!.error` is `{ code, message, details }`
  (`details`: `{ status, body?, reason? }`); in the app it is a `RemoteError`. Throw `RequestError`
  in test routes, imported from `@olan-app/cli/testing` or `@olan-app/sdk/server` (your server's
  own routes work as they are).
- **Files.** The picker returns the `fixtures/files.json` files (default: all that `accept` and
  `maxBytes` allow, up to `maxFiles`); `ui.files` chooses (`['tanitim.mp4']`, inline entries,
  `null`/`[]` = cancelled, or `(options) => …`). Uploads must target the manifest `remote.url`
  origin or an `http:<host>` permission (`http_blocked`); `http://127.0.0.1` works because tests
  are a development installation. `onProgress` gets `{ loaded: 0 }` at the start and
  `{ loaded: size }` at the end.
- **Upload types** (exported from `@olan-app/cli/testing`). `host.uploads` and the `upload` handler's
  argument are `MockUpload`: `{ uploadId: 'upl_…', file: FileHandle & { content: string }, url,
  method: 'PUT' | 'POST', headers: Record<string, string>, formField: string | null, fields:
  Record<string, string>, status: 'running' | 'done' | 'cancelled' | 'failed' }`. `file.content` is
  the fixture file's `content` text (`''` when it has none); `headers` are what the target got,
  lower-case (`content-type`, `content-length` for PUT, `x-olan-file-name`, yours). The handler
  returns `MockUploadAnswer` = `{ status?: number, headers?: Record<string, string>, body?: JsonValue }`
  (only `content-type`, `etag`, `location` reach the app); its type is `MockUploadHandler`.
- **Cancelling an upload.** `press` resolves only when everything it started has settled, and a
  running upload has not. Start the press **without awaiting it**, wait for the progress UI, press
  cancel, then await the first press:

  ```ts
  const app = await renderApp({ ui: { files: ['tanitim.mp4'] }, upload: () => new Promise(() => {}) });  // never answers
  const uploading = app.press('Yükle');                       // not awaited yet
  await app.waitFor((view) => view.find('ProgressBar').length > 0);
  await app.press('İptal');                                   // task.cancel(): the upload rejects with `cancelled`
  await uploading;                                            // now it settles
  assert.equal(app.host.uploads[0]!.status, 'cancelled');
  ```

  Awaiting `press('Yükle')` directly fails after `timeoutMs` with "files.upload is still pending";
  the same pattern works for a slow `remote` route (return a promise you resolve later).
- **Without `profile:read`.** The envelope's `user` has only `id`, `organizationId`, `locale` and
  `timeZone`. Leave the permission out of the list to test what your server does then (`remote`
  stays granted):

  ```ts
  const app = await renderApp({ permissions: ['files:pick'], remote: remote({ 'GET /me': (ctx) => ({ body: { email: ctx.user?.email ?? null } }) }) });
  assert.equal(app.host.remoteRequests[0]!.envelope.user?.email, undefined);
  ```
- **Testing your server.** `createTestIssuer` and `signRemoteRequest` sign requests exactly as Olan
  does, for tests of the app server itself (remote-requests.md#testing-the-app-server).
- **Links.** `host.opened` lists `{ url, external, expectReturn }`. `ui.openExternal` answers
  `openExternal(…, { expectReturn: true })` (e.g. `{ returned: true, params: { state: 'st_1' } }`).
  A return without a pending call is `renderApp({ params: { return: { state: 'st_1' } } })`.
- **App addresses.** `renderApp({ navigation: { screen: 'item', params: { id: 'm1' } } })` opens on
  `item` over `index` (`app.back()` returns to `index`); `screen: 'index'` gives the first screen
  these params.
- **Refresh.** The mock host never ticks by itself: `host.timers()` lists the running
  `{ timerId, intervalMs }` (at least 5000) and `app.fireTimers()` sends one tick to each.
- **Switches and multi-selects.** `await app.toggle('Hemen yayınla')`,
  `await app.select('Kanallar', ['instagram', 'tiktok'])` (or one value to toggle it).
- **Banners.** `await app.press('Yeniden bağla')` presses a `Banner` action;
  `await app.dismiss('Bağlantının süresi doldu')` presses its close button (`onDismiss`).

## Backend tests

Backend code (`server`, backend.md) is tested headlessly with `createBackendHarness`: it bundles
`server.entry`, runs it in `@olan-app/runtime` (isolated-vm in a forked runtime process, or QuickJS
with `olan-app test --engine quickjs`) and answers `olan.*` from the same mock host as `renderApp`
(in-memory `olan.db`, `fixtures/*.json`, `fixtures/http.json` for `olan.http.fetch`). Name the files
`tests/*.backend.test.ts` (any `*.test.ts` runs).

```ts
import { createBackendHarness, signHookRequest } from '@olan-app/cli/testing';

test('digest', async () => {
  const backend = await createBackendHarness({ secrets: { apiToken: 't' }, now: '2026-10-17T09:00:00Z' });
  try {
    const summary = await backend.call<{ count: number }>('summary', { limit: 5 });   // { ok, value | error, logs, cpuMs, wallMs }
    assert.equal(summary.ok, true, summary.error?.message);
    await backend.runSchedule('digest', { scheduledAt: '2026-10-17T09:05:00Z' });
    await backend.emit({ type: 'project.task.created', data: { projectId: 'p0', task: { id: 't1', title: 'Yeni' } } });
    const hook = await backend.hook('github', { headers: { 'x-github-event': 'push' }, body: { ref: 'refs/heads/main' } });
    assert.equal(hook.status, 200);                                   // signed with the secret setting for you
    const forged = await backend.hook('github', { headers: { 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    assert.equal(forged.status, 401);                                 // the function did not run
    assert.equal(backend.calls('http.fetch')[0]?.ok, true);           // olan.* calls the backend made
  } finally {
    await backend.dispose();                                          // always: it stops the runtime
  }
});
```

| Option | Default | Notes |
|---|---|---|
| `settings`, `secrets` | manifest defaults + `fixtures/settings.json`; secrets = the `secret: true` values | `secrets: { apiToken: null }` tests "not configured" |
| `db`, `fixtures` | `fixtures/*.json` | `db` = rows by collection (like `fixtures/db.json`) |
| `permissions` | the manifest's | The app identity's (schedules, events, hooks) and the default caller's |
| `engine` | `auto` (`OLAN_APP_BACKEND_ENGINE`, `olan-app test --engine`) | `isolated-vm` or `quickjs` |
| `manifest` | — | Fields over `olan-app.json` |
| `build` | `true` | `false` loads the existing `dist/server.js` |
| `limits` | 1000 ms CPU, 10 s / 30 s, 64 MiB, 4 at once | e.g. `{ cpuMs: 5000 }` on a slow machine |
| `userId`, `now` | as in `renderApp` | |

Methods: `call(name, args?, { userId?, permissions? })` (actor `user`), `runSchedule(name, { scheduledAt? })`,
`emit(type | { type, data?, actor?, id? })` (only events in `server.events`; default data from the
fixtures), `hook(name, { method?, headers?, body?, query?, sign? })` (returns `{ status, headers, body,
verified }` plus the result; `sign: false` sends it unsigned), `migrate(fromVersion)`, `calls(method?)`
(only the backend's calls),
`logs()`, `host`, `db`, `manifest`, `engine`, `dispose()`. Results: `{ ok, value?, error?: { code,
runtimeCode, message }, logs, cpuMs, wallMs }` — `code` is what `olan.backend.call` rejects with
(`backend_error`, `backend_limit`, …), `runtimeCode` the runtime's (`handler_error`, `cpu_limit`, …).

`hook()` bodies: a string is sent as is; any other JSON value as `JSON.stringify(body)` with
`content-type: application/json` (signed over those exact bytes). `await signHookRequest(verify, body,
secret)` is async and returns the headers to send: `{ [verify.header]: 'sha256=<lower-case hex>' }`
for `hmac-sha256`, `webhook-id`/`webhook-timestamp`/`webhook-signature` for `standard-webhooks`;
`verifyHookSignature` checks one by hand.

Recorded calls (`backend.calls()`, `renderApp().calls(m, { source: 'backend' })`): `params` is the
RPC object, e.g. `http.fetch` → `{ url, method?, headers?, body? }`. Secret values never appear:
a `secrets.get` result is `"[secret]"`, and every occurrence of a secret value (4+ characters) in
params, results and errors is replaced by `"[secret]"` (`headers.authorization` →
`'Bearer [secret]'`). `host.handle()` and the backend itself still get the real values.
`fixtures/settings.json` holds dev-only secrets (never real ones): it is used by tests, `validate`
and `dev`, and is not packed.

## Patterns

```ts
// project.widget with params
const app = await renderApp({ surface: 'project.widget', params: { projectId: 'site' }, now: '2026-10-20T09:00:00Z' });

// a write: check the call and the new state
await app.press('Görev 2');
await app.press('Tamamlandı');                                   // Menu item
assert.equal(app.calls('projects.updateTask')[0]?.ok, true);
assert.equal(app.host.data.projects[0]!.tasks[1]!.status, 'completed');

// dialogs
const app2 = await renderApp({ ui: { confirm: false, prompt: (params) => 'Yeni ad' } });

// storage
const app3 = await renderApp({ fixtures: { storage: { currency: 'EUR' } } });
assert.deepEqual(app3.host.data.storage, { currency: 'EUR' });

// forms
await app.fill('Başlık', 'Rapor');
await app.select('Durum', 'completed');
await app.press('Kaydet');                                        // Form submitLabel (or a Button)

// permissions
const denied = await renderApp({ permissions: [] });
assert.equal(denied.calls('projects.list')[0]?.error?.code, 'permission_denied');
```

Test files are bundled with esbuild for Node, so TypeScript works without a separate compiler.
Import only `node:*` modules, `@olan-app/cli/testing`, `@olan-app/sdk/server` (server tests), your
app server's modules (`../app-server/routes.ts`) and your own helpers; do not import `src/app.tsx`
into tests (`renderApp` loads it). After a file's tests end, its process gets 1.5 s to exit by
itself; a crash after every test passed is reported as `test.process_crashed` (a warning), not as
a failed test.

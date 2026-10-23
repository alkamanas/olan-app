# Operasyon Kutusu — an Olan App

App id `com.visetra.ops-inbox` (template `backend`). The UI is `src/app.tsx`; the backend Olan runs is
`server/index.ts` (`schedules.digest`, `events['project.task.created']`, `hooks.github`);
its tests are `tests/inbox.backend.test.ts`. Read the "Backend code" section below before changing `server/`.

An Olan App is React + TypeScript that runs in a sandbox: it describes its UI with
`@olan-app/sdk` components (Olan draws them natively on web, desktop, iOS and Android) and gets
data through `olan.*` calls that Olan permission-checks.

Full offline docs: `node_modules/@olan-app/sdk/docs/` (start with `getting-started.md`), a one-file
digest in `node_modules/@olan-app/sdk/llms.txt`, search with `npx olan-app docs <query>`. Complete
example surfaces: `node_modules/@olan-app/sdk/docs/examples.md` (the `examples/` apps it names are
in the Olan repository, not in this project).

## Done

The task is done only when both pass (exit code 0):

```sh
npx olan-app validate --strict   # manifest, build, TypeScript, renders every surface, permissions
npx olan-app test                # tests/**/*.test.ts against the mock Olan host
```

Loop: edit → `npx olan-app validate --strict --json` → fix every error (each has `code`, `file`,
`line`, `hint`; codes in `docs/errors.md`) → `npx olan-app test --json` → fix → repeat. Add or
update tests in `tests/` for every behaviour you build.

Before packaging, run `npx olan-app validate --strict` (it must pass): `olan-app pack` itself runs only
the normal checks (manifest, build, files, size, TypeScript) and refuses to pack on errors
(`pack.validation_failed`); it does not render the surfaces.

## Files

- `src/app.tsx` — the app. Ends with `export default defineApp({ app: Home })`.
- `olan-app.json` — id, name, version, `surfaces`, `permissions`, `settings` (`docs/manifest.md`).
  Keep `id` stable; bump `version` before each publish. Keep `minServerVersion` at `0.1.0`
  (the oldest Olan server with Olan Apps) unless the app needs a newer server.
- `tests/*.test.ts` — `node:test` + `renderApp` from `@olan-app/cli/testing` (`docs/testing.md`).
- `fixtures/*.json` — mock data: `projects.json`, `chat.json`, `settings.json`, `storage.json`,
  `http.json`, `users.json` (`[{ "id", "displayName", "email", "title"? }]`), `db.json` (`{ "<collection>": [{ "id"?, "data": { … } }] }`, must match `data`).
  Used by tests, `validate --strict` and `dev`.

## Rules

1. Surfaces are named components: `defineApp({ app: Home, 'project.widget': Widget, settings: SettingsScreen })`.
   Never inline arrow functions. Surface names: `app` (full screen), `project.widget` (card on a
   project page, `params = { projectId }`), `settings`, and the in-context surfaces `chat.action`,
   `chat.command`, `chat.card`, `mail.sidebar`, `mail.action`, `calendar.event.action`,
   `meeting.panel` (each needs a `title`; `chat.command` also `command`). Declare each in
   `olan-app.json` `surfaces`; read what it was opened on with `useSurfaceParams<'mail.sidebar'>()`
   (`docs/surfaces.md`). Root component: `app`/`settings` start with `<Screen>` (`ui.root_not_screen`),
   `project.widget` with `<Card>`; modals and panels should also start with `<Screen>` (its title is the header).
2. No DOM or React Native: no `<div>`/`<span>`, no `react-dom`, no `react-native`, no Node modules,
   no `style`/`className`/colours. Only the components below.
3. Strings go inside `<Text>` (`<Text text="…" />` or `<Text>…</Text>`), never directly in
   `Screen`/`Stack`/`Card`/`Form`.
4. No `fetch`, `window`, `document`, `localStorage`, `XMLHttpRequest`, `WebSocket`: use `olan.*`.
5. Every `olan.*` call needs its permission in `olan-app.json` (table below). Handle failures:
   `useQuery` puts the `OlanError` (with `.code`) in `query.error`; show an `EmptyState`.
6. Unique `key` on every `List` item, `Table` row, `Menu` item and `Action`. Every `Button` has a
   `label`; every `Menu` has a `label`.
7. React hooks (`useState`, `useEffect`, `useMemo`) work. Load data with
   `useQuery(() => olan.….(), [deps])`; call `olan.*` only in effects, handlers or `useQuery`.

## Components (`import { … } from '@olan-app/sdk'`)

`Tone` = `default|muted|accent|danger|success|warning`; `Spacing` = `none|xs|sm|md|lg`; `Key` = string | number;
`Action` = `{ key, label, icon?, onPress }`. Required props in **bold**.

| Component | Props |
|---|---|
| `Screen` | `title`, `subtitle`, `actions: Action[]`, `loading`, `scroll`; children |
| `Stack` | `direction: 'vertical'\|'horizontal'`, `gap: Spacing`, `align: start\|center\|end\|stretch`, `justify: start\|center\|end\|between`, `wrap`, `padding: Spacing`; children |
| `Card` | `title`, `subtitle`, `actions`, `padding`; children |
| `Text` | `text` (or text children), `variant: title\|heading\|body\|caption\|label`, `tone`, `weight: regular\|medium\|semibold\|bold`, `truncate` |
| `Badge` | **`text`**, `tone` |
| `EmptyState` | **`title`**, `description`, `icon`, `action: { label, onPress }` |
| `List` | **`items`**: `{ key, title, subtitle?, meta?, badge?: { text, tone? }, icon?, disabled? }[]`, `onSelect({ key })`, `emptyText`, `loading` |
| `Table` | **`columns`**: `{ key, title, width?, align? }[]`, **`rows`**: `{ key, cells: { [columnKey]: string\|number\|null } }[]`, `onSelectRow({ key })`, `emptyText` |
| `Chart` | **`kind`**: `bar\|line`, **`series`**: `{ name, points: { x: string, y: number }[] }[]`, `height` |
| `Form` | **`onSubmit({ values })`** (`values: Record<name, string>`), `submitLabel`, `cancelLabel`, `onCancel`; children |
| `TextField` | **`name`**, **`label`**, `value`, `placeholder`, `multiline`, `secure`, `required`, `error`, `onChange({ value })` |
| `Select` | **`name`**, **`label`**, **`options`**: `{ value, label }[]`, `value: string\|null`, `placeholder`, `onChange({ value })` |
| `DatePicker` | **`name`**, **`label`**, `value` (ISO date/date-time or null), `mode: date\|datetime`, `onChange({ value })` |
| `Button` | **`label`**, **`onPress`**, `variant: primary\|secondary\|ghost\|danger`, `icon`, `disabled`, `loading` |
| `Menu` | **`label`** (or `icon`), **`items`**: `{ key, label, icon?, destructive?, disabled? }[]`, **`onSelect({ key })`** |

Details and icon names: `docs/components.md`.

## `olan.*` API (`import { olan, OlanError } from '@olan-app/sdk'`)

| Call | Returns | Permission |
|---|---|---|
| `olan.projects.list({ limit?, cursor? })` | `{ items: Project[], nextCursor? }` | `projects:read` |
| `olan.projects.get(projectId)` | `{ project, members, lists, tasks }` | `projects:read` |
| `olan.projects.tasks(projectId, { status? })` | `ProjectTask[]` | `projects:read` |
| `olan.projects.createTask(projectId, { title, listId?, description?, status?, due?, allDay?, assigneeId?, priority? })` | `ProjectTask` | `tasks:write` |
| `olan.projects.updateTask(projectId, taskId, { status?, due?, assigneeId?, revision })` | `ProjectTask` | `tasks:write` (older apps: `projects:write`) |
| `olan.projects.deleteTask(projectId, taskId, { revision })` | void | `tasks:delete` |
| `olan.projects.deleteList(projectId, listId, { revision })` (archives an empty work package) | void | `projects:delete` |
| `olan.db.collection<T>(name)` → `insert(data)`, `get(id)`, `query({ where?, orderBy?, limit?, cursor? })`, `update(id, patch, { revision })`, `delete(id, { revision? })`, `count(where?)` | `DbRow<T>` / `DbRow<T> \| null` / `{ rows, nextCursor }` / `DbRow<T>` / void / `number` | `db` |
| `olan.users.get(ids)` (directory: `{ id, displayName, email, title?, department?, team?, avatarUrl? }`; no lookup by email: collect member/assignee ids, then compare `email`) | `DirectoryUser[]` | `users:read` |
| `olan.chat.conversations()` / `olan.chat.messages(conversationId, { limit? })` | `Conversation[]` / `Message[]` | `chat:read` |
| `olan.storage.get(key)` / `set(key, value)` / `remove(key)` / `keys()` | JSON / void / void / `string[]` | `storage` |
| `olan.settings.get()` | the app's settings | none |
| `olan.http.fetch(url, { method?, headers?, body? })` | `{ status, headers, body, json() }` | `http:<host>` |
| `olan.ui.confirm({ title, message?, confirmLabel?, cancelLabel?, destructive? })` | `boolean` | none |
| `olan.ui.prompt({ title, message?, placeholder?, defaultValue? })` | `string \| null` | none |
| `olan.ui.toast({ text, tone? })`, `olan.ui.menu({ items })`, `olan.ui.datePicker({ value?, mode? })`, `olan.ui.share({ text, url? })` | void, key \| null, ISO \| null, void | none |
| `olan.navigation.push(screen, params?)` / `pop()` / `replace(screen, params?)` | void | none |
| `olan.chat.postCard({ conversationId, card, threadRootId? })` / `updateCard(messageId, card)` (`docs/cards.md`) | `{ messageId }` | `chat:write` |
| `olan.calendar.calendars()` / `events({ from, to, calendarId?, limit? })` | `Calendar[]` / `CalendarEvent[]` | `calendar:read` |
| `olan.calendar.createEvent({ title, start, end?, duration?, calendarId?, timeZone?, isAllDay?, location?, description? })` / `updateEvent(eventId, patch)` / `deleteEvent(eventId)` | `CalendarEvent` / void | `calendar:write` / `calendar:delete` |
| `olan.contacts.addressBooks()` / `search(query, { limit? })` (name, email or organization; ≤ 50) / `create({ name, addressBookId?, emails?, phones?, organization?, title?, note? })` / `update(contactId, patch)` / `delete(contactId)` | `AddressBook[]` / `Contact[]` / `Contact` / `Contact` / void | `contacts:read` / `contacts:write` / `contacts:delete` |
| `olan.mail.getMessage(messageId)` (only the email a `mail.*` surface was opened on) | `MailMessage` (`textBody`, attachments) | `mail:read` |
| `olan.meetings.get(meetingId)` | `Meeting` with participants | `meetings:read` |
| `olan.projects.create({ title, description? })` / `archive(projectId)` (only projects the app created) | `Project` / void | `projects:create` / `projects:archive` |

`ProjectTask`: `{ id, projectId, title, description, status: 'needs-action'|'in-process'|'completed'|'cancelled', due: string|null, assigneeId, revision, … }`.
`updateTask`, `deleteTask` and `deleteList` need the record's current `revision` (stale → `conflict`).
`ProjectTaskList`: `{ id, name, isDefault, revision, parentId }`. Hooks: `useQuery`, `useNavigation`,
`useSettings`, `useTheme`, `useLocale`, `usePlatform`, `useAppContext`, `useCollection`, `useRecord`,
`useUser()` (`{ id }` of the person using the app, no permission), `useUsers(ids)` (`users:read`)
(`docs/hooks.md`, `docs/api.md`). Check failures with `isOlanError(error, 'conflict')`.

## App database (`olan.db`, `docs/database.md`)

Declare collections in `olan-app.json` `data` (with `"sdk": "^1.4.0"` and the `db` permission);
increase `data.version` on every schema change (only additive changes install over existing data).

```jsonc
"data": { "version": 1, "collections": {
  "notes": { "scope": "organization",            // or "user": each person sees only their rows
    "fields": { "title": { "type": "string", "required": true, "maxLength": 200, "indexed": true },
                "projectId": { "type": "ref:project", "indexed": true }, "done": { "type": "boolean" } },
    "rules": { "read": "any", "update": "any", "delete": "owner" } } } }
```

Types: `string`, `number`, `boolean`, `date` (`YYYY-MM-DD`), `datetime`, `json`, `ref:project|task|user`
(UUIDs). `where`/`orderBy` only on `indexed` fields (≤ 5) and `createdAt`/`updatedAt`/`createdBy`.

```tsx
const notes = useCollection<Note>('notes', { where: { done: false }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 20 });
// notes.rows: DbRow<Note>[] ({ id, data, revision, createdAt, updatedAt, createdBy }), notes.loadMore(), notes.refetch()
await olan.db.collection<Note>('notes').update(row.id, { done: true }, { revision: row.revision });
```

Inserts, updates and deletes through `olan.db` reload the hooks of that collection. Errors:
`validation_failed` (row does not match `data`), `conflict` (stale revision: reload, retry),
`forbidden_record` (rules or a protected record: say "Bu kayıt korunuyor", do not retry),
`quota_exceeded`, `not_found`. User ids are central: `row.createdBy`, `task.assigneeId` and
`member.userId` equal `useUser().id` for the person's own records, so show `owner`-rule actions only
when `row.createdBy === useUser().id` (and still catch `forbidden_record`).

## Permissions and protected records

| Permission | Allows |
|---|---|
| `projects:read` | Read projects, work packages and tasks |
| `tasks:write` | Create and change tasks (`projects:write` still allows `updateTask` in older apps) |
| `tasks:delete` | Delete tasks; every deletion is written to the audit log |
| `projects:delete` | Remove (archive) empty work packages |
| `db` | The app's own database |
| `users:read` | Names, emails, titles of people in the organization (`olan.users.get`); not needed for `useUser().id` |
| `chat:read`, `storage`, `settings:read`, `http:<host>` | Chats, per-user storage, settings, one external host |
| `chat:write` | Post cards as the app (`olan.chat.postCard`) |
| `calendar:read` / `calendar:write` / `calendar:delete` | Calendars and events (no invitations are sent) |
| `contacts:read` / `contacts:write` / `contacts:delete` | Address books and contacts |
| `mail:read` | The full email a `mail.sidebar` / `mail.action` surface was opened on |
| `meetings:read` | Meeting details and participants |
| `projects:create` / `projects:archive` | Create projects; remove (archive) only the ones the app created |

`remote` (an app server) and `ai:tools` (assistant tools) are implied by the manifest fields
`remote` and `ai.tools`; never list them in `permissions` (`docs/server.md`).

Olan refuses (`forbidden_record`) deleting the project's **default work package** (`isDefault`),
a non-empty work package, a task with an approval workflow and — when the admin turns on "only
records it created" — anything the app did not create. Calendar events that are Olan meetings or
in project calendars (`system_record`), invitations (`not_organizer`), contacts in shared address
books (`system_record`) and projects the app did not create (`not_created_by_app`) are refused the
same way. Calendars, address books, chats, members and accounts cannot be created or deleted.
Handle `forbidden_record` with a toast.

## Backend code (`server`, `docs/backend.md`)

Code that must run without anyone looking (schedules, events, incoming webhooks) or must hold a
secret goes in `server/index.ts` and is declared in `olan-app.json`:

```jsonc
"server": { "entry": "server/index.ts",
  "schedules": [{ "name": "digest", "cron": "*/5 * * * *" }],         // ≤ 10, ≥ 5 min apart
  "events": { "project.task.created": "onTaskCreated" },                // needs the event's permission
  "hooks": [{ "name": "github", "verify": { "kind": "hmac-sha256", "header": "x-hub-signature-256", "secretSetting": "githubSecret" } }] }
```

```ts
import { defineBackend, olan } from '@olan-app/sdk/backend';
export default defineBackend({
  functions: { async summary(args, ctx) { return { count: await olan.db.collection('items').count() }; } },  // UI: olan.backend.call('summary')
  schedules: { digest: async (ctx) => { /* ctx.scheduledAt */ } },
  events: { 'project.task.created': async (event) => { /* event.data.task */ } },
  hooks: { github: async (request) => ({ status: 204 }) },    // request: { method, headers, body, query }, already verified
});
```

Backend rules:
1. Import only `@olan-app/sdk/backend` (and plain-JS libraries). No Node modules (`fs`, `crypto`, …),
   no `fetch`, `process`, `require`, `setInterval`: `olan-app build` rejects them
   (`build.backend_node_import`). Network: `olan.http.fetch` with an `http:<host>` permission.
2. Periodic work is a `schedules` entry (cron), never a timer. `setTimeout` only fires while the same
   call runs; pending timers are cancelled when it returns. Keep no state in globals: use `olan.db`.
3. Secrets (`"secret": true` settings) are read only in the backend with `olan.secrets.get(name)`;
   the UI gets `null` for them. Never return a secret from a function.
4. Limits per call: 1 s CPU, 10 s for `backend.call` (30 s for schedules, events, hooks), 64 MiB,
   4 calls at once, arguments and results ≤ 256 KiB, JSON only. A hook answers `{ status, headers?, body? }`
   within 10 s or Olan answers `202`.
5. `olan.backend.call` errors in the UI: `backend_function_not_found`, `backend_error` (the function threw),
   `backend_limit`, `backend_busy`, `payload_too_large`, `backend_unavailable`.
6. Every manifest schedule/event/hook needs a handler: put it in `schedules[name]` / `events[type]` /
   `hooks[name]` (`validate` checks it: `validate.backend_handler_missing`). Never put a trigger handler in
   `functions`: everything there is callable from the UI. A `functions` entry named as a schedule's or
   hook's optional `"function"` fallback, or as a `server.events` value, is not callable from the UI
   (`backend_function_not_found`).

Test it headlessly with `createBackendHarness` (`tests/*.backend.test.ts`):

```ts
const backend = await createBackendHarness({ secrets: { apiToken: 't' } });
const result = await backend.call('summary');         // { ok, value | error, logs }
await backend.runSchedule('digest'); await backend.emit('project.task.created');
const hook = await backend.hook('github', { body: { ref: 'main' } });   // signed for you; sign: false or a wrong header → 401
await backend.dispose();
```

`npx olan-app dev` runs the backend locally (`POST /backend/schedules/<name>/run`, `POST /hooks/<name>`) and
prints its console lines; `--engine quickjs` forces the slower QuickJS engine.

## Navigation

One surface component switches on `useNavigation().screen` (`'index'` first); `push('task', { id })`
opens a screen, Olan's back control pops it (`docs/navigation.md`).

```tsx
function App() {
  const { screen, params } = useNavigation();
  if (screen === 'project') return <ProjectScreen projectId={(params as { projectId: string }).projectId} />;
  return <ProjectsScreen />;   // List onSelect={({ key }) => navigation.push('project', { projectId: String(key) })}
}
```

## Tests

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '@olan-app/cli/testing';

test('works', async () => {
  const app = await renderApp({ surface: 'app' });          // options: params, fixtures, permissions, settings, ui, now, userId, quota
  app.expectText('Web sitesi');
  await app.press('Web sitesi');                             // Button label, List item title, Menu item, action, Form submitLabel (first match wins)
  await app.fill('Başlık', 'Rapor'); await app.select('Durum', 'completed');
  assert.equal(app.calls('projects.list')[0]?.ok, true);    // also toasts(), navigation(), tree(), text() (one string)
  const params = app.calls('projects.list')[0]!.params as { limit?: number };  // params/result are JsonValue: cast
  // RPC names = the olan.* path without `olan.`: projects.createTask, db.insert, users.get, mail.getMessage, calendar.events, contacts.search, chat.postCard, … (docs/testing.md)
  const items = app.find('List')[0]!.props.items as unknown as { key: string; title: string }[];  // tree()/find() props are PropValue: cast
  // host.data.projects is ProjectDetail[] ({ project, members, lists, tasks }); olan.db rows: app.host.data.db.<collection>; deletions: app.host.audit()
  await app.dispose();
});
```

Built-in data when `fixtures/projects.json` is absent: projects `p0` "Web sitesi", `p1` "Mobil
uygulama", `p2` "Ofis taşınması", tasks "Görev 1…4" due 2026-10-10…13 (first completed); each
project's first work package is the default one (`isDefault`); the signed-in user (only member,
`useUser().id`) is `00000000-0000-4000-8000-000000000001` "Utku" (`renderApp({ userId })` changes it;
more people for `users.get` in `fixtures/users.json`). `ref:*` fields need UUIDs, so an app that
stores project/task ids in `olan.db` needs its own `fixtures/projects.json` with UUID ids (the mock
host rejects references to projects, tasks or users that are not in the fixtures: `ref.not_found`).
Calendar, contacts, mail and meeting data: `cal-0` (events `ev-0`, `ev-meeting` an Olan meeting,
`ev-invite` an invitation), contacts `ct-0` / `ct-company` (shared), email `mail-0`, meeting `mt-0`;
override with `fixtures/calendar.json`, `contacts.json`, `mail.json`, `meetings.json`
(`docs/testing.md`). `renderApp({ surface: 'mail.sidebar' })` opens on the first `mail.json` entry (built-in
`mail-0`; params `{ messageId, threadId, subject, from: { name, email }, to, cc, receivedAt }`, `name` may be null); `app.setParams(…)`
moves a panel to another object.
`validate` type-checks the tests too. Submitting a `Form` does not clear uncontrolled fields.

## Commands

```sh
npm install
npx olan-app validate --strict      # add --json for machine-readable errors
npx olan-app test                   # npx olan-app test <pattern>
npx olan-app dev                    # dev server for Olan Studio → Geliştirme sunucuları
npx olan-app pack --dev-sign        # after validate --strict; dist/com.visetra.ops-inbox-<version>.olanapp signed with your development key
npx olan-app docs <query>           # search the SDK docs
npx olan-app events send project.task.created   # signed event to your app server (remote.url, docs/server.md)
npx olan-app tools call <tool> --input '{…}'    # call an ai.tools tool on your app server
npx olan-app dev --engine quickjs               # backend (`server`) on the QuickJS engine
```

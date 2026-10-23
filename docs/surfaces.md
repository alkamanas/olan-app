# Surfaces

A surface is a place in Olan where the app appears. Declare each one in `olan-app.json`
`surfaces` and define a component with the same name in `defineApp({ … })`:

```tsx
export default defineApp({ app: Home, 'chat.action': AddToStandup, 'mail.sidebar': CustomerPanel });
```

| Surface | Where | Shown as | `params` (`useSurfaceParams<S>()`) |
|---|---|---|---|
| `app` | Olan's app list, sidebar, its address `/apps/a/<appId>` | full screen | `null`, or `{ return }` after an external flow (SDK 1.5, links.md) |
| `project.widget` | Project summary page | card | `{ projectId }` |
| `settings` | Ayarlar → Uygulamalar | full screen | `null` |
| `chat.action` | A message's "More" menu → Apps | modal | `{ conversationId, message: { id, body, senderId, senderKind, createdAt, threadRootId } }` |
| `chat.command` | `/<command>` in the chat composer | modal | `{ conversationId, text, threadRootId? }` (`text`: what follows the command) |
| `chat.card` | The `open` button of the app's chat card (cards.md) | modal | `{ conversationId, messageId, payload }` |
| `mail.sidebar` | A tab next to the contact panel of an open email | panel | `{ messageId, threadId, subject, from: { name, email }, to, cc, receivedAt }` |
| `mail.action` | The email toolbar's overflow menu → Apps | modal | same as `mail.sidebar` |
| `calendar.event.action` | The event popover → Apps | modal | `{ calendarId, eventId, uid, title, start, end, timeZone, isAllDay, location?, isOrganizer }` |
| `meeting.panel` | A tab in the meeting room's side panel (not for guests) | panel | `{ meetingId, slug, title, startsAt, endsAt, role: 'organizer' \| 'participant', projectId? }` |
| `project.tab` | A tab of the project page (SDK 1.6) | tab | `{ projectId }` |
| `project.settings` | The project page → Uygulamalar → the app's "Ayarlar" (SDK 1.6) | full screen (a sheet) | `{ projectId }` |
| `task.action` | A task's "…" menu → the app (SDK 1.7) | modal | `{ projectId, task: { id, key, title, status, statusId, statusCategory, assigneeId, due } }` |
| `issue.action` | An issue's "…" menu → the app (SDK 1.7) | modal | `{ projectId, issue: { id, key, number, title, kind, state, stateReason, inTriage } }` |
| `record.card` | The `open` button of the card the app drew on a task or issue (SDK 1.7) | modal | `{ projectId, linkId, target: { kind, id }, externalId, payload }` |

Manifest entries: `app`, `project.widget`, `settings`, `project.tab` and `project.settings` take
`{ "title"?: string }` (the tab label and the settings title fall back to the app name); every other
surface needs `"title"` (1–80, the menu or tab label). `chat.command` also needs `"command"`
(`^[a-z][a-z0-9-]{1,31}$`, typed after `/`) and may have `"description"` (≤ 120):

```json
"surfaces": {
  "chat.action": { "title": "Standup'a ekle" },
  "chat.command": { "title": "Standup", "command": "standup", "description": "Bugünün standup'ını aç" },
  "mail.sidebar": { "title": "Müşteri" }
}
```

## Reading the params

```tsx
import { useSurfaceParams, useQuery, olan, Screen, Text } from '@olan-app/sdk';

function CustomerPanel() {
  const mail = useSurfaceParams<'mail.sidebar'>();          // typed per surface
  const contacts = useQuery(() => olan.contacts.search(mail.from.email), [mail.from.email]);
  return <Screen title={mail.subject}><Text text={`${contacts.data?.length ?? 0} kişi`} /></Screen>;
}
```

Exact shapes (types `SurfaceParams`, `MailSurfaceParams` … from `@olan-app/sdk`): keys without
`?` are always present; `?` keys may be absent or `null`. Tests build them from fixtures (testing.md):

```ts
type MailAddress = { name: string | null; email: string };   // name null when the header has none
interface MailSurfaceParams {        // mail.sidebar, mail.action (no body: olan.mail.getMessage)
  messageId: string; threadId: string | null; subject: string;   // '' when there is no subject
  from: MailAddress;                 // the first From address; email '' if the message has none
  to: MailAddress[]; cc: MailAddress[];   // [] when empty (no bcc)
  receivedAt: string;                // ISO 8601 date-time, e.g. '2026-10-16T09:00:00Z'
}
// chat.action: message.body/senderId/threadRootId are string | null; createdAt ISO date-time
// calendar.event.action: start/end ISO date (all-day) or date-time; timeZone/location string | null
// meeting.panel: endsAt/projectId string | null; chat.card: payload is the card action's JsonValue or null
// task.action: task.key ('WEB-12'), statusId, statusCategory, assigneeId, due string | null; status is the CalDAV value
// issue.action: issue.key ('WEB-#4'), kind, stateReason string | null; state 'open' | 'closed'
// record.card: target.kind 'task' | 'issue'; payload is the open action's JsonValue or null
```

Compare email addresses case-insensitively (`from.email.toLowerCase()`).

- The summary fields in `params` need no permission: the person opened the app on that object.
  More than that needs the read permission: the email body (`olan.mail.getMessage`, `mail:read`),
  other messages (`chat:read`), participants (`meetings:read`).
- Panels (`mail.sidebar`, `meeting.panel`) stay open while the person moves to another email or
  meeting; the component re-renders with the new params (no new start). Key queries on the params.
- Root component: `app`, `settings`, `project.tab` and `project.settings` start with `<Screen>`
  (`validate --strict` warns `ui.root_not_screen` otherwise); `project.widget` renders a `<Card>` (or `EmptyState`). Modals and
  panels should also start with `<Screen>`: its `title`/`actions` become the modal's or panel's
  header (not checked; another root is shown as is, without a header).
- Modals: the surface's first `Screen` is shown in a modal; `olan.navigation.pop()` (or the host's
  close control) on the first screen closes it. One modal per app at a time.
- The `params` prop of the surface component carries the same value (`JsonValue`).

## Project extensions (SDK 1.6)

A project is generic: statuses, labels, work packages. An app turns it into the project of a
process (a marketing calendar, a sales pipeline) only where a member adds it: the project page →
Uygulamalar lists the apps installed in the organization, and "Ekle" / "Kaldır" enables or removes
one there (it also shows in the project's activity). Only then:

- `project.widget` shows in the project's summary, `project.tab` adds a tab with the surface's
  `title` (or the app name), and `project.settings` opens from the app's "Ayarlar" button in
  Uygulamalar. All three get `{ projectId }`.
- `olan.projects.*` on the person's behalf reaches the project (`project_not_enabled` elsewhere).
- `olan.project.config` keeps the app's settings of that project (api.md#olanprojectconfig).

```tsx
function BrandTab() {
  const { projectId } = useSurfaceParams<'project.tab'>();
  const config = useProjectConfig();                       // this project's configuration
  const brandId = typeof config.value.brandId === 'string' ? config.value.brandId : null;
  return <Screen title="Marka">{brandId ? <BrandCalendar brandId={brandId} /> : <EmptyState title="Marka seçilmedi" />}</Screen>;
}
```

`project.tab` fills the tab's content area and keeps its own screen stack
(`olan.navigation.push` works; the back control appears in the tab). `project.settings` opens in a
sheet; `olan.navigation.pop()` on its first screen closes it. Removing the app from the project
hides its surfaces there; its configuration and the records it linked stay.

## Records on tasks and issues (SDK 1.7)

In the projects it is enabled in, an app also adds its own records and process (api.md#olanproject-records-statuses-calendar-feed-approvals):

- `task.action` / `issue.action` put the app in a task's or issue's "…" menu (the entry is the
  surface's `title`); the modal gets the task or issue. A typical action links one of the app's
  records to it: `olan.project.links.upsert` with a card the task or issue then shows.
- `record.card` opens from an `open` button of that card, with the link, its target, the record's
  `externalId` and the button's `payload`. Record cards have no `submit` buttons.
- The app's statuses (`olan.project.statuses.define`), labels and (SDK 1.8) custom fields
  (`olan.project.fields.define`, values with `setValues`) show among the project's; the task
  moves through a link (`olan.project.links.setStatus`). Its calendar items show as a layer of the
  project calendar, its feed lines and the status changes it made under its name in the project
  activity, its approval requests in the approvers' approval box.
- Manifest `projectTemplates` offers whole projects (work packages, statuses, labels, starter tasks)
  in "Yeni proje"; a project made from one has the app added (manifest.md#projecttemplates).

```tsx
function LinkRecord() {
  const { projectId, task } = useSurfaceParams<'task.action'>();
  const link = async () => {
    const created = await olan.project.links.upsert(projectId, { target: { kind: 'task', id: task.id }, externalId: 'SAT-12', card });
    await olan.project.links.setStatus(projectId, created.id, { statusKey: 'awaiting-approval' });
  };
  return <Screen title="Kayda bağla" subtitle={task.title}><Button label="Bağla" onPress={link} /></Screen>;
}
```

`olan-app init --template project-records` builds all of it with tests. Removing the app from the
project hides these surfaces; links and approvals stay read-only, calendar items hide.

## Visibility

An entry is shown when the installation is active, the person consented (the consent screen
opens on first use) and policy does not block it. Each place lists at most 8 apps, the rest go
under "Tüm uygulamalar". Two apps with the same `command` are both listed with their names.
Surfaces need no permission of their own; the consent screen lists them under "Görüneceği yerler".

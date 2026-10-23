# Manifest (`olan-app.json`)

```json
{
  "$schema": "https://olan.app/schemas/olan-app/v1.json",
  "schemaVersion": 1,
  "id": "com.example.overdue-tasks",
  "name": "Geciken görevler",
  "version": "0.1.0",
  "sdk": "^1.8.0",
  "minServerVersion": "0.1.0",
  "description": "Projelerdeki geciken görevler",
  "entry": "dist/app.js",
  "icon": "assets/icon.png",
  "surfaces": {
    "app": { "title": "Geciken görevler" },
    "project.widget": { "title": "Gecikenler" },
    "settings": { "title": "Ayarlar" }
  },
  "permissions": ["projects:read"],
  "settings": {
    "threshold": { "type": "number", "label": "Gecikme eşiği (gün)", "default": 3 }
  }
}
```

Unknown top-level fields are errors (`manifest.unknown_field`); only `$schema` is extra. The
allowed fields depend on `schemaVersion` (only `1` today).

`server` declares backend code that Olan runs (`server/index.ts` with `@olan-app/sdk/backend`;
backend.md). A server whose administrator turned backends off (`OLAN_APPS_BACKEND=0`) rejects it
with `manifest.feature_not_available`.

| Field | Required | Rule |
|---|---|---|
| `$schema` | no | `"https://olan.app/schemas/olan-app/v1.json"` (editor completion) |
| `schemaVersion` | yes | `1` |
| `id` | yes | Reverse domain, lowercase: `[a-z0-9-]+(\.[a-z0-9-]+)+`, ≤ 128. Never change it after publishing |
| `name` | yes | 1–80 characters |
| `version` | yes | Semver `MAJOR.MINOR.PATCH` (pre-release allowed). Raise it for every new release; an organization catalog (`publish --org`) never takes the same number twice. On the marketplace a `checks_failed`, rejected or withdrawn version number may be submitted again; approved or released ones may not (marketplace.md#publishing) |
| `sdk` | yes | `@olan-app/sdk` range: `"*"`, `"1.2.3"`, `"^1.0.0"`, `"~1.2.0"` or `">=1.0.0 <2.0.0"` (no `\|\|`, no `1.x`). Use `"^1.8.0"` (the current SDK; `olan-app init` writes it; `data` needs ^1.1.0, `useUser`/`olan.users` ^1.2.0, the Phase 3 surfaces, cards, calendar/contacts/mail/meetings calls and `remote` ^1.3.0, backend code (`server`) ^1.4.0, `remote.requests`, `olan.files`, `openUrl`/`openExternal`, `refetchIntervalMs`, the components `Tabs` … `ProgressBar` and `ai.tools` `timeoutMs` ^1.5.0, `project.tab`, `project.settings`, `olan.project.config` and `useProjectConfig` ^1.6.0, `task.action`, `issue.action`, `record.card`, the `olan.project` links/statuses/labels/calendar/activity/approvals calls, `projects:extend` and `projectTemplates` ^1.7.0, `olan.project.fields` ^1.8.0) |
| `minServerVersion` | no | Oldest Olan server that may install it (semver). Use `"0.1.0"`, the first Olan server with Olan Apps (`olan-app init` writes it); raise it only when the app needs a newer server. Olan's own version is still 0.x, so `"1.0.0"` would block every server today |
| `description` | no | ≤ 400 characters |
| `entry` | yes (apps) | Bundle path in the package: `"dist/app.js"` (relative `.js`/`.mjs`, no `..`) |
| `icon` | no | Package path to a png/svg/jpg/webp, e.g. `"assets/icon.png"` (the file must exist) |
| `kind` | no | `"app"` (default) or `"web-link"` |
| `surfaces` | yes (apps) | At least one surface (below, surfaces.md) |
| `permissions` | no | Default `[]`; ≤ 64; no duplicates (permissions.md) |
| `settings` | no | Settings fields (below) |
| `data` | no | App database collections (below, database.md). Apps only, not web links. Needs `"sdk": "^1.1.0"` and the `db` permission |
| `remote` | no | `{ "url", "jwksUrl", "requests"? }` of the app's own server (server.md); implies the `remote` permission. `"requests": true` (default `false`, SDK 1.5) turns on `olan.remote.request`: Olan posts signed requests to `{url}/requests` on behalf of the person (remote-requests.md). `profile:read` needs `remote` (`manifest.profile_requires_remote`) |
| `events` | no | Event types sent to `{remote.url}/events` (server.md#events); needs `remote` and each event's permission |
| `ai` | no | `{ "tools": [ … ] }`: assistant tools run by the app server (server.md#assistant-tools-aitools); needs `remote`, implies `ai:tools`. A tool's `timeoutMs` (1000–60000, default 15000; read-only tools at most 15000, SDK 1.5) sets how long Olan waits for it |
| `projectTemplates` | no | Project templates offered in "Yeni proje" while the app is installed (SDK 1.7, below) |
| `server` | no | Backend code Olan runs (backend.md): `{ "entry": "server/index.ts", "schedules"?: [{ name, cron, timeZone?, function? }] (≤ 10, ≥ 5 min apart), "events"?: { "<event type>": "<function>" }, "hooks"?: [{ name, function?, verify: { kind: "hmac-sha256"\|"standard-webhooks"\|"none", header?, secretSetting? } }] }`; `olan-app build` bundles `entry` into `dist/server.js`. Handlers go in `defineBackend`'s `schedules`/`events`/`hooks` maps by name; `function` (optional; required as the `events` value) only names a fallback in `functions`, and such a function is not callable from the UI (backend.md#handler-resolution) |

## Data (`olan.db`)

`data` declares the app's database collections (since SDK 1.1.0, still `schemaVersion: 1`):

```json
"data": {
  "version": 1,
  "collections": {
    "decisions": {
      "scope": "organization",
      "fields": {
        "title": { "type": "string", "required": true, "maxLength": 200, "indexed": true },
        "status": { "type": "string", "enum": ["open", "done"], "indexed": true },
        "projectId": { "type": "ref:project", "indexed": true }
      },
      "rules": { "read": "any", "update": "any", "delete": "owner" }
    }
  }
}
```

Field types, options, limits, scopes, rules and schema changes: database.md. Errors:
`manifest.data_*` (errors.md).

## Surfaces

| Surface | Where it appears | Params | Root component |
|---|---|---|---|
| `app` | Full screen: Olan's app list (`/apps/<installation>`), sidebar, the permanent address `/apps/a/<appId>` (links.md) | `null`, or `{ return }` (links.md) | `Screen` (required: `ui.root_not_screen`) |
| `project.widget` | A card on the summary page of the projects the app is enabled in | `{ projectId: string }` | `Card` (or `EmptyState`) |
| `project.tab` | A tab of the project page, in projects the app is enabled in (SDK 1.6) | `{ projectId: string }` | `Screen` (required) |
| `project.settings` | The app's settings of one project: project page → Uygulamalar → Ayarlar (SDK 1.6) | `{ projectId: string }` | `Screen` (required) |
| `settings` | Olan → Ayarlar → Uygulamalar, instead of the generated form | `null` | `Screen` (required) |
| `chat.action`, `chat.command`, `chat.card`, `mail.sidebar`, `mail.action`, `calendar.event.action`, `meeting.panel` | Modals and panels in chat, email, calendar and meeting screens (surfaces.md) | the object it was opened on | `Screen` recommended (its title is the header; not checked) |
| `task.action`, `issue.action`, `record.card` | A task's or issue's "…" menu; the `open` button of the app's record card (SDK 1.7, projects the app is enabled in) | `{ projectId, task }`, `{ projectId, issue }`, `{ projectId, linkId, target, externalId, payload }` | `Screen` recommended |

`app`, `project.widget`, `settings`, `project.tab` and `project.settings` entries are
`{ "title"?: string }` (≤ 80; defaults to the app name); the other surfaces need `"title"`, `chat.command` also `"command"` (surfaces.md). Every declared surface
must be defined in `defineApp({ ... })` with the same name (`app.surface_missing`), and a surface
defined in code but not declared is never opened (`app.surface_undeclared`).

```tsx
export default defineApp({ app: Overview, 'project.widget': OverdueCard, settings: SettingsScreen });
```

## `projectTemplates`

SDK 1.7: up to 5 project templates the organization's "Yeni proje" lists while the app is installed
for the person. A project made from one gets the template's work packages, statuses, labels, starter
tasks and task/issue templates, and the app is added to it; the statuses and labels are the app's
(members use them, the app manages them with `olan.project.statuses` / `labels`). A new app version
with the same `key` replaces the template.

```json
"projectTemplates": [{
  "key": "purchasing",
  "name": "Satın alma",
  "description": "Talep, onay, sipariş ve teslim",
  "content": {
    "version": 1,
    "lists": [{ "key": "requests", "title": "Talepler", "steps": [{ "key": "approval", "title": "Onay" }] }],
    "statuses": [
      { "key": "todo", "name": "Yeni talep", "color": "#8A94A6", "category": "unstarted" },
      { "key": "awaiting-approval", "name": "Onay bekliyor", "color": "#E0A526", "category": "started" },
      { "key": "done", "name": "Teslim alındı", "color": "#2F9E6E", "category": "completed" },
      { "key": "cancelled", "name": "İptal", "color": "#A1A7B3", "category": "cancelled" }
    ],
    "labels": [{ "name": "Donanım", "color": "#5B8DEF", "groupName": "Tür" }]
  }
}]
```

- `key` `^[a-z0-9][a-z0-9._-]{0,62}$`, unique; `name` 1–120; `description` ≤ 2000; `content` ≤ 64 KiB.
- `content`: `version: 1`; `lists` (1–50 work packages, `key`, `title`, `code?`, `color?`, `steps?` ≤ 50);
  `statuses?` (≤ 30, `{ key, name, color: #RRGGBB, category }`; when given they replace the defaults,
  so include one per `unstarted`, `started`, `completed` and `cancelled`); `labels?` (≤ 100,
  `{ name, color, groupName?, description? }`); `tasks?` (≤ 200) and `recordTemplates?` (≤ 50) in the
  shape of Olan's own project templates; `settings?` (`description`, `coverColor`, `estimateScale`).
- The manifest checks the shape (`manifest.project_template_invalid`); the server checks references
  between keys and skips a template it cannot use.

## Settings fields

`settings` maps a key (`^[A-Za-z][A-Za-z0-9_]{0,63}$`, ≤ 64 fields) to a field:

| Property | Notes |
|---|---|
| `type` | `"string"`, `"number"`, `"boolean"` or `"select"` |
| `label` | Required, ≤ 80 |
| `description` | ≤ 400 |
| `default` | Same type as the field; for `select` one of the option values |
| `required` | boolean |
| `secret` | boolean: stored encrypted, masked in admin screens. Apps without `server` still receive the value; with `server` the UI gets `null` and only backend code reads it (`olan.secrets.get`, backend.md#secrets) |
| `options` | `select` only: `[{ "value": "TRY", "label": "Türk lirası" }]`, ≥ 1, unique values |

```json
"settings": {
  "currency": { "type": "select", "label": "Para birimi", "default": "TRY", "options": [
    { "value": "TRY", "label": "Türk lirası" }, { "value": "EUR", "label": "Euro" } ] },
  "apiKey": { "type": "string", "label": "API anahtarı", "secret": true },
  "showDone": { "type": "boolean", "label": "Bitenleri göster", "default": false }
}
```

Olan generates the settings form from these fields (unless the app has a `settings` surface).
Read values with `useSettings()` or `olan.settings.get()`; defaults apply to unset fields. In tests
and `validate --strict` the defaults apply too, overridden by `fixtures/settings.json`.

## Web links

`{ "kind": "web-link", "url": "https://…" }` describes a link instead of a packaged app: no
`entry`, no `settings`, no permissions, no `remote`/`events`/`ai`, only the `app` surface (optional), and `icon` is an
http(s) URL or an Olan icon name. Users add web links in Olan → Uygulamalar; they are not built
with this SDK.

## Package (`olan-app pack`)

`dist/<id>-<version>.olanapp` is a ZIP of `olan-app.json`, `dist/app.js`, `dist/server.js` (when
the manifest declares `server`), `assets/**`, a
`digest.json` (SHA-256 of every file and of the whole package) and, when signed (`--dev-sign`,
or `olan-app.key.json` exists), `signature.json` (Ed25519; optional `keyId`, cli.md#signing-and-publishing).
The package must stay ≤ 5 MiB. The bundles keep the license comments of bundled code at the end
of the file; other notices go in `assets/NOTICE` or `assets/THIRD_PARTY_NOTICES` (marketplace.md#automatic-checks). Organization admins upload it
(`olan-app publish --org`, or the admin panel's Uygulamalar section).

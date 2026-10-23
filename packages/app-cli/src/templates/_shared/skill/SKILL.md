---
name: olan-app
description: Build, change, test and package this Olan App (React + @olan-app/sdk running in Olan's sandbox). Use for any change to src/app.tsx, olan-app.json, fixtures or tests, and before calling the work done.
---

# Olan App workflow

This directory is an Olan App (`olan-app.json` + `src/app.tsx`). Read `AGENTS.md` first: it lists
the rules, every component with its props, every `olan.*` call with its permission, and the test
API. Details are offline in `node_modules/@olan-app/sdk/docs/` (`components.md`, `api.md`,
`hooks.md`, `navigation.md`, `database.md`, `permissions.md`, `manifest.md`, `testing.md`,
`errors.md`, `examples.md`; an app with its own server: `remote-requests.md`, `files.md`,
`links.md`, `server.md`) and in `node_modules/@olan-app/sdk/llms.txt`.

SDK 1.5 adds `olan.remote.request` (the app's own server through Olan, `RemoteError` on failure),
`olan.files.pick` / `olan.files.upload` (straight to that server, with progress), `olan.ui.openUrl` /
`openExternal` (return address), `useQuery(…, { refetchIntervalMs })`, and the components `Tabs`,
`Switch`, `MultiSelect`, `Stat`, `Banner`, `Image`, `Avatar` and `ProgressBar` (props in `AGENTS.md`).
SDK 1.6 adds project surfaces (`project.tab`, `project.settings`) and `olan.project.config`. SDK 1.7
lets the app add its records and process to projects it is enabled in: `task.action`, `issue.action`
and `record.card` surfaces, `olan.project.links` (record cards on tasks and issues, moving the task
or issue through the link), `statuses`, `labels`, `calendar`, `activity`, `approvals`
(`projects:extend`), the events `project.task.completed`, `project.issue.*`, `project.approval.decided`
and manifest `projectTemplates`. SDK 1.8 adds `olan.project.fields` (the app's custom fields and the
values of tasks and issues).

## Loop

1. Change `src/app.tsx` (named surface components, only SDK components, text inside `<Text>`,
   data via `useQuery(() => olan.…)` or `useCollection('<collection>')`), and `olan-app.json`
   (`surfaces`, `permissions`, `settings`, `data` for `olan.db` — bump `data.version` on every
   schema change).
2. Add or update `fixtures/*.json` (`db.json` rows must match `data`; `ref:*` values are UUIDs,
   the built-in `p0` project ids are not; the default user is `00000000-0000-4000-8000-000000000001`,
   more people go in `users.json`; the app server's answers go in `remote.json` or
   `renderApp({ remote: remote(routes) })`, picker files in `files.json`) and `tests/*.test.ts` for the behaviour
   (`app.host.data.db`, `app.host.audit()`; `calls()[n].params` is `JsonValue`: cast it, because
   `validate` type-checks tests).
3. `npx olan-app validate --strict --json` — fix every error by its `code`, `file:line` and `hint`
   (`docs/errors.md` explains each code).
4. `npx olan-app test --json` — fix failures (messages include the visible text and what can be
   pressed). Backend code (`server/`) gets `createBackendHarness` tests (`call`, `runSchedule`,
   `emit`, `hook`).
5. Repeat until both return `"ok": true`. Only then is the task done (and only then pack).

## Useful commands

- `npx olan-app docs <query>` — search the SDK docs (e.g. `docs Menu`, `docs updateTask`).
- `npx olan-app dev` — dev server for Olan Studio (Geliştirme sunucuları); stop it when done.
- `npx olan-app pack --dev-sign` — `dist/<id>-<version>.olanapp` signed with the developer's local key.
  Run `validate --strict` first: `pack` runs only the non-strict checks and refuses on their errors.
  Servers install only packages signed with a key they trust (production: Olan Marketplace only;
  a local Olan: the key from `npx olan-app keygen --dev`). Unsigned packages upload but never install.
- `olan app publish --org --dev-sign` — upload to a (development) organization catalog (admins; the Olan CLI signs in).

## Do not

- Import `react-dom`, `react-native`, Node modules, or use `fetch`/`window`/`localStorage`
  (your own server: `olan.remote.request`; other hosts: `olan.http.fetch` with `http:<host>`).
- Send file bytes through `olan.remote.request` (1 MiB limit): upload with `olan.files.upload` to
  an address on the `remote.url` origin.
- Use `style`, `className`, colours or DOM elements.
- Write surfaces as inline arrow functions.
- Leave an `olan.*` call without its permission in `olan-app.json` (`tasks:write`, `tasks:delete`,
  `projects:delete`, `db` for writes, deletions and `olan.db`).
- Retry a `forbidden_record`: default work packages, non-empty work packages and records the
  admin protects cannot be deleted; tell the user "Bu kayıt korunuyor".
- Lower `"sdk"` below `"^1.8.0"` (the current SDK; `olan.db` needs ^1.1.0, `useUser`/`olan.users` ^1.2.0, Phase 3 surfaces, `useSurfaceParams`, `olan.calendar`/`contacts`/`mail`/`meetings`, cards and `@olan-app/sdk/server` ^1.3.0, backend code `server` ^1.4.0, `olan.remote.request`, `olan.files`, `olan.ui.openExternal`, `refetchIntervalMs` and the Phase 5a components ^1.5.0, `project.tab`, `project.settings` and `olan.project.config` ^1.6.0, `task.action`, `issue.action`, `record.card`, `olan.project.links`/`statuses`/`labels`/`calendar`/`activity`/`approvals`, `projects:extend` and `projectTemplates` ^1.7.0, `olan.project.fields` ^1.8.0).
- Put `submit` buttons in a record card (`olan.project.links.upsert`, `approvals.request`): record cards only `open` (`validation_failed`, `invalid_card`).
- In backend code (`server/`): import Node modules, use `fetch`/`setInterval`/globals for state, read
  secrets anywhere but `olan.secrets.get` in the backend, or return a secret to the UI (`docs/backend.md`).
- Guess who is signed in: use `useUser().id` (compare with `createdBy`/`assigneeId`); names need `users:read`.
- Change `id`, or raise `minServerVersion` above `0.1.0` unless the app needs a newer Olan server.

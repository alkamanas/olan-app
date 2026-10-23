# @olan-app/sdk

> Formerly @olan/app-sdk; the old name still builds.

Write Olan Apps in TypeScript and React. An app describes its UI with this package's components;
Olan draws them with its own native controls on web, desktop, iOS and Android. The app runs in a
sandbox and reaches Olan data only through permission-checked `olan.*` calls.

```tsx
import { List, Screen, defineApp, olan, useQuery } from '@olan-app/sdk';

function Projects() {
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const items = (projects.data?.items ?? []).map((p) => ({ key: p.id, title: p.name }));
  return (
    <Screen title="Projeler" loading={projects.loading}>
      <List items={items} emptyText="Henüz proje yok" />
    </Screen>
  );
}

export default defineApp({ app: Projects });   // olan-app.json: "permissions": ["projects:read"]
```

Start a project with `npx olan-app init <name>` (the CLI is `@olan-app/cli`), then
`npx olan-app validate --strict` and `npx olan-app test`.

Unsigned code runs only in development (Studio, `olan-app dev`, "Olan'da dene", with the
`developer` grant). An Olan server installs a package only when it is signed by a key on the
server's trusted list: in production the Olan Marketplace key built into every server, locally your
development key (`npx olan-app keygen --dev`, then `npx olan-app pack --dev-sign`). By default only
organization admins install apps. Manifests declare `"minServerVersion": "0.1.0"`. See
[docs/cli.md](docs/cli.md#signing-and-publishing).

## Documentation (offline, in this package)

The same pages online: https://docs.olan.app (source: https://github.com/alkamanas/olan-app).

| File | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Project layout, rules, the "done" definition |
| [docs/components.md](docs/components.md) | All 23 components and their props, accessibility checks, icon names |
| [docs/api.md](docs/api.md) | `olan.projects`, `chat`, `storage`, `db`, `settings`, `http`, `ui`, `navigation`, `remote`, `files`; data types |
| [docs/database.md](docs/database.md) | `olan.db`: manifest `data`, field types, rules, queries, cursors, schema changes, errors |
| [docs/hooks.md](docs/hooks.md) | `useQuery`, `useCollection`, `useRecord`, `useUser`, `useUsers`, `useNavigation`, `useSettings`, `useTheme`, `useLocale`, `usePlatform`, `useAppContext` |
| [docs/navigation.md](docs/navigation.md) | Multi-screen surfaces |
| [docs/permissions.md](docs/permissions.md) | Permissions and `http:<host>` rules |
| [docs/manifest.md](docs/manifest.md) | `olan-app.json`, surfaces, settings fields, `data`, packages |
| [docs/surfaces.md](docs/surfaces.md) | Where an app appears (chat, mail, calendar, meeting surfaces) and `useSurfaceParams` |
| [docs/cards.md](docs/cards.md) | Static chat cards (`olan.chat.postCard`) |
| [docs/server.md](docs/server.md) | The app's own server: `remote`, signed events, assistant tools, tokens, `@olan-app/sdk/server` |
| [docs/remote-requests.md](docs/remote-requests.md) | `olan.remote.request` and `handleRequest`: the signed envelope, `profile:read`, the answer wrapper, `RemoteError`, limits, an integration checklist |
| [docs/files.md](docs/files.md) | `olan.files.pick` / `upload`: progress, cancel, where uploads may go, the exact request, CORS |
| [docs/links.md](docs/links.md) | `olan.ui.openUrl` / `openExternal`, the return address (`appReturnUrl`), app addresses `/apps/a/<appId>` |
| [docs/backend.md](docs/backend.md) | Backend code that runs on Olan (`server`): `defineBackend`, `olan.*` on the server, secrets, schedules, events, hooks, limits |
| [docs/testing.md](docs/testing.md) | `renderApp`, fixtures, assertions |
| [docs/cli.md](docs/cli.md) | `olan-app` commands, JSON output, dev server, signing and the trusted key list, MCP |
| [docs/errors.md](docs/errors.md) | Every error code with its fix |
| [docs/examples.md](docs/examples.md) | Example apps and complete snippets |
| [llms.txt](llms.txt) | All of the above in one file for coding agents |

`llms.txt` is generated from `docs/` by `npm --workspace @olan-app/cli run llms`
(`packages/app-cli/scripts/build-llms.mjs`); edit the docs, not the digest.

Versions: SDK 1.8.1 (package metadata only: documentation at https://docs.olan.app, source mirror
https://github.com/alkamanas/olan-app; no API changes); 1.8.0 (`olan.project.fields`: the project's custom fields, the app's own by key, and
the values of tasks and issues; the same calls in backend code; fixture projects with `fields`/`fieldValues`;
docs/api.md); 1.7.0 (what an app adds to the projects it is enabled in: the `task.action`, `issue.action`
and `record.card` surfaces, `olan.project.links` (the app's records on tasks and issues with a record
card, moving the task or issue through the link), `olan.project.statuses`/`labels` (the app's own),
`olan.project.calendar` (a calendar layer), `olan.project.activity.post` (feed lines),
`olan.project.approvals` (approval requests), the `projects:extend` permission, the events
`project.task.completed`, `project.issue.opened`/`closed`/`triaged`, `project.approval.decided`, manifest
`projectTemplates`; the same calls in backend code; `olan-app init --template project-records`, fixture
projects with `issues`/`statuses`/`labels`/`links`/`calendarItems`/`approvals` and
`app.host.decideApproval`; docs/surfaces.md#records-on-tasks-and-issues-sdk-17, docs/api.md); 1.6.0 (project extensions: the `project.tab` and `project.settings` surfaces,
`olan.project.config.get/set` and `useProjectConfig()` for the app's settings of one project, the
`project_not_enabled` error for projects the app was not added to, `olan-app init --template project-tab`,
fixture projects with `enabled`/`config`; docs/surfaces.md#project-extensions-sdk-16); 1.5.4 (`olan-app keys register|list|revoke` registers your development key on your
Olan server for `olan-app try`, docs/cli.md; clearer `try` hints; docs: `ProgressBar` label without the
percentage, developer keys, `developer_key_revoked`/`developer_not_member`/`key_exists`; no SDK API
changes); 1.5.3 (`@olan-app/sdk/server`: `handleEvent` drops an installation's cached tokens on
`app.updated`, `app.consent.changed` and `app.uninstalled`; `invalidateToken(installationId)`, `clearTokenCache()`;
`fetchOlan` retries a stale-token 403 (`permission_denied`, `insufficient_scope`) once with a fresh token,
docs/server.md#calling-olan-back; the permission review counts `chat:write` for an app
server with a `chat.card` surface); 1.5.2 (`olan-app try` retries a changed build once under the server's `-dev.N`
`nextVersion` after `409 version_exists`; the dev server's `GET /package?version=`; no SDK API
changes); 1.5.1 (`@olan-app/sdk/server`: `handleRequest` refuses an envelope `issuer` other than
`olan-issuer` (`issuer_mismatch`), `handleToolCall` a body for another tool than the URL's
(`tool_mismatch`), `handleCardAction` a replayed `act_` id (409); `jwks()` key rotation with
`nextPrivateKeyPem`/`additionalPublicKeys` (docs/server.md#rotating-the-app-key); `PROFILE_REQUIRED`;
`validate --strict` and the marketplace count permissions the backend `dist/server.js` uses;
`olan-app try` and the dev server's `GET /package`); 1.5.0 (Phase 5a, `docs/plans/2026-10-18-olan-apps-phase-5a-contracts.md`:
`olan.remote.request` and `RemoteError`, `olan.files.pick`/`upload`/`cancel`, `olan.ui.openUrl`/`openExternal`,
`useQuery(…, { refetchIntervalMs })`, app addresses (`init.navigation`), the `Tabs`, `Switch`, `MultiSelect`,
`Stat`, `Banner`, `Image`, `Avatar` and `ProgressBar` components, Chart/Table/TextField additions,
`@olan-app/sdk/server` `handleRequest`, `appReturnUrl`; `DEFAULT_ISSUERS` is now `['https://api.olan.app']`);
1.4.0 (Phase 3 §15: backend code — `@olan-app/sdk/backend` `olan.*` on the backend
runtime, `olan.backend.call` errors, docs/backend.md); 1.3.0 (Phase 3: the chat, mail, calendar and meeting surfaces with
`useSurfaceParams`, `olan.chat.postCard`/`updateCard`, `olan.calendar`, `olan.contacts`, `olan.mail`,
`olan.meetings`, `olan.projects.create`/`archive`, `@olan-app/sdk/server` for app servers and the
`@olan-app/sdk/backend` types); 1.2.0 added `useUser()` / `context.user`, `olan.users.get`,
`useUsers`, `users:read`; 1.1.0 `olan.db`, `useCollection`/`useRecord`, task create/delete, work
package removal, `isOlanError`), UI protocol 1, manifest schema 1. Apps that use the newer APIs
declare `"sdk": "^1.5.0"` (`olan-app init` writes `^1.8.0`; the project extensions need `^1.6.0`, records, statuses, calendar, feed lines, approvals and project templates `^1.7.0`, `olan.project.fields` `^1.8.0`); older Olan servers answer new calls with `unknown_method`.

**App servers: always pass the issuer explicitly.** `createOlanServer({ issuers: [process.env.OLAN_ISSUER] })`
with the `apps.issuer` of the Olan server's `/.well-known/olan` (Olan's cloud: `https://api.olan.app`).
The default (`DEFAULT_ISSUERS`) is Olan's cloud only; self-hosted and development servers are never in it,
and a request from an issuer that is not listed is rejected.

`@olan-app/sdk/server` and `@olan-app/sdk/backend` run outside a bundler, so they ship compiled in
`dist/` (committed; `npm run build`, a test fails when it is stale). Everything else is TypeScript
source bundled by `olan-app`.

`@olan-app/sdk/memory-db` (`createMemoryDb`) is the in-memory `olan.db` used by the CLI mock
server, Studio and development previews; it is not part of the app bundle.

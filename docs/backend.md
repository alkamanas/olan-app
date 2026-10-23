# Backend code (`server`)

An app may ship backend code that **Olan runs** on its own server: functions the UI calls,
schedules (cron), event handlers and incoming webhooks (hooks). Use it for work that must happen
while nobody has the app open, or that needs a secret. (Your *own* server is `remote`, server.md.)

```jsonc
// olan-app.json
"server": {
  "entry": "server/index.ts",
  "schedules": [{ "name": "digest", "cron": "*/5 * * * *", "timeZone": "Europe/Istanbul" }],
  "events": { "project.task.created": "onTaskCreated" },
  "hooks": [{ "name": "github",
              "verify": { "kind": "hmac-sha256", "header": "x-signature-256", "secretSetting": "hookSecret" } }]
}
```

```ts
// server/index.ts
import { defineBackend, olan } from '@olan-app/sdk/backend';

export default defineBackend({
  // Only what the UI calls (olan.backend.call): everything here is callable from the UI.
  functions: { async summary(args, ctx) { return { count: await olan.db.collection('records').count() }; } },
  // Trigger handlers, keyed by the manifest name.
  schedules: { digest: async (ctx) => { /* ctx.schedule, ctx.scheduledAt */ } },
  events: { 'project.task.created': async (event, ctx) => { /* event.data.task */ } },
  hooks: { github: async (request, ctx) => ({ status: 204 }) },
});
```

In the UI: `const result = await olan.backend.call<Summary>('summary', args)` (no permission).
Full example: `examples/ops-inbox` in the Olan repository.

## Runtime model

- `olan-app build` bundles `server.entry` into `dist/server.js`: one script (esbuild IIFE,
  `globalName: '__olanBackendModule'`, ES2022) with `@olan-app/sdk/backend` inside. Its default
  export must be `defineBackend({ … })`. `pack` adds it to the package (covered by `digest.json` and
  the signature).
- Olan runs it in an isolated sandbox (`@olan-app/runtime`): **isolated-vm** (a V8 isolate) in a
  separate runtime process, or **QuickJS** (WebAssembly) where isolated-vm has no build (Intel Mac,
  Windows ARM; ~10–30× slower on CPU-heavy code). One sandbox per installation; globals may survive
  between calls but are dropped at any time: keep state in `olan.db`.
- Available: ES built-ins, `console.*`, `setTimeout`/`clearTimeout`, `queueMicrotask`,
  `TextEncoder`/`TextDecoder` (UTF-8), `atob`/`btoa`, and `olan.*`. **Not available**: Node modules
  (`fs`, `crypto`, `http`, …), `process`, `require`, `fetch`, `setInterval`, `URL`, `WebAssembly` and
  `Atomics` (by decision: WebAssembly memory escapes the sandbox's memory limit, `Atomics.wait` blocks
  without using CPU time). `olan-app build` fails on Node imports (`build.backend_node_import`).
- **Known limitation**: on servers with a separate Identity service, backend calls to Olan APIs
  (`olan.db`, `olan.projects`, …) fail with `host_error` for now; `secrets`, `settings` and `http.fetch` work.
- **Timers** only run while their call runs: a timer due after the call's deadline never fires and
  pending timers are cancelled when the call returns. Periodic work is a `schedules` entry.
- **Identity**: `backend.call` runs as the calling person with their consented permissions
  (`ctx.identity = { actor: 'user', userId, permissions }`); schedules, events and hooks run as the
  app (`actor: 'app'`, `userId: null`; the app identity sees only projects and chats the app was
  added to, server.md).
- `ctx = { installationId, appId, identity, signal }`. `signal` never aborts: at the deadline Olan
  tears the sandbox down, so nothing of that call runs afterwards.

## Handler resolution

| Trigger | Handler | Arguments |
|---|---|---|
| `olan.backend.call(name, args)` | `functions[name]` only | `(args, ctx)` |
| schedule | `schedules[schedule.name]`, else `functions[schedule.function]` | `(ctx & { schedule, scheduledAt })`, fallback `({ schedule, scheduledAt }, ctx)` |
| event | `events[type]`, else `functions[server.events[type]]` | `(event, ctx)` |
| hook | `hooks[hook.name]`, else `functions[hook.function]` | `(request, ctx)` |
| update | `migrate(fromVersion, ctx)` once after an update, before other calls | |
| lifecycle (`app.installed`, `app.updated`, `app.consent.changed`, `app.uninstalled`) | `events[type]`, else `functions[server.events[type]]`; none: ignored | `(event, ctx)` |

No handler → `not_found` (`backend_function_not_found` in the UI). `olan-app validate` loads
`dist/server.js` in the runtime and fails with `validate.backend_handler_missing` for every
schedule, event or hook without a handler.

Lifecycle events reach every backend, no subscription needed; `app.uninstalled` runs once, just
before the installation is removed (Olan waits ≤ 10 s). **A failed `migrate` is not done**: until it
succeeds, every call of the new version answers `backend_migrating` (503). Olan retries after 30 s,
2 min, 10 min, 30 min and 1 h (6 attempts in all), then an admin or developer retries it (Studio → Backend).

**Put trigger handlers in `schedules` / `events` / `hooks`**, never in `functions`. `function` of a
schedule or hook is optional (a fallback for older apps); the value of `server.events[type]` is
required by the manifest shape but only used as a fallback. **A function named as such a fallback
is not callable from the UI**: `olan.backend.call` answers `backend_function_not_found`, exactly as
for a missing one (on the Olan server, in `olan-app dev`, `renderApp` and `createBackendHarness`).
So the UI can never run a hook handler without its signature check, or a schedule as the person.

## `olan.*` in the backend

Same names, parameters and permissions as in the UI (api.md); each call is checked against the
invocation identity. Host errors throw `OlanBackendError` with `.code` (`permission_denied`,
`http_blocked`, `conflict`, `forbidden_record`, `validation_failed`, `not_found`, …).

| Call | Permission |
|---|---|
| `olan.secrets.get(name)` → `string \| null` | none (only `secret: true` settings) |
| `olan.settings.get()` (secret fields are `null`) | none |
| `olan.db.collection(name)` → `insert`, `get`, `query`, `update`, `delete`, `count` | `db` |
| `olan.http.fetch(url, { method?, headers?, body? })` → `{ status, headers, body, json() }` | `http:<host>` |
| `olan.projects.list/get/tasks/createTask/updateTask/deleteTask/deleteList/create/archive` | as in the UI |
| `olan.users.get(ids)` | `users:read` |
| `olan.chat.conversations/messages/postCard/updateCard` | `chat:read` / `chat:write` |
| `olan.calendar.calendars/events/createEvent/updateEvent/deleteEvent` | `calendar:*` |
| `olan.contacts.addressBooks/search/create/update/delete` | `contacts:*` |
| `olan.meetings.get(meetingId)` | `meetings:read` |
| `olan.project.config`, and (SDK 1.7) `olan.project.statuses/labels/links/calendar/activity/approvals`, (SDK 1.8) `olan.project.fields` | as in the UI (api.md); only projects the app was added to |

Not in the backend: `olan.ui.*`, `olan.navigation.*` (no screen), `olan.storage.*` (per person; use
`olan.db`), `olan.mail.getMessage` (bound to an opened mail surface), `olan.backend.call`.
Importing `@olan-app/sdk/backend` into the UI works for types; its `olan.*` rejects with
`backend_unavailable` there.

## Secrets

`"secret": true` settings of apps that declare `server` never reach the UI: `olan.settings.get()`
and `useSettings()` give `null` for them. Read them in the backend with `olan.secrets.get(name)`
and never return them from a function (return `configured: true` instead). Apps without `server`
keep the old behaviour (the UI receives the value). Locally the values come from
`fixtures/settings.json`: put only dev-only test secrets there (it is not packed). The test tools
record backend calls with secret values replaced by `"[secret]"` (testing.md#backend-tests).

## Schedules

`schedules`: ≤ 10, five-field cron (`minute hour day-of-month month day-of-week`), at least 5
minutes apart, `timeZone` IANA (default UTC). Runs as the app. On a DST change day a run at a
skipped local time does not happen, and one in the repeated hour runs once. Studio's Backend tab has
"Şimdi çalıştır"; locally:
`POST <dev>/backend/schedules/<name>/run`.

## Events

`server.events` maps catalogue event types (server.md#events) to handlers; each needs its
permission (`project.task.*` → `projects:read`, …) and follows the same scope rules as
`remote` events. Delivery retries like webhooks. The handler gets the envelope
`{ id, type, version, occurredAt, installationId, appId, actor, data }`.

## Hooks (incoming webhooks)

`POST /api/v2/apps/hooks/<installationId>/<name>`, body ≤ 1 MiB, 120 requests/min per
installation. Olan verifies the request **before** the function runs:

| `verify.kind` | Check |
|---|---|
| `hmac-sha256` | `verify.header` = `sha256=<hex>`: HMAC-SHA256 over the **raw body bytes** with the `secretSetting` value (hex in any case; the `sha256=` prefix is optional) |
| `standard-webhooks` | `webhook-id`, `webhook-timestamp` (± 5 min), `webhook-signature` `v1,<base64>` (`whsec_` secrets) |
| `none` | development installations only (Studio / `olan-app dev`, or signed with a development key) |

Use a generic header such as `x-signature-256` for your own senders (`x-hub-signature-256` for
GitHub). Sign the exact bytes you send:

```sh
BODY='{"ref":"main"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
# node -e 'console.log(require("crypto").createHmac("sha256",process.env.SECRET).update(process.argv[1]).digest("hex"))' "$BODY"
curl -X POST "$URL" -H 'content-type: application/json' -H "x-signature-256: sha256=$SIG" --data-binary "$BODY"
```

Failures answer `401 hook_verification_failed` (missing secret: `503 hook_secret_missing`). The
function gets `{ method, headers (lower-case), body (raw text), query }` and may return
`{ status, headers?, body? }` within 10 s: `status` 200–599; a string `body` is sent as is
(default `text/plain`), any other JSON value as `JSON.stringify(body)` (default `application/json`);
only `content-type`, `cache-control`, `etag`, `last-modified` and `x-*` headers are kept. Anything
else (no return value, no valid `status`) or no answer within 10 s → `202`; a thrown error → `500`.
`verifyHookSignature` / `signHookRequest` in `@olan-app/sdk/server` implement the same checks.

## Limits

| Limit | Default | Ceiling |
|---|---|---|
| CPU per call (also after `await` and in timers) | 1000 ms | 5000 ms |
| Wall clock, `backend.call` | 10 s | 30 s |
| Wall clock, schedules, events, hooks | 30 s | 30 s |
| Memory (isolate heap) | 64 MiB | 128 MiB |
| Calls at once per installation | 4 | 8 |
| Arguments and result | 256 KiB, JSON only (`undefined` → `null`) | |
| Console | 1000 lines per call, 4 KiB per line | |

Admins may change the defaults per organization, never past the ceilings (`BACKEND_LIMITS` in
`@olan-app/schema`). A limit only stops that call.

## Error codes (`olan.backend.call` → `OlanError.code`)

| Code | Meaning |
|---|---|
| `backend_function_not_found` | No `functions[name]`, or `name` is a trigger's fallback function |
| `backend_error` | The function threw (`message` is its error) or `dist/server.js` does not load |
| `backend_limit` | CPU, wall-clock or memory limit |
| `backend_busy` | Too many calls at once for this installation |
| `payload_too_large` | Arguments or result over 256 KiB |
| `backend_unavailable` | The app has no `server`, or backends are turned off on this server (`OLAN_APPS_BACKEND=0`; the manifest then fails with `manifest.feature_not_available`) |
| `backend_migrating` | The new version's `migrate` has not succeeded yet (`attempts`, `nextAttemptAt`) |

## Logs

`console.log/info/warn/error` lines of every invocation appear in Studio → the app → Backend
(kept 7 days), with each call's trigger, status, CPU and wall time. `olan-app dev` prints them
(`[backend log] …`), the test harness returns them (`result.logs`).

## Local development

```sh
npx olan-app build                    # dist/app.js + dist/server.js
npx olan-app validate --strict        # loads dist/server.js, checks every handler (--engine quickjs|isolated-vm)
npx olan-app test                     # UI tests + tests/*.backend.test.ts (createBackendHarness; --engine)
npx olan-app dev                      # backend runs locally on the mock host; --engine quickjs|isolated-vm
```

`olan-app dev` (cli.md#dev-server): `olan.backend.call` from the preview reaches the local
backend (the Studio preview of an uninstalled app has no installation, so there
`olan.backend.call` fails with `backend_unavailable`: use `olan-app dev` or install the app);
`POST /backend/call` `{ name, args }`, `POST /backend/schedules/<name>/run`,
`POST /backend/events/<type>` `{ data? }`, `POST /hooks/<name>` (verified with the secret from
`fixtures/settings.json`). Where isolated-vm cannot load, the engine falls back with the warning
`isolated-vm prebuild not available on <platform>; using QuickJS (slower)`.

Tests: `createBackendHarness` (testing.md#backend-tests). `renderApp` also runs the backend for
`olan.backend.call`, on the same mock database.

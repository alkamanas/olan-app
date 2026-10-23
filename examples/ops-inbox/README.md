# Operasyon Kutusu

An [Olan](https://olan.app) example app (`com.visetra.ops-inbox`) with **backend code that Olan
runs** (manifest `server`, `node_modules/@olan-app/sdk/docs/backend.md`). Nobody has to keep the
app open: the backend collects new project tasks and GitHub pushes into the app's own database
and writes a digest every five minutes.

- **UI** (`src/app.tsx`, "Operasyon Kutusu"): calls `olan.backend.call('summary')` and shows the
  counts, the latest records and whether the operations API token is set (never the token).
  "Özet oluştur" calls `olan.backend.call('digestNow')`.
- **Backend** (`server/index.ts`, `defineBackend`):
  - `functions.summary`, `functions.digestNow` (UI calls);
  - `schedules.digest` (manifest cron `*/5 * * * *`, Europe/Istanbul): writes a digest row to
    `olan.db` and, when the `apiToken` secret is set, posts it to `https://ops.example.com/digest`
    with `olan.http.fetch` (`http:ops.example.com`);
  - `events['project.task.created']` (manifest `server.events`, needs `projects:read`): records
    the task;
  - `hooks.github` (`POST /api/v2/apps/hooks/<installationId>/github`, `verify: hmac-sha256` on
    `x-hub-signature-256` with the `githubSecret` setting): records pushes; Olan rejects forged
    signatures before the function runs.
  - Trigger handlers live in `schedules`/`events`/`hooks`, never in `functions`: everything in
    `functions` is callable from the UI with `olan.backend.call`.
- **Secrets**: `apiToken` and `githubSecret` are `secret: true` settings. Because the app declares
  `server`, the UI receives `null` for them; only the backend reads them (`olan.secrets.get`,
  and Olan itself for hook verification).

Permissions: `db`, `projects:read`, `http:ops.example.com`. Test data: `fixtures/db.json` (one task,
one push), `fixtures/settings.json` (both secrets), `fixtures/http.json` (the operations API).

```sh
npm install
npm run validate                 # olan-app validate --strict: also loads dist/server.js and checks every handler
npm test                         # UI tests (renderApp runs the real backend) + tests/inbox.backend.test.ts (createBackendHarness)
npx olan-app test --engine quickjs
npm run dev                      # dev server; the backend runs locally:
                                 #   curl -X POST http://localhost:5178/backend/schedules/digest/run
                                 #   POST http://localhost:5178/hooks/github (signed with fixtures/settings.json githubSecret)
npx olan-app pack --dev-sign     # dist/com.visetra.ops-inbox-0.1.0.olanapp (dist/app.js + dist/server.js) for a local Olan
```

On a real Olan: install the package, set both secrets in the installation settings, add the app
to a project (events only arrive for projects the app was added to) and point a GitHub webhook
(content type `application/json`, the same secret) at the hook URL Studio shows. Studio → the
app → Backend lists invocations and console logs and runs the schedule on demand. Agents: read
`AGENTS.md`.

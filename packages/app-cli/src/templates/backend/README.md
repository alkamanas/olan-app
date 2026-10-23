# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `backend` template: a screen that
calls the app's own backend code (`server/index.ts`, manifest `server`) with
`olan.backend.call`, a backend that keeps notes in `olan.db`, an hourly schedule and a secret
setting (`apiToken`) that only the backend can read.

```sh
npm install
npm run validate   # olan-app validate --strict: manifest, build (dist/app.js + dist/server.js), types, handlers, render
npm test           # olan-app test: UI tests and backend tests (createBackendHarness)
npm run dev        # dev server; the backend runs locally (POST /backend/schedules/heartbeat/run)
npm run pack       # dist/{{appId}}-<version>.olanapp with dist/server.js (run validate first)
```

Backend rules and limits: `node_modules/@olan-app/sdk/docs/backend.md`. Agents: read `AGENTS.md`.

# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `remote` template: the UI
(`src/app.tsx`) and **your own Node app server** (`app-server/`, manifest `remote`). The app reads
and writes the server's data with `olan.remote.request` as the signed-in person and uploads files
straight to it (`olan.files.upload`). `server/` would be something else: backend code that Olan
runs for you (manifest `server`, docs/backend.md); this template has none.

```sh
npm install
npm run validate   # olan-app validate --strict (type-checks src/, tests/ and app-server/)
npm test           # olan-app test: UI tests (renderApp + the server's routes) and server tests (createTestIssuer)
npm run server     # node app-server/server.ts on http://127.0.0.1:4100 (Node ≥ 22.18 runs .ts directly)
npm run dev        # dev server; olan.remote.request answers from fixtures/remote.json
npx olan-app dev --remote live          # … or from the running app server, signed by the dev issuer
npx olan-app requests send GET /items   # one signed request to remote.url/requests
```

| Path | What it is |
|---|---|
| `app-server/server.ts` | Node HTTP server: `POST /olan/requests` (`handleRequest`), `PUT /olan/uploads/:id` (upload target, CORS), `GET /.well-known/jwks.json` |
| `app-server/routes.ts` | The routes the app calls (`GET /items`, `POST /items`, `DELETE /items/:id`) and an in-memory store |
| `app-server/tsconfig.json` | Node types for the server; `olan-app validate` type-checks it |
| `tests/app.test.ts` | The UI against the same routes (`renderApp({ remote })`), upload and cancel |
| `tests/server.test.ts` | The server over HTTP with requests signed like Olan's (`createTestIssuer`, `signRemoteRequest`) |

The app server accepts only the Olan servers it lists (`OLAN_ISSUERS`); the CLI's development
issuer is `http://127.0.0.1:5180`. Docs: `node_modules/@olan-app/sdk/docs/remote-requests.md`,
`server.md`, `files.md`. Agents: read `AGENTS.md`.

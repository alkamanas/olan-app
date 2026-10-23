# Medya Masası (Media Desk)

The Olan Apps Phase 5a example (`com.olan.examples.media-desk`, SDK 1.5): an app whose data lives on
its own server and is reached with `olan.remote.request`, with direct file uploads, images, an
external sign-in that returns to the app, and the 1.5 components.

| Where | What |
|---|---|
| `Tabs` "Medya" | `GET /items` through `olan.remote.request`; a sortable `Table` (`format` number / currency TRY / percent, `defaultSort`), a `Card` with `Image` and `Avatar` per ready item. While something is processing, `useQuery(…, { refetchIntervalMs: 10_000 })` refreshes quietly and the tab shows a badge. Failures are a `Banner` (`RemoteError`: `remote_rejected` shows the server's message, `remote_unavailable` "Medya sunucusuna şu anda ulaşılamıyor") with "Yeniden dene" |
| "Yükle" | `olan.files.pick({ accept: ['image/*', 'video/*'], multiple: true, maxFiles: 5, maxBytes: 100 MiB })` (`files:pick`), `TextField maxLength` (title 80, caption 280), `MultiSelect` "Kanallar" (max 3), `Switch` "Hemen yayınla". "Yüklemeyi başlat": `POST /items` → `{ item, upload: { url, method: 'PUT' } }` → `olan.files.upload(file, { url, onProgress })` with a `ProgressBar` and "İptal" (`task.cancel()`; the waiting item is deleted). A 422 `validation_failed` puts the server's issues on the fields |
| "Analiz" | `GET /stats`: `Stat` (number; currency TRY with `deltaGood: 'down'`; percent), `Chart kind="area" stacked valueFormat="currency" currency="TRY"` and a percent line chart |
| "Bağlantı" | `GET /me` shows what `profile:read` shared (name, email, role). "Hesap bağla": `POST /connections/start` → `olan.ui.openExternal(authorizeUrl, { expectReturn: true })` → `POST /connections/complete` with the returned params (the server checks `state`). A return that arrives without a waiting flow opens the app with `useSurfaceParams<'app'>().return` and completes the same way. "Sunucuda aç": `olan.ui.openUrl` |
| Screen `item` | `/apps/a/com.olan.examples.media-desk/item?id=<id>` opens it directly (`init.navigation`); `Image`, `Avatar`, `Stat`, "Sunucuda aç", "Sil" (owners and admins: `user.role`) |

Permissions: `profile:read`, `files:pick` (`remote` is implied by the manifest `remote`). The manifest
sets `"remote": { "url": "http://127.0.0.1:4419/olan", "jwksUrl": "http://127.0.0.1:4419/.well-known/jwks.json", "requests": true }`:
a local Olan delivers to a private address only for development installations with
`OLAN_APPS_REMOTE_ALLOW_PRIVATE=1`, and `http:` uploads, images and links are accepted only there.

```sh
npm install
npm run validate                 # olan-app validate --strict
npm test                         # olan-app test: the app (mock host + the real route table) and the app server (in-process, fake issuer)
npx olan-app pack --dev-sign     # dist/com.olan.examples.media-desk-0.1.0.olanapp for a local Olan trusting your dev key
```

## The app server (`remote-server/`)

```sh
node remote-server/server.ts     # Node ≥ 22.18 (24 recommended): runs the TypeScript directly
```

| Env | Default | |
|---|---|---|
| `PORT` | `4419` | Listens on `127.0.0.1` |
| `OLAN_ISSUERS` | `http://localhost:4000` | Comma-separated Olan servers it accepts (`olan-issuer`). Always list them explicitly: the SDK default is Olan's cloud only (`https://api.olan.app`) |
| `OLAN_WEB_ORIGIN` | — | Olan web origin for return addresses when the issuer's `/.well-known/olan` has no `webOrigin` (Olan before 1.5) |
| `OLAN_WEB_ORIGINS` | `http://localhost:3000` | Comma-separated browser origins allowed to upload (CORS) |
| `PUBLIC_URL` | `http://127.0.0.1:<PORT>` | Base of the upload, media and sign-in URLs it hands out |
| `PROCESSING_MS` | `3000` | An upload is `processing` this long, then `ready` |
| `MEDIA_DESK_DATA_DIR` | `remote-server/.data` | `app-key.json` (the app's Ed25519 key, made on the first start). Items, uploads and connections are kept in memory |

Routes:

- `GET /.well-known/jwks.json`: the app's public key.
- `POST /olan/requests`: `olan.remote.request`, verified and routed by `@olan-app/sdk/server` `handleRequest`
  (issuer allowlist → `kid` → Ed25519 → ±5 min, `body.id === webhook-id`, a repeated `req_` id → HTTP 409).
  Every verified request answers HTTP 200 with `{ status, headers?, body }`; verification failures answer 401
  without the wrapper. Routes (`remote-server/routes.ts`): `GET /me`, `GET /items`, `POST /items` (201,
  422 `validation_failed`), `GET /items/:id` (404 `item_not_found`), `DELETE /items/:id` (204; 403 `not_owner`
  unless owner or admin), `GET /stats`, `GET /connections`, `POST /connections/start` (201
  `{ authorizeUrl, state }`), `POST /connections/complete` (400 `invalid_state`, 409 `connection_denied`),
  `DELETE /connections`. An envelope without `user` (app identity) gets 403 `person_required`.
- `PUT /olan/uploads/:id?token=…`: the `olan.files.upload` target, same origin as `remote.url`. One-time
  token; raw bytes ≤ 100 MiB; the name from `x-olan-file-name` (URL-decoded); answers 201 `{ item }` with
  `etag` and `location`. `OPTIONS` answers the CORS preflight (`Allow-Methods: PUT, POST`,
  `Allow-Headers: content-type, x-olan-file-name`, `Expose-Headers: etag, location`) for `OLAN_WEB_ORIGINS`.
- `GET /olan/media/:id`: the uploaded bytes (`Image` src).
- `GET /oauth/authorize?state=…&return=…`: a stand-in for a network's sign-in page. It accepts only the
  return address stored with `state` and redirects (302) to
  `<return>?state=…&connection=connected&account=@medya-masasi`. The return address comes from
  `olan.appReturnUrl({ issuer, installationId })` = `<webOrigin>/apps/return/<installationId>`.
- `GET /health`, `GET /`: health and a plain page.

The surface tests pass the same route table to `renderApp({ remote: remote(routes) })`, so what the app
sends is what the server gets. (The table converts a thrown `RequestError` itself: the CLI test host
checks `instanceof` against its own bundled copy of the class.)

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/` (`remote-requests.md`, `files.md`, `components.md`, `testing.md`).

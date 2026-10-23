# The app's own server (`remote`)

An app may run its own HTTPS server. Olan then sends it signed **events**, runs its **assistant
tools** there, forwards **card actions** and (SDK 1.5, `"requests": true`) the app's own
**requests** made as the person (`olan.remote.request`, remote-requests.md); the server calls Olan
back with short-lived tokens.

```json
"remote": { "url": "https://standup.example.com/olan", "jwksUrl": "https://standup.example.com/.well-known/jwks.json" },
"events": ["project.task.created", "chat.message.created"],
"permissions": ["projects:read", "chat:read"],
"ai": { "tools": [ { "name": "standup_summary", "title": "Standup özeti", "description": "Summarises today's standup of a project.",
  "input": { "type": "object", "properties": { "projectId": { "type": "string" } }, "required": ["projectId"] },
  "permissions": ["projects:read"], "readOnly": true } ] }
```

- `remote.url`: https. Olan posts to `{url}/events`, `{url}/ai-tools/{name}`, `{url}/card-actions`
  and `{url}/requests`. Its origin is also where uploads (files.md) and `Image` pictures may come from.
  `http://127.0.0.1`, `localhost` and private addresses validate, but Olan only delivers to them
  for development installations on servers with `OLAN_APPS_REMOTE_ALLOW_PRIVATE=1`. An admin may
  point an installation to another copy of the server (`remoteUrlOverride`).
- `remote.jwksUrl`: https, your public keys (JWKS) for token requests.
- `remote` implies the permission `remote` ("Veriler `<host>` adresindeki uygulama sunucusuna
  gönderilebilir"), `ai.tools` implies `ai:tools`. Never list them in `permissions`.
- `events` and `ai.tools` need `remote`. Code that Olan runs for you (no server of your own) is
  `server`: backend.md.

## `@olan-app/sdk/server`

Plain Node ≥ 22 (WebCrypto, no dependencies; also Deno, Bun, edge runtimes). Create one per app.

**Where the code lives.** Your own server is a separate Node program that you run and host. In an
app project keep it in `app-server/` (`olan-app init --template remote` creates `app-server/server.ts`,
`routes.ts` and `tsconfig.json`), **not** in `server/`: `server/` is backend code that Olan runs for
you (manifest `server`, backend.md), bundled into the package. `app-server/` is never packed.
`olan-app validate` type-checks it through `app-server/tsconfig.json` (Node types), next to
`tsconfig.json` and `tests/tsconfig.json`; tests import it (`../app-server/server.ts`).

**Running TypeScript.** Node ≥ 22.18 (and 23.6+) runs `.ts` files directly (`node app-server/server.ts`;
type stripping: no enums or namespaces, relative imports with the `.ts` extension). Older Node 22
needs `node --experimental-strip-types app-server/server.ts`, or compile it first (`tsc`, esbuild).

```ts
import { createServer } from 'node:http';
import { createOlanServer, fromNodeRequest, sendNodeResponse, ToolError } from '@olan-app/sdk/server';

const olan = createOlanServer({
  appId: 'com.example.team-standup',
  privateKeyPem: process.env.OLAN_APP_KEY,          // PKCS#8 Ed25519 (or P-256 / RSA) private key
  issuers: process.env.OLAN_ISSUERS!.split(','),    // every Olan server you accept: always explicit
});

createServer(async (req, res) => {
  if (req.url === '/.well-known/jwks.json') return sendNodeResponse(res, Response.json(await olan.jwks()));
  const request = await fromNodeRequest(req);       // raw body: the signature covers the exact bytes
  if (req.url === '/olan/events') {
    return sendNodeResponse(res, await olan.handleEvent(request, {
      'project.task.created': async (event) => { /* event.data.task */ },
    }));
  }
  if (req.url?.startsWith('/olan/ai-tools/')) {
    return sendNodeResponse(res, await olan.handleToolCall(request, {
      standup_summary: async (input, ctx) => {
        const r = await fetch(`${ctx.issuer}/api/v2/projects/${input.projectId}`,
          { headers: { authorization: `Bearer ${ctx.token.accessToken}` } });
        if (!r.ok) throw new ToolError('not_found', 'Proje bulunamadı');
        return { result: await r.json(), summary: 'Standup özeti hazır' };
      },
    }));
  }
  if (req.url === '/olan/card-actions') {
    return sendNodeResponse(res, await olan.handleCardAction(request, async (action) => ({ toast: { text: 'Kaydedildi' } })));
  }
  if (req.url === '/olan/requests') {                // olan.remote.request (remote-requests.md)
    return sendNodeResponse(res, await olan.handleRequest(request, {
      'GET /standups/:day': async (ctx) => ({ body: await loadStandup(ctx.user!.organizationId, ctx.params.day) }),
    }));
  }
  res.writeHead(404).end();
}).listen(4100);
```

**Always pass `issuers` explicitly**, e.g. `[process.env.OLAN_ISSUER]` with the `apps.issuer` of the
Olan server's `/.well-known/olan` (Olan's cloud: `https://api.olan.app`). The default
`DEFAULT_ISSUERS` is `['https://api.olan.app']` only (since SDK 1.5; `https://olan.app` before):
self-hosted and development servers are never in it, and requests from an issuer that is not
listed are rejected.

Other helpers: `handleRequest` (remote-requests.md), `appReturnUrl({ issuer, installationId })` and
`isAppReturnUrl({ issuer, installationId, url })` for external flows (links.md), `RequestError`,
`matchRemoteRoute` and `runRemoteRoute` (the router `handleRequest` uses).

`await generateAppKey()` (async, WebCrypto) makes a new Ed25519 key: `{ privateKeyPem, publicJwk,
keyId }`; `jwks()` serves its public half. The `kid` defaults to the key's RFC 7638 thumbprint
(`keyId` overrides it). To replace the key without a gap, see
[Rotating the app key](#rotating-the-app-key).

### `createOlanServer(options)`

| Option | Type | Default | Needed for |
|---|---|---|---|
| `appId` **required** | `string` | — | Everything (`iss`/`sub` of client assertions) |
| `issuers` | `readonly string[] \| ((issuer: string) => boolean)` | `DEFAULT_ISSUERS` (`['https://api.olan.app']`) | Always set it (above) |
| `privateKeyPem` | `string` (PKCS#8 PEM: Ed25519, P-256 or RSA) | — | Only `jwks()`, `getInstallationToken()` and `createClientAssertion()`: without it they throw `OlanServerError('no_private_key')`. **Not** needed to verify: `verify`, `handleRequest`, `handleEvent`, `handleToolCall`, `handleCardAction`, `appReturnUrl` work without it |
| `keyId` | `string` | RFC 7638 thumbprint | `kid` of the key in your JWKS |
| `nextPrivateKeyPem`, `nextKeyId` | `string` | — | Key rotation: `jwks()` publishes this key too, tokens are still signed with `privateKeyPem` ([Rotating the app key](#rotating-the-app-key)) |
| `additionalPublicKeys` | `readonly Jwk[]` (each with `kid`) | — | More public keys for `jwks()`, e.g. the retired key while a rotation finishes; private members are dropped |
| `idempotency` | `IdempotencyStore \| false` | `memoryIdempotencyStore()` | Seen `webhook-id`s: `handleEvent` (24 h, a retry is processed once), `handleRequest` (`req_` ids) and `handleCardAction` (`act_` ids), 10 min each (a repeat is a replay: 409 `duplicate_request`); `false` turns the checks off |
| `toleranceSeconds` | `number` | `300` | Allowed clock skew of `webhook-timestamp` |
| `jwksCacheSeconds` | `number` | `600` | Cache of the issuer's `/.well-known/olan` and JWKS |
| `fetch` | `typeof fetch` | global `fetch` | Tests (a fake issuer) |
| `now` | `() => number` | `Date.now` | Tests (ms since the epoch) |

```ts
/** Share one across processes (Redis SET NX EX, a table with a unique key and an expiry). */
interface IdempotencyStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string, ttlSeconds: number): void | Promise<void>;
}
```

Types exported by `@olan-app/sdk/server`: `OlanServer` (what `createOlanServer` returns),
`OlanServerOptions`, `IdempotencyStore`, `OlanServerError` (`code`, `status`, `detail?`),
`VerifiedRequest`, `IncomingRequest` (a WHATWG `Request` or `{ headers, body: string | Uint8Array }`),
`InstallationToken`, `ToolHandler`/`ToolContext`/`ToolOutput`/`ToolError`, `EventHandler(s)`/`EventContext`,
`CardActionHandler`, and for `handleRequest`: **`RemoteRoutes`** (the router object,
`Readonly<Record<"METHOD /path", RemoteRequestHandler>>`), `RemoteRequestHandler`
(`(ctx: RemoteRequestContext) => RemoteRequestResult | void | Promise<…>`), `RemoteRequestContext`,
`RemoteRequestResult` (`{ status?, headers?, body? }`), `RequestError`, plus `RemoteRequestEnvelope`,
`RemoteRequestUser`, `RemoteAnswer`. Helpers: `memoryIdempotencyStore()`, `fromNodeRequest(req, { maxBytes? })`
(1 MiB default; keeps `req.url`), `sendNodeResponse(res, response)`, `cardResponse(card?, toast?)`.
Constants: `DEFAULT_ISSUERS`, `WEBHOOK_HEADERS`, `REQUEST_ID_RETENTION_SECONDS`, `PROFILE_REQUIRED`,
`TOKEN_INVALIDATING_EVENTS`, `STALE_TOKEN_ERRORS` ([Calling Olan back](#calling-olan-back)).

```ts
import type { RemoteRoutes } from '@olan-app/sdk/server';
export const routes: RemoteRoutes = { 'GET /items': async (ctx) => ({ body: await list(ctx.installationId) }) };
```

## Verifying Olan's requests

Every request from Olan (events, tool calls, card actions, requests) is signed (Standard Webhooks, asymmetric):

| Header | Value |
|---|---|
| `webhook-id` | `evt_…` / `call_…` / `act_…` / `req_…`: equals the body's `id`; the same on every retry (requests are never retried) |
| `webhook-timestamp` | Unix seconds of this attempt |
| `webhook-signature` | `v1a,<base64 Ed25519 signature of "<id>.<timestamp>.<raw body>">` (several, space-separated, during key rotation) |
| `olan-issuer` | The Olan server, e.g. `https://olan.example.com` |
| `olan-key-id` | `kid` of the signing key in the issuer's JWKS |
| `olan-installation-id` | The installation |
| `olan-event-type`, `olan-delivery-attempt` | Events only |

`olan.verify(request)` checks, in order: the issuer is in `issuers` → the `kid` is in the issuer's
JWKS (found through `<issuer>/.well-known/olan` → `apps.jwksUri`, cached 10 minutes, refetched
at most once a minute for an unknown `kid`) → the signature → the timestamp is within ±5 minutes.
It throws `OlanServerError` (`issuer_not_allowed`, `unknown_key`, `invalid_signature`,
`timestamp_out_of_range`, `missing_header`, `jwks_unavailable`, `invalid_body`); the `handle*`
helpers answer 401 for these. Keep the issuer list explicit: anyone can run "an Olan server".

The signature covers the id, the timestamp and the body, not the URL. The handlers therefore also
check what the body claims against how it arrived:

| Helper | Check | Answer |
|---|---|---|
| all | `body.id === webhook-id` | 400 `invalid_body` |
| `handleRequest` | the envelope's `issuer` equals the `olan-issuer` header (trailing `/` ignored); you map accounts by it | 401 `issuer_mismatch` (400 `invalid_body` without `issuer`) |
| `handleToolCall` | the tool in the URL (`…/ai-tools/{name}`) equals the body's `tool` | 400 `tool_mismatch` |
| `handleRequest`, `handleCardAction` | the `req_` / `act_` id was not seen in the last 10 minutes (Olan never retries them) | 409 `duplicate_request` |
| `handleEvent` | the `evt_` id was not processed in the last 24 h (Olan retries events) | 200 `{ ok: true, duplicate: true }` |

`handleToolCall` knows the URL from a WHATWG `Request` (`request.url`) or from
`fromNodeRequest(req)`, which keeps `req.url`; for a hand-made `{ headers, body }` add `url`
(the path is enough), otherwise only the body names the tool.

## The `/.well-known/olan` document

`GET <issuer>/.well-known/olan` (public, `Cache-Control: public, max-age=300`) describes an Olan
server. App servers need `apps.issuer`, `apps.jwksUri`, `apps.tokenEndpoint` and `webOrigin`
(`createOlanServer` reads them for you); the CLI and Studio read the rest. An Olan 1.5 server answers:

```json
{
  "apiVersion": 1,
  "serverVersion": "1.5.0",
  "sdkVersions": ["^1.0.0"],
  "apps": {
    "enabled": true,
    "maxPackageBytes": 5242880,
    "surfaces": ["app", "project.widget", "settings", "chat.action", "chat.command", "chat.card", "mail.sidebar", "mail.action", "calendar.event.action", "meeting.panel"],
    "permissions": ["projects:read", "projects:write", "…"],
    "trustedKeyFingerprints": ["3f2957e0dbdd6b87"],
    "builtInKeys": [{ "keyId": "olan-marketplace-2026-10-17", "fingerprint": "3f2957e0dbdd6b87" }],
    "trustedKeys": [{ "name": "olan-marketplace-2026-10-17", "publicKey": "Y/CrYSv6RfoVrZCRFUy6c/JGXsGRtVU9fDOQr8SNHEI=", "fingerprint": "3f2957e0dbdd6b87" }],
    "features": ["db", "record-writes", "remote", "events", "ai-tools", "pim-writes", "project-writes", "app-cards", "remote-requests", "files", "external-return", "app-links"],
    "issuer": "https://api.olan.app",
    "jwksUri": "https://api.olan.app/api/v2/apps/jwks.json",
    "tokenEndpoint": "https://api.olan.app/api/v2/apps/oauth/token",
    "events": ["app.installed", "app.updated", "…"],
    "returnUrlTemplate": "https://olan.app/apps/return/{installationId}",
    "appUrlTemplate": "https://olan.app/apps/a/{appId}"
  },
  "webOrigin": "https://olan.app",
  "catalogUrl": "https://api.olan.app/api/v2/apps/catalog",
  "marketplaceUrl": "https://marketplace.olan.app",
  "revocationsUrl": "https://api.olan.app/api/v2/apps/revocations",
  "marketplaceKeysUrl": "https://api.olan.app/api/v2/apps/marketplace-keys",
  "issuer": "https://api.olan.app"
}
```

| Field | Meaning |
|---|---|
| `apiVersion`, `serverVersion`, `sdkVersions` | Discovery version (1), the server's version (`minServerVersion` is checked against it), SDK ranges its host serves |
| `apps.enabled` | Olan Apps are on for this server |
| `apps.maxPackageBytes`, `apps.surfaces`, `apps.permissions` | Package size limit (5 MiB), the surfaces and permission ids it knows |
| `apps.trustedKeyFingerprints`, `apps.builtInKeys`, `apps.trustedKeys` | Package signing keys it trusts (first 16 hex of sha256 of the raw key); `builtInKeys` cannot be removed (cli.md#signing-and-publishing). Developers' registered keys are not listed: each vouches only for its developer's own development installations |
| `apps.features` | Capabilities; `remote-requests`, `files`, `external-return`, `app-links` since 1.5 |
| `apps.issuer` | **The issuer to list in `issuers`** (`OLAN_PUBLIC_URL`; also `olan-issuer` and the envelope's `issuer`) |
| `apps.jwksUri` | The Ed25519 keys that sign Olan's requests to app servers (`kid` = `olan-key-id`) |
| `apps.tokenEndpoint` | Where `getInstallationToken` posts its client assertion |
| `apps.events` | Event types this server delivers |
| `apps.returnUrlTemplate`, `apps.appUrlTemplate` | Return address of external flows and permanent app address (links.md); since 1.5, only when the web origin is configured |
| `webOrigin` | Origin of Olan's web app (`OLAN_WEB_URL`), e.g. `https://olan.app` for the API `https://api.olan.app`: return addresses and the CORS origin of uploads (files.md). Missing before 1.5 (`appReturnUrl` then throws `web_origin_unknown`) |
| `catalogUrl`, `revocationsUrl`, `marketplaceKeysUrl` | Organization catalog, signed revocation list and marketplace key set (authenticated) |
| `marketplaceUrl` | Olan Marketplace this server uses (null from older servers) |
| `marketplaceOwnership` | Only while an ownership proof runs (then `Cache-Control: no-store`): `{ serverId, challenge, token }` |
| `issuer` | Same as `apps.issuer` |

Older servers may lack the newer fields: read them as optional. The CLI's local issuers
(`events send`, `requests send`, `dev --remote live`, `createTestIssuer` in tests) serve the same shape.

## Events

Delivered to `POST {remote.url}/events` with this body (`data` version 1):

```json
{ "id": "evt_…", "type": "project.task.created", "version": 1, "occurredAt": "…", "issuer": "https://olan.example.com",
  "installationId": "…", "appId": "com.example.team-standup", "actor": { "kind": "user", "id": "…" }, "data": { … } }
```

| Event | Permission | Sent for | `data` |
|---|---|---|---|
| `app.installed`, `app.updated`, `app.uninstalled` | none, always sent | the installation | `{ versionId, version, scope, grantedPermissions, organizationId }` (`organizationId`, the tenant id = `user.organizationId` of requests, since Olan 1.5; `uninstalled`: `{}`) |
| `app.consent.changed` | none, always sent | the installation | `{ userId, permissions, declined }` |
| `chat.message.created` | `chat:read` | conversations the app was added to | `{ conversationId, message: { id, body, senderId, senderKind, createdAt, replyToId, threadRootId, attachments } }` |
| `project.task.created`, `project.task.updated` | `projects:read` | projects the app was added to | `{ projectId, task, changed? }` |
| `project.task.deleted` | `projects:read` | projects the app was added to | `{ projectId, taskId, title }` |
| `project.task.completed` | `projects:read` | projects the app was added to (SDK 1.7) | `{ projectId, task, changed }`: the task moved to a completed status (also sent as `project.task.updated`) |
| `project.issue.opened`, `.closed`, `.triaged` | `projects:read` | projects the app was added to (SDK 1.7) | `{ projectId, issue: { id, key, number, title, kind, state, stateReason, priority, assigneeId, labels, triagedAt, … }, decision? }` (`triaged`: `accepted`, `declined`, `duplicate`, `snoozed`) |
| `project.approval.decided` | `projects:read` | only the installation that asked (`olan.project.approvals.request`, SDK 1.7) | `{ projectId, installationId, approvalId, externalId, linkId, state: approved \| rejected \| cancelled, decisions }` |
| `calendar.event.created`, `.updated`, `.deleted` | `calendar:read` | people whose consent includes it | `{ userId, calendarId, eventId, uid, event? }` |
| `meeting.created`, `.started`, `.ended`, `.cancelled` | `meetings:read` | meetings of consenting organizers or of granted projects | `{ meetingId, slug, title, startsAt, endsAt, organizerId, projectId? }` |

- Answer 2xx within 10 s. Anything else is retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h,
  6 h and 12 h (±20 %, `Retry-After` honoured for 429/503); `410` stops at once. Order is not guaranteed.
- `handleEvent` skips `webhook-id`s it already processed (in memory; pass `idempotency` with a shared
  store when running several processes) and answers 500 when the handler throws, so Olan retries.
- Bodies over 256 KiB cut `chat.message.created` `body` (`truncated: true`). An app does not get
  events it caused itself.

## Assistant tools (`ai.tools`)

The Olan assistant (and Olan's MCP server) lists the tools of apps the person consented to
(`ai:tools` plus each tool's `permissions`) as `app_<slug>_<name>`, where `slug` is the last part
of the app id in `[a-z0-9]` (≤ 16): `app_teamstandup_standup_summary`.

- Manifest: ≤ 16 tools; `name` `^[a-z][a-z0-9_]{1,31}$`; `title` ≤ 80; `description` 1–1024 (the
  model reads it); `input` a JSON Schema with `"type": "object"` (≤ 8 KiB, only local `$ref`);
  `permissions` ⊆ the manifest's; `readOnly` (runs without confirmation, retried once) or
  `destructive` (always confirmed), not both. Other tools are confirmed by the person first.
- Request body: `{ id: "call_…", tool, installationId, appId, issuer, channel: "assistant" | "mcp",
  user: { id, locale, timeZone }, input, token: { accessToken, expiresIn: 300 } }`.
- `timeoutMs` (SDK 1.5): 1000–60000, default 15000; a `readOnly` tool keeps at most 15000
  (`manifest.ai_tool_invalid`). Use it for slow tools that change something (an AI draft).
- Answer HTTP 200 within the tool's timeout: `{ "ok": true, "result": …, "summary"?: "≤ 500" }` or
  `{ "ok": false, "error": { "code", "message" } }`, ≤ 64 KiB. Olan reports `app_tool_timeout`,
  `app_tool_failed` (non-2xx), `app_tool_result_too_large`, `app_tool_unavailable`.
- Tool results are untrusted content for the assistant: writes after them ask for confirmation.

## Card actions

A card's `submit` button (cards.md) posts `{ id: "act_…", issuer, installationId, user: { id, locale },
conversationId, messageId, name, payload, token }` to `{url}/card-actions`; answer within 5 s with
`{ card?, toast? }` (`card` replaces the message's card). Olan sends each action once:
`handleCardAction` answers a repeated `act_` id with 409 `duplicate_request` without running the
handler (ids kept 10 minutes in `idempotency`; share the store across processes).

## Calling Olan back

- **Embedded tokens.** Tool calls and card actions carry `token.accessToken` (300 s, on behalf of the
  person; permissions = the tool's ∩ the person's). Use it as `Authorization: Bearer …` on the routes
  app tokens may call (e.g. `GET <issuer>/api/v2/projects/:projectId`, `…/apps/installations/:id/…`).
- **Installation tokens.** `await olan.getInstallationToken({ issuer, installationId, userId? })` signs
  a client assertion (RFC 7523 `private_key_jwt`: `iss = sub = appId`,
  `aud = <issuer>/api/v2/apps/oauth/token`, ≤ 300 s, single-use `jti`, `olan_installation_id`,
  optional `olan_user_id`) and returns `{ accessToken, expiresIn (≤ 900), permissions }` (cached).
  - Without `userId` (**app identity**): only the app's own `db` collections, `users.get` with
    `users:read`, and the projects and conversations people added the app to (project/chat
    settings → Uygulamalar). Never calendars, contacts, mail, meetings or creating projects.
  - With `userId`: on behalf of that person; fails with `consent_required` until they consented.
  - Errors: `invalid_client` (unknown key, bad signature), `invalid_grant`, `consent_required`.
- **After a grant change.** A cached token keeps the permissions it was issued with (≤ 15 min), so
  after a new version or a consent change the first call needing a new permission would be refused.
  `handleEvent` drops the installation's cached tokens (app identity and every person) on
  `app.updated`, `app.consent.changed` and `app.uninstalled` (`TOKEN_INVALIDATING_EVENTS`) before
  your handler runs. Handling events yourself, or in another process or `createOlanServer` instance
  (one per app id)? Call `olan.invalidateToken(installationId, { issuer? })` (returns how many it
  dropped) or `olan.clearTokenCache()`.
- **`olan.fetchOlan({ issuer, installationId, userId? }, path, init?)`** sends `init` to
  `<issuer><path>` with the installation token (another origin is refused). A 403
  `permission_denied` or `insufficient_scope` (`STALE_TOKEN_ERRORS`: the token predates the grant)
  is retried **once** with a fresh token (bodies must be replayable: string, bytes, `FormData`, …);
  a second refusal and other 403s (`app_project_forbidden`, …) come back unchanged.

## Rotating the app key

Olan verifies your client assertions with the keys at `remote.jwksUrl`, cached 10 minutes and
refetched at most once a minute for an unknown `kid`. Publish the new key before you sign with it:

1. **Publish the next key.** `const next = await generateAppKey()`; store `next.privateKeyPem` as a
   second secret and deploy with
   `createOlanServer({ …, privateKeyPem: CURRENT, keyId: 'app-2026-10', nextPrivateKeyPem: NEXT, nextKeyId: 'app-2027-01' })`.
   `jwks()` now serves both keys (current first); tokens are still signed with the current key.
2. **Wait** at least 10 minutes (Olan's JWKS cache), longer if a CDN caches your `jwksUrl`.
3. **Switch.** Deploy with `privateKeyPem: NEXT, keyId: 'app-2027-01'` and
   `additionalPublicKeys: [{ ...currentPublicJwk, kid: 'app-2026-10' }]` (the old public half,
   e.g. `(await previousServer.jwks()).keys[0]`), so assertions signed by processes that still run
   the old key keep verifying.
4. **Retire.** After every process runs the new key (and at least 5 minutes: an assertion lives
   60 s), drop `additionalPublicKeys` and delete the old secret.

A key that leaked is removed at once instead: switch to the new key without `additionalPublicKeys`.
Tokens issued before stay valid until they expire (≤ 15 minutes). Never reuse a `kid`.

## When the app needs the person's profile

`email`, `displayName` and `role` reach `handleRequest` only with `profile:read`
(remote-requests.md#the-person-user). When a route needs them and they are missing, answer the
generic error `profile_required` (exported as `PROFILE_REQUIRED` by `@olan-app/sdk/server` and
`@olan-app/sdk`) instead of creating an account from `user.id` alone:

```ts
import { PROFILE_REQUIRED, RequestError } from '@olan-app/sdk/server';

'POST /connections/start': async (ctx) => {
  if (!ctx.user?.email) throw new RequestError(409, { error: PROFILE_REQUIRED, message: 'Profil izni gerekli' });
  …
},
```

The app gets a `RemoteError` `remote_rejected` with `status` 409 and
`details.error === PROFILE_REQUIRED`, and explains that the app needs "Profilinizi görme".

## Self-hosted Olan servers

Each Olan server signs with its own key and is its own issuer (`OLAN_PUBLIC_URL`): add every
server you serve to `issuers`. Olan servers that the internet cannot reach still deliver to you,
but embedded tokens only work where your server can reach that Olan. Deliveries follow the
organization's egress rules.

## Developing locally

```sh
npx olan-app events send project.task.created        # signed event to remote.url/events (sample data from fixtures)
npx olan-app events send chat.message.created --data @event-data.json --to http://127.0.0.1:4100/olan
npx olan-app tools call standup_summary --input '{"projectId":"p0"}'
npx olan-app requests send GET "/standups/2026-10-18?team=web"   # olan.remote.request to remote.url/requests
npx olan-app dev --remote live                       # the dev server forwards the app's remote.request calls
```

They sign with your development key and serve its JWKS from a local issuer
`http://127.0.0.1:5180` while the request runs (for `dev --remote live`, while dev runs): add it to
`issuers` in development (`issuers: ['https://olan.example.com', 'http://127.0.0.1:5180']`). The
embedded token is a placeholder (`olan-app-dev-token`); calls back to Olan need a local Olan server.
MCP: `olan_app_event_send`, `olan_app_tool_call`, `olan_app_request_send`. Automated server tests:
`createTestIssuer` and `signRemoteRequest` (remote-requests.md#testing-the-app-server).

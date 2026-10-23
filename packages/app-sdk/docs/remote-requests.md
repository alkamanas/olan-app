# Remote requests (`olan.remote.request`)

An app with its own server (`remote`, server.md) can ask that server for data **as the person using
the app** (SDK 1.5). The sandbox never sees a token and the app server never sees Olan's cookie:

```
sandbox ── olan.remote.request ──▶ Olan host ──▶ Olan server ── signed POST {remote.url}/requests ──▶ app server
        ◀── { status, headers, body } ◀────────────────────────── HTTP 200 { status, headers?, body } ◀──
```

Olan checks the installation, the person's consent and the limits, signs an envelope with the
person's identity and a 300 s token, posts it, and passes the app server's answer back. Olan never
retries a request.

## Manifest

```json
"sdk": "^1.5.0",
"remote": { "url": "https://media.example.com/olan", "jwksUrl": "https://media.example.com/olan/jwks.json", "requests": true },
"permissions": ["profile:read"]
```

- `remote.requests: true` turns the call on (default `false`; without it every call fails with
  `permission_denied`, "manifest does not declare remote.requests").
- No permission of its own: it uses the implied `remote` permission. An admin who blocks `remote`
  blocks it (`permission_denied`).
- `profile:read` (optional) adds the person's email, name and role to the envelope (below).
- UI only: backend code (`server`, backend.md) has no `olan.remote`; it uses `olan.http.fetch`.

## Calling it

```tsx
import { isRemoteError, olan, useQuery } from '@olan-app/sdk';

const items = useQuery(() => olan.remote.request({ method: 'GET', path: '/items', query: { status: ['ready', 'processing'] } }), []);
// items.data: { status: 200, headers: { 'content-type': 'application/json' }, body: [...] }

const created = await olan.remote.request({
  method: 'POST',
  path: '/brands/b1/posts',
  body: { text: 'Merhaba' },
  headers: { 'idempotency-key': draftId },
  timeoutMs: 60_000,                 // a slow AI draft; default 30 s
});
```

| Field | Rule |
|---|---|
| `method` **required** | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` |
| `path` **required** | Starts with `/`, ≤ 2048, no `?`, `#`, `\`, `//`, `.`/`..` segments, encoded `/` or control characters. Put parameters in `query`, encode segments with `encodeURIComponent` |
| `query` | `Record<string, string \| number \| boolean \| (string \| number \| boolean)[]>`, ≤ 50 keys (≤ 128 characters each), ≤ 100 values per key. The app server gets strings (`true` → `"true"`) |
| `headers` | Only `accept`, `accept-language`, `if-match`, `if-none-match`, `idempotency-key` (names lower-cased, values one line ≤ 1024). Others: `invalid_params` |
| `body` | Any JSON value, ≤ 1 MiB serialised (`payload_too_large`); not with `GET` and `DELETE` |
| `timeoutMs` | Integer 1000–60000, default 30000 |

The result (`RemoteResponse`) is `{ status, headers: { 'content-type'?, etag? }, body }` for an app
server status **200–399**. `body` is the app server's JSON as it is (`null` when it had none).

## Errors: `RemoteError`

Every failure rejects with a `RemoteError` (a subclass of `OlanError`, so `isOlanError` is true too):

| `code` | When | `status` | `details` |
|---|---|---|---|
| `remote_rejected` | The app server answered 400–499 | its status | its `body` |
| `remote_unavailable` | The app server answered 500–599 (`reason: 'http_status'`), or no usable answer: `reason` `timeout`, `network`, `invalid_response` (not the wrapper below, not JSON, HTTP status other than 200), `response_too_large` (> 4 MiB) | its status, else `0` | its `body`, else `null` |
| `consent_required` | The person has not consented to the app yet | `403` | `null` |
| `permission_denied` | No `remote.requests`, or `remote` is blocked by policy | `403` | `null` |
| `feature_not_enabled` | The organization's plan does not include the app's feature | `403` | `null` |
| `payload_too_large` | `body` over 1 MiB | `413` | `null` |
| `rate_limited` | Over 300 requests a minute, or 8 at once, per person and installation; `retryAfterSeconds` says when to retry | `429` | `null` |
| `invalid_params` | A field breaks the rules above | `400` | `null` |
| `not_installed`, `cancelled`, `host_error`, `unknown_method` | As for every call (errors.md); `unknown_method` on an Olan server before 1.5 | | |

```tsx
try {
  await olan.remote.request({ method: 'POST', path: '/items', body: draft });
} catch (error) {
  if (isRemoteError(error, 'remote_rejected') && error.status === 422) {
    setIssues((error.details as { issues?: Issue[] } | null)?.issues ?? []);   // the server's 422 body
  } else if (isRemoteError(error, 'remote_unavailable')) {
    setBanner(error.reason === 'timeout' ? 'Sunucu yanıt vermedi' : 'Sunucuya ulaşılamıyor');
  } else throw error;
}
```

`RemoteError`: `code`, `message`, `status: number`, `details: JsonValue`, `reason?` and
`retryAfterSeconds?`. `isRemoteError(error, code?)` narrows an unknown error. In `useQuery` the
`RemoteError` is in `query.error`.

## The app server: `handleRequest`

```ts
import { createOlanServer, RequestError } from '@olan-app/sdk/server';

const olan = createOlanServer({
  appId: 'com.example.media-desk',
  privateKeyPem: process.env.OLAN_APP_KEY,
  issuers: (process.env.OLAN_ISSUERS ?? '').split(',').filter(Boolean),   // always explicit
});

// POST {remote.url}/requests
const response = await olan.handleRequest(request, {
  'GET /items': async (ctx) => ({ body: await listItems(ctx.user!.organizationId) }),
  'POST /items': async (ctx) => ({ status: 201, body: await createItem(ctx.user!, ctx.body) }),
  'GET /items/:id': async (ctx) => {
    const item = await findItem(ctx.params.id);
    if (!item) throw new RequestError(404, { error: 'item_not_found' });
    return { body: item, headers: { etag: `"${item.revision}"` } };
  },
  'GET /files/*': async (ctx) => ({ body: await describe(ctx.params['*']) }),   // the rest of the path
});
```

`request` is a WHATWG `Request`, or `{ headers, body: Uint8Array }` from `fromNodeRequest(req)`
(server.md); the answer is a `Response` (`sendNodeResponse(res, response)` in Node).

- `handleRequest(request, router)` verifies the request (below), checks the envelope (`id` equals
  `webhook-id`, `installationId`, `appId`, `request.method`, `request.path`; `issuer` equals the
  `olan-issuer` header, else HTTP 401 `{ error: 'issuer_mismatch' }`), refuses a repeated
  `req_` id with **HTTP 409** `{ error: 'duplicate_request' }` (ids are kept 10 minutes in the
  `idempotency` store; pass a shared one when you run several processes), then routes.
- Routes are `"METHOD /path"`: `:name` matches one segment (decoded into `ctx.params.name`), a
  trailing `/*` the rest (`ctx.params['*']`), `*` as the method any method. The first matching route
  in declaration order wins: list specific routes first. `router` may also be one function.
- Unknown path: `status: 404` `{ error: 'unknown_route' }`; known path, other method: `status: 405`
  `{ error: 'method_not_allowed' }`. Both are wrapped (HTTP 200), so the app sees `remote_rejected`.
- A route returns `{ status?, headers?, body? }` (`status` default 200, 200–599; `body` default
  `null`). `throw new RequestError(status, body?, headers?)` answers that status; any other
  exception answers `status: 500` `{ error: 'internal_error' }` (the app sees `remote_unavailable`).
- Answer within the request's `ctx.timeoutMs` (default 30 s, at most 60 s): Olan gives up then.

The route context (`RemoteRequestContext`):

| Field | |
|---|---|
| `id` | `req_<uuid>`, also the `webhook-id` |
| `issuer` | The Olan server (`https://api.olan.app` for Olan's cloud) |
| `installationId`, `appId` | The installation that called |
| `user` | `{ id, organizationId, locale, timeZone, email?, displayName?, role? }`; `null` for an app-identity call (none in SDK 1.5: every request comes from a person) |
| `method`, `path`, `params` | The request and the route's parameters |
| `query` | `Record<string, string \| string[]>` (normalised) |
| `headers` | Only the allowed request headers, lower-case |
| `body` | JSON, `null` when none |
| `token` | `{ accessToken, expiresIn: 300 }` on behalf of the person: call Olan back (server.md#calling-olan-back) |
| `timeoutMs` | What the app asked for |

### The person (`user`)

- `user.id` is the central Olan user id (the OIDC `sub` of "Olan ile giriş yap") and
  `user.organizationId` the tenant id. Map them to your accounts as `(issuer, user.id)` and
  `(issuer, user.organizationId)`: ids are unique per issuer only.
- `locale` (`tr`, `en-US`) and `timeZone` (IANA) are always present.
- `email`, `displayName` and `role` are present **only** when the person's permissions include
  `profile:read` (permissions.md); otherwise the keys are missing. `email` is the Olan account's
  address (verified by Olan). `displayName` is missing when the person has none. `role` is
  `'admin'` (organization admins) or `'member'`.
- Without `profile:read`, do not create accounts from `user.id` alone if you need an email; answer
  the generic `409 { error: 'profile_required' }` (`throw new RequestError(409, { error: PROFILE_REQUIRED })`,
  server.md#when-the-app-needs-the-persons-profile) and let the app explain it: it gets
  `remote_rejected` with `error.details.error === PROFILE_REQUIRED` (exported by `@olan-app/sdk`).
- No `user` means the app identity (Phase 3 tokens): never act on behalf of a person then.

## The envelope

`POST {remote.url}/requests` (the installation's `remoteUrlOverride` applies), signed like events
(server.md#verifying-olans-requests):

```
POST https://media.example.com/olan/requests
content-type: application/json
webhook-id: req_5f0c2a8e-1b7d-4c31-9b0e-2f7d8c1a9e44
webhook-timestamp: 1792310400
webhook-signature: v1a,<base64 Ed25519 signature of "<webhook-id>.<webhook-timestamp>.<raw body>">
olan-issuer: https://api.olan.app
olan-key-id: olan-apps-2026-10-17
olan-installation-id: 6d3f8e2a-0c4b-4f7e-9a51-3b2c1d0e9f87
```

```json
{
  "id": "req_5f0c2a8e-1b7d-4c31-9b0e-2f7d8c1a9e44",
  "issuer": "https://api.olan.app",
  "installationId": "6d3f8e2a-0c4b-4f7e-9a51-3b2c1d0e9f87",
  "appId": "com.example.media-desk",
  "user": { "id": "0b7a1c2d-…", "organizationId": "9c8b7a6d-…", "locale": "tr", "timeZone": "Europe/Istanbul",
            "email": "utku@example.com", "displayName": "Utku Gökcan", "role": "admin" },
  "request": { "method": "POST", "path": "/brands/b1/posts", "query": { "draft": "true", "channel": ["instagram", "tiktok"] },
               "headers": { "idempotency-key": "c1f2" }, "body": { "text": "Merhaba" }, "timeoutMs": 60000 },
  "token": { "accessToken": "eyJhbGciOi…", "expiresIn": 300 }
}
```

No `olan-event-type` or `olan-delivery-attempt` header. Verify in this order: issuer in your
allowlist → `kid` in the issuer's JWKS → signature over the raw bytes → timestamp within ±5 minutes
→ `body.id === webhook-id` → `body.issuer` is the `olan-issuer` header → the `req_` id not seen in the last 10 minutes (a repeat is a replay,
since Olan never retries). `handleRequest` does all of it.

## The answer: the JSON wrapper

To every **verified** request the app server answers **HTTP 200**, `content-type: application/json`:

```json
{ "status": 201, "headers": { "content-type": "application/json", "etag": "\"v7\"" }, "body": { "id": "post_9", "status": "draft" } }
```

- `status`: the app's own status, an integer 200–599 (404 "no such brand", 422 validation …).
- `headers`: optional; Olan passes only `content-type` and `etag` to the app.
- `body`: any JSON value, `null` when none. The raw answer is ≤ 4 MiB.
- A request that fails verification gets **HTTP 401** `{ error, message }` without the wrapper; a
  malformed envelope HTTP 400; a replayed id HTTP 409.
- Any HTTP status other than 200, a body that is not the wrapper, more than 4 MiB or no answer in
  time is `remote_unavailable` for the app (`reason`: `http_status`, `invalid_response`,
  `response_too_large`, `timeout`, `network`).

The wrapper keeps your own statuses apart from transport failures (a 401 signature error, a 502
proxy, a missing `/requests` route). A server that already has an HTTP API can forward the request
internally and wrap that answer (`{ status: res.statusCode, headers: res.headers, body: res.json() }`).

Without the SDK (another language), follow the same rules: verify as above, answer the wrapper,
keep seen ids 10 minutes.

## Limits

| Limit | Value |
|---|---|
| Request body | 1 MiB (JSON) |
| App server answer | 4 MiB |
| Timeout | 30 s default, 1–60 s |
| Rate | 300 a minute and 8 at once per person and installation (`rate_limited`, `Retry-After`) |
| Path / query | 2048 characters / 50 keys, 100 values per key |
| Replay window | Keep `req_` ids ≥ 10 minutes |

Olan writes an audit row per request (`remote.request { method, status, durationMs, errorCode? }`);
paths, queries, headers and bodies are never stored.

## Issuers: always pass them explicitly

`createOlanServer({ issuers })` decides which Olan servers you accept. Always set it, e.g.
`issuers: [process.env.OLAN_ISSUER]` with the `apps.issuer` of the Olan server's
`/.well-known/olan` (Olan's cloud: `https://api.olan.app`). The default (`DEFAULT_ISSUERS`,
`['https://api.olan.app']`) is Olan's cloud only; self-hosted and development servers (e.g.
`http://localhost:4000`, the CLI's `http://127.0.0.1:5180`) are never in it, and a request from an
issuer that is not listed is rejected (`issuer_not_allowed`, HTTP 401).

## Testing

**The app.** `renderApp({ remote })` runs `olan.remote.request` against routes in the same
`"METHOD /path"` format (or `fixtures/remote.json` answers), with the same wrapper and `RemoteError`
mapping; `app.host.remoteRequests` holds each envelope and answer (testing.md#remote-requests-files-and-links).
Pass your server's own routes object to test the UI against the real route code.

### Testing the app server

`@olan-app/cli/testing` has a local Olan issuer for server tests (`olan-app init --template remote`
writes this test): `createTestIssuer()` serves `/.well-known/olan` (with `webOrigin`) and the JWKS
of a fresh Ed25519 key on `127.0.0.1` and returns `{ issuer, keyId, jwk, wellKnown(), sign(), close() }`;
`signRemoteRequest(issuer, input, options?)` returns `{ headers, body, envelope }`, exactly what Olan
posts to `{remote.url}/requests`. Your server lists `issuer.issuer` in `issuers` and verifies the
requests over the real JWKS: no mocks, no private key on the app server.

```ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createTestIssuer, signRemoteRequest, type TestIssuer } from '@olan-app/cli/testing';
import { createOlanServer } from '@olan-app/sdk/server';

import { routes } from '../app-server/routes.ts';

let issuer: TestIssuer;
before(async () => { issuer = await createTestIssuer(); });     // { webOrigin?, port?, keyId? }
after(() => issuer.close());

test('routes a signed request', async () => {
  const olan = createOlanServer({ appId: 'com.example.media-desk', issuers: [issuer.issuer] });
  const signed = signRemoteRequest(issuer, {
    appId: 'com.example.media-desk',
    request: { method: 'POST', path: '/items', body: { title: 'Lansman' } },
    // installationId (default 'mock-installation'), user (default the mock person; null = no user), token, id
  });
  const response = await olan.handleRequest({ headers: signed.headers, body: signed.body }, routes);
  assert.equal(response.status, 200);                                    // HTTP 200 + the wrapper
  assert.equal(((await response.json()) as { status: number }).status, 201);
  // Over HTTP instead: await fetch(`${baseUrl}/olan/requests`, { method: 'POST', headers: signed.headers, body: signed.body })
});

test('refuses forged requests', async () => {
  const olan = createOlanServer({ appId: 'com.example.media-desk', issuers: [issuer.issuer] });
  const forged = (options: Parameters<typeof signRemoteRequest>[2]) =>
    olan.handleRequest(signRemoteRequest(issuer, { appId: 'com.example.media-desk', request: { method: 'GET', path: '/items' } }, options), routes);
  assert.equal((await forged({ badSignature: true })).status, 401);                               // invalid_signature
  assert.equal((await forged({ timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);  // timestamp_out_of_range
  assert.equal((await forged({ issuer: 'https://evil.example' })).status, 401);                   // issuer_not_allowed
  assert.equal((await forged({ keyId: 'other' })).status, 401);                                   // unknown_key
  assert.equal((await forged({ webhookId: 'req_other' })).status, 400);                           // id ≠ webhook-id
});
```

- `input.user` defaults to `{ id: DEFAULT_USER_ID, organizationId: DEFAULT_ORGANIZATION_ID, locale: 'tr',
  timeZone: 'Europe/Istanbul' }` (no profile fields); pass `email`/`displayName`/`role` to test
  `profile:read`, `null` for an envelope without a person.
- `input.request` is normalised like Olan does (`query` values become strings, header names
  lower-case); params Olan would refuse throw. Each call gets a new `req_` id; sending the same
  `signed` twice is a replay (409).
- The signature covers `body` byte for byte: send it unchanged.
- Types: `TestIssuer`, `TestIssuerOptions`, `RemoteRequestSignInput`, `RemoteRequestSignOptions`
  (`timestamp`, `badSignature`, `keyId`, `issuer`, `webhookId`), `SignedRemoteRequest`.
- By hand: `olan-app requests send POST /items --body '{"title":"Lansman"}'` against the running
  server (cli.md), or `olan-app dev --remote live` for the whole app.

## Integration checklist (an existing service as the app server)

1. Manifest: `"sdk": "^1.5.0"`, `"remote": { "url", "jwksUrl", "requests": true }`, `profile:read`
   if you map people by email, `files:pick` for uploads (files.md).
2. `POST {remote.url}/requests`: `handleRequest` (or the same rules), issuers from configuration
   (`https://api.olan.app`), a shared `idempotency` store if you run more than one process.
3. Map the person: `(issuer, user.id)` → your account, `(issuer, user.organizationId)` → your
   workspace. `email`/`displayName`/`role` only with `profile:read`; without them, do not create
   accounts: answer a 4xx the app can explain.
4. No `user` = the app identity: never act as a person.
5. Route only an allowlist of your API (`"GET /brands"`, `"POST /brands/:brandId/posts"` …); forward
   internally and wrap the answer. Your 4xx bodies (e.g. 422 `{ issues }`) reach the app as
   `RemoteError.details`.
6. Answer within the app's `timeoutMs`; long jobs (AI drafts, campaign creation) send
   `timeoutMs: 60000`, or answer 202 and let the app poll (`useQuery(…, { refetchIntervalMs })`, hooks.md).
7. Uploads: issue a one-time upload URL on the `remote.url` origin (or a host the manifest grants
   as `http:<host>`), read the name from `x-olan-file-name`, allow CORS from Olan's web origin (files.md).
8. Images (`Image`, `Avatar`) come from the `remote.url` origin or an `http:<host>` host (components.md).
9. External sign-in (OAuth of a network): build the return address with
   `olan.appReturnUrl({ issuer, installationId })`, keep and check your own `state`, accept a
   caller-given `returnUrl` only when `olan.isAppReturnUrl(…)` is true (links.md).
10. `app.installed` / `app.updated` events carry `organizationId`: link the installation to the
    workspace there (server.md#events).

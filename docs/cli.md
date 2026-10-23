# CLI (`olan-app`)

`@olan-app/cli` is a dev dependency of every app, so `npx olan-app <command>` works offline. The
Olan CLI forwards `olan app <command>` to it (and passes your Olan sign-in to `publish --org` and `login --marketplace`).
Node.js 22 or newer.

Every command accepts `--json` (machine-readable output), `--cwd <dir>` and `--help`. Commands
that need an app look for `olan-app.json` in the directory or its parents. The marketplace commands
(`login`, `developer`, `keys`, `publish`/`status --marketplace`, `release`, `rollout`, `halt`, `withdraw`) print the marketplace's answer unchanged
with `--json`; every other command uses the `{ ok, … }` envelope (Output).

| Command | What it does |
|---|---|
| `init <name> [--template blank\|list-detail\|project-widget\|project-tab\|project-records\|external-api\|data-list\|backend\|remote] [--backend] [--id <id>] [--dir <dir>] [--link <packagesDir>]` | New app from a template (with AGENTS.md, CLAUDE.md, agent skills, tests, fixtures). `--backend` = `--template backend` (UI + `server/index.ts`, backend code Olan runs, backend.md). `remote`: UI + your own Node app server in `app-server/` (`handleRequest` routes, an upload target, UI and server tests; server.md, remote-requests.md). `--link` (or `OLAN_APP_PACKAGES_DIR`) writes `file:` dependencies on `<dir>/app-sdk` and `<dir>/app-cli` (monorepo development) |
| `validate [--strict [--verbose]] [--no-build] [--no-typecheck] [--engine auto\|isolated-vm\|quickjs]` | Manifest, build, entry/icon files, size, `tsc --noEmit`; with `server`: loads `dist/server.js` in the backend runtime and checks every schedule, event and hook has a handler (`backend` check); `--strict` also renders every surface with the mock host (running the backend for `olan.backend.call`) and checks component props and missing permissions, then runs Olan Marketplace's static review checks on the files `pack` would package (size, files, forbidden APIs, permissions, accessibility, licenses; the marketplace's codes, errors.md; `--verbose` prints info findings) |
| `test [pattern] [--engine auto\|isolated-vm\|quickjs]` | Runs `tests/**/*.test.ts` (testing.md), backend tests (`createBackendHarness`, `tests/*.backend.test.ts`) and app-server tests included; `--engine` picks their engine. A test file whose process crashes after all its tests passed is a `test.process_crashed` warning, not a failure. `--report <file> [--package <pkg>]` packs first, then writes a signed test report for the marketplace (marketplace.md#signed-test-reports) |
| `build [--no-minify]` | Bundles `src/app.tsx` into `dist/app.js` (one classic script with React and the SDK inside) and, with `server`, `server.entry` into `dist/server.js` (IIFE `__olanBackendModule`, no Node modules: `build.backend_node_import`) |
| `dev [--port 5178] [--host 127.0.0.1] [--server <olan web url>] [--open] [--engine auto\|isolated-vm\|quickjs] [--remote fixtures\|live] [--issuer-port 5180] [--detach]` | Watches and rebuilds; serves the app to Olan Studio (and, with `--host 0.0.0.0`, to a phone on your network); with `server` runs the backend locally (below). `olan.remote.request` is answered from `fixtures/remote.json`, or with `--remote live` by your app server at `remote.url` (below). Stopping: below |
| `pack [--out <file>] [--dev-sign \| --sign-key <file> \| --no-sign] [--no-build] [--no-validate]` | Runs the non-strict `validate` checks first and refuses on errors (`pack.validation_failed` plus the errors; `--no-validate` skips them), then writes `dist/<id>-<version>.olanapp`; `--dev-sign` signs with your development key, otherwise it signs when `olan-app.key.json` exists. Pack does not render surfaces: run `validate --strict` before it |
| `keygen --dev [--force]` | Creates (or shows) your development key in `~/.olan/olan-app-dev.key.json` (`OLAN_APP_DEV_KEY` overrides) and prints the `OLAN_APPS_TRUSTED_KEYS` line for a local Olan |
| `keygen [--out olan-app.key.json] [--force]` | Creates an Ed25519 key in the app and adds it to `.gitignore` (installs only where a server trusts it) |
| `sign --key <private-key.pem> [--key-id <id>] <package.olanapp>` | **Internal** (Olan's own apps): signs an existing package with an Ed25519 PEM key (below) |
| `login --marketplace [url] --server <api> [--no-browser] [--token <t>]` | Signs in to Olan Marketplace with your Olan account (in the browser unless `--token`/`OLAN_TOKEN`); saves a 30-day developer session (marketplace.md) |
| `developer create --marketplace [url] --slug <slug> --name <name> [--kind person\|company] --accept-agreement`, `developer list` | Creates a marketplace developer account (you become its owner) / lists yours |
| `publish --marketplace [url] [--developer <slug>] [--channel stable\|beta] [--percent N] [--visibility public\|org\|organization:<serverId>/<organizationId>] [--file <pkg>] [--test-report <file>] [--age-rating 4+|9+|13+] [--no-wait]` | Packs (unsigned) and submits to Olan Marketplace: automatic checks, review, signing; attaches a signed test report. Production path (marketplace.md) |
| `release`, `rollout`, `halt`, `withdraw` `--marketplace [url] <appId> <version>` | Release an approved version (`release [--channel stable\|beta] [--percent N]`), widen a staged rollout (`rollout --percent N`: 10 → 50 → 100), halt it, withdraw a submission (marketplace.md#releasing-and-rollout) |
| `keys register\|list\|revoke <id> [--server <api>] [--token <t>] [--name <n>]` | Registers your development key's public half on your Olan server (the server and token of `try`): it signs only your own development installations in your organization (below); `revoke` is final and stops them. With `--marketplace [url] [--developer <slug>]` (`register\|list\|remove <fingerprint>`): on a marketplace developer account instead (signed test reports show as verified) |
| `status --marketplace [url] <appId> [version] [--wait-decision]` | Submission state, checks, review level, next action (the exact command), rejection and findings; exit 1 on `checks_failed`, `rejected`, `withdrawn` |
| `app show|set --marketplace [url] <appId> [--age-rating 4+|9+|13+] [--category <id>] [--platforms <list>] [--support-url <u>] [--privacy-url <u>]` | Shows or changes the app's store settings; the age rating is required before `release`; for a live app the change is reviewed first ("in review") |
| `publish --org [--server <api url>] [--token <t>] [--file <pkg>] [--dev-sign]` | Packs and uploads to an organization catalog (admins; development and offline servers). Token from `--token` or `OLAN_TOKEN`, server from `--server`, `OLAN_SERVER` or `OLAN_API_URL`. Warns when the server will not install the version |
| `try [--server <api url>] [--token <t>]` | Packs (validate + build, like `pack`), signs with your development key and installs the app for your organization on a development server (`POST <server>/api/v2/apps/developer/try`, multipart `package`; needs developer access and a server that trusts the key). Same server and token as `publish --org`. Prints the app address `<webOrigin>/apps/<installationId>` (below) |
| `revocations sign --dev --in list.json [--out revocations.json]` | Development only: signs a revocation list with your development key (below) |
| `events send <type> [--to <url>] [--data <json\|@file>] [--installation <id>] [--attempt <n>] [--id <evt_…>] [--issuer-port 5180]` | Sends one signed event to the app's own server (`{remote.url}/events`), signed with your development key; a local issuer `http://127.0.0.1:5180` serves its JWKS meanwhile (server.md#developing-locally). Non-2xx: `events.delivery_failed` |
| `tools call <name> [--input <json\|@file>] [--to <url>] [--user <id>] [--channel assistant\|mcp]` | Calls an `ai.tools` tool on the app server like the Olan assistant and checks input and answer |
| `requests send <METHOD> <path[?query]> [--body <json\|@file>] [--query <json>] [--headers <json>] [--user <id>] [--profile\|--no-profile] [--role admin\|member] [--timeout <ms>] [--to <url>] [--issuer-port 5180]` | Sends one signed `olan.remote.request` envelope to `{remote.url}/requests` (development key, local issuer `http://127.0.0.1:5180`) and reads the answer as Olan does: prints the `{ status, headers, body }` wrapper and what the app gets (the response or a `RemoteError`). `--profile` (default: when the manifest has `profile:read`) adds `email`, `displayName`, `role`. No usable answer (401, not the wrapper, not running): `requests.delivery_failed`. Git Bash rewrites `/items` into a Windows path: use `MSYS_NO_PATHCONV=1` or `//items` there |
| `docs <query> [--limit 8]` | Searches these docs offline |
| `mcp` | MCP server over stdio (below) |

## The agent loop

1. Edit `src/app.tsx` (and `olan-app.json`, `fixtures/`, `tests/`).
2. `npx olan-app validate --strict --json` — fix every error (each has `code`, `file`, `line`, `hint`).
3. `npx olan-app test --json` — fix failing tests or the app.
4. Repeat until both report `"ok": true`. That is "done".

## Output

Without `--json`: results on stdout, progress and problems on stderr as
`file:line:column code: message` plus `hint:` lines.

With `--json`, stdout holds exactly one JSON object (for marketplace commands the marketplace's answer, marketplace.md):

```json
{ "ok": true, "command": "validate", "result": { … }, "warnings": [ … ] }
{ "ok": false, "command": "validate", "errors": [{ "code": "tree.unknown_prop", "message": "…", "file": "src/app.tsx", "line": 12, "column": 5, "hint": "…" }], "result": { … } }
```

`dev --json` prints the envelope on one line, then one JSON line per event
(`{"type":"rebuilt","buildId":"…","durationMs":…}`, `{"type":"error","errors":[…]}`,
`{"type":"manifest"}`, `{"type":"log","level":"info","args":[…],"at":"…"}`).

Exit codes: `0` success, `1` the command failed (errors), `2` usage error (unknown command or
option).

`validate --json` result: `{ app: { id, version }, strict, checks: [{ name, ok, skipped? }],
bundleBytes, surfaces: [{ surface, rendered, nodes, calls: [{ method, ok, code? }], text }], review? }`;
`--strict` adds `review: { findings: [{ check, code, severity, message, path?, hint?, rule? }], usage }`
(every marketplace finding, info included); review issues in `errors`/`warnings` carry `rule`.
Checks: `manifest`, `build`, `files`, `size`, `backend` (with `server`), `typescript`, `strict`. With `server` the result also has
`backend: { bytes, engine, handlers: { functions, schedules, events, hooks, migrate } }`; `build --json` has
`backend: { file, bytes, sha256 }`; `pack` puts `dist/server.js` in the package.

`pack --json` result: `{ file, bytes, sha256, signed, publicKey, keyFingerprint, files: [{ path, bytes, sha256 }] }`
(`files` are the app files; the archive also holds `digest.json` and, when signed, `signature.json`:
"3 app files (+ digest, signature)"),
plus `devKey: { file, created, fingerprint, envLine }` with `--dev-sign`. `sign --json` result:
`{ file, bytes, sha256, publicKey, keyFingerprint, keyId, signedAt, replaced }`. `publish --json` adds
`trust` (the server's verdict, below). `test --report --json` adds `report: { file, appId, appVersion,
packageSha256, package, keyFingerprint, keyFile, keyCreated }`.

## dev server

`olan-app dev` listens on `http://localhost:5178` (127.0.0.1 only). `--host 0.0.0.0` listens on
every interface and prints the LAN addresses (`result.lanUrls`) for the Olan mobile app's direct
mode (development builds); anyone on that network can then reach the server, so use it only on a
trusted network.

| Endpoint | |
|---|---|
| `GET /manifest` | The parsed `olan-app.json` (422 `{ error: 'manifest_invalid', issues }`) |
| `GET /app.js` | Latest successful bundle (503 `{ error: 'build_failed', errors }`) |
| `GET /package` | That bundle (and, with `server`, the backend) packed and signed with your development key: `application/octet-stream`, `content-disposition: attachment; filename="<id>-<version>.olanapp"`, `x-olan-package-sha256`, `x-olan-signing-key` (fingerprint). Studio's "Bu kurumda dene" uploads it. `?version=<semver>` packs and signs it with that `version` in the packaged `olan-app.json` (the server-named `-dev.N`; the file on disk is not changed; otherwise 400 `version_invalid`). 503 `build_failed` while a build fails, 422 `manifest_invalid` |
| `GET /status` | `{ appId, version, buildId, errors, builtAt, user: { id } }`; hosts using `/rpc` send `user` as `context.user` |
| `GET /fixtures` | The mock data |
| `POST /rpc` | `{ method, params, permissions? }` → the mock host's answer |
| `POST /logs` | `{ entries: [{ level, args, at }] }` (≤ 100 entries, ≤ 8 KiB each) → 204; printed as `[app <level>] …` (`--json`: `log` events) |
| `ws://localhost:5178/ws` | `{ type: 'rebuilt', buildId }`, `{ type: 'error', errors }`, `{ type: 'manifest' }`; with a backend also `{ type: 'backend', kind, name, ok }`, `backend-built`, `backend-error` |

With `server` (backend.md) the backend runs locally in `@olan-app/runtime` on the same mock host
(`olan.backend.call` through `/rpc` reaches it), is rebuilt when files under `server/` change, and
every invocation is printed with its console lines (`backend schedule digest: ok (4 ms)`,
`  [backend log] …`; `--json`: `backend-invocation` events). `--engine` forces an engine; `auto` falls
back to QuickJS where isolated-vm has no prebuild and prints
`isolated-vm prebuild not available on <platform>; using QuickJS (slower)`. `dev` bundles the
backend in memory, unminified (it writes no `dist/server.js`): its `sha256` differs from the
minified `dist/server.js` of `olan-app build`.

| Endpoint | |
|---|---|
| `GET /backend` | `{ engine, sha256, errors, schedules, hooks, events }` (also `status.backend`) |
| `POST /backend/call` | `{ name, args?, permissions? }` → `{ ok, value \| error, logs, cpuMs, wallMs }` (`result`: alias of `value`); a trigger's fallback function answers `backend_function_not_found` |
| `POST /backend/schedules/<name>/run` | Run a schedule now → `{ ok, value \| error, logs, cpuMs, wallMs }` |
| `POST /backend/events/<type>` | `{ data? }` (default: sample data from the fixtures) → the handler's outcome |
| `POST /hooks/<name>` | Raw body ≤ 1 MiB: verified like Olan does (secret from `fixtures/settings.json`), then the hook's answer, or `202` after 10 s |

In Olan open Studio (`/studio`, needs developer access from an admin), add the address under
"Geliştirme sunucuları", and the preview reloads on every save. `--open` opens
`<server>/studio?dev=<dev url>`.

**Remote requests in dev.** By default `dev` answers `olan.remote.request` (through `/rpc`) from
`fixtures/remote.json`, like tests do. `--remote live` sends each call to your running app server
instead: a signed envelope to `{remote.url}/requests` from the development issuer
`http://127.0.0.1:<--issuer-port, 5180>` (your development key; it runs as long as `dev` and serves
its `/.well-known/olan` and JWKS), read with Olan's rules (HTTP 200 + wrapper, ≤ 4 MiB, the call's
`timeoutMs`). List that issuer in the server's `issuers`. Each call is printed
(`remote GET /items → 200 (12 ms)`; `--json`: `{"type":"remote","message":…}`); a 401 means the
issuer is not listed. The envelope's `installationId` is `00000000-0000-4000-8000-0000000000a1` and
the token a placeholder.

**Stopping `dev`.** Ctrl+C or SIGTERM. On Windows Ctrl+C works in Windows Terminal, PowerShell and
cmd; closing the terminal window, or ending the shell or agent process that started `dev`, also
stops it within 2 s (it watches its parent process), so no orphaned server keeps the port. With
`--detach` it keeps running: stop it with `Stop-Process -Id <pid>` (PowerShell) or
`taskkill /PID <pid> /T /F` (the PID of the `node` process listening on 5178:
`netstat -ano | findstr :5178`), or `kill <pid>` elsewhere.

## Signing and publishing

An Olan server installs and runs a package only when its Ed25519 signature verifies **and** the
signing key is on the server's trusted key list (`OLAN_APPS_TRUSTED_KEYS`). The public key inside
`signature.json` proves nothing by itself. Every Olan server ships with the **Olan Marketplace key** built in (key id `olan-marketplace-2026-10-17`); `OLAN_APPS_TRUSTED_KEYS` can add keys but cannot remove the built-in one, which is revoked only through the marketplace revocation list (Phase 4a).
In production the list holds the **Olan Marketplace key only**: every app, organization-only apps included, is reviewed and signed by Olan Marketplace
(Phase 4). There is no organization key, and an administrator's approval does not replace the
signature.

| Package | Upload to a catalog | Install / run |
|---|---|---|
| Signed with a trusted key | accepted | yes |
| Unsigned | accepted, marked "İmzasız" | no: `package_unsigned` |
| Signed with another key | accepted, marked "Bilinmeyen anahtar" | no: `package_untrusted_key` |
| Bad signature or digest | rejected: `package_invalid` | — |

Trust is checked again on every install, version change, bundle and app-token request, so a key
removed from the list stops its apps. Unsigned code runs only in development: Studio, `olan-app dev`
and "Olan'da dene" (`/apps/dev`), for people with the `developer` grant, under a "Geliştirme" label.

Who installs: catalog uploads are for admins, and an organization without an install policy is **admin only** by default until an admin lets members install (Olan → Yönetim → Uygulamalar).

Local development with your own Olan:

```sh
npx olan-app keygen --dev             # once: ~/.olan/olan-app-dev.key.json, prints the env line
# add the printed line to the local Platform API environment and restart it:
#   OLAN_APPS_TRUSTED_KEYS=dev-local=<your public key>
npx olan-app keys register            # or instead: register the key on the server (your development installations only)
npx olan-app validate --strict && npx olan-app test
npx olan-app pack --dev-sign          # dist/<id>-<version>.olanapp, signed with the development key
npx olan-app publish --org --dev-sign --server http://localhost:4000 --token "$OLAN_TOKEN"
olan app publish --org --dev-sign     # the same with the Olan CLI signed in (sets OLAN_TOKEN and --server)
npx olan-app try --server http://localhost:4000 --token "$OLAN_TOKEN"   # install it for your organization now
```

**Trying an app in your organization.** `olan-app try` packs and dev-signs like `pack --dev-sign`,
then uploads to `POST <server>/api/v2/apps/developer/try` (multipart field `package`, the same bearer
token as `publish --org`). The server installs it for your organization and answers
`{ installationId, appId, version }`; `try` prints `Open: <webOrigin>/apps/<installationId>`
(`webOrigin` from `/.well-known/olan`; without it, open Olan → Uygulamalar). `--json` result:
`{ server, endpoint, file, installationId, appId, version, appUrl, keyFingerprint }`. Refusals come
back as `try.<error>` (e.g. `try.developer_required`) or the package issue codes. Studio does the same
from a running `olan-app dev` ("Bu kurumda dene" uploads `GET /package`). **Developer keys:** instead of `OLAN_APPS_TRUSTED_KEYS`, register the key on the server once (`olan-app keys register`, or Studio → Geliştir → "Geliştirici anahtarları"). It vouches only for your own development installations (`try`) in your organization, while you are a member and until you revoke it; then they stop (`developer_key_revoked` / `developer_not_member`) but are not deleted. It never vouches for catalog uploads (`publish --org`), marketplace packages or other people.

**Development versions (`-dev.N`).** A version in the organization's catalog never changes. When you
try a changed build under a version the catalog already holds, the server answers
`409 version_exists` with `nextVersion`, the next free development prerelease of that app
(`1.2.0` → `1.2.0-dev.1`, then `1.2.0-dev.2`, …; a `-dev.N` version counts on from the same base).
`olan-app.json` is part of the signed digest, so the server cannot rename the package: `try` packs
and signs the same build again with `version` set to `nextVersion` and uploads it once more (the
`file` and `version` of the result name it; `olan-app.json` on disk is not changed). Studio asks the
dev server for `GET /package?version=<nextVersion>` and does the same. A second conflict, or a server
that names no `nextVersion`, is reported as `try.version_exists`: raise `version` yourself. To ask
first: `GET <server>/api/v2/apps/developer/try/next-version?appId=<id>&version=<version>` →
`{ appId, version }` (the version itself while the catalog does not hold it). The catalog upload
(`publish --org`) keeps a plain `version_exists`.

`/.well-known/olan` lists the fingerprints of the keys a server trusts
(`apps.trustedKeyFingerprints`); `pack` prints your key's fingerprint to compare. Never add a
development key to a production server. `olan-app keygen` without `--dev` writes a key into the
app (`olan-app.key.json`, git-ignored) for servers that are configured to trust it, such as an
offline test server.

**Internal: signing Olan's own apps.** Until Olan Marketplace signs packages itself, Olan signs its own apps with the marketplace key: `npx olan-app pack --no-sign`, then `npx olan-app sign --key <marketplace.pem> --key-id olan-marketplace-2026-10-17 dist/<id>-<version>.olanapp`. `sign` reads an unencrypted PKCS#8 Ed25519 PEM (`-----BEGIN PRIVATE KEY-----`, e.g. `openssl genpkey -algorithm ed25519`) and refuses other key types and encrypted keys, verifies the package digest, then writes `signature.json` (replacing an existing one; other files stay byte-identical). `--key-id` becomes `keyId`, the key's name on the server's trusted list (1-64 letters, digits, `.`, `_`, `-`); it is informational, servers trust the public key. The private key stays in memory only: never printed, logged, copied or stored. App developers use `pack --dev-sign` instead.

**Revocation lists (development).** Olan Marketplace signs the list of revoked apps; servers and
the mobile app refuse to open a revoked version. To try this locally:

```sh
echo '[{ "appId": "com.example.my-app", "versions": ["0.1.0"], "reason": "Test" }]' > list.json
npx olan-app revocations sign --dev --in list.json --out revocations.json
```

The output is `{ "payload": "<JSON text>", "signature": { "keyId": "dev-local", "algorithm": "ed25519", "signature": "…" } }`,
signed over the payload text with your development key. `--in` holds the entries (`appId`, then
`versions` or `packageSha256` or neither for every version, `reason`, `revokedAt`?) or
`{ issuedAt?, expiresAt?, sequence?, entries }`; missing values become now, now + 48 h and the time
in seconds. Only development builds accept such a list.

`publish` prints a warning (`publish.package_unsigned`, `publish.package_untrusted_key`) when the
server stored the version but will not install it. Server rejections come back as
`publish.<error>` (e.g. `publish.version_exists`: bump `version`) or the package issue codes.

## Olan Marketplace

The production path: `login --marketplace` once (browser sign-in or the Olan CLI; CI uses the saved session as `OLAN_MARKETPLACE_SESSION`), `developer create` once, `keys register` once per computer, then `test --report`, `publish --marketplace --test-report`, `status --marketplace`, `app set --age-rating` once and, after approval, `release`. Sign-in, the
marketplace address order, `--visibility`, the `--json` answers, `nextAction`, review levels and
every automatic check with its finding codes: marketplace.md. Error codes: errors.md#olan-marketplace.

## MCP server

`olan-app mcp` gives Claude Code and Codex the same tools over stdio:

```sh
claude mcp add olan-app -- npx olan-app mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.olan-app]
command = "npx"
args = ["olan-app", "mcp"]
```

| Tool | Input | Returns |
|---|---|---|
| `olan_app_validate` | `{ dir?, strict? = true }` | validate result or errors |
| `olan_app_build` | `{ dir? }` | build result |
| `olan_app_test` | `{ dir?, pattern? }` | test summary |
| `olan_app_render` | `{ dir?, surface?, params?, permissions?, fixtures?, settings?, userId?, locale?, theme?, now? }` | `{ surface, tree, text, calls, toasts, navigation, errors }`; becomes the session |
| `olan_app_dispatch` | `{ action: 'press' \| 'fill' \| 'select' \| 'submit' \| 'back', label?, value? }` | the new view of the session |
| `olan_app_logs` | `{}` | session logs, errors, calls; last build and test |
| `olan_app_db` | `{ collection?, where?, limit? }` | the session's mock `olan.db`: collections with row counts and usage, or the rows of one collection (every user's, with owner), newest first (default 50, max 500) |
| `olan_app_event_send` | `{ type, dir?, to?, data?, installationId?, attempt?, id?, issuerPort? }` | the signed event, HTTP status and the app server's answer |
| `olan_app_tool_call` | `{ name, dir?, input?, to?, userId?, channel?, issuerPort? }` | the tool's answer (`{ ok, result \| error }`) |
| `olan_app_request_send` | `{ method, path, dir?, query?, body?, headers?, timeoutMs?, userId?, profile?, role?, to?, issuerPort? }` | the signed envelope, the app server's wrapper and what the app gets (`requests send`) |
| `olan_app_docs_search` | `{ query, limit? }` | matching doc sections |

Every tool answers `{ ok, result }` or `{ ok: false, errors }` as JSON text.

# Olan Marketplace

Apps reach production Olan servers through Olan Marketplace: automatic checks run on the package, a person reviews it, and the marketplace signs the approved version with the marketplace key.

```sh
npx olan-app login --marketplace --server https://api.example.com   # once: browser sign-in, 30-day session
npx olan-app developer create --marketplace --slug acme --name "Acme Ltd" --accept-agreement   # once
npx olan-app keys register --marketplace    # once per computer: your development key signs test reports
npx olan-app validate --strict && npx olan-app test --report test-report.json   # packs, then tests
npx olan-app publish --marketplace --test-report test-report.json   # submits, attaches, waits for the checks
npx olan-app status --marketplace com.example.my-app --wait-decision
npx olan-app app set --marketplace com.example.my-app --age-rating 4+   # once: required before release
npx olan-app release --marketplace com.example.my-app 1.0.0 --percent 10   # after approval
```

Reviewers apply review-guidelines.md (rule numbers like `2.1` in findings and rejections). **Studio** does the same in the browser: sign in to your Olan web app (e.g. `https://olan.example.com`) with an account that has developer access (the `developer` grant), open `<Olan web address>/tr/studio?section=publish` (Studio → Yayınla): developer accounts, store settings and page, submissions, test reports, releases.

## Signing in

The marketplace trusts your Olan server: `login` gets a 5-minute identity token from the server (`POST /api/v2/apps/marketplace/identity-token`; your account needs the `developer` grant from an admin) and exchanges it for a developer session. There are three ways to give `login` your Olan sign-in:

1. **Browser (default).** `olan-app login --marketplace --server <Olan API address>` opens the browser at the server's sign-in page (OAuth 2.0 authorization code with PKCE; the endpoints come from `<server>/.well-known/openid-configuration`, client `olan-app-cli`) and receives the answer on `http://127.0.0.1:<random port>/callback`. `--no-browser` only prints the address; open it in a browser **on the same computer** (the redirect goes to 127.0.0.1). The CLI waits 5 minutes.
2. **Olan CLI.** `olan app login --marketplace` with the Olan CLI signed in (`olan auth login`) passes your access token (`OLAN_TOKEN`) and server. Every `olan app …` command needs an Olan CLI that has the `app` command (`olan app --help` works; Olan Apps 4a release or newer); with an older `olan` use `npx olan-app …` and 1.
3. **CI.** Olan has no personal access tokens or API keys to create for CI, and `olan` does not print its token. CI uses a marketplace session instead: run `olan-app login --marketplace --server <api>` once on your computer (browser), then store the contents of `~/.olan/marketplace.json` (or only its `token`) as the CI secret `OLAN_MARKETPLACE_SESSION`; it replaces the file, lasts 30 days (sign in again and update the secret before `expiresAt`) and is all `publish`, `status`, `app`, `release`, `keys` need. `OLAN_TOKEN` / `--token` is only an input to `login` (an Olan access token the Olan CLI passes); CI never needs it.

The server is `--server`, else `OLAN_SERVER`, else `OLAN_API_URL` (the Olan CLI sets them). The session is saved in `~/.olan/marketplace.json` (`{ url, token, expiresAt, userRef, … }`, mode 0600; on Windows restricted to your user with `icacls`, best effort) and lasts 30 days. No token is ever printed or logged, and the session token is not accepted on the command line.

**Marketplace address**, first of: `--marketplace <url>`, `OLAN_MARKETPLACE_URL`, the saved session's marketplace (`publish`, `status`, `developer`), the server's `/.well-known/olan` `marketplaceUrl` (when a server is known: `login --server`, `OLAN_SERVER`, `OLAN_API_URL`), `https://marketplace.olan.app`.

## Developer accounts

Apps belong to a developer account (a person or a company); you can be a member of several.

- `olan-app developer create --marketplace [url] --slug <slug> --name <name> [--kind person|company] --accept-agreement` creates one and makes you its owner. `--slug` is the developer name in app pages (a-z, 0-9 and `-`, 2-63 characters; `olan…` is reserved). Creating an account accepts the current developer agreement; `--accept-agreement` is required and the CLI reads the version from `GET /api/v1/developer/me`.
- `olan-app developer list` shows your accounts, roles, agreement state and pending invites (invites are accepted in Studio → Yayınla).

## Publishing

- **publish.** A new app needs a developer account; `--developer <slug>` picks one when you have several. Existing apps get a new version (versions only go up). `--channel stable|beta [--percent N]` releases on approval. `--visibility public` (default) or `--visibility organization:<serverId>/<organizationId>` limits a new app to one organization on one Olan server; `--visibility org` fills both from the session (the server must be registered with the marketplace). Visibility is set when the app is created; later in Studio. `publish` waits while the checks run (`--no-wait` does not) and exits 1 with the findings on `checks_failed`. `--age-rating 4+|9+|13+` sets the app's age rating after uploading.
- **Version numbers.** A `checks_failed`, `rejected` or withdrawn version may be submitted again under the same number (it was never signed); one that is in review, approved or released may not (`version_exists`), and a new version must be higher than the latest (`version_not_increasing`). Organization catalog uploads (`publish --org`) always need a new number (manifest.md).
- **status.** Without a version: the newest. Prints the state, each check's status, the review level and reasons and `Next:` with the exact command (rejections too, on stderr before the findings). Exit 0 for `approved`, `checking`, `in_review`; 1 for `checks_failed`, `rejected`, `withdrawn`. `--wait-decision` polls every 5 s until a decision.
- **Store settings.** `olan-app app show --marketplace <appId>` and `olan-app app set --marketplace <appId> [--age-rating 4+|9+|13+] [--category <id>] [--platforms web,desktop,ios,android] [--support-url <url>] [--privacy-url <url>]` (developer role; `PATCH /api/v1/developer/apps/:appId`). Before the first release the change applies at once; for an app live in the public store it is reviewed first (`202 { pendingChange }`, printed as "in review"). Studio → Yayınla → the app → Mağaza sayfası is the same.
- **`--json`** prints the marketplace's answer unchanged (no `{ ok, … }` envelope): `publish` → `{ app, version, createdApp, submission }` (the submission as last polled; with `--test-report` also `testReport`; with `--age-rating` also `storeSettings`), `app` → `{ app, pendingChange? }`, `status` → `{ version, submission }`, `keys` → `{ key }` / `{ keys }`, `login` → `{ url, expiresAt, user, developers, sessionFile }`, `developer list` → `{ user, developers, agreement, invites }`, `developer create` → `{ developer }`, errors → `{ error, message, issues?, hint? }`.

## Releasing and rollout

After approval (`status` says `nextAction: release`), with an owner or admin role. **The app needs an age rating first** (4+, 9+ or 13+; guideline 5.4): `olan-app app set --marketplace <appId> --age-rating 4+`, `publish --marketplace --age-rating 4+`, or Studio → Yayınla → the app → Mağaza sayfası; without it `release` fails with `age_rating_required`.

- `olan-app release --marketplace [url] <appId> <version> [--channel stable|beta] [--percent N]`: publish to a channel (default `stable`, 100%). `--percent 10` is a staged rollout: only that share of servers get it (chosen deterministically per server). `beta` reaches only the organizations on the app's beta list (Studio → Yayınla).
- `olan-app rollout … --percent N`: widen it (10 → 50 → 100). It never narrows (`rollout_invalid`); it also resumes a halted rollout.
- `olan-app halt --marketplace <appId> <version>`: no new servers get the version; installed copies stay.
- `olan-app withdraw --marketplace <appId> <version>`: take back a submission still `checking` or `in_review`.

Each prints the marketplace answer with `--json` (`{ version }`, `withdraw`: `{ submission }`; errors `{ error, message }`) and exits 0 on success, 1 on failure (2: unknown option).

## Signed test reports

The marketplace cannot run your own tests (a package has no sources), so you attach their result, bound to the exact package and signed with your development key:

1. `olan-app keys register --marketplace [--developer <slug>] [--name <name>]` registers the public half of `~/.olan/olan-app-dev.key.json` (`OLAN_APP_DEV_KEY` overrides; created on first use) with the developer account. `keys list` and `keys remove <fingerprint>` manage them. (Without `--marketplace`, `keys register` registers the key on your Olan server for your development installations instead: cli.md.)
2. `olan-app test --report test-report.json` packs the app first (unsigned, into `.olan-app/report/`; a signature does not change `digest.package`), runs the whole suite and writes the report. Generate it **after** your last source change: `publish` packs the same sources to the same `digest.package`; a report for another build is refused (`test_report_mismatch`). `--package <file>` binds it to a package you packed yourself (for `publish --file`). Failing runs still write a report (and exit 1); reviewers see the failures.
3. `olan-app publish --marketplace --test-report test-report.json` checks the report locally, submits, then attaches it (`PUT …/versions/:version/test-report`, only while `checking`/`in_review`). `--json` adds `testReport` (`{ status: verified|unregistered_key, keyFingerprint, summary, failed }`).

The file is `{ payload, signature: { algorithm: "ed25519", publicKey, signature, keyId } }`: `payload` is the JSON text of `{ version: 1, appId, appVersion, packageSha256, generatedAt, tool: { cli, runner }, summary: { passed, failed, skipped, durationMs }, tests: [{ file, name, status, durationMs?, error? }] }`, signed over its UTF-8 bytes (`@olan-app/schema` `TestReportDocument`, `verifyTestReport`). A registered key shows as `verified` to reviewers, any other as `unregistered_key`.

## Submissions

A submission has `state`, `reviewLevel`, `reviewReasons`, `checks` (the report below), `rejection` (`{ rule, code, notes, findings }`), `release`, `testReport`, `notes` (reviewer notes) and `nextAction`. `checks` is null while checking, then `{ version: 1, passed, startedAt, finishedAt, usage: { rpcMethods, permissionsUsed, permissionsUnused, httpHosts }, checks: [{ id, status: passed|warning|failed|skipped, durationMs, findings: [{ check, code, severity, message, path?, rule?, hint? }] }] }` (`@olan/contracts` `OlanAppCheckReport`), one entry per check below.

| `nextAction` | Meaning |
|---|---|
| `wait` | `checking` or `in_review`: automatic checks or a reviewer are working |
| `fix_and_resubmit` | `checks_failed` or `rejected`: fix the findings, publish again (same version allowed) |
| `release` | `approved` without a release: `olan-app release` (or Studio → Yayınla) |
| `none` | `approved` and released (on approval or with `olan-app release`) |
| `resubmit` | `withdrawn`: publish again |

`reviewLevel` is `light` or `full`. `reviewReasons` say why a review is full: `first_version`, `new_permissions` (permissions the last approved version did not have), `unverified_developer`, `security_findings` (a warning or error under guideline 1.x).

## Automatic checks

Every submission runs these checks on the package (the same static checks the marketplace shares with `@olan-app/schema`). `checks.passed` is false when any finding is an `error`; warnings go to the reviewer; `info` findings are notes. Each finding has `check`, `code`, `severity`, `message`, and often `path`, `rule` (the guideline, e.g. `2.1`) and `hint`.

| Check | Looks at | Common codes |
|---|---|---|
| `manifest` | `olan-app.json`, digest, signature and package layout (the server's install validation) | `manifest.*`, `package.*` (errors; the other checks are skipped) |
| `size` | Package and entry size (≤ 5 MiB) | `size.package_too_large` (error), `size.entry_large` (warning), `size.summary` (info) |
| `files` | File types in the package | `files.entry_missing`, `files.native_binary`, `files.type_not_allowed`, `files.svg_active_content` (errors), `files.source_map` (warning) |
| `permissions` | Declared permissions against `olan.*` calls in the bundle, in the backend (`dist/server.js`, since 1.5.1), during the render, and the event subscriptions and assistant tools that need them | `permissions.missing`, `permissions.http_missing` (errors), `permissions.unused`, `permissions.http_unused` (warnings), `permissions.http_hosts` (info) |
| `forbidden-apis` | Code the sandbox forbids (guideline 1.x) | `forbidden.eval`, `forbidden.function_constructor`, `forbidden.dynamic_import`, `forbidden.fetch`, `forbidden.xhr`, `forbidden.websocket`, `forbidden.dom`, `forbidden.browser_storage`, `forbidden.workers`, `forbidden.crypto_mining` (errors); `forbidden.navigator`, `forbidden.location`, `forbidden.require`, `obfuscation.*` (warnings) |
| `surfaces` | Renders every declared surface with sample data | `surfaces.not_rendered`, `surfaces.load_error`, `surfaces.timeout`, `surfaces.unknown_method`, `surfaces.limit_exceeded`, `surfaces.app_error` (errors; `surfaces.runner_failed` is the marketplace's own failure: publish again); `surfaces.empty`, `surfaces.root_not_screen`, `surfaces.not_settled` (warnings) |
| `interaction` | Presses the buttons and menus of each rendered surface | `interaction.app_error` (error), `interaction.summary` (info), `interaction.developer_tests_unavailable` (info; `interaction.developer_tests_reported` once a test report is attached) |
| `accessibility` | Labels and keys in the rendered trees (guideline 4.x) | `a11y.button_label_missing`, `a11y.field_label_missing`, `a11y.action_label_missing`, `a11y.menu_item_label_missing` (errors); `a11y.image_alt_missing`, `a11y.menu_label_missing`, `a11y.list_key_missing`, `a11y.duplicate_key` (warnings) |
| `licenses` | License files and notices in the bundle (guideline 6.x) | `licenses.found` (info), `licenses.notices_missing` (info), `licenses.copyleft` (warning) |

`validate --strict` catches most of these before you submit. `interaction.developer_tests_unavailable` is always informational: a package does not contain your source, so your own `olan-app test` suites cannot run on the marketplace; attach a signed test report instead (above). The checks may finish before the report arrives; once it is attached the note reads `interaction.developer_tests_reported` with the report's counts. What each `rule` means and how to fix it: review-guidelines.md. `olan-app build` keeps the license comments of bundled code (React, MIT) at the end of `dist/app.js` and `dist/server.js`, which satisfies `licenses.notices_missing`; extra notices go in a `NOTICE` or `THIRD_PARTY_NOTICES` file under `assets/` (only `assets/**` is packed).

Marketplace error codes (`marketplace.<code>`) are listed in errors.md#olan-marketplace.

# Error codes

## Run time: `OlanError.code`

| Code | Meaning | Fix |
|---|---|---|
| `permission_denied` | The installation did not grant the permission the call needs | Add it to `permissions` (permissions.md); handle the error with an `EmptyState` |
| `http_blocked` | `olan.http.fetch` to a host without `http:<host>`, a private address, or (tests) a URL without an HTTP fixture | Add `http:<host>`; add the URL to `fixtures/http.json` |
| `invalid_params` | Bad arguments: storage value > 64 KiB, `json()` on a non-JSON body, unknown `olan.db` collection, `where`/`orderBy` on a field that is not indexed, `limit` outside 1–100, a cursor from another query | Check the arguments (database.md#queries) |
| `validation_failed` | An `olan.db` row does not match the manifest `data` schema; `message` is `"data.<field>: row.<code>"` (`row.unknown_field`, `row.required`, `row.type`, `row.max_length`, `row.range`, `row.enum`, `row.not_integer`, `row.json_too_large`, `row.too_large`), `"data.<field>: ref.not_found"` (the referenced project, task or user does not exist or is not visible; on `insert` and on changed `update` fields), `ref.too_many` (> 20 references per call); or a card is invalid (`card.*`, below) | Fix the value of that field |
| `conflict` | Stale `revision` in `olan.db` `update`/`delete`, `updateTask`, `deleteTask` or `deleteList` (older servers: `invalid_params`) | Reload (`get`/`refetch`) and retry with the new `revision` |
| `not_found` | The row, task or work package does not exist (any more) | Refetch the list |
| `forbidden_record` | A protected record (default work package, non-empty work package, task with an approval workflow, a record the app did not create when the admin requires that; Olan meetings, project calendar events and shared contacts `system_record`; invitations `not_organizer`; read-only calendars `permission_denied`; a project the app did not create `not_created_by_app`) or an `olan.db` row the collection's `rules` do not allow this user to change | Show "Bu kayıt korunuyor"; do not retry |
| `quota_exceeded` | The installation's database is full (rows or bytes) | Ask an admin to raise the limit, or delete rows |
| `not_installed` | The app is not installed (or was disabled) for this user | Nothing to do in code |
| `unknown_method` | The host does not know the call (older Olan) | Check `olan.*` names; require a newer server with `minServerVersion` |
| `host_error` | The host failed, or `olan.*` was called before the runtime started (e.g. at module top level) | Call `olan.*` from effects, handlers or `useQuery` |
| `cancelled` | The app was closed while the call was pending | Ignore |
| `backend_function_not_found` | `olan.backend.call(name)`: the backend has no `functions[name]` | Add it to `defineBackend({ functions })` (backend.md) |
| `backend_error` | The backend function threw (`message` is its error) or `dist/server.js` does not load | Fix the function; check the logs (Studio → Backend, `olan-app dev`) |
| `backend_limit` | The backend call ran out of CPU (1 s), time (10 s) or memory (64 MiB) | Do less per call; move periodic work to `schedules` |
| `backend_busy` | More than 4 backend calls at once for this installation | Retry later |
| `payload_too_large` | `backend.call` arguments or result over 256 KiB | Send ids, page results |
| `backend_unavailable` | The app has no `server`, or backends are off on this server | Declare `server`; ask the admin |
| `backend_migrating` | After an update, the new version's `migrate` has not succeeded yet (retried with backoff, then by hand) | Retry later; fix `migrate` (Studio → Backend shows the error) |
| `remote_rejected` | `olan.remote.request`: the app server answered 400–499; `RemoteError.status` is its status, `details` its body (remote-requests.md) | Show the server's reason (e.g. 422 `issues` per field); do not retry unchanged |
| `remote_unavailable` | `olan.remote.request`: the app server answered 500–599 (`reason: 'http_status'`) or gave no usable answer: `timeout`, `network`, `invalid_response` (not HTTP 200 with the `{ status, headers?, body? }` wrapper), `response_too_large` (> 4 MiB) | A `Banner` with "Tekrar dene"; on the server, check the `/requests` route and the wrapper |
| `consent_required` | The person has not consented to the app yet (remote requests) | Nothing in code: Olan shows the consent screen on the next open |
| `rate_limited` | Over 300 remote requests a minute (or 8 at once) per person and installation; `RemoteError.retryAfterSeconds` | Wait and retry; poll less often |
| `feature_not_enabled` | The organization's plan does not include this app (`details.feature` on the server) | Nothing in code; an admin changes the plan |
| `payload_too_large` | Also: a `remote.request` body over 1 MiB | Send less, or upload files with `olan.files.upload` |
| `upload_failed` | `olan.files.upload`: network error, or no progress for 60 s | Offer to retry the upload |
| `project_not_enabled` | SDK 1.6: the call names a project the app was not added to (`olan.projects.*`, `olan.project.*`) | Say "Uygulama bu projeye eklenmemiş"; a member adds it on the project page → Uygulamalar |

`olan.project.*` (SDK 1.7) map the server's reasons to these codes; the reason is in `message`:
`not_found` — `link_not_found`, `status_not_found`, `label_not_found`, `calendar_item_not_found`,
`approval_not_found`, `field_not_found`, `task_not_found`, `issue_not_found` (refetch); `validation_failed` —
`invalid_card` (a record card with a `submit` button or another card problem: use `{ kind: 'open' }`);
`conflict` — `status_key_taken`, `label_key_taken`, `field_key_taken`, `status_name_taken`, `label_name_taken`,
`field_name_taken` (the project already uses the key or name: pick another), `field_read_only` (the field's app was
removed from the project), `approval_not_pending` (already decided or cancelled),
`last_status_in_category` (the project keeps one status of each required kind), `project_archived`;
`quota_exceeded` — `record_links_limit` (10 records per task or issue), `calendar_items_limit` (500 per
project), `fields_limit` (50 fields per project); `invalid_params` — `invalid_key`, `invalid_definitions`, `status_category_immutable`,
`invalid_target`, `invalid_status`, `invalid_state`, `invalid_range`, `invalid_approvers` (not a
member who may change the project), `invalid_text`, and for fields `invalid_field_type`, `field_type_immutable`,
`invalid_field_options`, `invalid_field` (no such field for that task or issue), `invalid_field_value`, `field_required`.
| `cancelled` | Also: an upload stopped with `task.cancel()` / `olan.files.cancel` | Expected after your own cancel; reset the progress UI |
| `http_blocked` | Also: an upload `url` that is not on the `remote.url` origin or a granted `http:<host>` (or `http:` outside development) | Upload to your app server's origin (files.md#where-uploads-may-go) |

## `olan-app validate`

Each error has `code`, `message`, `file`, `line`/`column` when known, and a `hint`.

### Manifest (`olan-app.json`)

| Code | Fix |
|---|---|
| `manifest.missing` | Create `olan-app.json` (`olan-app init`, or copy manifest.md) |
| `manifest.invalid_json` / `manifest.not_object` | Fix the JSON syntax; the file is one object |
| `manifest.unknown_field` | Remove the field (only the fields in manifest.md exist) |
| `manifest.feature_not_available` | This server turned backend code off (`OLAN_APPS_BACKEND=0`; locally the same variable): remove `server`, or use your own server (`remote`, server.md) or `olan.http.fetch` |
| `manifest.schema_version` | `"schemaVersion": 1` |
| `manifest.id` | Lowercase reverse domain: `"com.example.my-app"` |
| `manifest.name` | 1–80 characters |
| `manifest.version` | Semver: `"0.1.0"` |
| `manifest.sdk` | `"^1.5.0"` |
| `manifest.schema_url` | `$schema` is `"https://olan.app/schemas/olan-app/v1.json"`, or remove it |
| `manifest.min_server_version` | Semver, or remove it |
| `manifest.description` | ≤ 400 characters |
| `manifest.entry` / `manifest.entry_required` | `"entry": "dist/app.js"` |
| `manifest.icon` | A png/svg/jpg/webp path in the package, e.g. `"assets/icon.png"` |
| `manifest.kind` | `"app"` or `"web-link"` |
| `manifest.surfaces_required` | `"surfaces": { "app": { "title": "…" } }` |
| `manifest.surface_unknown` | Use a surface from surfaces.md |
| `manifest.surface_invalid` | `app`/`project.widget`/`settings`: `{ "title"?: string }`; other surfaces need `"title"` (1–80); `chat.command` `description` ≤ 120 |
| `manifest.project_template_invalid` | `projectTemplates`: ≤ 5 `{ key, name, description?, content }` with unique keys; `content` is `{ version: 1, lists, statuses?, labels?, tasks?, recordTemplates?, settings? }` (manifest.md#projecttemplates) |
| `manifest.command_invalid` | `chat.command` needs `"command"`: `^[a-z][a-z0-9-]{1,31}$`, e.g. `"standup"` |
| `manifest.permissions` / `manifest.permission_unknown` | Use a permission from permissions.md or `http:<host>` (no scheme or path); `remote` and `ai:tools` are implied, never listed |
| `manifest.permission_reserved` | The permission is reserved for a later phase (none today) |
| `manifest.remote_invalid_url` | `remote` is `{ "url", "jwksUrl", "requests"? }`: https URLs without credentials, query or fragment (http only for localhost/private addresses); `requests` a boolean |
| `manifest.profile_requires_remote` | `profile:read` only adds fields to remote requests: add `"remote": { "url", "jwksUrl", "requests": true }`, or remove `profile:read` |
| `manifest.events_require_remote`, `manifest.ai_tools_require_remote` | Add `remote`: events and tools go to the app's own server |
| `manifest.event_unknown` | Use an event type from server.md#events |
| `manifest.event_permission_missing` | Add the permission the event needs (`detail: { event, permission }`) |
| `manifest.ai_tool_invalid` | Tool `name` `^[a-z][a-z0-9_]{1,31}$` and unique, `description` 1–1024, `input` a JSON Schema with `"type": "object"` (≤ 8 KiB, only `#…` `$ref`), not both `readOnly` and `destructive`, ≤ 16 tools; `timeoutMs` an integer 1000–60000, at most 15000 on a `readOnly` tool |
| `manifest.ai_tool_permission_missing` | A tool's `permissions` must also be in the manifest's `permissions` |
| `manifest.web_link_remote` | Web links have no `remote`, `events`, `ai` or `server` |
| `manifest.server_invalid` | Fix `server` (`entry` a .ts/.js path in the package, `schedules` cron ≥ 5 minutes apart and unique names, `hooks` `verify` with `header` and a `secret: true` `secretSetting`) |
| `manifest.permission_duplicate` | Remove the repeated permission |
| `manifest.settings_field` | Fix the settings field: `type`, `label`, `default` of the right type, `select` with `options` containing the default |
| `manifest.url` / `manifest.url_required` / `manifest.url_not_allowed` | `url` only for `kind: "web-link"` |
| `manifest.web_link_entry` / `_surface` / `_permissions` / `_settings` / `_data` | Web links have none of these |
| `manifest.data_version` | `data.version` is an integer 1–1000000; increase it when the schema changes |
| `manifest.data_collections_required` | `data` is `{ "version", "collections" }` with at least one collection |
| `manifest.data_collection_name` / `manifest.data_collection_limit` | Collection names `^[a-z][a-z0-9_]{0,39}$`; at most 20 |
| `manifest.data_scope` | `"scope": "organization"` or `"user"` |
| `manifest.data_field_name` / `manifest.data_field_reserved` / `manifest.data_field_limit` | Field names `^[A-Za-z][A-Za-z0-9_]{0,63}$`, not `id`, `createdAt`, `updatedAt`, `createdBy`, `revision`; at most 64 |
| `manifest.data_field_type` | `type`: `string`, `number`, `boolean`, `date`, `datetime`, `json`, `ref:project`, `ref:task`, `ref:user` |
| `manifest.data_field_option` | An option the type does not have (e.g. `maxLength` on a number) or a bad value (`maxLength` 1–10000, `enum` 1–100 unique strings, `min` ≤ `max`) |
| `manifest.data_index_limit` / `manifest.data_index_type` | At most 5 `indexed` fields; `json` cannot be indexed, strings only with `maxLength` ≤ 512 or `enum` |
| `manifest.data_rules` | `rules` only on `organization` collections; values `"any"` or `"owner"` |
| `manifest.invalid` | Other schema error; read the message |

### Build and files

| Code | Fix |
|---|---|
| `build.entry_missing` | Create `src/app.tsx` with `export default defineApp({ … })` |
| `build.sdk_missing` | `npm install` |
| `build.error` | Syntax or import error at `file:line`; "Could not resolve" → install the package or fix the path |
| `build.forbidden_import` | Remove imports of `react-dom`, `react-native`, Node built-ins or `@olan-app/cli` from `src/` |
| `build.manifest_invalid` (warning) | `build` ran although `olan-app.json` has errors; run `olan-app validate` |
| `build.warning` (warning) | esbuild warning; usually a real bug |
| `build.too_large` (warning), `validate.bundle_too_large`, `validate.package_too_large` | Bundle/package over 5 MiB: drop big dependencies (`olan-app build --json` → `largestInputs`) or assets |
| `validate.entry_missing` | Run `olan-app build` (or drop `--no-build`) |
| `validate.icon_missing` | Add the icon file or remove `"icon"` |
| `validate.typescript_missing` (warning) | `npm install -D typescript` |
| `build.backend_node_import` | Backend code (`server/`) imported a Node module (`fs`, `crypto`, `node:*`, `axios`, …): use `olan.http.fetch`, `olan.db`, `olan.secrets` (backend.md) |
| `build.backend_forbidden_import` | Backend code may import only `@olan-app/sdk/backend` from the SDK, no React and no `@olan-app/cli` |
| `build.backend_entry_missing`, `build.backend_missing` | Create `server.entry` (`export default defineBackend({ … })`) |
| `build.backend_error` | Syntax or import error in backend code at `file:line` |
| `build.backend_large` (warning) | `dist/server.js` is over 1 MiB; every new sandbox loads it |
| `validate.backend_missing` | `dist/server.js` does not exist: run `olan-app build` (or drop `--no-build`) |
| `validate.backend_load`, `validate.backend_default_export` | `dist/server.js` does not load in the backend runtime (a top-level throw, a Node API at the top level) or has no `export default defineBackend(...)` |
| `validate.backend_handler_missing` | A `server.schedules`/`events`/`hooks` entry has no handler: add `schedules[name]`/`events[type]`/`hooks[name]` or `functions[<its function>]` (backend.md#handler-resolution) |
| `validate.backend_handler_unused` (warning) | `defineBackend` has a schedule, event or hook handler the manifest does not declare, so Olan never runs it |
| `backend.engine` (warning) | The backend engine fell back (`isolated-vm prebuild not available on <platform>; using QuickJS (slower)`) |
| `backend.engine_unavailable`, `backend.runtime_missing` | `--engine isolated-vm` cannot start here: use `--engine quickjs` or `auto`; reinstall `@olan-app/cli` |
| `typescript.TS<n>` | A type error at `file:line` (e.g. `typescript.TS2322`: wrong prop type, `TS2741`: missing required prop) |
| `typescript.failed` | `tsc` could not run; read the message |

### `--strict`: rendering every surface

| Code | Fix |
|---|---|
| `app.default_export` | End `src/app.tsx` with `export default defineApp({ app: MyScreen })` |
| `app.surface_missing` | The manifest declares a surface `defineApp` does not define: add it or remove it from `surfaces` |
| `app.surface_undeclared` (warning) | Declare the surface in `olan-app.json` or remove it from `defineApp` |
| `runtime.load_failed` | `src/app.tsx` throws at import time (top-level code); move it into components |
| `runtime.render_failed` / `runtime.error` | The surface threw while rendering with the default fixtures. "`fetch`/`window`/`document`/`localStorage` is not defined" → use `olan.*`; otherwise guard missing data (`data?.items ?? []`) |
| `runtime.unknown_method` | Use only the `olan.*` calls in api.md |
| `permission.missing` | A write in a handler (found in `src/`, at `file:line`) or a backend call needs a permission the manifest lacks: add it. `olan.files.*` needs `files:pick`; `olan.remote.request` needs `"requests": true` in `remote` |
| `fixtures.db_invalid`, `fixtures.db_unknown_collection` | A row in `fixtures/db.json` does not match its collection in `data.collections`, or names a collection the manifest does not declare; fix the row or the collection name (rendering continues on an empty database) |
| `fixtures.http_missing` (warning) | Add the URL to `fixtures/http.json` so headless runs get a response |
| `fixtures.remote_missing` (warning) | Add the route to `fixtures/remote.json` (or pass `renderApp({ remote })`) so `olan.remote.request` gets an answer |
| `tree.unknown_type` | Only the 23 SDK components exist; no `<div>`, `<span>`, `<img>` (use `Image`). An Olan server before 1.5 reports it for the SDK 1.5 components |
| `tree.unknown_prop` | Remove the prop (no `style`, `className`, `color`, `onClick` — it is `onPress`) |
| `tree.invalid_prop` | Wrong value: check the allowed values in components.md (e.g. `gap="16"` → `gap="md"`, missing required `label`, `Menu` without `label` and `icon`, `format: 'currency'` without `currency`, `Tabs` with fewer than 2 or more than 8 items, `stacked` on a line chart, an `Image` `src` that is not an http(s) URL) |
| `tree.text_outside_text` | Wrap strings and numbers in `<Text>` |
| `tree.children_not_allowed` | Only `Screen`, `Stack`, `Card`, `Form` take children; `Text` takes text; `List`, `Button`, `Badge` … take none (use props) |
| `tree.text_invalid` | Text nodes carry one string |
| `tree.child_missing`, `tree.cycle`, `tree.shared_child`, `tree.root_missing`, `tree.id_mismatch`, `tree.invalid_node` | Internal tree errors; report them with the app source |
| `ui.empty_tree` (warning) | The surface rendered nothing; render an `EmptyState` instead of `null` |
| `ui.root_not_screen` (warning) | Start `app`/`settings` surfaces with `<Screen>` (only these two are checked; `project.widget` uses `Card`, modals and panels should use `Screen`) |

### `--strict`: Olan Marketplace review checks

The marketplace's static checks (`@olan-app/schema` `runStaticReviewChecks`, `reviewPermissions`,
`lintUiTree`) on the files `pack` would package, merged with the calls the surfaces made: the same
codes, severities and guideline (`rule`, explained in review-guidelines.md) the marketplace reports (marketplace.md#automatic-checks).
Errors fail `validate`, warnings print, info findings show with `--verbose` (`--json`: `result.review`).

| Code | Fix |
|---|---|
| `permissions.missing` | Add the named permission (or remove the call); with a `file:line` in `src/` when the source scan found the call |
| `permissions.http_missing` | `olan.http.fetch` without `http:<host>`, or a fetched host not granted: add `http:<host>` |
| `permissions.unused`, `permissions.http_unused` (warnings) | Remove permissions nothing uses. Counted as use: `olan.*` calls in `dist/app.js` and, with `server`, in `dist/server.js` (SDK 1.5.1; before, backend-only use was not seen), event subscriptions (`events`, `server.events`) and `ai.tools[].permissions`. What your own server (`remote`) does with its tokens is not visible: the reviewer reads your listing |
| `permissions.http_hosts` (info) | The hosts the app may call; the listing must explain each |
| `a11y.button_label_missing`, `a11y.field_label_missing`, `a11y.menu_item_label_missing`, `a11y.action_label_missing` | Give every `Button`, field (also `Switch`, `MultiSelect`), menu item and action (also a `Banner` action) a non-empty `label` |
| `a11y.tab_label_missing` | Every `Tabs` item needs a non-empty `label`; the `Tabs` `label` (the group's name) is optional but not empty |
| `a11y.avatar_name_missing` | Give every `Avatar` the person's or brand's `name` (read aloud, and the initials) |
| `a11y.menu_label_missing`, `a11y.image_alt_missing` (warnings) | Add `label` to icon-only menus; `alt` to images (`""` only for decoration) |
| `a11y.list_key_missing`, `a11y.duplicate_key` (warnings) | Every `List` item needs a unique `key`; make `Menu` item, `Table` row and action keys unique |
| `forbidden.*` (e.g. `forbidden.eval`, `forbidden.function_constructor`, `forbidden.dom`, `forbidden.fetch`) | Remove the API from the bundle (`dist/app.js#line:column`); use `olan.*` and SDK components |
| `files.native_binary`, `files.type_not_allowed`, `files.svg_active_content`, `files.entry_missing`, `files.source_map` (warning) | Package only JS, JSON, images, text; plain SVGs; no source maps |
| `size.package_too_large`, `size.entry_large` (warning), `size.summary` (info) | Stay ≤ 5 MiB; keep the entry under 2 MiB |
| `licenses.copyleft` (warning), `licenses.found`, `licenses.notices_missing` (info) | Copyleft code gets manual review; `olan-app` keeps license comments at the end of `dist/app.js` |

### Data schema changes (install and update)

The server compares the new `data` with the stored one: `409 data_schema_incompatible` with
`issues`. Fix: keep the change additive and increase `data.version` (database.md#changing-the-schema).

| Code | Fix |
|---|---|
| `data.version_not_bumped` | The schema changed: increase `data.version` |
| `data.version_downgrade` | `data.version` must not go down |
| `data.collection_removed`, `data.field_removed` | Keep it (stop using it instead) |
| `data.type_changed`, `data.scope_changed` | Add a new field or collection instead |
| `data.required_added` | Add the field as optional |
| `data.constraint_tightened` | Keep `maxLength`/`max` as large, `min` as small, every `enum` value, no new `integer` |

## Other commands

| Code | Fix |
|---|---|
| `cli.unknown_command`, `cli.unknown_option`, `cli.missing_value`, `cli.invalid_option` | See `olan-app <command> --help` (exit code 2) |
| `cli.internal` | An unexpected failure; the message (and the stack without `--json`) says where |
| `project.not_found` | Run inside an app directory or pass `--cwd` |
| `test.none` | Add `tests/*.test.ts` with at least one `test(...)` |
| `test.build_error` | The test file does not compile; see `file:line` |
| `test.failed` | Assertion or app failure; the message includes the visible text |
| `test.process_crashed` (warning) | Every test of the file passed, then its process exited with a non-zero code (on Windows often `0xC0000409`, the Node/libuv abort while sockets close); not counted as a failure. Rerun; if it repeats, look for `process.exit()` or aborts in `after()` hooks |
| `test.report_pattern`, `test.package_without_report` | A report covers the whole suite (drop the pattern); `--package` needs `--report` |
| `test.report_too_many`, `test.report_too_large`, `test.report_invalid` | A report holds ≤ 2000 tests and ≤ 512 KiB; shorten names or split the suite |
| `test.report_package_stale` (warning) | `dist/<id>-<version>.olanapp` is another build than the report's package: pack again before `publish --file` |
| `package.missing`, `package.unreadable` | `--package` must be a `.olanapp` made by `olan-app pack` |
| `fixtures.invalid_json`, `fixtures.invalid`, `fixtures.users_invalid` | Fix the fixture file (testing.md#fixtures; users need `id`, `displayName`, `email`) |
| `init.name_required`, `init.name_too_long`, `init.invalid_id`, `init.not_empty`, `init.unknown_template`, `init.template_conflict` | Fix the `init` arguments (`--backend` is the `backend` template; it cannot be combined with another `--template`) |
| `pack.key_missing`, `pack.key_invalid` | Run `olan-app keygen` or pass a valid `--sign-key` (`--dev-sign` creates the development key itself) |
| `pack.validation_failed` | `pack` ran the `validate` checks and found the errors listed after it: fix them (and run `validate --strict`); `--no-validate` packages anyway |
| `pack.sign_conflict` | `--dev-sign` signs with the development key; drop `--sign-key`/`--no-sign` |
| `pack.entry_missing`, `pack.icon_missing`, `pack.unsafe_path`, `pack.too_large`, `pack.web_link`, `pack.signature_failed` | Fix the files named in the message |
| `pack.version_invalid` | The version to package (`olan-app try`'s server-named `-dev.N`) is not semver: check the server's `nextVersion` |
| `pack.backend_missing` | The manifest has `server` but `dist/server.js` is missing: run `olan-app build` |
| `keygen.exists` | Keep the key, or `--force` to replace it |
| `keygen.dev_out` | `--dev` keeps the key in `~/.olan`; set `OLAN_APP_DEV_KEY` for another file |
| `sign.key_required`, `sign.key_missing`, `sign.key_invalid`, `sign.key_encrypted`, `sign.key_not_ed25519`, `sign.key_id_invalid` | Internal `olan-app sign`: pass `--key` with an unencrypted PKCS#8 Ed25519 PEM; `--key-id` is 1-64 letters, digits, `.`, `_`, `-` |
| `sign.package_required`, `sign.package_missing`, `sign.package_invalid`, `sign.package_too_large`, `sign.digest_missing`, `sign.digest_invalid`, `sign.digest_mismatch`, `sign.signature_failed` | Pass one package made by `olan-app pack`; if it changed after packing, pack it again |
| `validate.unsigned` (warning, `--strict`) | Nothing to do for `publish --marketplace` (the marketplace signs approved versions). For an organization catalog (`publish --org`) a plain `pack` is unsigned and not installable: `olan-app pack --dev-sign` / `publish --org --dev-sign` locally with your development key (`keygen --dev`; cli.md#signing-and-publishing) |
| `manifest.description_template` (warning, `--strict`) | `description` is still the `olan-app init` template's: describe your app (guideline 5.1) |
| `publish.target_required` | Pass `--marketplace` (production, marketplace.md) or `--org` (development servers) |
| `publish.target_conflict`, `publish.marketplace_option` | Use one target; `--developer`, `--channel`, `--percent`, `--visibility` are for `--marketplace` only |
| `publish.server_required`, `publish.token_required` | Use `olan app publish --org` (signed in), or pass `--server` and `--token`/`OLAN_TOKEN` |
| `publish.network` | Check `--server` (the API address) |
| `publish.test_report_missing`, `publish.test_report_invalid` | `--test-report` must be the JSON file `olan-app test --report <file>` wrote |
| `publish.file_missing` | The `--file` package does not exist; run `olan-app pack` or drop `--file` |
| `publish.apps_disabled` | Olan Apps are turned off on that server |
| `publish.dev_sign_file` | `--dev-sign` packs and signs; drop `--file` (or upload a package you packed with `pack --dev-sign`) |
| `publish.package_unsigned` (warning) | Uploaded but unsigned, so it cannot be installed. Locally: `publish --dev-sign` and trust the key (`keygen --dev`); production installs need Olan Marketplace signing |
| `publish.package_untrusted_key` (warning) | Uploaded, but the server does not trust the signing key; on a development server add it to `OLAN_APPS_TRUSTED_KEYS` |
| `publish.<server error>` | e.g. `publish.version_exists` (bump `version`), `publish.forbidden`/`admin_required` (admins only), `publish.invalid_token` (sign in again); package issues come with their own codes (`package.*`, `manifest.*`) |
| `docs.query_required`, `docs.sdk_missing` | Pass a query; `npm install` |
| `dev.port_in_use` | Stop the other server or `--port <n>` |
| `dev.remote_missing` | `dev --remote live` needs `remote` (with `requests: true`) in `olan-app.json` |
| `cli.usage`, `revocations.dev_required`, `revocations.input_required`, `revocations.input_missing`, `revocations.input_invalid`, `revocations.entry_invalid`, `revocations.signature_failed` | `olan-app revocations sign --dev --in list.json`; entries need `appId` (and `versions`/`packageSha256`, `reason`) |
| `mcp.no_session`, `mcp.invalid_input` | Call `olan_app_render` first; pass `label`/`value` |
| `events.unknown_type` | Use an event type from server.md#events |
| `events.delivery_failed` | The app server did not answer 2xx; 401 usually means the dev issuer `http://127.0.0.1:5180` is not in its `issuers` |
| `events.not_subscribed`, `events.permission_missing` (warnings) | Olan would not send this event: add it to `events` / add its permission |
| `tools.unknown_tool`, `tools.input_invalid` | Use a tool from `ai.tools`; make `--input` match its `input` schema |
| `tools.response_invalid` | Answer HTTP 200 with `{ ok: true, result }` or `{ ok: false, error: { code, message } }`, ≤ 64 KiB, `summary` ≤ 500 |
| `remote.missing`, `remote.invalid_url`, `remote.unreachable`, `remote.issuer_port` | Add `remote` or pass `--to`; start the app server; free port 5180 or pass `--issuer-port` |
| `remote.request_invalid` | `requests send`: the method, path, query, headers or body break the `olan.remote.request` rules (remote-requests.md#calling-it); put the query in `?…` or `--query`, not in the path segments |
| `requests.delivery_failed` | `requests send` got no usable answer (the app sees `remote_unavailable` with that `reason`): 401 = the app server does not list the dev issuer `http://127.0.0.1:5180`; `invalid_response` = not HTTP 200 with `{ status, headers?, body? }`; `network` = not running |
| `requests.not_enabled` (warning) | `remote` has no `"requests": true`, so Olan refuses `olan.remote.request` |

## Olan Marketplace

`login`, `developer`, `app`, `publish --marketplace`, `status --marketplace` and `release` report `marketplace.<code>`
in human output; with `--json` they print `{ error: "<code>", message, hint?, issues? }` (marketplace.md).

| Code | Fix |
|---|---|
| `marketplace.target_required`, `marketplace.app_required`, `marketplace.action_required`, `marketplace.invalid_option`, `marketplace.invalid_url` | Fix the arguments: `--marketplace [url]`, the app id, `developer create\|list`, `--channel stable\|beta`, `--percent 1-100` (needs `--channel`), `--visibility public\|org\|organization:<serverId>/<organizationId>`, `--slug`/`--name`/`--kind` |
| `marketplace.server_required` | `login` needs the Olan API address: `--server <url>`, `OLAN_SERVER` or `OLAN_API_URL` |
| `marketplace.token_required` | `--token` was empty: drop it to sign in in the browser, or pass an Olan access token (`olan app login --marketplace` passes one; CI uses `OLAN_MARKETPLACE_SESSION` instead) |
| `marketplace.server_unreachable`, `marketplace.network` | Check `--server` / `--marketplace` (or `OLAN_MARKETPLACE_URL`) and the connection |
| `marketplace.sign_in_unsupported` | The server has no OpenID configuration with PKCE: check `--server`, or use `OLAN_TOKEN` / `olan app login --marketplace` |
| `marketplace.sign_in_timeout`, `marketplace.sign_in_denied` | Run `login` again and finish signing in within 5 minutes, in a browser on the same computer |
| `marketplace.sign_in_failed` | The server refused the code exchange; `invalid_client`: the server predates the `olan-app-cli` client (update it, or use `OLAN_TOKEN`) |
| `marketplace.identity_token_failed` | 401: the access token expired (sign in again); 403: ask an admin for the `developer` grant; 404: the server predates marketplace sign-in |
| `marketplace.identity_invalid`, `marketplace.identity_untrusted_issuer` | The marketplace did not accept your server's identity: sign in again; an unregistered server must be verified with the marketplace by its administrator |
| `marketplace.session_missing`, `marketplace.session_expired`, `marketplace.developer_sign_in_required`, `marketplace.session_invalid`, `marketplace.session_other_marketplace` | Run `olan-app login --marketplace [url]` (CI: a valid `OLAN_MARKETPLACE_SESSION`) |
| `marketplace.session_env_override` (warning) | `OLAN_MARKETPLACE_SESSION` replaces the session `login` just saved; unset it |
| `marketplace.developer_account_missing` | `olan-app developer create --marketplace --slug <slug> --name <name> --accept-agreement` (or accept an invite) |
| `marketplace.developer_required` | You belong to several developer accounts: pass `--developer <slug>` |
| `marketplace.developer_not_found`, `marketplace.developer_role_required` | Check `--developer` (`olan-app developer list`); ask an owner or admin for the role |
| `marketplace.developer_exists` | The developer name is taken (`olan…` is reserved): choose another `--slug` |
| `marketplace.agreement_required`, `marketplace.agreement_unknown` | Pass `--accept-agreement` to `developer create`; existing accounts accept a new version in Studio → Yayınla |
| `marketplace.file_missing`, `marketplace.package_unreadable` | `--file` must be a package made by `olan-app pack` |
| `marketplace.package_invalid` (with issues), `marketplace.package_too_large` | Fix the listed package issues (`validate --strict`); stay ≤ 5 MiB |
| `marketplace.version_exists`, `marketplace.version_not_increasing` | Raise `version` in `olan-app.json` |
| `marketplace.app_not_found`, `marketplace.version_not_found` | No such app in your developer accounts, or no such version: check the id and version (`status` shows the newest) |
| `marketplace.app_owned_by_other_developer`, `marketplace.app_id_reserved` | Change `id` (`com.olan.*`, `app.olan.*`, `olan.*` are Olan's), or pass the owning `--developer` |
| `marketplace.age_rating_required`, `marketplace.age_rating_not_allowed` | Release needs an age rating: `olan-app app set --marketplace <appId> --age-rating 4+` (4+, 9+ or 13+; or Studio → Yayınla → the app → Mağaza sayfası); Olan does not accept 16+ or 18+ (guideline 5.4) |
| `marketplace.age_rating_not_set` | `publish --age-rating` submitted the version but could not save the rating: run the `olan-app app set` command in the hint |
| `marketplace.visibility_org_unknown`, `marketplace.visibility_ignored` (warning) | Pass `--visibility organization:<serverId>/<organizationId>`; visibility applies only when an app is created |
| `marketplace.server_not_found`, `marketplace.server_not_verified`, `marketplace.organization_not_allowed` | Organization-only apps need a server registered and verified with the marketplace, and an admin or developer sign-in through it |
| `marketplace.checks_failed`, `marketplace.rejected`, `marketplace.withdrawn` | Fix the findings listed after it (marketplace.md#automatic-checks) or the review notes, then publish again; the cited guideline is explained in review-guidelines.md |
| `marketplace.review_state_conflict`, `marketplace.rollout_invalid` | Only approved versions are released; a rollout only widens (10 → 50 → 100) and only once released; `halt` stops it |
| `marketplace.app_not_active`, `marketplace.package_revoked` | The app is suspended or the version revoked by Olan: publish a fixed version |
| `marketplace.submission_not_found`, `marketplace.submission_state_conflict` | `withdraw` and test reports need a submission that is still `checking` or `in_review` |
| `marketplace.test_report_invalid`, `marketplace.test_report_signature_invalid`, `marketplace.test_report_mismatch` | Generate the report again after packing, from the sources you publish (`olan-app test --report <file>`), and do not edit it |
| `marketplace.test_report_not_attached` | The package was submitted, the report was not: fix it and attach it in Studio → Yayınla |
| `marketplace.invalid_request` | The marketplace refused a parameter; check the command's options |
| `marketplace.rate_limited`, `marketplace.http_<status>` | Wait and retry; another status means the marketplace answered without an error body |

## Cards

`olan.chat.postCard` / `updateCard` fail with `validation_failed` listing these (cards.md):

| Code | Fix |
|---|---|
| `card.invalid` | `{ version: 1, root, nodes, fallbackText }` and nothing else |
| `card.fallback_text` | `fallbackText` 1–500 characters |
| `card.too_large`, `card.too_many_nodes`, `card.too_deep` | ≤ 16 KiB, ≤ 100 nodes, depth ≤ 8 |
| `card.component_not_allowed` | Only `Card`, `Stack`, `Text`, `Badge`, `Table`, `Button`, `EmptyState` |
| `card.handler_not_allowed` | No handlers in cards; buttons use `action` |
| `card.action_invalid`, `card.payload_too_large` | `{ kind: 'open', payload? }` or `{ kind: 'submit', name, payload? }`, `payload` ≤ 2 KiB; record cards (`olan.project.links.upsert`, `approvals.request`) only `open` |
| `card.submit_requires_remote` | `submit` buttons need `remote`; use `open` |
| `tree.*` | As in validate (props, children, text placement) |

## Install errors from the server

Uploading accepts any well-formed package; installing it is another matter (cli.md#signing-and-publishing).

| Error | Meaning | Fix |
|---|---|---|
| `package_unsigned` (403) | The version has no `signature.json`; the server installs, updates to or serves only signed versions | Locally: `olan-app pack --dev-sign` with your key on the server's `OLAN_APPS_TRUSTED_KEYS`; production: Olan Marketplace signs the app |
| `package_untrusted_key` (403, `keyFingerprint`) | Signed, but by a key not on the server's trusted list (or a key that was removed); from `developer/try` also when the key is not one you registered (`reason: developer_key_revoked \| developer_not_member` for one that stopped) | Sign with a trusted key; for `olan-app try`, register your development key (`olan-app keys register`); development servers may add it to `OLAN_APPS_TRUSTED_KEYS` |
| `developer_key_revoked` / `developer_not_member` (403) | A development installation signed with your registered key: the key was revoked, or you are no longer a member of the organization. The installation is kept | Register a new key (`keygen --dev --force`, `keys register`) and `olan-app try` again |
| `key_exists` (409) | `keys register`: the key is already registered (a revoked key cannot come back) | Use it, or create a new key |
| `package_invalid` with `package.signature_invalid` (400, on upload) | The signature does not verify against the package digest | Pack again; do not edit a package after signing |

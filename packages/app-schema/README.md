# @olan-app/schema

Schemas and constants shared by the Olan Apps SDK, CLI, web host, renderer and
server: the `olan-app.json` manifest, permissions, the UI tree protocol,
sandbox/host messages and `.olanapp` package metadata. Depends only on `zod` v4.
The binding contracts are `docs/plans/2026-10-16-olan-apps-phase-1-contracts.md` and
`docs/plans/2026-10-17-olan-apps-phase-1b-contracts.md` (app database, record writes; 1.1.0) and
`docs/plans/2026-10-17-olan-apps-phase-2-server-contract.md` §10.1 (current user in the context,
`users:read`, `users.get`; 1.2.0) and `docs/plans/2026-10-17-olan-apps-phase-3-contracts.md` (surfaces,
cards, `remote`, events, assistant tools, calendar/contacts/mail/meetings, backend types; 1.3.0;
§15 backend runtime: `server` on by default, limits, host methods, handler resolution; 1.4.0) and
`docs/plans/2026-10-18-olan-apps-phase-5a-contracts.md` (`remote.requests`, `remote-requests.ts`,
`files.ts`, `links.ts`, `profile:read`, `files:pick`, the Phase 5a components, `ai.tools[].timeoutMs`; 1.5.0).
1.5.1: `reviewPermissions` counts the backend bundle (`scanPackageUsage`, `scanBundleUsage(code, { backend: true })`,
`SERVER_BUNDLE_PATH`), event subscriptions and `ai.tools[].permissions`; `PROFILE_REQUIRED`.
1.5.2: no schema changes (released together with SDK and CLI 1.5.2).
1.5.3: `reviewPermissions` counts `chat:write` as used when the manifest has `remote` and a `chat.card` surface (the app server posts the cards).
1.5.4: no schema changes (released together with SDK and CLI 1.5.4).
1.6.0: project extensions (Olan Apps phase 6): surfaces `project.tab` (presentation `tab`) and `project.settings`, `PROJECT_SURFACES`/`isProjectSurface`, `ProjectSurfaceParams`; RPC methods `project.config.get`/`project.config.set` (no permission, also backend host methods) and the error code `project_not_enabled`.
1.7.0: project contributions (Olan Apps phase 6, second wave): surfaces `task.action`, `issue.action` and `record.card` (modal, titled, in `PROJECT_SURFACES`) with `TaskActionParams`, `IssueActionParams`, `RecordCardParams`; the permission `projects:extend`; RPC methods (also backend host methods) `project.statuses.list/define/remove`, `project.labels.list/define/remove`, `project.links.list/upsert/remove/setStatus` (`setStatus` also with `projects:write`), `project.calendar.list/upsert/remove`, `project.activity.post`, `project.approvals.list/request/cancel` and their `RPC_LIMITS`; events `project.task.completed`, `project.issue.opened`/`closed`/`triaged` and `project.approval.decided` (audience `requester`); manifest `projectTemplates` (`projectTemplatesSchema`, `PROJECT_TEMPLATE_LIMITS`, `manifest.project_template_invalid`); `validateRecordCard` (record cards only `open`).
1.8.0: project custom fields: RPC methods (also backend host methods) `project.fields.list` (`projects:read`), `project.fields.define`/`remove` (`projects:extend`, ≤ `RPC_LIMITS.projectDefinitions` per call), `project.fields.values` (`projects:read`) and `project.fields.setValues` (`tasks:write`).
1.8.1: no schema changes (package metadata: documentation at https://docs.olan.app, source mirror https://github.com/alkamanas/olan-app).

The compiled `dist/` is committed and exported (`main` → `dist/index.js`); run `npm run build` after
changing `src/` (a test fails when `dist/` is stale). The generated
JSON Schema ships at `@olan-app/schema/schemas/olan-app.v1.json`.

## Exports

| Area | Exports |
|---|---|
| Versions | `SCHEMA_VERSION`, `PROTOCOL_VERSION`, `MAX_PACKAGE_BYTES`, `SURFACES`, `Surface`, `isSurface` |
| Surfaces | `SURFACE_PRESENTATIONS` (screen/widget/modal/panel), `SURFACES_WITH_OPTIONAL_TITLE`, `CHAT_COMMAND_PATTERN`, `SURFACE_ENTRIES_PER_PLACE`, `surfacesSchema`, types `SurfaceDefinitions`, `SurfaceParams` (init params per surface), `ChatActionParams`, `MailSurfaceParams`, … |
| Manifest | `manifestSchema`, `manifestBaseSchema` (no cross-field rules), `validateManifest(input, { backend? })`, `impliedPermissions`, `requestedPermissions`, `defaultSettings`, `validateSettings`, types `OlanAppManifest`, `ManifestSurfaces`, `SettingsFieldDefinition`, `SettingsSchema`, `ManifestIssue` (`detail`); per version: `MANIFEST_FIELDS_BY_VERSION`, `manifestFieldsFor`, `RESERVED_MANIFEST_FIELDS` (empty), `BACKEND_FEATURE` |
| Remote (app servers) | `remoteUrlProblem`, `isRemoteUrl`, `isDevelopmentRemoteUrl`, `isPrivateHost`, `remoteEndpoint`, `remoteHost`, `WEBHOOK_HEADERS`, `webhookSignedContent`, `formatWebhookSignature`, `parseWebhookSignature`, `WEBHOOK_TOLERANCE_SECONDS`, `APPS_JWKS_PATH`, `APP_TOKEN_PATH`, `CLIENT_ASSERTION_TYPE`, `clientAssertionAudience`, types `ClientAssertionClaims`, `AppServerTokenResponse`, `EmbeddedAppToken`, `OlanAppsJwk` |
| Events | `EVENT_CATALOG`, `EVENT_TYPES`, `eventDefinition`, `eventPermission`, `isEventType`, `EVENT_DATA_VERSION`, types `AppEventEnvelope`, `AnyAppEvent`, `EventDataMap` |
| Assistant tools | `appToolName`, `appToolSlug`, `appToolDescription`, `isAppToolName`, `AI_TOOL_LIMITS`, `AI_TOOL_NAME_PATTERN`, `EXPOSED_TOOL_NAME_PATTERN`, `APP_TOOL_PREFIX`, `aiToolInputProblems`, types `AiToolDefinition`, `AiToolCallRequest`, `AiToolCallResponse` |
| Cards | `validateCard(card, { remote? })`, `CARD_COMPONENTS`, `CARD_LIMITS`, `cardButtonActionSchema`, `cardButtonPropsSchema`, `cardActions`, types `AppCard`, `CardButtonAction`, `CardIssue`, `CardActionRequest`, `CardActionResponse` |
| Backend (`server`) | `serverSchema`, `cronProblems`, `BACKEND_LIMITS` (§15.1 defaults and `*Max` ceilings), `HOOK_VERIFY_KINDS`, `BACKEND_HOST_METHODS` / `BACKEND_ONLY_METHODS` / `isBackendHostMethod` / `backendMethodAllowed(method, granted, url?)` (what `__olan.call` may reach), `backendTriggers(server)` + `backendHandlerResolves(definition, trigger)` (§15.1 handler resolution), `BACKEND_RUNTIME_ERRORS` / `backendCallErrorCode(runtimeCode)` (runtime → `backend.call` error codes), types `ManifestServer`, `BackendSchedule`, `BackendHook`, `BackendTrigger` |
| App database (`data`) | `dataSchema` (zod, all rules), `validateDataSchema`, `validateRow(collection, data, { partial })`, `rowIssueMessage`, `applyRowPatch`, `checkFieldValue`, `validateDbQuery`, `matchesDbCondition`, `compareDbValues`, `compareDataSchemas(previous, next)`, `effectiveRules`, `queryableField`, `DATA_LIMITS`, types `DataSchema`, `CollectionSchema`, `FieldSchema`, `DbRow`, `DbWhere`, `DbCondition`, `DbOrderBy`, `DbQuery`, `RowIssue`, `DataChangeIssue` |
| JSON Schema | `manifestJsonSchema()`, `manifestJsonSchemaText()`, `MANIFEST_JSON_SCHEMA_FILE`, `MANIFEST_SCHEMA_URL` |
| Permissions | `PERMISSIONS`, `parsePermission`, `isPermission`, `normalizePermission`, `permissionScope`, `describePermission(id, locale, { host? })`, `isHttpUrlAllowed`, `HTTP_PERMISSION_PATTERN`, `RESERVED_PERMISSIONS` (empty), `reservedPermission`, `IMPLIED_PERMISSIONS` (`remote`, `ai:tools`), `isImpliedPermission`, `PERMISSION_CATEGORIES`, `permissionCategory`, `permissionDefinition` (`PermissionDefinition.category`, `.legacy`, `.implied`) |
| RPC | `USERS_GET_MAX_IDS` (100), `RPC_LIMITS`, `FORBIDDEN_RECORD_REASONS`, `RPC_METHODS`, `REQUIRED_PERMISSION`, `ALTERNATIVE_PERMISSIONS`, `methodAllowed(method, granted, url?)` (the only permission check hosts, server and mock use), `permissionsForMethod`, `isRpcMethod`, `RPC_ERROR_CODES`, `RpcErrorCode` |
| UI tree | `COMPONENT_TYPES`, `TEXT_NODE_TYPE`, `UiNode`, `UiPatch`, `HandlerRef`, `PropValue`, `JsonValue`, `uiNodeSchema`, `uiPatchSchema`, `uiPatchBatchSchema`, `propValueSchema`, `isHandlerRef` |
| Components | `componentPropSchemas` (strict, per type), `ComponentProps<T>`, `COMPONENT_CHILDREN`, value sets (`TONES`, `SPACINGS`, …) |
| Tree check | `validateTree(nodes, root)` |
| Messages | `SandboxMessage`, `HostMessage`, `AppContext` (`user: AppUser` = `{ id }`, required in `init`), `sandboxMessageSchema`, `hostMessageSchema` |
| Revocations | `revocationDocumentSchema`, `revocationPayloadSchema`, `revocationEntrySchema`, `parseRevocationPayload`, `isRevoked`, `REVOCATION_VALIDITY_MS` (48 h), `REVOCATION_MAX_AGE_MS` (24 h), types `RevocationDocument`, `RevocationPayload`, `RevocationEntry` (Phase 2 server contract §3) |
| Package | `digestSchema`, `signatureSchema`, `PackageDigest`, `PackageSignature`, `packageDigestInput`, `PACKAGE_REQUIRED_FILES`, `isPackagePath` |
| Semver | `isSemver`, `isSemverRange`, `compareSemver`, `satisfiesSemverRange` |

`validateManifest(input)` accepts a parsed value or raw JSON text and returns
`{ ok: true, manifest }` (normalised: `kind` defaulted, `http:` hosts
lowercased) or `{ ok: false, issues }`, every issue with a stable `code`, a
`path`, an English `message` and a `hint`.

`packageDigestInput(files)` sorts paths with plain `Array.prototype.sort` and
concatenates `${path}\n${hex}\n`; SHA-256 of that UTF-8 string is
`digest.package`, and `signature.json` signs the UTF-8 bytes of that hex.

## Versioning

- `SCHEMA_VERSION` (manifest) and `PROTOCOL_VERSION` (UI tree + messages) are
  independent integers, both `1` today.
- Bump `SCHEMA_VERSION` only when an existing valid `olan-app.json` would be
  rejected or read differently (removed/renamed fields, changed meaning,
  stricter rules). Adding an optional field, a new permission, a new surface
  or a new settings field type keeps the version; such additions bump the
  package minor version.
- Top-level fields are known per schema version (`MANIFEST_FIELDS_BY_VERSION`,
  built from the zod shapes in `manifest.ts`: common fields + a per-version
  shape). Unknown fields are rejected (`manifest.unknown_field`). Fields the
  plan has fixed for later phases (`RESERVED_MANIFEST_FIELDS`, empty since
  1.3.0) are rejected with `manifest.feature_not_available`, and permissions
  in `RESERVED_PERMISSIONS` (empty since 1.3.0) with
  `manifest.permission_reserved`. `server` is in the version 1 shape since
  1.3.0 and accepted by default since 1.4.0; `validateManifest(…, { backend: false })`
  answers `manifest.feature_not_available` for it (the server: `OLAN_APPS_BACKEND=0`).
  1.3.0 also added `remote`, `events`, `ai`, seven surfaces and the Phase 3
  permissions. 1.1.0 added `data` to schema version 1 and
  moved `db`, `tasks:write`, `tasks:delete`, `projects:delete` into
  `PERMISSIONS`. 1.2.0 added `users:read` (`users.get`) and `context.user`. Making one available means moving it into a
  version's shape / `PERMISSIONS` and out of the reserved table.
- A schema bump adds a new file `schemas/olan-app.v<N>.json` with `$id`
  `https://olan.app/schemas/olan-app/v<N>.json`; older files stay published.
- Bump `PROTOCOL_VERSION` only when a sandbox built for the old protocol can
  no longer work with the host. New optional props, new components or new RPC
  methods do not bump it. The host refuses `ready` messages whose
  `protocolVersion` is greater than its own.

## Development

```sh
npx vitest run                         # tests
npx tsc --noEmit -p .                  # type-check
npx tsx scripts/emit-json-schema.ts    # regenerate schemas/olan-app.v1.json (commit the result)
```

A test fails when the committed JSON Schema differs from the generated one.

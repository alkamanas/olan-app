import { z } from 'zod';
import { AI_TOOL_LIMITS, AI_TOOL_NAME_PATTERN, aiToolInputProblems, type ManifestAi } from './ai-tools.js';
import { serverSchema, type ManifestServer } from './backend.js';
import { dataSchemaIssues, dataStructureSchema, type DataSchema } from './data.js';
import { EVENT_CATALOG, eventDefinition } from './events.js';
import { jsonObjectSchema, type JsonValue } from './json.js';
import { formatIssuePath } from './issue-path.js';
import { isPackagePath } from './paths.js';
import { PERMISSION_PATTERN, PERMISSIONS, isImpliedPermission, isPermission, normalizePermission, reservedPermission } from './permissions.js';
import { remoteUrlProblem, type ManifestRemote, type RemoteUrlProblem } from './remote.js';
import { SEMVER_PATTERN, isSemverRange } from './semver.js';
import { projectTemplatesSchema, type ManifestProjectTemplate } from './project-templates.js';
import { surfacesSchema, type ManifestSurfaces } from './surfaces.js';
import { SCHEMA_VERSION, SURFACES } from './versions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppKind = 'app' | 'web-link';

interface SettingsFieldBase {
  label: string;
  description?: string;
  required?: boolean;
  /**
   * Stored encrypted on the server and masked in admin screens. Apps without `server` still receive
   * the value; for apps with `server` the UI gets `null` and only backend code reads it
   * (`olan.secrets.get`, Phase 3 §15.1).
   */
  secret?: boolean;
}

export interface SettingsSelectOption {
  value: string;
  label: string;
}

export type SettingsFieldDefinition =
  | (SettingsFieldBase & { type: 'string'; default?: string })
  | (SettingsFieldBase & { type: 'number'; default?: number })
  | (SettingsFieldBase & { type: 'boolean'; default?: boolean })
  | (SettingsFieldBase & { type: 'select'; options: SettingsSelectOption[]; default?: string });

export type SettingsFieldType = SettingsFieldDefinition['type'];

export type SettingsSchema = Record<string, SettingsFieldDefinition>;

/** Parsed (output) form of `olan-app.json`. `kind` and `permissions` are always present after parsing. */
export interface OlanAppManifest {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  sdk: string;
  minServerVersion?: string;
  description?: string;
  entry?: string;
  icon?: string;
  kind: AppKind;
  url?: string;
  surfaces?: ManifestSurfaces;
  /** Canonical permission strings (`http:` hosts lowercased). */
  permissions: string[];
  settings?: SettingsSchema;
  /** App database collections (`olan.db`, Phase 1b). */
  data?: DataSchema;
  /** The app's own server (Phase 3 §1). Implies the `remote` permission. */
  remote?: ManifestRemote;
  /** Event types delivered to `POST {remote.url}/events` (Phase 3 §5.1); needs `remote`. */
  events?: string[];
  /** Assistant tools (Phase 3 §6); need `remote` and imply `ai:tools`. */
  ai?: ManifestAi;
  /** Backend code (Phase 3 §8.1, §15; docs/backend.md). */
  server?: ManifestServer;
  /** Project templates offered in "Yeni proje" while the app is installed (Phase 6). */
  projectTemplates?: ManifestProjectTemplate[];
}

export interface ManifestIssue {
  code: string;
  /** Dotted path into the manifest, e.g. `permissions[1]` or `surfaces["project.widget"].title`. Empty for the root. */
  path: string;
  message: string;
  hint?: string;
  /** Machine-readable details, e.g. `{ event, permission }` for `manifest.event_permission_missing`. */
  detail?: Record<string, string>;
}

export interface ValidateManifestOptions {
  /**
   * Accept `server` (backend code). On by default (Phase 3 §15.1); `false` answers
   * `manifest.feature_not_available` for it (the Olan server with `OLAN_APPS_BACKEND=0`).
   */
  backend?: boolean;
}

/** `server` is accepted unless the caller turns the backend off. */
const backendEnabled = (options: ValidateManifestOptions) => options.backend !== false;

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_URL = 'https://olan.app/schemas/olan-app/v1.json';
export const APP_ID_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const SETTINGS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ICON_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const ICON_FILE_PATTERN = /\.(png|svg|jpe?g|webp)$/i;
const ENTRY_FILE_PATTERN = /\.m?js$/;
const MAX_PERMISSIONS = 64;
const MAX_SETTINGS_FIELDS = 64;

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const notBlank = (value: string) => /\S/.test(value);
const MAX_EVENTS = 64;

const remoteSchema = z
  .strictObject({
    url: z
      .string()
      .max(2048)
      .describe('Base URL of the app server: https (http only for loopback/private hosts, in development). Olan posts to {url}/events, {url}/ai-tools/{name} and {url}/card-actions.'),
    jwksUrl: z.string().max(2048).describe("The app server's public keys (JWKS) for token requests (private_key_jwt)."),
    requests: z
      .boolean()
      .optional()
      .describe('Turns on olan.remote.request: Olan posts signed requests to {url}/requests on behalf of the person (default false).'),
  })
  .describe('The app\'s own server; implies the "remote" permission.');

const aiToolSchema = z.strictObject({
  name: z.string().regex(AI_TOOL_NAME_PATTERN).describe('Tool name: ^[a-z][a-z0-9_]{1,31}$, unique in the app.'),
  title: z.string().min(1).max(AI_TOOL_LIMITS.titleMax).refine(notBlank).optional().describe('Shown on confirmation cards (≤ 80).'),
  description: z.string().min(1).max(AI_TOOL_LIMITS.descriptionMax).refine(notBlank).describe('What the tool does; goes to the model (1–1024).'),
  input: jsonObjectSchema.describe('JSON Schema 2020-12 of the input: "type": "object" at the root, ≤ 8 KiB, only local $ref.'),
  permissions: z.array(z.string()).max(64).default([]).describe('Subset of the manifest permissions; the call token carries only these.'),
  readOnly: z.boolean().default(false).describe('Only reads: runs without confirmation and may be retried once.'),
  destructive: z.boolean().default(false).describe('Deletes or overwrites: always confirmed. Not together with readOnly.'),
  timeoutMs: z
    .number()
    .int()
    .min(AI_TOOL_LIMITS.minTimeoutMs)
    .max(AI_TOOL_LIMITS.maxTimeoutMs)
    .optional()
    .describe(`Call timeout in ms, ${AI_TOOL_LIMITS.minTimeoutMs}–${AI_TOOL_LIMITS.maxTimeoutMs} (readOnly tools ≤ ${AI_TOOL_LIMITS.timeoutMs}); default ${AI_TOOL_LIMITS.timeoutMs}.`),
});

const aiSchema = z
  .strictObject({
    tools: z
      .array(aiToolSchema)
      .max(AI_TOOL_LIMITS.toolsPerApp)
      .optional()
      .describe(`Assistant tools (≤ ${AI_TOOL_LIMITS.toolsPerApp}) run by the app server; implies "ai:tools".`),
  })
  .describe('Olan assistant integration.');

const settingsFieldBase = {
  label: z.string().min(1).max(80).refine(notBlank),
  description: z.string().max(400).optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional().describe('Encrypted on the server and masked in admin screens.'),
};

const selectOptionSchema = z.strictObject({
  value: z.string().min(1).max(128),
  label: z.string().min(1).max(80),
});

const settingsFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), ...settingsFieldBase, default: z.string().max(4096).optional() }),
  z.strictObject({ type: z.literal('number'), ...settingsFieldBase, default: z.number().optional() }),
  z.strictObject({ type: z.literal('boolean'), ...settingsFieldBase, default: z.boolean().optional() }),
  z
    .strictObject({
      type: z.literal('select'),
      ...settingsFieldBase,
      options: z.array(selectOptionSchema).min(1, 'select fields need at least one option'),
      default: z.string().optional(),
    })
    .superRefine((field, ctx) => {
      const seen = new Set<string>();
      field.options.forEach((option, index) => {
        if (seen.has(option.value)) {
          ctx.addIssue({ code: 'custom', path: ['options', index, 'value'], message: `Duplicate option value "${option.value}".` });
        }
        seen.add(option.value);
      });
      if (field.default !== undefined && !seen.has(field.default)) {
        ctx.addIssue({
          code: 'custom',
          path: ['default'],
          message: `default "${field.default}" is not one of the option values.`,
        });
      }
    }),
], { error: 'Settings fields need "type": "string", "number", "boolean" or "select".' });

// ---------------------------------------------------------------------------
// Fields per schema version
// ---------------------------------------------------------------------------
//
// Unknown top-level fields are always rejected. Which fields are known depends
// on `schemaVersion`: `manifestCommonFields` holds the fields every version
// shares and `MANIFEST_SHAPES_BY_VERSION` adds the version-specific ones. A
// later version that brings `data`/`server` adds an entry such as
//
//   2: { $schema, schemaVersion: z.literal(2), ...manifestCommonFields, data: dataSchema, server: serverSchema }
//
// and `validateManifest` then picks the shape by the manifest's `schemaVersion`
// (if a phase instead adds an optional field to an existing version, it goes
// into that version's entry). Fields a future phase will add are listed in
// `RESERVED_MANIFEST_FIELDS`; until a version knows them they are rejected
// with `manifest.feature_not_available` instead of `manifest.unknown_field`.

const schemaUrlField = z.string().optional().describe(`JSON Schema URL, normally "${MANIFEST_SCHEMA_URL}".`);

/** Fields shared by every manifest schema version (everything except `$schema` and `schemaVersion`). */
const manifestCommonFields = {
  id: z
    .string()
    .max(128)
    .regex(APP_ID_PATTERN)
    .describe('Reverse-domain app id, e.g. "com.example.overdue-tasks" (≤ 128).'),
  name: z.string().min(1).max(80).refine(notBlank).describe('Display name (≤ 80).'),
  version: z.string().regex(SEMVER_PATTERN).describe('App version (semver).'),
  sdk: z
    .string()
    .refine(isSemverRange)
    .describe('Supported @olan-app/sdk range: "*", "x.y.z", "^x.y.z", "~x.y.z" or ">=x.y.z <a.b.c".'),
  minServerVersion: z.string().regex(SEMVER_PATTERN).optional().describe('Oldest Olan server version that can install the app.'),
  description: z.string().max(400).optional().describe('Short description (≤ 400).'),
  entry: z
    .string()
    .refine((value) => isPackagePath(value) && ENTRY_FILE_PATTERN.test(value))
    .optional()
    .describe('Bundle path inside the package, normally "dist/app.js". Required for kind "app", absent for "web-link".'),
  icon: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Icon: a package path (png/svg/jpg/webp) for kind "app"; an http(s) URL or Olan icon name for "web-link".'),
  kind: z.enum(['app', 'web-link']).default('app').describe('"app" (default) or "web-link".'),
  url: z.string().refine(isHttpUrl).optional().describe('Only for kind "web-link": the http(s) address to open.'),
  surfaces: surfacesSchema.optional(),
  permissions: z
    .array(z.string().regex(PERMISSION_PATTERN).refine(isPermission))
    .max(MAX_PERMISSIONS)
    .default([])
    .transform((list) => list.map((permission) => normalizePermission(permission) ?? permission))
    .describe(`Requested permissions: ${PERMISSIONS.map((p) => (p.pattern ? 'http:<host>' : p.id)).join(', ')}.`),
  settings: z
    .record(
      z.string().regex(SETTINGS_KEY_PATTERN, 'Setting names start with a letter and use only letters, digits and underscores (≤ 64).'),
      settingsFieldSchema,
    )
    .refine((record) => Object.keys(record).length <= MAX_SETTINGS_FIELDS, `At most ${MAX_SETTINGS_FIELDS} settings fields.`)
    .optional()
    .describe('Settings form fields keyed by setting name.'),
};

const manifestV1Shape = {
  $schema: schemaUrlField,
  schemaVersion: z.literal(SCHEMA_VERSION).describe('Manifest schema version. Currently always 1.'),
  ...manifestCommonFields,
  // Phase 1b added `data` to version 1: an optional field does not change the schema version.
  // Its rules (`manifest.data_*`) come from `dataSchemaIssues`, run with the cross-field rules.
  data: dataStructureSchema.optional(),
  // Phase 3 added these to version 1 too (contract §1); their cross-field rules run below.
  remote: remoteSchema.optional(),
  events: z
    .array(z.string())
    .max(MAX_EVENTS)
    .optional()
    .describe(
      `Events delivered to {remote.url}/events (needs "remote"): ${EVENT_CATALOG.filter((entry) => entry.subscription)
        .map((entry) => entry.type)
        .join(', ')}.`,
    ),
  ai: aiSchema.optional(),
  server: serverSchema.optional(),
  // Phase 6 (second wave): project templates the app offers.
  projectTemplates: projectTemplatesSchema.optional(),
};

/** zod object shape per manifest schema version. */
const MANIFEST_SHAPES_BY_VERSION = { 1: manifestV1Shape } as const;

/** Manifest schema versions this package can validate. */
export type ManifestSchemaVersion = keyof typeof MANIFEST_SHAPES_BY_VERSION;

/** Top-level fields each manifest schema version accepts, in schema order. */
export const MANIFEST_FIELDS_BY_VERSION: Readonly<Record<ManifestSchemaVersion, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MANIFEST_SHAPES_BY_VERSION).map(([version, shape]) => [version, Object.freeze(Object.keys(shape))]),
  ) as Record<ManifestSchemaVersion, readonly string[]>,
);

/** Top-level fields for a manifest's `schemaVersion`; the current version's fields when it is unknown. */
export function manifestFieldsFor(schemaVersion: unknown): readonly string[] {
  return Object.prototype.hasOwnProperty.call(MANIFEST_FIELDS_BY_VERSION, String(schemaVersion))
    ? MANIFEST_FIELDS_BY_VERSION[schemaVersion as ManifestSchemaVersion]
    : MANIFEST_FIELDS_BY_VERSION[SCHEMA_VERSION];
}

export interface ReservedManifestField {
  /** Top-level manifest field. */
  field: string;
  /** Olan Apps phase that introduces the field. */
  phase: 'Phase 1b' | 'Phase 3';
  /** What the field will describe (English, used in messages and the JSON Schema). */
  feature: string;
  /** What to use until then. */
  instead: string;
}

/**
 * Fields the platform plan has fixed but no schema version accepts yet. They
 * are still rejected, with an error that names the phase. Remove a field from
 * this table when a schema version adds it to `MANIFEST_SHAPES_BY_VERSION`.
 * Empty since Phase 3: `server` is in the version 1 shape; `validateManifest(…, { backend: false })`
 * answers `manifest.feature_not_available` for it (see `BACKEND_FEATURE`).
 */
export const RESERVED_MANIFEST_FIELDS: Readonly<Record<string, ReservedManifestField>> = Object.freeze({});

/** `server` on a server that turned backends off (Phase 3 §15.1): what `manifest.feature_not_available` says. */
export const BACKEND_FEATURE: ReservedManifestField = Object.freeze({
  field: 'server',
  phase: 'Phase 3',
  feature: 'backend code that runs on the Olan server (server/)',
  instead: 'run your own server ("remote") or call your service with olan.http.fetch (permission "http:<host>")',
});

function reservedManifestField(key: string): ReservedManifestField | undefined {
  return Object.prototype.hasOwnProperty.call(RESERVED_MANIFEST_FIELDS, key) ? RESERVED_MANIFEST_FIELDS[key] : undefined;
}

const baseManifestSchema = z.strictObject(manifestV1Shape);

// ---------------------------------------------------------------------------
// Cross-field rules (contract §2)
// ---------------------------------------------------------------------------

interface SemanticIssue {
  code: string;
  path: (string | number)[];
  message: string;
  hint?: string;
  detail?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Cross-field checks. Written defensively against raw (unparsed) input so that
 * `validateManifest` can report them together with field errors.
 */
function semanticIssues(raw: Record<string, unknown>, options: ValidateManifestOptions = {}): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const kind = raw.kind === undefined ? 'app' : raw.kind;
  const surfaces = isRecord(raw.surfaces) ? raw.surfaces : undefined;
  const knownSurfaceKeys = surfaces ? Object.keys(surfaces).filter((key) => (SURFACES as readonly string[]).includes(key)) : [];

  if (kind === 'app') {
    if (raw.entry === undefined) {
      issues.push({
        code: 'manifest.entry_required',
        path: ['entry'],
        message: 'Apps of kind "app" must declare "entry", the bundle path inside the package.',
        hint: 'Add "entry": "dist/app.js" (the output of `olan-app build`).',
      });
    }
    if (raw.url !== undefined) {
      issues.push({
        code: 'manifest.url_not_allowed',
        path: ['url'],
        message: '"url" is only allowed when "kind" is "web-link".',
        hint: 'Remove "url", or set "kind": "web-link" and remove "entry".',
      });
    }
    if (raw.surfaces === undefined || (surfaces && Object.keys(surfaces).length === 0)) {
      issues.push({
        code: 'manifest.surfaces_required',
        path: ['surfaces'],
        message: 'Declare at least one surface.',
        hint: 'Add "surfaces": { "app": { "title": "…" } }.',
      });
    }
    if (typeof raw.icon === 'string' && !(isPackagePath(raw.icon) && ICON_FILE_PATTERN.test(raw.icon))) {
      issues.push({
        code: 'manifest.icon',
        path: ['icon'],
        message: '"icon" must be a png, svg, jpg or webp file path inside the package.',
        hint: 'Use e.g. "assets/icon.png".',
      });
    }
  } else if (kind === 'web-link') {
    if (raw.url === undefined) {
      issues.push({
        code: 'manifest.url_required',
        path: ['url'],
        message: 'Web links must declare "url" (http or https).',
        hint: 'Add "url": "https://example.com".',
      });
    }
    if (raw.entry !== undefined) {
      issues.push({
        code: 'manifest.web_link_entry',
        path: ['entry'],
        message: 'Web links have no package bundle, so "entry" is not allowed.',
        hint: 'Remove "entry", or use "kind": "app" for a packaged app.',
      });
    }
    for (const key of knownSurfaceKeys) {
      if (key !== 'app') {
        issues.push({
          code: 'manifest.web_link_surface',
          path: ['surfaces', key],
          message: `Web links only support the "app" surface, not "${key}".`,
          hint: `Remove surfaces["${key}"].`,
        });
      }
    }
    if (Array.isArray(raw.permissions) && raw.permissions.length > 0) {
      issues.push({
        code: 'manifest.web_link_permissions',
        path: ['permissions'],
        message: 'Web links cannot request permissions.',
        hint: 'Set "permissions": [] or remove the field.',
      });
    }
    if (raw.settings !== undefined) {
      issues.push({
        code: 'manifest.web_link_settings',
        path: ['settings'],
        message: 'Web links cannot declare settings.',
        hint: 'Remove "settings".',
      });
    }
    if (raw.data !== undefined) {
      issues.push({
        code: 'manifest.web_link_data',
        path: ['data'],
        message: 'Web links cannot declare an app database ("data").',
        hint: 'Remove "data".',
      });
    }
    for (const key of ['remote', 'events', 'ai', 'server'] as const) {
      if (raw[key] !== undefined && (key !== 'server' || backendEnabled(options))) {
        issues.push({
          code: 'manifest.web_link_remote',
          path: [key],
          message: `Web links cannot declare "${key}": they have no app server, events, assistant tools or backend.`,
          hint: `Remove "${key}", or use "kind": "app".`,
        });
      }
    }
    if (typeof raw.icon === 'string' && !isHttpUrl(raw.icon) && !ICON_NAME_PATTERN.test(raw.icon)) {
      issues.push({
        code: 'manifest.icon',
        path: ['icon'],
        message: 'For web links "icon" must be an http(s) URL or an Olan icon name.',
        hint: 'Use e.g. "globe" or "https://example.com/icon.png".',
      });
    }
  }

  if (Array.isArray(raw.permissions)) {
    const seen = new Set<string>();
    raw.permissions.forEach((permission, index) => {
      if (typeof permission !== 'string') return;
      const canonical = normalizePermission(permission);
      if (!canonical) return;
      if (seen.has(canonical)) {
        issues.push({
          code: 'manifest.permission_duplicate',
          path: ['permissions', index],
          message: `Permission "${permission}" is listed more than once.`,
          hint: 'Remove the duplicate entry (http hosts are compared case-insensitively).',
        });
      }
      seen.add(canonical);
      if (isImpliedPermission(canonical)) {
        issues.push({
          code: 'manifest.permission_unknown',
          path: ['permissions', index],
          message: `"${permission}" is implied by the manifest and cannot be listed in "permissions".`,
          hint: permission === 'remote' ? 'Remove it: declaring "remote" implies it.' : 'Remove it: declaring "ai.tools" implies it.',
        });
      }
    });
  }
  if (raw.data !== undefined && kind !== 'web-link') issues.push(...dataSchemaIssues(raw.data));
  if (kind !== 'web-link') issues.push(...phase3Issues(raw, options));
  if (raw.server !== undefined && !backendEnabled(options)) {
    issues.push({
      code: 'manifest.feature_not_available',
      path: ['server'],
      message: `"server" (${BACKEND_FEATURE.feature}) is turned off on this server.`,
      hint: `Remove "server", or ask the administrator to turn backends on (OLAN_APPS_BACKEND). Otherwise ${BACKEND_FEATURE.instead}.`,
    });
  }
  return issues;
}

const REMOTE_URL_TEXT: Record<RemoteUrlProblem, string> = {
  not_url: 'is not an absolute URL',
  scheme: 'must use https',
  credentials: 'must not contain a user name or password',
  query: 'must not have a query or fragment',
  http_public: 'must use https (plain http is only accepted for localhost and private network addresses, in development installations)',
};

function declaredPermissions(raw: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(raw.permissions)) {
    for (const permission of raw.permissions) {
      const canonical = typeof permission === 'string' ? normalizePermission(permission) : null;
      if (canonical) out.add(canonical);
    }
  }
  return out;
}

/** Event subscriptions at `path` (manifest `events`, or the keys of `server.events`). */
function eventIssues(types: readonly unknown[], pathOf: (index: number, type: string) => (string | number)[], permissions: Set<string>): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  types.forEach((type, index) => {
    if (typeof type !== 'string') return;
    const definition = eventDefinition(type);
    if (!definition) {
      issues.push({
        code: 'manifest.event_unknown',
        path: pathOf(index, type),
        message: `Unknown event "${type}".`,
        hint: `Events: ${EVENT_CATALOG.map((entry) => entry.type).join(', ')}.`,
      });
      return;
    }
    if (definition.permission && !permissions.has(definition.permission)) {
      issues.push({
        code: 'manifest.event_permission_missing',
        path: pathOf(index, type),
        message: `The "${type}" event needs the "${definition.permission}" permission.`,
        hint: `Add "${definition.permission}" to "permissions".`,
        detail: { event: type, permission: definition.permission },
      });
    }
  });
  return issues;
}

/** Surfaces, `remote`, `events`, `ai.tools` and `server` (Phase 3 contract §1, §3, §6, §8). */
function phase3Issues(raw: Record<string, unknown>, options: ValidateManifestOptions): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const permissions = declaredPermissions(raw);
  const hasRemote = raw.remote !== undefined;

  if (isRecord(raw.remote)) {
    for (const key of ['url', 'jwksUrl'] as const) {
      const value = raw.remote[key];
      if (value === undefined) continue;
      const problem = remoteUrlProblem(value);
      if (problem) {
        issues.push({
          code: 'manifest.remote_invalid_url',
          path: ['remote', key],
          message: `remote.${key} ${REMOTE_URL_TEXT[problem]}.`,
          hint: key === 'url' ? 'Use e.g. "https://standup.example.com/olan".' : 'Use e.g. "https://standup.example.com/.well-known/jwks.json".',
        });
      }
    }
  }

  if (permissions.has('profile:read') && !hasRemote && Array.isArray(raw.permissions)) {
    issues.push({
      code: 'manifest.profile_requires_remote',
      path: ['permissions', raw.permissions.indexOf('profile:read')],
      message: '"profile:read" sends the person\'s profile to the app\'s own server, so it needs "remote".',
      hint: 'Add "remote": { "url": "https://…", "jwksUrl": "https://…", "requests": true }, or remove "profile:read".',
    });
  }

  if (Array.isArray(raw.events)) {
    if (raw.events.length > 0 && !hasRemote) {
      issues.push({
        code: 'manifest.events_require_remote',
        path: ['events'],
        message: 'Events are delivered to the app\'s own server, so "events" needs "remote".',
        hint: 'Add "remote": { "url": "https://…", "jwksUrl": "https://…" }, or remove "events".',
      });
    }
    issues.push(...eventIssues(raw.events, (index) => ['events', index], permissions));
  }

  const ai = isRecord(raw.ai) ? raw.ai : undefined;
  if (ai && Array.isArray(ai.tools)) {
    if (ai.tools.length > 0 && !hasRemote) {
      issues.push({
        code: 'manifest.ai_tools_require_remote',
        path: ['ai', 'tools'],
        message: 'Assistant tools run on the app\'s own server, so "ai.tools" needs "remote".',
        hint: 'Add "remote": { "url": "https://…", "jwksUrl": "https://…" }, or remove "ai".',
      });
    }
    const names = new Set<string>();
    ai.tools.forEach((tool, index) => {
      if (!isRecord(tool)) return;
      if (typeof tool.name === 'string') {
        if (names.has(tool.name)) {
          issues.push({ code: 'manifest.ai_tool_invalid', path: ['ai', 'tools', index, 'name'], message: `Tool name "${tool.name}" is used twice.`, hint: 'Tool names are unique in the app.' });
        }
        names.add(tool.name);
      }
      if (tool.readOnly === true && typeof tool.timeoutMs === 'number' && tool.timeoutMs > AI_TOOL_LIMITS.timeoutMs) {
        issues.push({
          code: 'manifest.ai_tool_invalid',
          path: ['ai', 'tools', index, 'timeoutMs'],
          message: `Read-only tools keep the ${AI_TOOL_LIMITS.timeoutMs} ms limit; "timeoutMs" up to ${AI_TOOL_LIMITS.maxTimeoutMs} is for tools that change something.`,
          hint: `Lower "timeoutMs" to ${AI_TOOL_LIMITS.timeoutMs} or less, or remove it.`,
        });
      }
      if (tool.readOnly === true && tool.destructive === true) {
        issues.push({
          code: 'manifest.ai_tool_invalid',
          path: ['ai', 'tools', index],
          message: 'A tool cannot be both "readOnly" and "destructive".',
          hint: 'Read-only tools only read; set one of them to false.',
        });
      }
      if (tool.input !== undefined) {
        for (const problem of aiToolInputProblems(tool.input)) {
          issues.push({ code: 'manifest.ai_tool_invalid', path: ['ai', 'tools', index, 'input'], message: problem, hint: 'Use a JSON Schema object such as { "type": "object", "properties": { … } }.' });
        }
      }
      if (Array.isArray(tool.permissions)) {
        tool.permissions.forEach((permission, permissionIndex) => {
          const canonical = typeof permission === 'string' ? normalizePermission(permission) : null;
          if (canonical && permissions.has(canonical)) return;
          issues.push({
            code: 'manifest.ai_tool_permission_missing',
            path: ['ai', 'tools', index, 'permissions', permissionIndex],
            message: `Tool "${String(tool.name)}" uses "${String(permission)}", which the manifest does not request.`,
            hint: 'Tool permissions must be a subset of "permissions".',
            ...(typeof permission === 'string' ? { detail: { tool: String(tool.name), permission } } : {}),
          });
        });
      }
    });
  }

  if (backendEnabled(options) && isRecord(raw.server)) issues.push(...serverIssues(raw.server, permissions, raw.settings));
  return issues;
}

function serverIssues(server: Record<string, unknown>, permissions: Set<string>, settings: unknown): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  if (isRecord(server.events)) {
    const types = Object.keys(server.events);
    issues.push(...eventIssues(types, (_index, type) => ['server', 'events', type], permissions));
  }
  for (const key of ['schedules', 'hooks'] as const) {
    const list = server[key];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return;
      if (seen.has(entry.name)) {
        issues.push({ code: 'manifest.server_invalid', path: ['server', key, index, 'name'], message: `server.${key}: "${entry.name}" is used twice.` });
      }
      seen.add(entry.name);
    });
  }
  if (Array.isArray(server.hooks)) {
    server.hooks.forEach((hook, index) => {
      const verify = isRecord(hook) && isRecord(hook.verify) ? hook.verify : undefined;
      if (!verify) return;
      const path = ['server', 'hooks', index, 'verify'];
      if (verify.kind === 'hmac-sha256' && (verify.header === undefined || verify.secretSetting === undefined)) {
        issues.push({ code: 'manifest.server_invalid', path, message: '"hmac-sha256" hooks need "header" and "secretSetting".' });
      }
      if (verify.kind === 'standard-webhooks' && verify.secretSetting === undefined) {
        issues.push({ code: 'manifest.server_invalid', path, message: '"standard-webhooks" hooks need "secretSetting".' });
      }
      if (typeof verify.secretSetting === 'string') {
        const field = isRecord(settings) ? settings[verify.secretSetting] : undefined;
        if (!isRecord(field) || field.secret !== true) {
          issues.push({
            code: 'manifest.server_invalid',
            path: [...path, 'secretSetting'],
            message: `secretSetting "${verify.secretSetting}" must name a "secret": true field in "settings".`,
            hint: `Add "settings": { "${verify.secretSetting}": { "type": "string", "label": "…", "secret": true } }.`,
          });
        }
      }
    });
  }
  return issues;
}

/**
 * Permissions the manifest implies (Phase 3 §1): `remote` when it declares `remote`, `ai:tools`
 * when it declares assistant tools. They are never written in `permissions`; consent screens show
 * them (`describePermission(id, locale, { host: remoteHost(manifest.remote) })`), they belong to the
 * effective permissions and a policy may block them. Surfaces imply nothing.
 */
export function impliedPermissions(manifest: Pick<OlanAppManifest, 'remote' | 'ai'>): string[] {
  const out: string[] = [];
  if (manifest.remote) out.push('remote');
  if ((manifest.ai?.tools?.length ?? 0) > 0) out.push('ai:tools');
  return out;
}

/** `permissions` followed by `impliedPermissions`: everything an installation of the manifest asks for. */
export function requestedPermissions(manifest: Pick<OlanAppManifest, 'permissions' | 'remote' | 'ai'>): string[] {
  return [...manifest.permissions, ...impliedPermissions(manifest)];
}

function buildManifestSchema(options: ValidateManifestOptions): z.ZodType<OlanAppManifest> {
  return baseManifestSchema.superRefine((manifest, ctx) => {
    for (const issue of semanticIssues(manifest as Record<string, unknown>, options)) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
        params: { code: issue.code, hint: issue.hint, semantic: true },
      });
    }
  }) as unknown as z.ZodType<OlanAppManifest>;
}

/** Zod schema for `olan-app.json` (schema version 1), including the cross-field rules. */
export const manifestSchema: z.ZodType<OlanAppManifest> = buildManifestSchema({});
const manifestSchemaWithoutBackend = buildManifestSchema({ backend: false });

/** Structural schema without cross-field rules; used for JSON Schema output. */
export const manifestBaseSchema = baseManifestSchema;

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment as string];
  }
  return current;
}

const PERMISSION_HINT = `Use one of: ${PERMISSIONS.filter((p) => !p.pattern)
  .map((p) => p.id)
  .join(', ')}, or http:<host> (hostname with an optional :port, no scheme or path).`;

interface FieldRule {
  code: string;
  message: (value: unknown) => string;
  hint?: string;
}

const FIELD_RULES: Record<string, FieldRule> = {
  $schema: { code: 'manifest.schema_url', message: () => '"$schema" must be a string.', hint: `Use "${MANIFEST_SCHEMA_URL}".` },
  schemaVersion: {
    code: 'manifest.schema_version',
    message: (value) => `"schemaVersion" must be ${SCHEMA_VERSION}${value === undefined ? '' : `, got ${JSON.stringify(value)}`}.`,
    hint: `Set "schemaVersion": ${SCHEMA_VERSION}.`,
  },
  id: {
    code: 'manifest.id',
    message: () =>
      '"id" must be a reverse-domain identifier: lowercase letters, digits and hyphens in at least two dot-separated segments, at most 128 characters.',
    hint: 'Use e.g. "com.example.overdue-tasks".',
  },
  name: { code: 'manifest.name', message: () => '"name" must be a non-empty string of at most 80 characters.', hint: 'Use a short display name.' },
  version: {
    code: 'manifest.version',
    message: () => '"version" must be a semver version (MAJOR.MINOR.PATCH).',
    hint: 'Use e.g. "0.1.0".',
  },
  sdk: {
    code: 'manifest.sdk',
    message: () => '"sdk" must be a semver range: "*", "1.2.3", "^1.2.3", "~1.2.3" or comparators such as ">=1.0.0 <2.0.0".',
    hint: 'Use "^1.0.0".',
  },
  minServerVersion: {
    code: 'manifest.min_server_version',
    message: () => '"minServerVersion" must be a semver version.',
    hint: 'Use e.g. "1.0.0" or remove the field.',
  },
  description: { code: 'manifest.description', message: () => '"description" must be a string of at most 400 characters.', hint: 'Shorten the description.' },
  entry: {
    code: 'manifest.entry',
    message: () => '"entry" must be a relative .js/.mjs path inside the package (forward slashes, no "..").',
    hint: 'Use "dist/app.js".',
  },
  icon: { code: 'manifest.icon', message: () => '"icon" must be a non-empty string of at most 512 characters.', hint: 'Use e.g. "assets/icon.png".' },
  kind: { code: 'manifest.kind', message: () => '"kind" must be "app" or "web-link".', hint: 'Remove "kind" for a packaged app.' },
  url: { code: 'manifest.url', message: () => '"url" must be an absolute http or https URL.', hint: 'Use e.g. "https://example.com".' },
  surfaces: {
    code: 'manifest.surface_invalid',
    message: () => 'Invalid surface definition.',
    hint: 'Each surface is an object like { "title": "…" }; Phase 3 surfaces need a title, chat.command also "command".',
  },
  remote: {
    code: 'manifest.remote_invalid_url',
    message: () => '"remote" must be { "url": "https://…", "jwksUrl": "https://…" }.',
    hint: 'Use e.g. { "url": "https://standup.example.com/olan", "jwksUrl": "https://standup.example.com/.well-known/jwks.json" }.',
  },
  events: {
    code: 'manifest.event_unknown',
    message: () => '"events" must be an array of at most 64 event type strings.',
    hint: `Events: ${EVENT_CATALOG.map((entry) => entry.type).join(', ')}.`,
  },
  ai: {
    code: 'manifest.ai_tool_invalid',
    message: () => '"ai" must be { "tools": [ … ] }.',
    hint: 'Each tool needs "name" (^[a-z][a-z0-9_]{1,31}$), "description" (1–1024) and "input" (a JSON Schema object); at most 16 tools.',
  },
  server: {
    code: 'manifest.server_invalid',
    message: () => '"server" must be { "entry": "server/index.ts", "schedules"?, "events"?, "hooks"? }.',
    hint: 'See docs/manifest.md#server.',
  },
  projectTemplates: {
    code: 'manifest.project_template_invalid',
    message: () => '"projectTemplates" must be an array of at most 5 { key, name, description?, content } with unique keys.',
    hint: 'See docs/manifest.md#projecttemplates: content is { version: 1, lists: [ { key, title, steps? } ], statuses?, labels?, tasks?, recordTemplates?, settings? }.',
  },
  permissions: { code: 'manifest.permissions', message: () => `"permissions" must be an array of at most ${MAX_PERMISSIONS} permission strings.`, hint: PERMISSION_HINT },
  settings: {
    code: 'manifest.settings_field',
    message: () => 'Invalid settings field.',
    hint: 'Each field needs "type" (string, number, boolean or select) and "label"; select fields need "options"; "default" must match the type.',
  },
};

function mapZodIssue(issue: z.core.$ZodIssue, input: unknown, options: ValidateManifestOptions): ManifestIssue[] {
  const path = issue.path;
  // `data` is reported by `dataSchemaIssues` (precise `manifest.data_*` codes), not from zod.
  if (path[0] === 'data') return [];
  // With the backend turned off `server` gets one `manifest.feature_not_available` (cross-field rules).
  if (path[0] === 'server' && !backendEnabled(options)) return [];
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const fullPath = [...path, key];
      if (path.length === 0) {
        const schemaVersion = isRecord(input) ? input.schemaVersion : undefined;
        const reserved = reservedManifestField(String(key));
        if (reserved) {
          return {
            code: 'manifest.feature_not_available',
            path: formatIssuePath(fullPath),
            message: `"${key}" is reserved for ${reserved.feature} and is not available with "schemaVersion": ${JSON.stringify(schemaVersion ?? SCHEMA_VERSION)}.`,
            hint: `Remove "${key}": it arrives in Olan Apps ${reserved.phase}. Until then ${reserved.instead}.`,
          };
        }
        return {
          code: 'manifest.unknown_field',
          path: formatIssuePath(fullPath),
          message: `Unknown manifest field "${key}".`,
          hint: `Remove "${key}". Allowed fields: ${manifestFieldsFor(schemaVersion).join(', ')}.`,
        };
      }
      if (path.length === 1 && path[0] === 'surfaces') {
        return {
          code: 'manifest.surface_unknown',
          path: formatIssuePath(fullPath),
          message: `Unknown surface "${key}".`,
          hint: `Supported surfaces: ${SURFACES.join(', ')}.`,
        };
      }
      const rule = FIELD_RULES[String(path[0])];
      return {
        code: rule?.code ?? 'manifest.invalid',
        path: formatIssuePath(fullPath),
        message: `Unknown field "${key}" in ${formatIssuePath(path)}.`,
        hint: `Remove "${key}".`,
      };
    });
  }

  const top = path.length > 0 ? String(path[0]) : '';
  const value = valueAt(input, path);
  const pathText = formatIssuePath(path);

  if (top === 'permissions' && path.length >= 2) {
    const reserved = typeof value === 'string' ? reservedPermission(value) : undefined;
    if (reserved) {
      return [
        {
          code: 'manifest.permission_reserved',
          path: pathText,
          message: `Permission "${value}" (${reserved.feature}) is reserved and not available yet.`,
          hint: `Remove "${value}": it arrives in Olan Apps ${reserved.phase}. ${PERMISSION_HINT}`,
        },
      ];
    }
    return [
      {
        code: 'manifest.permission_unknown',
        path: pathText,
        message: typeof value === 'string' ? `Unknown permission "${value}".` : 'Permissions must be strings.',
        hint: PERMISSION_HINT,
      },
    ];
  }

  const rule = FIELD_RULES[top];
  if (!rule) {
    return [{ code: path.length === 0 ? 'manifest.not_object' : 'manifest.invalid', path: pathText, message: issue.message }];
  }
  // Nested structures keep the precise zod message.
  const nested = ['surfaces', 'settings', 'remote', 'events', 'ai', 'server'].includes(top) && path.length > 1;
  // Record key failures wrap the key schema's own issue.
  const detail = issue.code === 'invalid_key' ? (issue.issues[0]?.message ?? issue.message) : issue.message;
  let message = nested ? `${pathText}: ${detail}` : rule.message(value);
  if (!nested && value === undefined && path.length === 1) message = `"${top}" is required. ${message}`;
  const code = top === 'surfaces' && path[1] === 'chat.command' && path[2] === 'command' ? 'manifest.command_invalid' : rule.code;
  const hint = code === 'manifest.command_invalid' ? 'Use lowercase letters, digits and hyphens after a letter, 2–32 characters, e.g. "standup".' : rule.hint;
  return [{ code, path: pathText, message, ...(hint ? { hint } : {}) }];
}

export type ValidateManifestResult = { ok: true; manifest: OlanAppManifest } | { ok: false; issues: ManifestIssue[] };

/**
 * Validates an `olan-app.json` value (parsed object or raw JSON text) and
 * returns either the normalised manifest or every issue found. `server` is accepted unless
 * `{ backend: false }`.
 */
export function validateManifest(input: unknown, options: ValidateManifestOptions = {}): ValidateManifestResult {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            code: 'manifest.invalid_json',
            path: '',
            message: `olan-app.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            hint: 'Check for trailing commas, comments and unquoted keys; the manifest must be plain JSON.',
          },
        ],
      };
    }
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ code: 'manifest.not_object', path: '', message: 'The manifest must be a JSON object.', hint: 'Start from `olan-app init` or the documented example.' }],
    };
  }

  const result = (backendEnabled(options) ? manifestSchema : manifestSchemaWithoutBackend).safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };

  const issues: ManifestIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: ManifestIssue) => {
    const key = `${issue.code}\u0000${issue.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  for (const issue of result.error.issues) {
    if (issue.code === 'custom' && (issue.params as { semantic?: boolean } | undefined)?.semantic) continue;
    mapZodIssue(issue, value, options).forEach(push);
  }
  // Cross-field rules are skipped by zod when field errors exist; run them on the raw input.
  for (const issue of semanticIssues(value, options)) {
    push({ code: issue.code, path: formatIssuePath(issue.path), message: issue.message, ...(issue.hint ? { hint: issue.hint } : {}), ...(issue.detail ? { detail: issue.detail } : {}) });
  }
  if (issues.length === 0) {
    const first = result.error.issues[0];
    push({ code: 'manifest.invalid', path: formatIssuePath(first?.path ?? []), message: first?.message ?? 'Invalid manifest.' });
  }
  return { ok: false, issues };
}

// ---------------------------------------------------------------------------
// Settings values
// ---------------------------------------------------------------------------

/** Default values declared in the manifest settings schema. Fields without `default` are omitted. */
export function defaultSettings(manifest: Pick<OlanAppManifest, 'settings'>): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(manifest.settings ?? {})) {
    if (field.default !== undefined) values[key] = field.default;
  }
  return values;
}

export interface SettingsIssue {
  code: 'settings.not_object' | 'settings.unknown_key' | 'settings.type' | 'settings.option' | 'settings.required';
  key: string;
  message: string;
}

/**
 * Validates installation settings against the manifest schema. Returns the
 * values merged over the defaults when valid.
 */
export function validateSettings(
  manifest: Pick<OlanAppManifest, 'settings'>,
  values: unknown,
): { ok: true; values: Record<string, JsonValue> } | { ok: false; issues: SettingsIssue[] } {
  if (!isRecord(values)) {
    return { ok: false, issues: [{ code: 'settings.not_object', key: '', message: 'Settings must be a JSON object.' }] };
  }
  const schema = manifest.settings ?? {};
  const issues: SettingsIssue[] = [];
  const merged: Record<string, JsonValue> = defaultSettings(manifest);
  for (const [key, value] of Object.entries(values)) {
    const field = schema[key];
    if (!field) {
      issues.push({ code: 'settings.unknown_key', key, message: `Unknown setting "${key}".` });
      continue;
    }
    // null clears the value: the default (if any) applies.
    if (value === null || value === undefined) continue;
    const expected = field.type === 'select' ? 'string' : field.type;
    if (typeof value !== expected || (field.type === 'number' && !Number.isFinite(value))) {
      issues.push({ code: 'settings.type', key, message: `Setting "${key}" must be a ${field.type === 'select' ? 'string option value' : field.type}.` });
      continue;
    }
    if (field.type === 'select' && !field.options.some((option) => option.value === value)) {
      issues.push({ code: 'settings.option', key, message: `Setting "${key}" must be one of: ${field.options.map((o) => o.value).join(', ')}.` });
      continue;
    }
    merged[key] = value as JsonValue;
  }
  for (const [key, field] of Object.entries(schema)) {
    if (!field.required) continue;
    const value = merged[key];
    if (value === undefined || (typeof value === 'string' && value.length === 0)) {
      issues.push({ code: 'settings.required', key, message: `Setting "${key}" is required.` });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, values: merged };
}

import { z } from 'zod';
import { type ManifestAi } from './ai-tools.js';
import { type ManifestServer } from './backend.js';
import { type DataSchema } from './data.js';
import { type JsonValue } from './json.js';
import { type ManifestRemote } from './remote.js';
import { type ManifestProjectTemplate } from './project-templates.js';
import { type ManifestSurfaces } from './surfaces.js';
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
export type SettingsFieldDefinition = (SettingsFieldBase & {
    type: 'string';
    default?: string;
}) | (SettingsFieldBase & {
    type: 'number';
    default?: number;
}) | (SettingsFieldBase & {
    type: 'boolean';
    default?: boolean;
}) | (SettingsFieldBase & {
    type: 'select';
    options: SettingsSelectOption[];
    default?: string;
});
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
export declare const MANIFEST_SCHEMA_URL = "https://olan.app/schemas/olan-app/v1.json";
export declare const APP_ID_PATTERN: RegExp;
export declare const SETTINGS_KEY_PATTERN: RegExp;
export declare function isHttpUrl(value: unknown): value is string;
/** zod object shape per manifest schema version. */
declare const MANIFEST_SHAPES_BY_VERSION: {
    readonly 1: {
        data: z.ZodOptional<z.ZodObject<{
            version: z.ZodNumber;
            collections: z.ZodRecord<z.ZodString, z.ZodObject<{
                scope: z.ZodEnum<{
                    user: "user";
                    organization: "organization";
                }>;
                fields: z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                    maxLength: z.ZodOptional<z.ZodNumber>;
                    enum: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    required: z.ZodOptional<z.ZodBoolean>;
                    indexed: z.ZodOptional<z.ZodBoolean>;
                    label: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"string">;
                }, z.core.$strict>, z.ZodObject<{
                    integer: z.ZodOptional<z.ZodBoolean>;
                    min: z.ZodOptional<z.ZodNumber>;
                    max: z.ZodOptional<z.ZodNumber>;
                    required: z.ZodOptional<z.ZodBoolean>;
                    indexed: z.ZodOptional<z.ZodBoolean>;
                    label: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"number">;
                }, z.core.$strict>, ...z.ZodObject<{
                    required: z.ZodOptional<z.ZodBoolean>;
                    indexed: z.ZodOptional<z.ZodBoolean>;
                    label: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"boolean" | "date" | "datetime" | "json" | "ref:project" | "ref:task" | "ref:user">;
                }, z.core.$strict>[]], "type">>;
                rules: z.ZodOptional<z.ZodObject<{
                    read: z.ZodOptional<z.ZodEnum<{
                        any: "any";
                        owner: "owner";
                    }>>;
                    update: z.ZodOptional<z.ZodEnum<{
                        any: "any";
                        owner: "owner";
                    }>>;
                    delete: z.ZodOptional<z.ZodEnum<{
                        any: "any";
                        owner: "owner";
                    }>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        remote: z.ZodOptional<z.ZodObject<{
            url: z.ZodString;
            jwksUrl: z.ZodString;
            requests: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        events: z.ZodOptional<z.ZodArray<z.ZodString>>;
        ai: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodString;
                input: z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>;
                permissions: z.ZodDefault<z.ZodArray<z.ZodString>>;
                readOnly: z.ZodDefault<z.ZodBoolean>;
                destructive: z.ZodDefault<z.ZodBoolean>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        server: z.ZodOptional<z.ZodObject<{
            entry: z.ZodString;
            schedules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                cron: z.ZodString;
                timeZone: z.ZodOptional<z.ZodString>;
                function: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            events: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            hooks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                function: z.ZodOptional<z.ZodString>;
                verify: z.ZodObject<{
                    kind: z.ZodEnum<{
                        "hmac-sha256": "hmac-sha256";
                        "standard-webhooks": "standard-webhooks";
                        none: "none";
                    }>;
                    header: z.ZodOptional<z.ZodString>;
                    secretSetting: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        projectTemplates: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            content: z.ZodObject<{
                version: z.ZodLiteral<1>;
                lists: z.ZodArray<z.ZodObject<{
                    key: z.ZodString;
                    title: z.ZodString;
                    code: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        key: z.ZodString;
                        title: z.ZodString;
                        color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                statuses: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    key: z.ZodString;
                    name: z.ZodString;
                    color: z.ZodString;
                    category: z.ZodEnum<{
                        backlog: "backlog";
                        unstarted: "unstarted";
                        started: "started";
                        completed: "completed";
                        cancelled: "cancelled";
                    }>;
                }, z.core.$strict>>>;
                labels: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    color: z.ZodString;
                    groupName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                    description: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>>;
                tasks: z.ZodOptional<z.ZodArray<z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>>>;
                recordTemplates: z.ZodOptional<z.ZodArray<z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>>>;
                settings: z.ZodOptional<z.ZodObject<{
                    description: z.ZodOptional<z.ZodString>;
                    coverColor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                    estimateScale: z.ZodOptional<z.ZodEnum<{
                        none: "none";
                        fibonacci: "fibonacci";
                        linear: "linear";
                        tshirt: "tshirt";
                    }>>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
        }, z.core.$strict>>>;
        id: z.ZodString;
        name: z.ZodString;
        version: z.ZodString;
        sdk: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
        minServerVersion: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        entry: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
        kind: z.ZodDefault<z.ZodEnum<{
            app: "app";
            "web-link": "web-link";
        }>>;
        url: z.ZodOptional<z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>;
        surfaces: z.ZodOptional<z.ZodObject<Record<"app" | "project.widget" | "settings" | "chat.action" | "chat.command" | "chat.card" | "mail.sidebar" | "mail.action" | "calendar.event.action" | "meeting.panel" | "project.tab" | "project.settings" | "task.action" | "issue.action" | "record.card", z.ZodOptional<z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>>>, z.core.$strict>>;
        permissions: z.ZodPipe<z.ZodDefault<z.ZodArray<z.ZodString>>, z.ZodTransform<string[], string[]>>;
        settings: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            default: z.ZodOptional<z.ZodString>;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            secret: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodLiteral<"string">;
        }, z.core.$strict>, z.ZodObject<{
            default: z.ZodOptional<z.ZodNumber>;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            secret: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodLiteral<"number">;
        }, z.core.$strict>, z.ZodObject<{
            default: z.ZodOptional<z.ZodBoolean>;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            secret: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodLiteral<"boolean">;
        }, z.core.$strict>, z.ZodObject<{
            options: z.ZodArray<z.ZodObject<{
                value: z.ZodString;
                label: z.ZodString;
            }, z.core.$strict>>;
            default: z.ZodOptional<z.ZodString>;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            secret: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodLiteral<"select">;
        }, z.core.$strict>], "type">>>;
        $schema: z.ZodOptional<z.ZodString>;
        schemaVersion: z.ZodLiteral<1>;
    };
};
/** Manifest schema versions this package can validate. */
export type ManifestSchemaVersion = keyof typeof MANIFEST_SHAPES_BY_VERSION;
/** Top-level fields each manifest schema version accepts, in schema order. */
export declare const MANIFEST_FIELDS_BY_VERSION: Readonly<Record<ManifestSchemaVersion, readonly string[]>>;
/** Top-level fields for a manifest's `schemaVersion`; the current version's fields when it is unknown. */
export declare function manifestFieldsFor(schemaVersion: unknown): readonly string[];
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
export declare const RESERVED_MANIFEST_FIELDS: Readonly<Record<string, ReservedManifestField>>;
/** `server` on a server that turned backends off (Phase 3 §15.1): what `manifest.feature_not_available` says. */
export declare const BACKEND_FEATURE: ReservedManifestField;
/**
 * Permissions the manifest implies (Phase 3 §1): `remote` when it declares `remote`, `ai:tools`
 * when it declares assistant tools. They are never written in `permissions`; consent screens show
 * them (`describePermission(id, locale, { host: remoteHost(manifest.remote) })`), they belong to the
 * effective permissions and a policy may block them. Surfaces imply nothing.
 */
export declare function impliedPermissions(manifest: Pick<OlanAppManifest, 'remote' | 'ai'>): string[];
/** `permissions` followed by `impliedPermissions`: everything an installation of the manifest asks for. */
export declare function requestedPermissions(manifest: Pick<OlanAppManifest, 'permissions' | 'remote' | 'ai'>): string[];
/** Zod schema for `olan-app.json` (schema version 1), including the cross-field rules. */
export declare const manifestSchema: z.ZodType<OlanAppManifest>;
/** Structural schema without cross-field rules; used for JSON Schema output. */
export declare const manifestBaseSchema: z.ZodObject<{
    data: z.ZodOptional<z.ZodObject<{
        version: z.ZodNumber;
        collections: z.ZodRecord<z.ZodString, z.ZodObject<{
            scope: z.ZodEnum<{
                user: "user";
                organization: "organization";
            }>;
            fields: z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                maxLength: z.ZodOptional<z.ZodNumber>;
                enum: z.ZodOptional<z.ZodArray<z.ZodString>>;
                required: z.ZodOptional<z.ZodBoolean>;
                indexed: z.ZodOptional<z.ZodBoolean>;
                label: z.ZodOptional<z.ZodString>;
                type: z.ZodLiteral<"string">;
            }, z.core.$strict>, z.ZodObject<{
                integer: z.ZodOptional<z.ZodBoolean>;
                min: z.ZodOptional<z.ZodNumber>;
                max: z.ZodOptional<z.ZodNumber>;
                required: z.ZodOptional<z.ZodBoolean>;
                indexed: z.ZodOptional<z.ZodBoolean>;
                label: z.ZodOptional<z.ZodString>;
                type: z.ZodLiteral<"number">;
            }, z.core.$strict>, ...z.ZodObject<{
                required: z.ZodOptional<z.ZodBoolean>;
                indexed: z.ZodOptional<z.ZodBoolean>;
                label: z.ZodOptional<z.ZodString>;
                type: z.ZodLiteral<"boolean" | "date" | "datetime" | "json" | "ref:project" | "ref:task" | "ref:user">;
            }, z.core.$strict>[]], "type">>;
            rules: z.ZodOptional<z.ZodObject<{
                read: z.ZodOptional<z.ZodEnum<{
                    any: "any";
                    owner: "owner";
                }>>;
                update: z.ZodOptional<z.ZodEnum<{
                    any: "any";
                    owner: "owner";
                }>>;
                delete: z.ZodOptional<z.ZodEnum<{
                    any: "any";
                    owner: "owner";
                }>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    remote: z.ZodOptional<z.ZodObject<{
        url: z.ZodString;
        jwksUrl: z.ZodString;
        requests: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    events: z.ZodOptional<z.ZodArray<z.ZodString>>;
    ai: z.ZodOptional<z.ZodObject<{
        tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodString;
            input: z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>;
            permissions: z.ZodDefault<z.ZodArray<z.ZodString>>;
            readOnly: z.ZodDefault<z.ZodBoolean>;
            destructive: z.ZodDefault<z.ZodBoolean>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    server: z.ZodOptional<z.ZodObject<{
        entry: z.ZodString;
        schedules: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            cron: z.ZodString;
            timeZone: z.ZodOptional<z.ZodString>;
            function: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        events: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        hooks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            function: z.ZodOptional<z.ZodString>;
            verify: z.ZodObject<{
                kind: z.ZodEnum<{
                    "hmac-sha256": "hmac-sha256";
                    "standard-webhooks": "standard-webhooks";
                    none: "none";
                }>;
                header: z.ZodOptional<z.ZodString>;
                secretSetting: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    projectTemplates: z.ZodOptional<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        content: z.ZodObject<{
            version: z.ZodLiteral<1>;
            lists: z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                title: z.ZodString;
                code: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    key: z.ZodString;
                    title: z.ZodString;
                    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>;
            statuses: z.ZodOptional<z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                name: z.ZodString;
                color: z.ZodString;
                category: z.ZodEnum<{
                    backlog: "backlog";
                    unstarted: "unstarted";
                    started: "started";
                    completed: "completed";
                    cancelled: "cancelled";
                }>;
            }, z.core.$strict>>>;
            labels: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                color: z.ZodString;
                groupName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                description: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            tasks: z.ZodOptional<z.ZodArray<z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>>>;
            recordTemplates: z.ZodOptional<z.ZodArray<z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>>>;
            settings: z.ZodOptional<z.ZodObject<{
                description: z.ZodOptional<z.ZodString>;
                coverColor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                estimateScale: z.ZodOptional<z.ZodEnum<{
                    none: "none";
                    fibonacci: "fibonacci";
                    linear: "linear";
                    tshirt: "tshirt";
                }>>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>>>;
    id: z.ZodString;
    name: z.ZodString;
    version: z.ZodString;
    sdk: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
    minServerVersion: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    entry: z.ZodOptional<z.ZodString>;
    icon: z.ZodOptional<z.ZodString>;
    kind: z.ZodDefault<z.ZodEnum<{
        app: "app";
        "web-link": "web-link";
    }>>;
    url: z.ZodOptional<z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>;
    surfaces: z.ZodOptional<z.ZodObject<Record<"app" | "project.widget" | "settings" | "chat.action" | "chat.command" | "chat.card" | "mail.sidebar" | "mail.action" | "calendar.event.action" | "meeting.panel" | "project.tab" | "project.settings" | "task.action" | "issue.action" | "record.card", z.ZodOptional<z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>>>, z.core.$strict>>;
    permissions: z.ZodPipe<z.ZodDefault<z.ZodArray<z.ZodString>>, z.ZodTransform<string[], string[]>>;
    settings: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        default: z.ZodOptional<z.ZodString>;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodBoolean>;
        secret: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodLiteral<"string">;
    }, z.core.$strict>, z.ZodObject<{
        default: z.ZodOptional<z.ZodNumber>;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodBoolean>;
        secret: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodLiteral<"number">;
    }, z.core.$strict>, z.ZodObject<{
        default: z.ZodOptional<z.ZodBoolean>;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodBoolean>;
        secret: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodLiteral<"boolean">;
    }, z.core.$strict>, z.ZodObject<{
        options: z.ZodArray<z.ZodObject<{
            value: z.ZodString;
            label: z.ZodString;
        }, z.core.$strict>>;
        default: z.ZodOptional<z.ZodString>;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodBoolean>;
        secret: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodLiteral<"select">;
    }, z.core.$strict>], "type">>>;
    $schema: z.ZodOptional<z.ZodString>;
    schemaVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export type ValidateManifestResult = {
    ok: true;
    manifest: OlanAppManifest;
} | {
    ok: false;
    issues: ManifestIssue[];
};
/**
 * Validates an `olan-app.json` value (parsed object or raw JSON text) and
 * returns either the normalised manifest or every issue found. `server` is accepted unless
 * `{ backend: false }`.
 */
export declare function validateManifest(input: unknown, options?: ValidateManifestOptions): ValidateManifestResult;
/** Default values declared in the manifest settings schema. Fields without `default` are omitted. */
export declare function defaultSettings(manifest: Pick<OlanAppManifest, 'settings'>): Record<string, JsonValue>;
export interface SettingsIssue {
    code: 'settings.not_object' | 'settings.unknown_key' | 'settings.type' | 'settings.option' | 'settings.required';
    key: string;
    message: string;
}
/**
 * Validates installation settings against the manifest schema. Returns the
 * values merged over the defaults when valid.
 */
export declare function validateSettings(manifest: Pick<OlanAppManifest, 'settings'>, values: unknown): {
    ok: true;
    values: Record<string, JsonValue>;
} | {
    ok: false;
    issues: SettingsIssue[];
};
export {};

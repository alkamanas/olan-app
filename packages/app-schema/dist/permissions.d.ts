export interface LocalizedText {
    tr: string;
    en: string;
}
/**
 * Consent screens group permissions by category, in this order: read, write, delete (its own
 * heading in a warning tone), app data, network, settings.
 */
export declare const PERMISSION_CATEGORIES: readonly ["read", "write", "delete", "data", "network", "settings"];
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];
export interface PermissionDefinition {
    /** Permission string, or `http:*` for the host pattern entry. */
    id: string;
    label: LocalizedText;
    description: LocalizedText;
    /** OAuth scope the app token receives for this permission, or null when the host enforces it. */
    scope: string | null;
    /** Consent screen group (`PERMISSION_CATEGORIES` order). */
    category: PermissionCategory;
    /**
     * Still valid for existing apps; new apps use the replacement (`projects:write` → `tasks:write`).
     * No error or warning is raised.
     */
    legacy?: boolean;
    /** Set on the pattern entry (`http:<host>`). */
    pattern?: 'http';
    /**
     * Implied by the manifest (Phase 3 §1: `remote`, `ai:tools`; see `impliedPermissions`), never
     * written in `permissions`. Shown at consent, part of the effective permissions and blockable by
     * policy. `{host}` in its texts is the app server's host (`describePermission(id, locale, { host })`).
     */
    implied?: true;
}
export declare const PERMISSIONS: readonly PermissionDefinition[];
export interface ReservedPermission {
    id: string;
    /** Olan Apps phase that introduces the permission. */
    phase: 'Phase 1b' | 'Phase 3';
    /** What it will allow (English, used in messages). */
    feature: string;
}
export declare const RESERVED_PERMISSIONS: readonly ReservedPermission[];
/** The reserved (not yet grantable) permission with this id, if any. */
export declare function reservedPermission(permission: string): ReservedPermission | undefined;
/** Id of the pattern entry; also the `REQUIRED_PERMISSION` value of `http.fetch`. */
export declare const HTTP_PERMISSION_PATTERN = "http:*";
/**
 * Syntactic pattern for every valid permission string (JSON Schema friendly).
 * `parsePermission` additionally checks the port range and the host length.
 */
export declare const PERMISSION_PATTERN: RegExp;
export type ParsedPermission = {
    kind: 'static';
    id: string;
} | {
    kind: 'http';
    host: string;
};
/**
 * Parses a permission string. `http:` hosts are normalised to lowercase and
 * keep an explicit port (`http:API.Example.com:8443` → `api.example.com:8443`).
 * Schemes, paths, wildcards, IPv6 literals and `http:*` itself are rejected.
 */
export declare function parsePermission(permission: string): ParsedPermission | null;
export declare function isPermission(permission: string): boolean;
/** Canonical form of a permission string (`http:` hosts lowercased), or null when invalid. */
export declare function normalizePermission(permission: string): string | null;
/**
 * OAuth scope granted for a permission (contract §2 table); null for
 * host-enforced, reserved or unknown permissions. The scope comes from the
 * `PERMISSION_LIST` entry, so a new permission's scope is set there. Several
 * permissions share a scope (`tasks:write`, `tasks:delete`, `projects:delete`
 * → `projects:write`); the app-token guard checks the permission itself.
 */
export declare function permissionScope(permission: string): string | null;
/** Consent screen category of a valid permission (`http:<host>` → `network`), or null. */
export declare function permissionCategory(permission: string): PermissionCategory | null;
/** The definition behind a valid permission (`http:<host>` → the `http:*` entry), or null. */
export declare function permissionDefinition(permission: string): PermissionDefinition | null;
/**
 * Consent texts of a permission. `http:<host>` fills in its own host; the implied permissions
 * (`remote`, `ai:tools`) fill in `options.host`, the app server's host (`remoteHost(manifest)`).
 */
export declare function describePermission(permission: string, locale: 'tr' | 'en', options?: {
    host?: string | null;
}): {
    label: string;
    description: string;
};
/** Permissions the manifest implies (Phase 3 §1, `impliedPermissions`); never listed in `permissions`. */
export declare const IMPLIED_PERMISSIONS: readonly string[];
export declare function isImpliedPermission(permission: unknown): boolean;
/**
 * Whether `url` may be fetched with the given permissions. A permission
 * without a port matches only the scheme's default port (http 80, https 443);
 * `http:host:port` matches only that explicit port. Only http/https URLs and
 * URLs without credentials qualify. The server still blocks private addresses.
 */
export declare function isHttpUrlAllowed(url: string, permissions: readonly string[]): boolean;

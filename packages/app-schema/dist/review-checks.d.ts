import { type UiNode } from './ui.js';
import type { OlanAppManifest } from './manifest.js';
export type ReviewCheckId = 'manifest' | 'size' | 'files' | 'permissions' | 'forbidden-apis' | 'surfaces' | 'interaction' | 'accessibility' | 'licenses';
/** Report order of the checks. */
export declare const REVIEW_CHECK_IDS: readonly ReviewCheckId[];
export type ReviewSeverity = 'error' | 'warning' | 'info';
export type ReviewRule = '1.1' | '1.2' | '1.3' | '1.4' | '1.5' | '2.1' | '2.2' | '2.3' | '2.4' | '3.1' | '3.2' | '3.3' | '4.1' | '4.2' | '5.1' | '5.2' | '5.3' | '5.4' | '6.1' | '6.2' | '7.1' | '7.2' | '8.1';
export interface ReviewFinding {
    check: ReviewCheckId;
    /** Stable machine code, e.g. `permissions.unused`, `forbidden.eval`, `a11y.button_label_missing`. */
    code: string;
    severity: ReviewSeverity;
    message: string;
    /** Package path (and `#line:column`) or surface, when it applies. */
    path?: string;
    hint?: string;
    rule?: ReviewRule;
}
export interface ReviewUsage {
    /** `olan.*` methods the bundle calls (`db.*` stands for any `olan.db.collection(…)` method). */
    rpcMethods: string[];
    /** Requested permissions that something the bundle calls needs. */
    permissionsUsed: string[];
    /** Requested permissions nothing in the bundle needs. */
    permissionsUnused: string[];
    /** Hosts of URL literals in the bundle and of `olan.http.fetch` calls seen at run time. */
    httpHosts: string[];
}
export interface StaticReviewInput {
    manifest: OlanAppManifest;
    /** Package files by path (bytes or UTF-8 text). `digest.json`/`signature.json` may be included. */
    files: Record<string, Uint8Array | string>;
    /** Size of the `.olanapp` archive itself. */
    sizeBytes?: number;
}
export interface StaticReviewResult {
    findings: ReviewFinding[];
    usage: ReviewUsage;
}
/** Entry bundles above this size get a `size.entry_large` warning (2 MiB). */
export declare const ENTRY_BUNDLE_WARN_BYTES: number;
/** File types a package may contain (plus extensionless `LICENSE*`, `NOTICE*`, `COPYING*`). */
export declare const ALLOWED_PACKAGE_EXTENSIONS: readonly string[];
/** Native code and bytecode: never allowed (rule 1.3). */
export declare const NATIVE_BINARY_EXTENSIONS: readonly string[];
/** Sorts findings deterministically: check order, severity, code, path, message. */
export declare function sortFindings<T extends ReviewFinding>(findings: readonly T[]): T[];
/** Drops findings with the same check, code, severity, path and message. */
export declare function dedupeFindings<T extends ReviewFinding>(findings: readonly T[]): T[];
/** Stand-in method for `olan.db.collection(…)` use (which `db.*` method runs is not visible statically). */
export declare const DB_ANY_METHOD = "db.*";
export interface BundleUsage {
    /** `olan.*` methods called (`db.*` for `olan.db.collection(…)`). */
    rpcMethods: string[];
    /** Hosts (`host` or `host:port`) of absolute http(s) URL literals, lowercased; React's error links left out. */
    urlHosts: string[];
}
/**
 * What a bundle calls, from property chains that survive minification (`x.projects.tasks(`,
 * `x.db.collection(`, `x.http.fetch(`). The SDK's own API table is written as object literals
 * (`{list(u){return rpc("projects.list",u)}}`), so it does not count as use. An app that
 * destructures the API (`const { projects } = olan`) is not seen; the run-time pass covers it.
 *
 * `{ backend: true }` scans backend code (`dist/server.js`): its `olan.*` methods are
 * `BACKEND_HOST_METHODS`, which carry the RPC names (and permissions) of the UI methods, plus
 * `secrets.get` (no permission).
 */
export declare function scanBundleUsage(code: string, options?: {
    backend?: boolean;
}): BundleUsage;
/** What a package calls: the entry bundle's usage, plus its backend's (`dist/server.js`, manifest `server`). */
export interface PackageUsage extends BundleUsage {
    /** Usage of `dist/server.js` when the manifest declares `server` and the package carries it, else null. */
    server: (BundleUsage & {
        path: string;
    }) | null;
}
/**
 * `scanBundleUsage` over a package's files: the entry bundle and, with a manifest `server`, the
 * backend bundle (backend methods map 1:1 to RPC names). Pass the result to `reviewPermissions`
 * (`rpcMethods`, `urlHosts`, `server`) so permissions only backend code needs are not "unused".
 */
export declare function scanPackageUsage(manifest: Pick<OlanAppManifest, 'entry' | 'server'>, files: Readonly<Record<string, Uint8Array | string>>): PackageUsage;
/** `host` or `host:port` of an http(s) URL as `http:<host>` permissions name it, or null. */
export declare function urlPermissionHost(url: string): string | null;
export interface PermissionReviewInput {
    /** `events`, `server.events` and `ai.tools[].permissions` count as uses of their permissions; `remote` with a `chat.card` surface uses `chat:write`. */
    manifest: Pick<OlanAppManifest, 'permissions' | 'data' | 'events' | 'server' | 'ai' | 'remote' | 'surfaces'>;
    /** Methods seen statically and/or at run time (`db.*` allowed). */
    rpcMethods: readonly string[];
    /** Hosts of URL literals in the bundle. */
    urlHosts?: readonly string[];
    /** Hosts `olan.http.fetch` was called with at run time. */
    fetchedHosts?: readonly string[];
    /** Where to point static findings (the entry bundle). */
    path?: string;
    /**
     * The backend's usage (`scanPackageUsage(…).server`, from `dist/server.js`): its methods and URL
     * literals count like the UI's; findings about methods only it calls point at its `path`.
     */
    server?: {
        rpcMethods: readonly string[];
        urlHosts?: readonly string[];
        path?: string;
    } | null;
}
/**
 * Compares requested permissions with what the app uses: requested but unused → warning (2.1);
 * used but not requested → error (2.1); `olan.http.fetch` without any `http:<host>` or to a host
 * not granted → error (2.3); every requested host is listed for the reviewer (2.3). Backend code
 * (`input.server`) and declared uses (event subscriptions, assistant tools) count as use too.
 */
export declare function reviewPermissions(input: PermissionReviewInput): StaticReviewResult;
/** Licenses whose obligations reach the whole app (rule 6.2: manual review). */
export declare const COPYLEFT_LICENSES: readonly string[];
/**
 * Every static check on a package's files: `size`, `files`, `forbidden-apis` (every .js file),
 * `permissions` (static usage of the entry bundle and of `dist/server.js`) and `licenses`. Sorted, deterministic.
 */
export declare function runStaticReviewChecks(input: StaticReviewInput): StaticReviewResult;
/**
 * Accessibility lint of a rendered tree (mirrors `olan-app validate --strict`): unlabelled
 * Buttons, fields and actions → error (4.1); a Menu with only an icon → warning (4.1); an Image
 * without `alt` → warning (4.2); List items without a key and repeated keys → warning.
 * `where` (a surface) becomes the findings' `path`.
 */
export declare function lintUiTree(nodes: UiNode[], where?: string): ReviewFinding[];

export declare const APP_RETURN_PATH_PREFIX = "/apps/return/";
export declare const APP_LINK_PATH_PREFIX = "/apps/a/";
export declare const LINK_LIMITS: Readonly<{
    /** Query parameters of a return or app address. */
    params: 50;
    /** Their total size (`key=value` UTF-8 bytes). */
    paramsBytes: 4096;
    /** A pending `openExternal(…, { expectReturn: true })` resolves `{ returned: false }` after this. */
    returnTimeoutMs: number;
    urlMax: 4096;
}>;
/** Screen names in app addresses (`/apps/a/<appId>/<screen>`). */
export declare const SCREEN_NAME_PATTERN: RegExp;
/** First screen and its params, from an app address (`init.navigation`). */
export interface AppNavigationStart {
    /** `index` unless the address names a screen. */
    screen: string;
    params: Record<string, string>;
}
/** `https://<webOrigin>/apps/return/<installationId>`: where an app server sends the person back. */
export declare function appReturnUrl(webOrigin: string, installationId: string): string;
/** Whether `url` is the return address of `installationId` on `webOrigin` (query allowed, nothing else). */
export declare function isAppReturnUrl(url: string, webOrigin: string, installationId: string): boolean;
/**
 * Query parameters as the host passes them (`params` of `openExternal`, `init.params.return`,
 * `init.navigation.params`): strings, the last of repeated keys, fragment ignored. Null when there
 * are more than 50 or they exceed 4 KiB.
 */
export declare function linkParams(search: string | URLSearchParams): Record<string, string> | null;
/** The installation and params of a return address (any origin; check it with `isAppReturnUrl`). */
export declare function parseAppReturnUrl(url: string): {
    installationId: string;
    params: Record<string, string>;
} | null;
/** `https://<webOrigin>/apps/a/<appId>[/<screen>][?params]`: the permanent address of an app. */
export declare function appLinkUrl(webOrigin: string, appId: string, options?: {
    screen?: string;
    params?: Record<string, string>;
}): string;
/**
 * Parses an app address (a URL, or a path with its query): `{ appId, navigation }`, or null when it
 * is not one (wrong path, invalid app id or screen, too many params).
 */
export declare function parseAppLink(url: string): {
    appId: string;
    navigation: AppNavigationStart;
} | null;
export type ExternalUrlProblem = 'not_url' | 'scheme' | 'credentials' | 'http_public';
/**
 * The URL rule of `ui.openUrl` and `ui.openExternal`: `https:`; `http:` only for loopback/private
 * hosts in development installations; no credentials. Null when allowed.
 */
export declare function externalUrlProblem(url: unknown, context?: {
    development?: boolean;
}): ExternalUrlProblem | null;

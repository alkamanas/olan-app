import { isPrivateHost } from './remote.js';

/*
 * Olan web addresses of apps (Phase 5a contract §5, §8; G5, G8): the return address of external
 * flows (`/apps/return/<installationId>`), the permanent app address (`/apps/a/<appId>[/<screen>]`)
 * and the URL rule of `ui.openUrl` / `ui.openExternal`. Web, mobile, the server and app servers
 * (Markanera's `returnUrl` check) share these.
 */

export const APP_RETURN_PATH_PREFIX = '/apps/return/';
export const APP_LINK_PATH_PREFIX = '/apps/a/';

export const LINK_LIMITS = Object.freeze({
  /** Query parameters of a return or app address. */
  params: 50,
  /** Their total size (`key=value` UTF-8 bytes). */
  paramsBytes: 4096,
  /** A pending `openExternal(…, { expectReturn: true })` resolves `{ returned: false }` after this. */
  returnTimeoutMs: 30 * 60 * 1000,
  urlMax: 4096,
});

/** Screen names in app addresses (`/apps/a/<appId>/<screen>`). */
export const SCREEN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const APP_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const INSTALLATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** First screen and its params, from an app address (`init.navigation`). */
export interface AppNavigationStart {
  /** `index` unless the address names a screen. */
  screen: string;
  params: Record<string, string>;
}

const trimOrigin = (webOrigin: string) => new URL(webOrigin).origin;

/** `https://<webOrigin>/apps/return/<installationId>`: where an app server sends the person back. */
export function appReturnUrl(webOrigin: string, installationId: string): string {
  return `${trimOrigin(webOrigin)}${APP_RETURN_PATH_PREFIX}${encodeURIComponent(installationId)}`;
}

/** Whether `url` is the return address of `installationId` on `webOrigin` (query allowed, nothing else). */
export function isAppReturnUrl(url: string, webOrigin: string, installationId: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === trimOrigin(webOrigin) && parsed.pathname === `${APP_RETURN_PATH_PREFIX}${encodeURIComponent(installationId)}` && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * Query parameters as the host passes them (`params` of `openExternal`, `init.params.return`,
 * `init.navigation.params`): strings, the last of repeated keys, fragment ignored. Null when there
 * are more than 50 or they exceed 4 KiB.
 */
export function linkParams(search: string | URLSearchParams): Record<string, string> | null {
  const query = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of query) {
    out[key] = value;
    bytes += new TextEncoder().encode(`${key}=${value}`).length;
  }
  if (Object.keys(out).length > LINK_LIMITS.params || bytes > LINK_LIMITS.paramsBytes) return null;
  return out;
}

/** The installation and params of a return address (any origin; check it with `isAppReturnUrl`). */
export function parseAppReturnUrl(url: string): { installationId: string; params: Record<string, string> } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(APP_RETURN_PATH_PREFIX)) return null;
    const installationId = decodeURIComponent(parsed.pathname.slice(APP_RETURN_PATH_PREFIX.length));
    if (!INSTALLATION_ID.test(installationId)) return null;
    const params = linkParams(parsed.searchParams);
    return params ? { installationId, params } : null;
  } catch {
    return null;
  }
}

/** `https://<webOrigin>/apps/a/<appId>[/<screen>][?params]`: the permanent address of an app. */
export function appLinkUrl(webOrigin: string, appId: string, options: { screen?: string; params?: Record<string, string> } = {}): string {
  const screen = options.screen && options.screen !== 'index' ? `/${encodeURIComponent(options.screen)}` : '';
  const query = options.params && Object.keys(options.params).length > 0 ? `?${new URLSearchParams(options.params).toString()}` : '';
  return `${trimOrigin(webOrigin)}${APP_LINK_PATH_PREFIX}${appId}${screen}${query}`;
}

/**
 * Parses an app address (a URL, or a path with its query): `{ appId, navigation }`, or null when it
 * is not one (wrong path, invalid app id or screen, too many params).
 */
export function parseAppLink(url: string): { appId: string; navigation: AppNavigationStart } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://olan.invalid');
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith(APP_LINK_PATH_PREFIX)) return null;
  const parts = parsed.pathname.slice(APP_LINK_PATH_PREFIX.length).split('/').filter((part) => part.length > 0);
  if (parts.length < 1 || parts.length > 2) return null;
  const appId = parts[0]!;
  if (!APP_ID.test(appId) || appId.length > 128) return null;
  let screen = 'index';
  if (parts[1] !== undefined) {
    try {
      screen = decodeURIComponent(parts[1]);
    } catch {
      return null;
    }
    if (!SCREEN_NAME_PATTERN.test(screen)) return null;
  }
  const params = linkParams(parsed.searchParams);
  return params ? { appId, navigation: { screen, params } } : null;
}

export type ExternalUrlProblem = 'not_url' | 'scheme' | 'credentials' | 'http_public';

/**
 * The URL rule of `ui.openUrl` and `ui.openExternal`: `https:`; `http:` only for loopback/private
 * hosts in development installations; no credentials. Null when allowed.
 */
export function externalUrlProblem(url: unknown, context: { development?: boolean } = {}): ExternalUrlProblem | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > LINK_LIMITS.urlMax) return 'not_url';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not_url';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'scheme';
  if (parsed.username || parsed.password) return 'credentials';
  if (parsed.protocol === 'http:' && !(context.development === true && isPrivateHost(parsed.hostname))) return 'http_public';
  return null;
}

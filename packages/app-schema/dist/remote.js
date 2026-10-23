/*
 * The app's own server (`remote`, Phase 3 contract §1, §4, §5.3). Shared by the manifest validator,
 * the Olan server (signing, delivery, token endpoint) and `@olan-app/sdk/server` (verification,
 * client assertions). No runtime dependencies: plain functions and constants.
 */
/** Fixed paths under `remote.url` (§1). */
export const REMOTE_PATHS = Object.freeze({
    events: 'events',
    aiTools: 'ai-tools',
    cardActions: 'card-actions',
    /** Phase 5a (G1): `remote.request` calls. */
    requests: 'requests',
});
/**
 * Issuer of Olan's own cloud (`/.well-known/olan` `apps.issuer` = `OLAN_PUBLIC_URL` in production,
 * Phase 5a G20). Self-hosted and development servers have their own issuer.
 */
export const OLAN_CLOUD_ISSUER = 'https://api.olan.app';
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/**
 * Whether a hostname is loopback, private, link-local or otherwise local (`localhost`,
 * `*.localhost`, `*.local`, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8,
 * `::1`, `fc00::/7`, `fe80::/10`). Name resolution is not done here: the server's egress guard
 * still checks where a public name resolves.
 */
export function isPrivateHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
        return true;
    const v4 = IPV4.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    if (host.includes(':')) {
        if (host === '::1' || host === '::')
            return true;
        if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host))
            return true;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
        if (mapped)
            return isPrivateHost(mapped[1]);
    }
    return false;
}
/**
 * Checks a `remote.url` / `remote.jwksUrl`: an absolute https URL without credentials, query or
 * fragment; `http:` only for loopback/private hosts (development, §1). Returns null when valid.
 */
export function remoteUrlProblem(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048)
        return 'not_url';
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return 'not_url';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return 'scheme';
    if (!url.hostname)
        return 'not_url';
    if (url.username || url.password)
        return 'credentials';
    if (url.search || url.hash || value.includes('#'))
        return 'query';
    if (url.protocol === 'http:' && !isPrivateHost(url.hostname))
        return 'http_public';
    return null;
}
export function isRemoteUrl(value) {
    return remoteUrlProblem(value) === null;
}
/**
 * Whether a valid remote URL is only allowed for development installations with
 * `OLAN_APPS_REMOTE_ALLOW_PRIVATE=1` (§1): plain http, or a loopback/private host.
 */
export function isDevelopmentRemoteUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || isPrivateHost(url.hostname);
    }
    catch {
        return false;
    }
}
/**
 * `POST` target under a remote base URL: `remoteEndpoint(url, 'events')`,
 * `remoteEndpoint(url, 'ai-tools', 'standup_summary')`, `remoteEndpoint(url, 'card-actions')`,
 * `remoteEndpoint(url, 'requests')` (Phase 5a).
 */
export function remoteEndpoint(baseUrl, path, name) {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const tail = path === 'ai-tools' ? `ai-tools/${encodeURIComponent(name ?? '')}` : path;
    return new URL(tail, base).toString();
}
/** Host shown in consent texts of `remote` / `ai:tools` (`describePermission(..., { host })`). */
export function remoteHost(remote) {
    if (!remote)
        return null;
    try {
        const url = new URL(remote.url);
        return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Olan → app: signed requests (§5.3, Standard Webhooks with asymmetric `v1a`)
// ---------------------------------------------------------------------------
/** Request headers of every signed call to the app's server (events, ai-tools, card-actions). */
export const WEBHOOK_HEADERS = Object.freeze({
    /** `evt_…` / `call_…` / `act_…` / `req_…`; the idempotency key, the same on every attempt. */
    id: 'webhook-id',
    /** Unix seconds of this attempt. */
    timestamp: 'webhook-timestamp',
    /** `v1a,<base64 Ed25519 signature>`; several space-separated during key rotation. */
    signature: 'webhook-signature',
    /** The Olan server (`OLAN_PUBLIC_URL`); checked against the app's issuer allowlist first. */
    issuer: 'olan-issuer',
    /** `kid` of the signing key in the issuer's JWKS. */
    keyId: 'olan-key-id',
    installationId: 'olan-installation-id',
    /** Events only. */
    eventType: 'olan-event-type',
    /** Events only: 1-based attempt number. */
    attempt: 'olan-delivery-attempt',
});
/** Signature scheme prefix (asymmetric Standard Webhooks). */
export const WEBHOOK_SIGNATURE_VERSION = 'v1a';
/** Receivers reject timestamps further than this from their clock (±5 min). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Receivers keep seen `webhook-id`s at least this long. */
export const WEBHOOK_ID_RETENTION_SECONDS = 24 * 60 * 60;
/** The exact bytes that are signed: `${id}.${timestamp}.${rawBody}` (UTF-8). */
export function webhookSignedContent(id, timestamp, rawBody) {
    return `${id}.${timestamp}.${rawBody}`;
}
/** Signature header value for base64 signatures: `v1a,<sig>[ v1a,<sig>]`. */
export function formatWebhookSignature(signatures) {
    return signatures.map((signature) => `${WEBHOOK_SIGNATURE_VERSION},${signature}`).join(' ');
}
/** The base64 signatures of a `webhook-signature` header that use `v1a` (others are ignored). */
export function parseWebhookSignature(header) {
    if (!header)
        return [];
    return header
        .split(' ')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${WEBHOOK_SIGNATURE_VERSION},`))
        .map((part) => part.slice(WEBHOOK_SIGNATURE_VERSION.length + 1))
        .filter((signature) => signature.length > 0);
}
/** Path of the Olan apps signing JWKS (§4.3): `GET <issuer>/api/v2/apps/jwks.json`. */
export const APPS_JWKS_PATH = '/api/v2/apps/jwks.json';
/** Discovery document: `<issuer>/.well-known/olan` → `apps.jwksUri`, `apps.tokenEndpoint`. */
export const WELL_KNOWN_PATH = '/.well-known/olan';
/** Seconds the Olan JWKS may be cached (`Cache-Control: max-age=600`). */
export const APPS_JWKS_MAX_AGE_SECONDS = 600;
// ---------------------------------------------------------------------------
// app → Olan: token endpoint (§4.2, private_key_jwt / RFC 7523)
// ---------------------------------------------------------------------------
export const APP_TOKEN_PATH = '/api/v2/apps/oauth/token';
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const CLIENT_ASSERTION_ALGORITHMS = ['EdDSA', 'ES256', 'RS256'];
/** `exp` may be at most this many seconds after `iat`. */
export const CLIENT_ASSERTION_MAX_LIFETIME_SECONDS = 300;
/** Tokens from the token endpoint live at most this long. */
export const APP_SERVER_TOKEN_MAX_SECONDS = 900;
/** Tokens embedded in ai-tools and card-actions requests live this long. */
export const EMBEDDED_TOKEN_SECONDS = 300;
/** `aud` of a client assertion: the issuer's token endpoint. */
export function clientAssertionAudience(issuer) {
    return `${issuer.replace(/\/+$/, '')}${APP_TOKEN_PATH}`;
}

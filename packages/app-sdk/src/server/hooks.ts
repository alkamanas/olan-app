/*
 * Incoming webhook verification for backend hooks (manifest `server.hooks[].verify`, Phase 3
 * §8.1). The Olan server runs these before a hook function sees the request; `olan-app dev` and
 * `createBackendHarness` use the same code. WebCrypto only.
 */
import { fromBase64, toBase64, utf8 } from './crypto.js';

/** `server.hooks[].verify` (repeated from @olan-app/schema so this module stays dependency-free). */
export interface HookVerifyConfig {
  kind: 'hmac-sha256' | 'standard-webhooks' | 'none';
  /** `hmac-sha256`: the header carrying the hex signature (e.g. `x-hub-signature-256`). */
  header?: string;
  /** The `secret: true` setting holding the shared secret. */
  secretSetting?: string;
}

export type HookVerificationResult =
  | { ok: true }
  | { ok: false; status: 401 | 413 | 503; code: 'hook_verification_failed' | 'hook_secret_missing' | 'payload_too_large'; message: string };

/** Hook body limit (`BACKEND_LIMITS.hookBodyBytes`). */
export const HOOK_BODY_MAX_BYTES = 1024 * 1024;
/** Standard Webhooks timestamp tolerance (seconds). */
export const HOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

/** Constant-time comparison of two byte strings. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function fromHex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function standardWebhooksKey(secret: string): Uint8Array<ArrayBuffer> {
  return secret.startsWith('whsec_') ? fromBase64(secret.slice('whsec_'.length)) : utf8(secret);
}

const bodyBytes = (body: string | Uint8Array): Uint8Array<ArrayBuffer> => (typeof body === 'string' ? utf8(body) : (new Uint8Array(body) as Uint8Array<ArrayBuffer>));

/**
 * Checks an incoming hook request against its manifest `verify` (Phase 3 §8.1):
 * - body ≤ 1 MiB (`413 payload_too_large`);
 * - `hmac-sha256`: `verify.header` holds the hex HMAC-SHA256 of the raw body with the secret, with
 *   an optional `sha256=` prefix (GitHub's `x-hub-signature-256`);
 * - `standard-webhooks`: `webhook-id`, `webhook-timestamp` (± 5 min) and `webhook-signature`
 *   (`v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, several space-separated), `whsec_` secrets;
 * - `none`: accepted only when `development` is true (development installations).
 * A missing secret answers `503 hook_secret_missing`, a bad signature `401 hook_verification_failed`.
 */
export async function verifyHookSignature(
  verify: HookVerifyConfig,
  request: { headers: HeaderSource; body: string | Uint8Array },
  secret: string | null | undefined,
  options: { development?: boolean; now?: number } = {},
): Promise<HookVerificationResult> {
  const body = bodyBytes(request.body);
  if (body.byteLength > HOOK_BODY_MAX_BYTES) return { ok: false, status: 413, code: 'payload_too_large', message: `Hook bodies are limited to ${HOOK_BODY_MAX_BYTES} bytes` };
  const fail = (message: string): HookVerificationResult => ({ ok: false, status: 401, code: 'hook_verification_failed', message });
  if (verify.kind === 'none') return options.development ? { ok: true } : fail('"verify": { "kind": "none" } is only accepted in development installations');
  if (!secret) return { ok: false, status: 503, code: 'hook_secret_missing', message: `The secret setting "${verify.secretSetting ?? ''}" is not set for this installation` };
  if (verify.kind === 'hmac-sha256') {
    const given = header(request.headers, verify.header ?? '');
    if (!given) return fail(`Missing signature header ${verify.header ?? ''}`);
    const bytes = fromHex(given.trim().replace(/^sha256=/i, ''));
    if (!bytes) return fail('The signature header is not hex');
    return same(bytes, await hmac(utf8(secret), body)) ? { ok: true } : fail('The HMAC-SHA256 signature does not match the body');
  }
  const id = header(request.headers, 'webhook-id');
  const timestamp = header(request.headers, 'webhook-timestamp');
  const signatures = header(request.headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) return fail('Missing webhook-id, webhook-timestamp or webhook-signature');
  const seconds = Number(timestamp);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > HOOK_TIMESTAMP_TOLERANCE_SECONDS) return fail('webhook-timestamp is outside the 5 minute tolerance');
  const signed = new Uint8Array([...utf8(`${id}.${timestamp}.`), ...body]);
  const expected = await hmac(standardWebhooksKey(secret), signed);
  for (const entry of signatures.split(' ')) {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) continue;
    try {
      if (same(fromBase64(value), expected)) return { ok: true };
    } catch {
      // not base64: try the next entry
    }
  }
  return fail('No webhook-signature entry matches');
}

/** Headers that make `body` pass `verify` with `secret` (for tests and local tools). */
export async function signHookRequest(verify: HookVerifyConfig, body: string | Uint8Array, secret: string, options: { now?: number; id?: string } = {}): Promise<Record<string, string>> {
  const bytes = bodyBytes(body);
  if (verify.kind === 'hmac-sha256') return { [(verify.header ?? 'x-signature').toLowerCase()]: `sha256=${toHex(await hmac(utf8(secret), bytes))}` };
  if (verify.kind === 'standard-webhooks') {
    const id = options.id ?? `msg_${crypto.randomUUID()}`;
    const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000));
    const signature = await hmac(standardWebhooksKey(secret), new Uint8Array([...utf8(`${id}.${timestamp}.`), ...bytes]));
    return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${toBase64(signature)}` };
  }
  return {};
}

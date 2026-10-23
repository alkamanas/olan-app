/**
 * Server tests for an app's own server (`remote`, `@olan-app/sdk/server`): a local Olan issuer with
 * its own Ed25519 key, and requests signed exactly as Olan signs `POST {remote.url}/requests`.
 *
 * ```ts
 * const issuer = await createTestIssuer();
 * const olan = createOlanServer({ appId: 'com.example.media', issuers: [issuer.issuer] });
 * const { headers, body } = signRemoteRequest(issuer, { appId: 'com.example.media', request: { method: 'GET', path: '/items' } });
 * const response = await olan.handleRequest({ headers, body }, routes);   // HTTP 200 { status, headers?, body }
 * await issuer.close();
 * ```
 */
import type { JsonValue, RemoteRequestEnvelope, RemoteRequestInit, RemoteRequestUser } from '@olan-app/schema';

import { DEFAULT_ORGANIZATION_ID, DEFAULT_USER_ID, MOCK_INSTALLATION_ID } from '../mock-server';
import { generateIssuerKey, remoteEnvelope, signRemoteEnvelope, startLocalIssuer, type DevIssuer } from '../remote-dev';

export interface TestIssuerOptions {
  /** Port on 127.0.0.1 (default `0`: a free port). */
  port?: number;
  /** `webOrigin` of its `/.well-known/olan` (default: the issuer itself); `null` leaves it out, as an Olan before 1.5 does. */
  webOrigin?: string | null;
  /** `kid` of its key (default `olan-test-<random>`). */
  keyId?: string;
}

/** A local Olan issuer: `/.well-known/olan` and the JWKS on 127.0.0.1, signing with its own key. */
export interface TestIssuer {
  /** `http://127.0.0.1:<port>`: list it in `createOlanServer({ issuers })`. */
  readonly issuer: string;
  readonly keyId: string;
  /** The public key it serves at `<issuer>/api/v2/apps/jwks.json`. */
  readonly jwk: Record<string, string>;
  /** Its `/.well-known/olan` document (server.md#the-well-known-olan-document). */
  wellKnown(): Record<string, JsonValue>;
  /** Base64 Ed25519 signature of `content` (`<webhook-id>.<webhook-timestamp>.<raw body>`). */
  sign(content: string): string;
  /** Stops the server (always call it, e.g. in `after()`). */
  close(): Promise<void>;
}

/** Starts a `TestIssuer` (a fresh key, a free port unless `port` is given). */
export async function createTestIssuer(options: TestIssuerOptions = {}): Promise<TestIssuer> {
  const issuer: DevIssuer = await startLocalIssuer({
    key: generateIssuerKey(options.keyId),
    port: options.port ?? 0,
    serverVersion: 'olan-app-test',
    ...(options.webOrigin !== undefined ? { webOrigin: options.webOrigin } : {}),
    portHint: 'Pass another port to createTestIssuer({ port }) or 0 for a free one.',
  });
  return issuer;
}

/** What `signRemoteRequest` builds the envelope from (the body of `POST {remote.url}/requests`). */
export interface RemoteRequestSignInput {
  appId: string;
  /** Default `MOCK_INSTALLATION_ID` (`mock-installation`). */
  installationId?: string;
  /**
   * The person. Default `{ id: DEFAULT_USER_ID, organizationId: DEFAULT_ORGANIZATION_ID, locale: 'tr',
   * timeZone: 'Europe/Istanbul' }` (no `email`/`displayName`/`role`: those come only with `profile:read`).
   * `null`: no `user` (an app-identity envelope).
   */
  user?: RemoteRequestUser | null;
  /** What the app passes to `olan.remote.request`; normalised as Olan does (query values to strings, headers allowlisted). */
  request: RemoteRequestInit;
  /** Default `{ accessToken: 'olan-app-dev-token', expiresIn: 300 }`. */
  token?: { accessToken: string; expiresIn: number };
  /** `req_…`, also the `webhook-id` (default a new id: a repeated id is a replay, HTTP 409). */
  id?: string;
}

/** Options for forged requests. */
export interface RemoteRequestSignOptions {
  /** `webhook-timestamp` in Unix seconds (default now): more than 300 s away → `timestamp_out_of_range` (401). */
  timestamp?: number;
  /** Sign with a key the issuer does not publish → `invalid_signature` (401). */
  badSignature?: boolean;
  /** `olan-key-id` header (default the issuer's key) → `unknown_key` (401) for a kid the issuer does not publish. */
  keyId?: string;
  /** `olan-issuer` header (default `issuer.issuer`) → `issuer_not_allowed` (401) for one the server does not list. */
  issuer?: string;
  /** `webhook-id` header (default the envelope `id`) → HTTP 400 `invalid_body` when it differs. */
  webhookId?: string;
}

export interface SignedRemoteRequest {
  /** Lower-case: `content-type`, `webhook-id`, `webhook-timestamp`, `webhook-signature`, `olan-issuer`, `olan-key-id`, `olan-installation-id`. */
  headers: Record<string, string>;
  /** The exact JSON text that was signed: send it unchanged. */
  body: string;
  envelope: RemoteRequestEnvelope;
}

/**
 * Signs a `remote.request` envelope as Olan does: `handleRequest({ headers, body }, routes)` or
 * `fetch(`${remoteUrl}/requests`, { method: 'POST', headers, body })`. Throws for params Olan refuses.
 */
export function signRemoteRequest(issuer: Pick<TestIssuer, 'issuer' | 'keyId' | 'sign'>, input: RemoteRequestSignInput, options: RemoteRequestSignOptions = {}): SignedRemoteRequest {
  const user = input.user === undefined ? { id: DEFAULT_USER_ID, organizationId: DEFAULT_ORGANIZATION_ID, locale: 'tr', timeZone: 'Europe/Istanbul' } : input.user;
  let envelope: RemoteRequestEnvelope;
  try {
    envelope = remoteEnvelope(options.issuer ?? issuer.issuer, { ...input, installationId: input.installationId ?? MOCK_INSTALLATION_ID, user });
  } catch (error) {
    const message = (error as { issues?: { message: string }[] }).issues?.[0]?.message ?? (error instanceof Error ? error.message : String(error));
    throw new TypeError(`signRemoteRequest: ${message}`);
  }
  return { ...signRemoteEnvelope(issuer, envelope, options), envelope };
}

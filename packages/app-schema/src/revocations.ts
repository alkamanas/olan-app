import { z } from 'zod';
import { APP_ID_PATTERN } from './manifest.js';
import { KEY_ID_PATTERN } from './package.js';
import { isSemver } from './semver.js';

/*
 * Signed revocation list (Phase 2 server contract §3). The marketplace and the Olan server serve
 * the same document; the signature covers the UTF-8 bytes of `payload`, which is JSON *text*
 * (no canonical JSON needed). Only the Olan Marketplace key signs production lists; the
 * development key (`olan-app revocations sign --dev`) is accepted only by development builds.
 */

/** `expiresAt - issuedAt` of a freshly signed list (48 h). */
export const REVOCATION_VALIDITY_MS = 48 * 60 * 60 * 1000;
/** Clients accept a list only while `now - issuedAt` is at most this (24 h) and `now < expiresAt`. */
export const REVOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RevocationEntry {
  /** Manifest id of the revoked app. */
  appId: string;
  /** Revoked versions; without `versions` and `packageSha256` every version of the app is revoked. */
  versions?: string[];
  /** `digest.package` hex of one revoked package. */
  packageSha256?: string;
  /** Shown to the user (plain TR/EN text). */
  reason: string;
  revokedAt: string;
}

export interface RevocationPayload {
  version: 1;
  issuedAt: string;
  expiresAt: string;
  /** Increasing integer; a client rejects a lower sequence than the highest it has seen. */
  sequence: number;
  entries: RevocationEntry[];
}

export interface RevocationSignature {
  /** Name of the signing key (`olan-marketplace-2026-10-17`, or the development key name). */
  keyId: string;
  algorithm: 'ed25519';
  /** Base64 Ed25519 signature over the UTF-8 bytes of `payload`. */
  signature: string;
}

export interface RevocationDocument {
  /** `RevocationPayload` as JSON text; parse it with `parseRevocationPayload`. */
  payload: string;
  signature: RevocationSignature;
}

const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 time');

export const revocationEntrySchema = z.strictObject({
  appId: z.string().regex(APP_ID_PATTERN, 'must be an app id (reverse domain)'),
  versions: z.array(z.string().refine(isSemver, 'must be a semantic version')).min(1).optional(),
  packageSha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest').optional(),
  reason: z.string().max(1000),
  revokedAt: isoTime,
});

export const revocationPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    issuedAt: isoTime,
    expiresAt: isoTime,
    sequence: z.number().int().nonnegative(),
    entries: z.array(revocationEntrySchema),
  })
  .refine((payload) => Date.parse(payload.expiresAt) > Date.parse(payload.issuedAt), { message: 'expiresAt must be after issuedAt', path: ['expiresAt'] });

export const revocationDocumentSchema = z.strictObject({
  payload: z.string().min(1),
  signature: z.strictObject({
    keyId: z.string().regex(KEY_ID_PATTERN),
    algorithm: z.literal('ed25519'),
    signature: z.string().min(1),
  }),
});

/** Parses and checks the `payload` text of a revocation document (the signature is checked separately). */
export function parseRevocationPayload(text: string): { ok: true; payload: RevocationPayload } | { ok: false; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: 'payload is not JSON' };
  }
  const result = revocationPayloadSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, message: `payload${first?.path.length ? `.${first.path.join('.')}` : ''}: ${first?.message ?? 'invalid'}` };
  }
  return { ok: true, payload: result.data as RevocationPayload };
}

/** The first entry that revokes this app version or package (`packageSha256` = `digest.package`), or null. */
export function isRevoked(entries: readonly RevocationEntry[], target: { appId: string; version: string; packageSha256?: string }): RevocationEntry | null {
  for (const entry of entries) {
    if (entry.appId !== target.appId) continue;
    if (!entry.versions && !entry.packageSha256) return entry;
    if (entry.versions?.includes(target.version)) return entry;
    if (entry.packageSha256 && entry.packageSha256 === target.packageSha256) return entry;
  }
  return null;
}

import { z } from 'zod';
import { KEY_ID_PATTERN } from './package.js';
/*
 * Signed Olan Marketplace key set (Phase 4a design, "Güvenilir anahtar listesi"). Same envelope as
 * the revocation list: `payload` is JSON *text* and the Ed25519 signature covers its UTF-8 bytes.
 * Olan servers pull it from `<marketplaceUrl>/api/v1/keys` and accept it only when a marketplace key
 * they already trust signed it and `sequence` does not go back. `active` and `retired` keys verify
 * packages; a `revoked` key (the built-in one included) stops being trusted.
 */
export const MARKETPLACE_KEY_STATUSES = ['active', 'retired', 'revoked'];
/** `expiresAt - issuedAt` of a freshly signed key set (48 h, like the revocation list). */
export const MARKETPLACE_KEY_SET_VALIDITY_MS = 48 * 60 * 60 * 1000;
const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 time');
const rawKeyBase64 = z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be the base64 of a raw 32-byte Ed25519 public key');
export const marketplaceKeySchema = z.strictObject({
    keyId: z.string().regex(KEY_ID_PATTERN),
    publicKey: rawKeyBase64,
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/, 'must be 16 lowercase hex characters'),
    status: z.enum(MARKETPLACE_KEY_STATUSES),
    revokedAt: isoTime.optional(),
    reason: z.string().max(1000).optional(),
});
export const marketplaceKeySetPayloadSchema = z
    .strictObject({
    version: z.literal(1),
    issuedAt: isoTime,
    expiresAt: isoTime,
    sequence: z.number().int().nonnegative(),
    keys: z.array(marketplaceKeySchema).min(1),
})
    .refine((payload) => Date.parse(payload.expiresAt) > Date.parse(payload.issuedAt), { message: 'expiresAt must be after issuedAt', path: ['expiresAt'] })
    .refine((payload) => new Set(payload.keys.map((key) => key.keyId)).size === payload.keys.length, { message: 'key ids must be unique', path: ['keys'] })
    .refine((payload) => new Set(payload.keys.map((key) => key.publicKey)).size === payload.keys.length, { message: 'public keys must be unique', path: ['keys'] });
export const marketplaceKeySetDocumentSchema = z.strictObject({
    payload: z.string().min(1),
    signature: z.strictObject({
        keyId: z.string().regex(KEY_ID_PATTERN),
        algorithm: z.literal('ed25519'),
        signature: z.string().min(1),
    }),
});
/** Parses and checks the `payload` text of a key set document (the signature is checked separately). */
export function parseMarketplaceKeySetPayload(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return { ok: false, message: 'payload is not JSON' };
    }
    const result = marketplaceKeySetPayloadSchema.safeParse(value);
    if (!result.success) {
        const first = result.error.issues[0];
        return { ok: false, message: `payload${first?.path.length ? `.${first.path.join('.')}` : ''}: ${first?.message ?? 'invalid'}` };
    }
    return { ok: true, payload: result.data };
}

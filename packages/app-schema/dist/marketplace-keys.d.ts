import { z } from 'zod';
export declare const MARKETPLACE_KEY_STATUSES: readonly ["active", "retired", "revoked"];
export type MarketplaceKeyStatus = (typeof MARKETPLACE_KEY_STATUSES)[number];
/** `expiresAt - issuedAt` of a freshly signed key set (48 h, like the revocation list). */
export declare const MARKETPLACE_KEY_SET_VALIDITY_MS: number;
export interface MarketplaceKey {
    /** The `keyId` packages and lists name (`olan-marketplace-2026-10-17`). */
    keyId: string;
    /** Base64 of the raw 32-byte Ed25519 public key. */
    publicKey: string;
    /** First 16 hex characters of sha256(raw key). */
    fingerprint: string;
    status: MarketplaceKeyStatus;
    /** Set on `revoked` keys. */
    revokedAt?: string;
    reason?: string;
}
export interface MarketplaceKeySetPayload {
    version: 1;
    issuedAt: string;
    expiresAt: string;
    /** Increasing integer; a lower sequence than the highest seen is refused. */
    sequence: number;
    keys: MarketplaceKey[];
}
export interface MarketplaceKeySetDocument {
    /** `MarketplaceKeySetPayload` as JSON text; parse it with `parseMarketplaceKeySetPayload`. */
    payload: string;
    signature: {
        keyId: string;
        algorithm: 'ed25519';
        signature: string;
    };
}
export declare const marketplaceKeySchema: z.ZodObject<{
    keyId: z.ZodString;
    publicKey: z.ZodString;
    fingerprint: z.ZodString;
    status: z.ZodEnum<{
        active: "active";
        retired: "retired";
        revoked: "revoked";
    }>;
    revokedAt: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const marketplaceKeySetPayloadSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    sequence: z.ZodNumber;
    keys: z.ZodArray<z.ZodObject<{
        keyId: z.ZodString;
        publicKey: z.ZodString;
        fingerprint: z.ZodString;
        status: z.ZodEnum<{
            active: "active";
            retired: "retired";
            revoked: "revoked";
        }>;
        revokedAt: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const marketplaceKeySetDocumentSchema: z.ZodObject<{
    payload: z.ZodString;
    signature: z.ZodObject<{
        keyId: z.ZodString;
        algorithm: z.ZodLiteral<"ed25519">;
        signature: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Parses and checks the `payload` text of a key set document (the signature is checked separately). */
export declare function parseMarketplaceKeySetPayload(text: string): {
    ok: true;
    payload: MarketplaceKeySetPayload;
} | {
    ok: false;
    message: string;
};

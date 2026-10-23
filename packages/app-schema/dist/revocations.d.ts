import { z } from 'zod';
/** `expiresAt - issuedAt` of a freshly signed list (48 h). */
export declare const REVOCATION_VALIDITY_MS: number;
/** Clients accept a list only while `now - issuedAt` is at most this (24 h) and `now < expiresAt`. */
export declare const REVOCATION_MAX_AGE_MS: number;
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
export declare const revocationEntrySchema: z.ZodObject<{
    appId: z.ZodString;
    versions: z.ZodOptional<z.ZodArray<z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>>;
    packageSha256: z.ZodOptional<z.ZodString>;
    reason: z.ZodString;
    revokedAt: z.ZodString;
}, z.core.$strict>;
export declare const revocationPayloadSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    sequence: z.ZodNumber;
    entries: z.ZodArray<z.ZodObject<{
        appId: z.ZodString;
        versions: z.ZodOptional<z.ZodArray<z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>>;
        packageSha256: z.ZodOptional<z.ZodString>;
        reason: z.ZodString;
        revokedAt: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const revocationDocumentSchema: z.ZodObject<{
    payload: z.ZodString;
    signature: z.ZodObject<{
        keyId: z.ZodString;
        algorithm: z.ZodLiteral<"ed25519">;
        signature: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Parses and checks the `payload` text of a revocation document (the signature is checked separately). */
export declare function parseRevocationPayload(text: string): {
    ok: true;
    payload: RevocationPayload;
} | {
    ok: false;
    message: string;
};
/** The first entry that revokes this app version or package (`packageSha256` = `digest.package`), or null. */
export declare function isRevoked(entries: readonly RevocationEntry[], target: {
    appId: string;
    version: string;
    packageSha256?: string;
}): RevocationEntry | null;

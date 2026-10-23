import { z } from 'zod';
export declare const MANIFEST_FILE = "olan-app.json";
export declare const DIGEST_FILE = "digest.json";
export declare const SIGNATURE_FILE = "signature.json";
export declare const PACKAGE_EXTENSION = ".olanapp";
export declare const PACKAGE_REQUIRED_FILES: readonly ["olan-app.json", "digest.json"];
/** Files never listed in `digest.files` (they describe the digest itself). */
export declare const DIGEST_EXCLUDED_FILES: readonly ["digest.json", "signature.json"];
export interface PackageDigest {
    algorithm: 'sha256';
    /** Package path → lowercase hex SHA-256 of the file bytes. */
    files: Record<string, string>;
    /** SHA-256 (hex) of `packageDigestInput(files)` encoded as UTF-8. */
    package: string;
}
export interface PackageSignature {
    algorithm: 'ed25519';
    /** Base64 of the raw 32-byte public key. */
    publicKey: string;
    /** Base64 of the 64-byte Ed25519 signature over the UTF-8 bytes of `digest.package`. */
    signature: string;
    signedAt: string;
    /**
     * Optional name of the signing key on the server's trusted list (e.g. `olan-marketplace-2026-10-17`
     * for the built-in Olan Marketplace key). Informational: servers trust `publicKey`, never `keyId`.
     */
    keyId?: string;
}
/** `signature.json` `keyId`: 1-64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
export declare const KEY_ID_PATTERN: RegExp;
export declare const digestSchema: z.ZodType<PackageDigest>;
export declare const signatureSchema: z.ZodType<PackageSignature>;
/**
 * Deterministic input for the package digest: entries sorted by path (UTF-16
 * code unit order, i.e. plain `Array.prototype.sort`), each written as
 * `${path}\n${hexDigest}\n`. SHA-256 of this string (UTF-8) is `digest.package`.
 */
export declare function packageDigestInput(files: Record<string, string>): string;

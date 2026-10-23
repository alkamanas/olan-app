import { z } from 'zod';
import { isPackagePath } from './paths.js';
/*
 * `.olanapp` package metadata (contract §5). The archive is a ZIP holding
 * `olan-app.json`, `dist/app.js`, optional `assets/**`, `digest.json` and an
 * optional `signature.json`.
 */
export const MANIFEST_FILE = 'olan-app.json';
export const DIGEST_FILE = 'digest.json';
export const SIGNATURE_FILE = 'signature.json';
export const PACKAGE_EXTENSION = '.olanapp';
export const PACKAGE_REQUIRED_FILES = [MANIFEST_FILE, DIGEST_FILE];
/** Files never listed in `digest.files` (they describe the digest itself). */
export const DIGEST_EXCLUDED_FILES = [DIGEST_FILE, SIGNATURE_FILE];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha256Hex = z.string().regex(SHA256_HEX, 'must be a lowercase hex SHA-256 digest');
/** Decoded length of a padded base64 string. */
function base64Length(value) {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return (value.length / 4) * 3 - padding;
}
const base64Of = (bytes) => z
    .string()
    .regex(BASE64, 'must be standard padded base64')
    .refine((value) => base64Length(value) === bytes, `must decode to ${bytes} bytes`);
/** `signature.json` `keyId`: 1-64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const digestSchema = z
    .strictObject({
    algorithm: z.literal('sha256'),
    files: z.record(z.string().refine(isPackagePath, 'must be a relative package path'), sha256Hex),
    package: sha256Hex,
})
    .superRefine((digest, ctx) => {
    if (!(MANIFEST_FILE in digest.files)) {
        ctx.addIssue({ code: 'custom', path: ['files'], message: `digest must list ${MANIFEST_FILE}` });
    }
    for (const excluded of DIGEST_EXCLUDED_FILES) {
        if (excluded in digest.files) {
            ctx.addIssue({ code: 'custom', path: ['files', excluded], message: `${excluded} must not be listed in the digest` });
        }
    }
});
export const signatureSchema = z.strictObject({
    algorithm: z.literal('ed25519'),
    publicKey: base64Of(32),
    signature: base64Of(64),
    signedAt: z.iso.datetime({ offset: true }),
    keyId: z.string().regex(KEY_ID_PATTERN, 'must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit').optional(),
});
/**
 * Deterministic input for the package digest: entries sorted by path (UTF-16
 * code unit order, i.e. plain `Array.prototype.sort`), each written as
 * `${path}\n${hexDigest}\n`. SHA-256 of this string (UTF-8) is `digest.package`.
 */
export function packageDigestInput(files) {
    return Object.keys(files)
        .sort()
        .map((path) => `${path}\n${files[path]}\n`)
        .join('');
}

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { DIGEST_EXCLUDED_FILES, DIGEST_FILE, KEY_ID_PATTERN, MAX_PACKAGE_BYTES, SIGNATURE_FILE, digestSchema, packageDigestInput, signatureSchema, type PackageDigest } from '@olan-app/schema';

import { stringFlag } from '../args';
import type { Command } from '../command';
import { keyFingerprint } from '../dev-key';
import { fail } from '../errors';
import { displayPath } from '../paths';
import { formatBytes } from './build';
import { sha256Hex, signDigest, verifyPackageSignature, ZIP_MTIME } from './pack';

/*
 * `olan-app sign` (internal, decision 2026-10-17): signs an existing `.olanapp` with a PKCS#8
 * Ed25519 PEM key. Olan uses it to sign its own apps with the Olan Marketplace key until the
 * marketplace signs packages itself. The private key is only held in memory: it is never printed,
 * logged, copied or written anywhere, and error messages never quote the key file's contents.
 */

/** `keyId` of the Olan Marketplace key built into Olan servers. */
export const MARKETPLACE_KEY_ID = 'olan-marketplace-2026-10-17';

export interface SignResult {
  /** Path of the signed package (relative to the working directory when inside it). */
  file: string;
  bytes: number;
  /** `digest.package`. */
  sha256: string;
  publicKey: string;
  keyFingerprint: string;
  keyId: string | null;
  signedAt: string;
  /** Whether an existing `signature.json` was replaced. */
  replaced: boolean;
}

/** Reads a PKCS#8 Ed25519 private key PEM; refuses anything else without echoing the file. */
export function readPemSigningKey(path: string): { privateKey: KeyObject; publicKey: string } {
  if (!existsSync(path)) fail('sign.key_missing', `The key file ${path} does not exist`);
  const pem = readFileSync(path, 'utf8');
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem)) {
    fail('sign.key_encrypted', `${path} is an encrypted PKCS#8 key`, { hint: 'Pass an unencrypted PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"), e.g. from `openssl genpkey -algorithm ed25519`.' });
  }
  if (!/-----BEGIN PRIVATE KEY-----/.test(pem)) {
    fail('sign.key_invalid', `${path} is not a PKCS#8 private key PEM`, { hint: 'Expected "-----BEGIN PRIVATE KEY-----" (`openssl genpkey -algorithm ed25519`).' });
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    fail('sign.key_invalid', `${path} could not be read as a PKCS#8 private key`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('sign.key_not_ed25519', `${path} is a ${privateKey.asymmetricKeyType ?? 'unknown'} key; Olan packages are signed with Ed25519 only`);
  }
  const raw = (createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { privateKey, publicKey: raw.toString('base64') };
}

/** Checks that `digest.json` describes exactly the package's files and returns it. */
function verifiedDigest(entries: Record<string, Uint8Array>, shown: string): PackageDigest {
  const digestBytes = entries[DIGEST_FILE];
  if (!digestBytes) fail('sign.digest_missing', `${shown} has no ${DIGEST_FILE}`, { hint: 'Create packages with `olan-app pack`.' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(digestBytes));
  } catch {
    fail('sign.digest_invalid', `${shown}: ${DIGEST_FILE} is not valid JSON`);
  }
  const result = digestSchema.safeParse(parsed);
  if (!result.success) fail('sign.digest_invalid', `${shown}: ${DIGEST_FILE} is invalid (${result.error.issues[0]?.message ?? 'schema'})`);
  const digest = result.data;
  const excluded = new Set<string>(DIGEST_EXCLUDED_FILES);
  const files = Object.keys(entries).filter((path) => !excluded.has(path) && !path.endsWith('/'));
  for (const path of files) {
    if (!(path in digest.files)) fail('sign.digest_mismatch', `${shown}: ${path} is not listed in ${DIGEST_FILE}`);
    if (sha256Hex(entries[path]!) !== digest.files[path]) fail('sign.digest_mismatch', `${shown}: ${path} does not match its digest`);
  }
  for (const path of Object.keys(digest.files)) {
    if (!(path in entries)) fail('sign.digest_mismatch', `${shown}: ${DIGEST_FILE} lists ${path}, which is not in the package`);
  }
  if (sha256Hex(packageDigestInput(digest.files)) !== digest.package) fail('sign.digest_mismatch', `${shown}: digest.package does not match the file digests`);
  return digest;
}

/** Verifies the package digest and writes (or replaces) its `signature.json`, in place. */
export function signPackageFile(packagePath: string, keyPath: string, options: { keyId?: string; cwd: string }): SignResult {
  const shown = displayPath(options.cwd, packagePath);
  if (options.keyId !== undefined && !KEY_ID_PATTERN.test(options.keyId)) {
    fail('sign.key_id_invalid', `"${options.keyId}" is not a valid key id`, { hint: `1-64 letters, digits, ".", "_" or "-" (the Olan Marketplace key is ${MARKETPLACE_KEY_ID}).` });
  }
  if (!existsSync(packagePath)) fail('sign.package_missing', `${shown} does not exist`, { hint: 'Create it with `olan-app pack --no-sign`.' });
  if (statSync(packagePath).size > MAX_PACKAGE_BYTES) fail('sign.package_too_large', `${shown} is larger than ${formatBytes(MAX_PACKAGE_BYTES)}`);
  const { privateKey, publicKey } = readPemSigningKey(keyPath);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(readFileSync(packagePath));
  } catch {
    fail('sign.package_invalid', `${shown} is not a ZIP archive (.olanapp)`);
  }
  const digest = verifiedDigest(entries, shown);
  const replaced = SIGNATURE_FILE in entries;

  const signature = signDigest(digest.package, privateKey, publicKey, options.keyId);
  signatureSchema.parse(signature);
  if (!verifyPackageSignature(digest.package, signature)) fail('sign.signature_failed', 'The new signature does not verify');

  // Same entry order as `olan-app pack`: package files, digest.json, then signature.json.
  const zip: Zippable = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path !== SIGNATURE_FILE) zip[path] = [data, { mtime: ZIP_MTIME }];
  }
  zip[SIGNATURE_FILE] = [strToU8(`${JSON.stringify(signature, null, 2)}\n`), { mtime: ZIP_MTIME }];
  const archive = zipSync(zip, { level: 9 });
  const temp = `${packagePath}.signing-${process.pid}`;
  try {
    writeFileSync(temp, archive);
    renameSync(temp, packagePath);
  } finally {
    rmSync(temp, { force: true });
  }
  return {
    file: shown,
    bytes: archive.byteLength,
    sha256: digest.package,
    publicKey,
    keyFingerprint: keyFingerprint(publicKey),
    keyId: signature.keyId ?? null,
    signedAt: signature.signedAt,
    replaced,
  };
}

export const signCommand: Command = {
  name: 'sign',
  summary: 'Internal: sign an existing .olanapp with an Ed25519 PEM key (Olan\'s own apps)',
  usage: 'olan-app sign --key <private-key.pem> [--key-id <id>] <package.olanapp>',
  options: [
    'Internal command for signing Olan\'s own apps until the Olan Marketplace signs packages.',
    'App developers use `olan-app pack --dev-sign` instead.',
    '--key <file>     Unencrypted PKCS#8 Ed25519 private key PEM; read in memory only, never printed or stored',
    `--key-id <id>    Name of the key on the server's trusted list, written to signature.json (marketplace key: ${MARKETPLACE_KEY_ID})`,
    'The package digest is verified first; an existing signature.json is replaced.',
  ],
  spec: { strings: ['key', 'key-id'] },
  async run(args, context) {
    const keyPath = stringFlag(args, 'key');
    if (!keyPath) fail('sign.key_required', 'Pass the signing key: `olan-app sign --key <private-key.pem> <package.olanapp>`');
    if (args.positionals.length !== 1) fail('sign.package_required', 'Pass exactly one package: `olan-app sign --key <private-key.pem> <package.olanapp>`');
    const result = signPackageFile(resolve(context.cwd, args.positionals[0]!), resolve(context.cwd, keyPath), { keyId: stringFlag(args, 'key-id'), cwd: context.cwd });
    return {
      result,
      human: [
        `${result.replaced ? 'Re-signed' : 'Signed'} ${result.file} (${formatBytes(result.bytes)})`,
        `  sha256 ${result.sha256}`,
        `  key ${result.keyFingerprint}${result.keyId ? ` (${result.keyId})` : ''}, public key ${result.publicKey}`,
        '  It installs only on servers that trust this public key.',
      ],
    };
  },
};

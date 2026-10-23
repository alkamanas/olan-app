import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { strToU8, zipSync, type Zippable } from 'fflate';
import { DIGEST_FILE, MANIFEST_FILE, MAX_PACKAGE_BYTES, PACKAGE_EXTENSION, SIGNATURE_FILE, digestSchema, isPackagePath, isSemver, packageDigestInput, signatureSchema, type OlanAppManifest, type PackageDigest, type PackageSignature } from '@olan-app/schema';

import { booleanFlag, stringFlag } from '../args';
import type { Command } from '../command';
import { devKeyAdvice, ensureDevKey, keyFingerprint } from '../dev-key';
import { CliError, fail, issue } from '../errors';
import { displayPath, toPosix } from '../paths';
import { entryPath, KEY_FILE, requireManifest, requireProjectDir } from '../project';
import { BACKEND_BUNDLE } from '../backend/build';
import { buildApp, formatBytes } from './build';
import { validateApp } from './validate';

/** `olan-app.key.json` (contract §5). */
export interface SigningKeyFile {
  algorithm: 'ed25519';
  /** Base64 of the raw 32-byte public key. */
  publicKey: string;
  /** Base64 of the PKCS#8 DER private key. */
  privateKey: string;
}

/** DER SubjectPublicKeyInfo prefix of a raw Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Fixed ZIP timestamps keep packages byte-for-byte reproducible. */
export const ZIP_MTIME = new Date(Date.UTC(2000, 0, 1));

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function readSigningKey(path: string): { key: SigningKeyFile; privateKey: ReturnType<typeof createPrivateKey> } {
  if (!existsSync(path)) fail('pack.key_missing', `The signing key ${path} does not exist`, { hint: 'Create one with `olan-app keygen`.' });
  let key: SigningKeyFile;
  try {
    key = JSON.parse(readFileSync(path, 'utf8')) as SigningKeyFile;
  } catch {
    fail('pack.key_invalid', `${path} is not valid JSON`);
  }
  if (key.algorithm !== 'ed25519' || typeof key.privateKey !== 'string' || typeof key.publicKey !== 'string') {
    fail('pack.key_invalid', `${path} is not an Olan app signing key ({ algorithm: "ed25519", publicKey, privateKey })`);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    fail('pack.key_invalid', `${path}: privateKey is not a base64 PKCS#8 Ed25519 key`);
  }
  const raw = (createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  if (raw.toString('base64') !== key.publicKey) fail('pack.key_invalid', `${path}: publicKey does not belong to privateKey`);
  return { key, privateKey };
}

/** Ed25519 signature over the UTF-8 bytes of the package digest hex (contract §5). */
export function signPackage(packageHex: string, keyPath: string): PackageSignature {
  const { key, privateKey } = readSigningKey(keyPath);
  return signDigest(packageHex, privateKey, key.publicKey);
}

/** Signs `digest.package` with an in-memory Ed25519 key; `keyId` names the key on the server's trusted list. */
export function signDigest(packageHex: string, privateKey: KeyObject, publicKey: string, keyId?: string): PackageSignature {
  const signature = sign(null, Buffer.from(packageHex, 'utf8'), privateKey);
  return {
    algorithm: 'ed25519',
    publicKey,
    signature: signature.toString('base64'),
    signedAt: new Date().toISOString(),
    ...(keyId ? { keyId } : {}),
  };
}

export function verifyPackageSignature(packageHex: string, signature: PackageSignature): boolean {
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signature.publicKey, 'base64')]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(packageHex, 'utf8'), publicKey, Buffer.from(signature.signature, 'base64'));
}

function collect(dir: string, base: string, into: Map<string, Uint8Array>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, base, into);
    else if (entry.isFile() && !entry.name.startsWith('.')) into.set(toPosix(relative(base, path)), readFileSync(path));
  }
}

export interface PackResult {
  /** Project-relative path of the `.olanapp`. */
  file: string;
  bytes: number;
  /** `digest.package`. */
  sha256: string;
  signed: boolean;
  publicKey: string | null;
  /** Fingerprint of the signing key (what the server and `/.well-known/olan` show), or null. */
  keyFingerprint: string | null;
  files: { path: string; bytes: number; sha256: string }[];
}

export interface PackOptions {
  out?: string;
  /** Signing key file; default `olan-app.key.json` when it exists. `false` disables signing. */
  signKey?: string | false;
  /** Build before packing (default `true`). */
  build?: boolean;
  /**
   * Run the normal (non-strict) `olan-app validate` checks first and refuse on errors (default
   * `true`). `--strict` is not run here: run `olan-app validate --strict` before packing.
   */
  validate?: boolean;
  /**
   * Package `olan-app.json` with this version instead of the one on disk (the file itself is left
   * alone): the `-dev.N` prerelease an Olan server names for a changed build (`olan-app try`).
   */
  version?: string;
}

/**
 * `olan-app.json` with another `version`, for a package only (the project file is not written). The
 * version is part of the signed digest, so it is set before signing; the server cannot rename it.
 */
export function manifestFileWithVersion(raw: Uint8Array, version: string): Uint8Array {
  if (!isSemver(version)) fail('pack.version_invalid', `"${version}" is not a semver version`);
  const json = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  return strToU8(`${JSON.stringify({ ...json, version }, null, 2)}\n`);
}

/**
 * `olan-app pack`: `olan-app.json`, the bundle, `dist/server.js` (with `server`), `assets/**` (and the icon) plus `digest.json` and,
 * with a key, `signature.json`, zipped into `dist/<id>-<version>.olanapp`.
 */
export async function packApp(projectDir: string, options: PackOptions = {}): Promise<PackResult> {
  const onDisk = requireManifest(projectDir);
  const manifest = options.version ? { ...onDisk, version: options.version } : onDisk;
  if (manifest.kind === 'web-link') fail('pack.web_link', 'Web links are not packaged; add them in Olan → Uygulamalar → Web bağlantısı ekle');
  if (options.validate !== false) {
    // validateApp builds first (unless build is false), so the bundle is fresh afterwards.
    const { errors } = await validateApp(projectDir, { build: options.build !== false });
    if (errors.length > 0) {
      throw new CliError([
        issue('pack.validation_failed', `The app does not pass \`olan-app validate\` (${errors.length} ${errors.length === 1 ? 'error' : 'errors'}); nothing was packed`, {
          hint: 'Fix the errors that follow (and run `olan-app validate --strict` before packing), or pass --no-validate to package anyway.',
        }),
        ...errors,
      ]);
    }
  } else if (options.build !== false) await buildApp(projectDir);
  const { files, digest } = collectPackageFiles(projectDir, manifest, options.version ? { version: options.version } : {});
  const digestFiles = digest.files;

  const keyPath = options.signKey === false ? null : options.signKey ? resolve(projectDir, options.signKey) : existsSync(join(projectDir, KEY_FILE)) ? join(projectDir, KEY_FILE) : null;
  let signature: PackageSignature | null = null;
  if (keyPath) {
    signature = signPackage(digest.package, keyPath);
    signatureSchema.parse(signature);
    if (!verifyPackageSignature(digest.package, signature)) fail('pack.signature_failed', 'The new signature does not verify');
  }

  const archive = zipPackage(files, digest, signature);
  if (archive.byteLength > MAX_PACKAGE_BYTES) {
    throw new CliError(issue('pack.too_large', `The package is ${formatBytes(archive.byteLength)}; the limit is ${formatBytes(MAX_PACKAGE_BYTES)}`));
  }
  const out = resolve(projectDir, options.out ?? join('dist', `${manifest.id}-${manifest.version}${PACKAGE_EXTENSION}`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, archive);
  return {
    file: displayPath(projectDir, out),
    bytes: statSync(out).size,
    sha256: digest.package,
    signed: signature !== null,
    publicKey: signature?.publicKey ?? null,
    keyFingerprint: signature ? keyFingerprint(signature.publicKey) : null,
    files: [...files.entries()].map(([path, data]) => ({ path, bytes: data.byteLength, sha256: digestFiles[path]! })),
  };
}

/**
 * The files a package of the project holds (`olan-app.json`, the bundle, `dist/server.js` with
 * `server`, `assets/**` and the icon) and their digest. Shared by `pack` and `validate --strict`
 * (which runs the marketplace's static review checks on exactly these files). `built` replaces the
 * files on disk with in-memory bundles (`olan-app dev`'s current build); `built.version` packages
 * `olan-app.json` under another version (`manifestFileWithVersion`).
 */
export function collectPackageFiles(
  projectDir: string,
  manifest: OlanAppManifest,
  built: { entry?: Uint8Array; server?: Uint8Array; version?: string } = {},
): { files: Map<string, Uint8Array>; digest: PackageDigest } {
  const entry = entryPath(manifest);
  const files = new Map<string, Uint8Array>();
  const manifestFile = readFileSync(join(projectDir, MANIFEST_FILE));
  files.set(MANIFEST_FILE, built.version ? manifestFileWithVersion(manifestFile, built.version) : manifestFile);
  const entryFile = join(projectDir, entry);
  if (!built.entry && !existsSync(entryFile)) fail('pack.entry_missing', `${entry} does not exist`, { hint: 'Run `olan-app build`.' });
  files.set(entry, built.entry ?? readFileSync(entryFile));
  // Backend code (Phase 3 §15.2): dist/server.js is covered by digest.json and signature.json.
  if (manifest.server) {
    const serverFile = join(projectDir, BACKEND_BUNDLE);
    if (!built.server && !existsSync(serverFile)) fail('pack.backend_missing', `${BACKEND_BUNDLE} does not exist`, { hint: 'Run `olan-app build` (it bundles server.entry).' });
    files.set(BACKEND_BUNDLE, built.server ?? readFileSync(serverFile));
  }
  collect(join(projectDir, 'assets'), projectDir, files);
  if (manifest.icon) {
    const icon = join(projectDir, manifest.icon);
    if (!existsSync(icon)) fail('pack.icon_missing', `The icon ${manifest.icon} does not exist`, { file: MANIFEST_FILE });
    files.set(manifest.icon, readFileSync(icon));
  }
  for (const path of files.keys()) {
    if (!isPackagePath(path)) fail('pack.unsafe_path', `${path} cannot be stored in a package (relative paths without .., \\ or special characters only)`);
  }

  const digestFiles: Record<string, string> = {};
  for (const [path, data] of files) digestFiles[path] = sha256Hex(data);
  const digest: PackageDigest = { algorithm: 'sha256', files: digestFiles, package: sha256Hex(packageDigestInput(digestFiles)) };
  digestSchema.parse(digest);
  return { files, digest };
}

export interface DevPackage {
  bytes: Uint8Array;
  /** `<id>-<version>.olanapp`. */
  fileName: string;
  /** `digest.package`. */
  sha256: string;
  /** Fingerprint of the development key that signed it. */
  keyFingerprint: string;
}

/**
 * An in-memory package of the given bundles, signed with the development key (created on first
 * use): what `olan-app dev` serves at `GET /package` for Studio's "Bu kurumda dene". `version`
 * (`GET /package?version=`) packages the manifest under the `-dev.N` the Olan server named.
 */
export function packDevBuild(projectDir: string, onDisk: OlanAppManifest, built: { entry: Uint8Array; server?: Uint8Array; version?: string }, env: NodeJS.ProcessEnv): DevPackage {
  const manifest = built.version ? { ...onDisk, version: built.version } : onDisk;
  const { files, digest } = collectPackageFiles(projectDir, manifest, built);
  const devKey = ensureDevKey(env);
  const signature = signPackage(digest.package, devKey.path);
  const bytes = zipPackage(files, digest, signature);
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new CliError(issue('pack.too_large', `The package is ${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(MAX_PACKAGE_BYTES)}`));
  }
  return { bytes, fileName: `${manifest.id}-${manifest.version}${PACKAGE_EXTENSION}`, sha256: digest.package, keyFingerprint: devKey.fingerprint };
}

/** The `.olanapp` bytes: the files, `digest.json` and, when given, `signature.json` (fixed timestamps, reproducible). */
export function zipPackage(files: ReadonlyMap<string, Uint8Array>, digest: PackageDigest, signature: PackageSignature | null): Uint8Array {
  const zip: Zippable = {};
  for (const [path, data] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) zip[path] = [data, { mtime: ZIP_MTIME }];
  zip[DIGEST_FILE] = [packageMetaFile(digest), { mtime: ZIP_MTIME }];
  if (signature) zip[SIGNATURE_FILE] = [packageMetaFile(signature), { mtime: ZIP_MTIME }];
  return zipSync(zip, { level: 9 });
}

/** `digest.json` / `signature.json` text as packages store it. */
export function packageMetaFile(value: PackageDigest | PackageSignature): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

/** `3 app files (+ digest, signature)`: the files `files` lists plus the package's own metadata entries. */
export function packContents(result: Pick<PackResult, 'files' | 'signed'>): string {
  const count = result.files.length;
  return `${count} app file${count === 1 ? '' : 's'} (+ digest${result.signed ? ', signature' : ''})`;
}

/** Lines explaining what a signed or unsigned package can do on a server (decision 2026-10-17). */
export function signingAdvice(result: Pick<PackResult, 'signed' | 'keyFingerprint'>): string[] {
  if (!result.signed) {
    return [
      '  Unsigned: an Olan server lists it after upload but will not install it (package_unsigned).',
      '  For a local Olan run `olan-app pack --dev-sign`; production installs need Olan Marketplace signing.',
    ];
  }
  return [`  Signed with key ${result.keyFingerprint}; it installs only on servers whose OLAN_APPS_TRUSTED_KEYS lists that key.`];
}

export const packCommand: Command = {
  name: 'pack',
  summary: 'Validate, build and package the app as dist/<id>-<version>.olanapp (signed when a key exists)',
  usage: 'olan-app pack [--out <file>] [--dev-sign | --sign-key <olan-app.key.json> | --no-sign] [--no-build] [--no-validate]',
  options: [
    '--out <file>       Output path (default dist/<id>-<version>.olanapp)',
    '--dev-sign         Sign with your local development key (created on first use; see `olan-app keygen --dev`)',
    '--sign-key <file>  Ed25519 key from `olan-app keygen` (default: olan-app.key.json if present)',
    '--no-sign          Do not sign even if olan-app.key.json exists',
    '--no-build         Package the existing bundle',
    '--no-validate      Skip the `olan-app validate` checks (manifest, files, size, types) pack runs first',
  ],
  spec: { strings: ['out', 'sign-key'], booleans: ['sign', 'build', 'dev-sign', 'validate'], aliases: { o: 'out' } },
  async run(args, context) {
    const projectDir = requireProjectDir(context.cwd);
    const devSign = booleanFlag(args, 'dev-sign');
    if (devSign && (args.flags.sign === false || stringFlag(args, 'sign-key'))) {
      fail('pack.sign_conflict', '--dev-sign cannot be combined with --sign-key or --no-sign');
    }
    const devKey = devSign ? ensureDevKey(context.env) : null;
    const result = await packApp(projectDir, {
      out: stringFlag(args, 'out'),
      signKey: devKey ? devKey.path : args.flags.sign === false ? false : stringFlag(args, 'sign-key'),
      build: args.flags.build !== false,
      validate: args.flags.validate !== false,
    });
    return {
      result: devKey
        ? { ...result, devKey: { file: devKey.path, created: devKey.created, fingerprint: devKey.fingerprint, envLine: devKey.envLine } }
        : result,
      human: [
        `Packed ${result.file} (${formatBytes(result.bytes)}, ${packContents(result)}, ${result.signed ? (devKey ? 'signed with your development key' : 'signed') : 'unsigned'})`,
        `  sha256 ${result.sha256}`,
        ...(devKey ? [...(devKey.created ? [`  Created ${devKey.path}`] : []), ...devKeyAdvice(devKey)] : signingAdvice(result)),
      ],
    };
  },
};

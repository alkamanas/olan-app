import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_JSON_SCHEMA_FILE,
  MAX_PACKAGE_BYTES,
  PACKAGE_REQUIRED_FILES,
  digestSchema,
  isPackagePath,
  manifestJsonSchema,
  manifestJsonSchemaText,
  packageDigestInput,
  signatureSchema,
} from './index.js';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('packageDigestInput', () => {
  const files = {
    'olan-app.json': sha256('{}'),
    'dist/app.js': sha256('export {}'),
    'assets/icon.png': sha256('png'),
    'assets/Icon.png': sha256('PNG'),
  };

  it('is sorted by path and independent of insertion order', () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(packageDigestInput(reversed)).toBe(packageDigestInput(files));
    expect(packageDigestInput(files)).toBe(
      `assets/Icon.png\n${files['assets/Icon.png']}\n` +
        `assets/icon.png\n${files['assets/icon.png']}\n` +
        `dist/app.js\n${files['dist/app.js']}\n` +
        `olan-app.json\n${files['olan-app.json']}\n`,
    );
    expect(packageDigestInput({})).toBe('');
  });

  it('round-trips through digest and an ed25519 signature', () => {
    const packageHex = sha256(Buffer.from(packageDigestInput(files), 'utf8'));
    const digest = { algorithm: 'sha256', files, package: packageHex };
    expect(digestSchema.safeParse(digest).success).toBe(true);

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = sign(null, Buffer.from(packageHex, 'utf8'), privateKey);
    const signatureJson = {
      algorithm: 'ed25519',
      publicKey: rawPublic.toString('base64'),
      signature: signature.toString('base64'),
      signedAt: new Date().toISOString(),
    };
    expect(signatureSchema.safeParse(signatureJson).error?.issues ?? []).toEqual([]);
    expect(verify(null, Buffer.from(packageHex, 'utf8'), publicKey, Buffer.from(signatureJson.signature, 'base64'))).toBe(true);
  });
});

describe('digestSchema', () => {
  const hex = sha256('x');
  it('rejects bad digests', () => {
    const bad = [
      { algorithm: 'sha1', files: { 'olan-app.json': hex }, package: hex },
      { algorithm: 'sha256', files: { 'olan-app.json': hex.toUpperCase() }, package: hex },
      { algorithm: 'sha256', files: { 'dist/app.js': hex }, package: hex }, // manifest missing
      { algorithm: 'sha256', files: { 'olan-app.json': hex, 'digest.json': hex }, package: hex },
      { algorithm: 'sha256', files: { 'olan-app.json': hex, '../evil': hex }, package: hex },
      { algorithm: 'sha256', files: { 'olan-app.json': hex }, package: 'abc' },
    ];
    for (const digest of bad) expect(digestSchema.safeParse(digest).success, JSON.stringify(digest)).toBe(false);
  });
});

describe('signatureSchema', () => {
  it('rejects wrong key and signature sizes', () => {
    const base = { algorithm: 'ed25519', publicKey: Buffer.alloc(32).toString('base64'), signature: Buffer.alloc(64).toString('base64'), signedAt: '2026-10-16T10:00:00Z' };
    expect(signatureSchema.safeParse(base).success).toBe(true);
    expect(signatureSchema.safeParse({ ...base, publicKey: Buffer.alloc(31).toString('base64') }).success).toBe(false);
    expect(signatureSchema.safeParse({ ...base, signature: 'not base64!' }).success).toBe(false);
    expect(signatureSchema.safeParse({ ...base, algorithm: 'rsa' }).success).toBe(false);
    expect(signatureSchema.safeParse({ ...base, signedAt: 'yesterday' }).success).toBe(false);
  });

  it('accepts an optional keyId and rejects malformed ones', () => {
    const base = { algorithm: 'ed25519', publicKey: Buffer.alloc(32).toString('base64'), signature: Buffer.alloc(64).toString('base64'), signedAt: '2026-10-16T10:00:00Z' };
    expect(signatureSchema.safeParse({ ...base, keyId: 'olan-marketplace-2026-10-17' }).success).toBe(true);
    for (const keyId of ['', '-leading', 'has space', 'a=b', 'x'.repeat(65), 42]) {
      expect(signatureSchema.safeParse({ ...base, keyId }).success, String(keyId)).toBe(false);
    }
  });
});

describe('package constants and paths', () => {
  it('matches the contract', () => {
    expect(MAX_PACKAGE_BYTES).toBe(5_242_880);
    expect(PACKAGE_REQUIRED_FILES).toEqual(['olan-app.json', 'digest.json']);
  });

  it('isPackagePath', () => {
    for (const p of ['olan-app.json', 'dist/app.js', 'assets/img/icon.png', '.well-known/x']) expect(isPackagePath(p), p).toBe(true);
    for (const p of ['', '/abs', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'C:/x', 'a\u0000b']) expect(isPackagePath(p), p).toBe(false);
  });
});

describe('JSON Schema', () => {
  it('committed schemas/olan-app.v1.json equals the generated schema', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const committed = readFileSync(resolve(root, MANIFEST_JSON_SCHEMA_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(manifestJsonSchemaText());
  });

  it('has id, title and the required fields', () => {
    const schema = manifestJsonSchema();
    expect(schema.$id).toBe('https://olan.app/schemas/olan-app/v1.json');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.title).toBeTruthy();
    expect(schema.required).toEqual(['schemaVersion', 'id', 'name', 'version', 'sdk']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('describes data and server (neither reserved)', () => {
    const properties = manifestJsonSchema().properties as Record<string, Record<string, unknown>>;
    expect(properties.data?.not).toBeUndefined();
    expect(properties.data?.type).toBe('object');
    expect(properties.server?.not).toBeUndefined();
    expect(properties.server).toMatchObject({ type: 'object', required: ['entry'] });
  });
});

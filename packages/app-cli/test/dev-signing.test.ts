// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRevocationPayload, revocationDocumentSchema, signatureSchema } from '@olan-app/schema';

import { runCli } from '../src/cli';
import { packContents, verifyPackageSignature } from '../src/commands/pack';
import { verifyRevocationDocument } from '../src/commands/revocations';
import { manifest, tempProject, type TempProject } from './helpers';

/*
 * Trusted-signing-key model (decision 2026-10-17): servers install only packages signed with a key
 * on their OLAN_APPS_TRUSTED_KEYS list. Locally that is a personal development key.
 */

const APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="Geliştirme"><Text text="Merhaba" /></Screen>; }
export default defineApp({ app: Home });
`;
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  let stdout = '';
  const code = await runCli([...argv, '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd, env });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
  return { code, out: JSON.parse(stdout) as { ok: boolean; result?: any; warnings?: { code: string }[]; errors?: { code: string }[] } };
}

describe('development key', () => {
  it('keygen --dev creates the key once, reuses it, and prints the trusted-keys env line', async () => {
    const project = tempProject('dev-keygen', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    const env = { OLAN_APP_DEV_KEY: join(project.dir, 'home', 'dev.key.json') };
    try {
      const first = await run(['keygen', '--dev'], project.dir, env);
      expect(first.code).toBe(0);
      const { publicKey, fingerprint, envLine, created, file } = first.out.result;
      expect(created).toBe(true);
      expect(file).toBe(env.OLAN_APP_DEV_KEY);
      expect(envLine).toBe(`OLAN_APPS_TRUSTED_KEYS=dev-local=${publicKey}`);
      // The same fingerprint the server shows and publishes in /.well-known/olan.
      expect(fingerprint).toBe(sha256(Buffer.from(publicKey, 'base64')).slice(0, 16));
      // Not inside the app: nothing to git-ignore, nothing to ship with the source.
      expect(existsSync(join(project.dir, 'olan-app.key.json'))).toBe(false);

      const again = await run(['keygen', '--dev'], project.dir, env);
      expect(again.out.result).toMatchObject({ created: false, publicKey });
      const replaced = await run(['keygen', '--dev', '--force'], project.dir, env);
      expect(replaced.out.result.publicKey).not.toBe(publicKey);
      expect((await run(['keygen', '--dev', '--out', 'x.json'], project.dir, env)).out.errors?.[0]?.code).toBe('keygen.dev_out');
    } finally {
      project.remove();
    }
  });

  it('pack --dev-sign signs with the development key, creating it on first use', async () => {
    const project = tempProject('dev-sign', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    const env = { OLAN_APP_DEV_KEY: join(project.dir, 'home', 'dev.key.json') };
    try {
      const packed = await run(['pack', '--dev-sign'], project.dir, env);
      expect(packed.code).toBe(0);
      expect(packed.out.result).toMatchObject({ signed: true, devKey: { created: true, file: env.OLAN_APP_DEV_KEY } });
      const key = JSON.parse(readFileSync(env.OLAN_APP_DEV_KEY, 'utf8')) as { publicKey: string };
      expect(packed.out.result.publicKey).toBe(key.publicKey);
      expect(packed.out.result.keyFingerprint).toBe(packed.out.result.devKey.fingerprint);
      expect(packed.out.result.devKey.envLine).toBe(`OLAN_APPS_TRUSTED_KEYS=dev-local=${key.publicKey}`);
      const zip = unzipSync(readFileSync(join(project.dir, packed.out.result.file)));
      const signature = signatureSchema.parse(JSON.parse(strFromU8(zip['signature.json']!)));
      expect(signature.publicKey).toBe(key.publicKey);
      expect(verifyPackageSignature(packed.out.result.sha256, signature)).toBe(true);

      const reused = await run(['pack', '--dev-sign', '--no-build'], project.dir, env);
      expect(reused.out.result.devKey).toMatchObject({ created: false });
      expect((await run(['pack', '--dev-sign', '--no-sign'], project.dir, env)).out.errors?.[0]?.code).toBe('pack.sign_conflict');
      expect((await run(['pack', '--dev-sign', '--sign-key', 'k.json'], project.dir, env)).out.errors?.[0]?.code).toBe('pack.sign_conflict');

      const unsigned = await run(['pack', '--no-build'], project.dir, env);
      expect(unsigned.out.result).toMatchObject({ signed: false, keyFingerprint: null });
    } finally {
      project.remove();
    }
  });

  it('revocations sign --dev writes the §3 document signed with the development key', async () => {
    const project = tempProject('dev-revocations', {
      'list.json': JSON.stringify([{ appId: 'com.example.test-app', versions: ['0.1.0'], reason: 'Test' }, { appId: 'com.example.other', reason: 'Gone' }]),
      'full.json': JSON.stringify({ issuedAt: '2026-10-17T10:00:00Z', sequence: 42, entries: [{ appId: 'com.x.y', packageSha256: 'a'.repeat(64), reason: 'r', revokedAt: '2026-10-17T09:00:00Z' }] }),
      'bad.json': JSON.stringify([{ appId: 'Not An Id', reason: 'x' }]),
    });
    const env = { OLAN_APP_DEV_KEY: join(project.dir, 'home', 'dev.key.json') };
    try {
      const signed = await run(['revocations', 'sign', '--dev', '--in', 'list.json', '--out', 'revocations.json'], project.dir, env);
      expect(signed.code).toBe(0);
      expect(signed.out.result).toMatchObject({ file: 'revocations.json', keyId: 'dev-local', entries: 2 });
      const document = revocationDocumentSchema.parse(JSON.parse(readFileSync(join(project.dir, 'revocations.json'), 'utf8')));
      expect(document.signature).toMatchObject({ keyId: 'dev-local', algorithm: 'ed25519' });
      const key = JSON.parse(readFileSync(env.OLAN_APP_DEV_KEY, 'utf8')) as { publicKey: string };
      expect(verifyRevocationDocument(document, key.publicKey)).toBe(true);
      expect(verifyRevocationDocument({ ...document, payload: document.payload.replace('Test', 'Tost') }, key.publicKey)).toBe(false);
      const payload = parseRevocationPayload(document.payload);
      expect(payload.ok).toBe(true);
      if (!payload.ok) return;
      expect(Date.parse(payload.payload.expiresAt) - Date.parse(payload.payload.issuedAt)).toBe(48 * 3600 * 1000);
      expect(payload.payload.sequence).toBe(Math.floor(Date.parse(payload.payload.issuedAt) / 1000));
      expect(payload.payload.entries[1]).toEqual({ appId: 'com.example.other', reason: 'Gone', revokedAt: payload.payload.issuedAt });

      const full = await run(['revocations', 'sign', '--dev', '--in', 'full.json', '--out', 'full-signed.json'], project.dir, env);
      expect(full.out.result).toMatchObject({ issuedAt: '2026-10-17T10:00:00Z', expiresAt: '2026-10-19T10:00:00.000Z', sequence: 42 });

      expect((await run(['revocations', 'sign', '--in', 'list.json'], project.dir, env)).out.errors?.[0]?.code).toBe('revocations.dev_required');
      expect((await run(['revocations', 'sign', '--dev'], project.dir, env)).out.errors?.[0]?.code).toBe('revocations.input_required');
      expect((await run(['revocations', 'sign', '--dev', '--in', 'bad.json'], project.dir, env)).out.errors?.[0]?.code).toBe('revocations.entry_invalid');
      expect((await run(['revocations', 'verify', '--dev', '--in', 'list.json'], project.dir, env)).out.errors?.[0]?.code).toBe('cli.usage');
    } finally {
      project.remove();
    }
  });

  it('validate --strict warns that a keyless pack is unsigned and will not install', async () => {
    const project = tempProject('dev-validate', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    try {
      const env = { OLAN_APP_DEV_KEY: join(project.dir, 'home', 'dev.key.json') };
      const validated = await run(['validate', '--strict', '--no-typecheck'], project.dir, env);
      expect(validated.out.warnings?.map((item) => item.code)).toContain('validate.unsigned');
      const hint = (out: typeof validated.out) => (out.warnings as { code: string; hint?: string }[]).find((item) => item.code === 'validate.unsigned')?.hint;
      expect(hint(validated.out)).toContain('olan-app keygen --dev');
      // With a development key the hint names the command that signs with it.
      await run(['keygen', '--dev'], project.dir, env);
      const withKey = await run(['validate', '--strict', '--no-typecheck', '--no-build'], project.dir, env);
      expect(hint(withKey.out)).toContain('`olan-app pack --dev-sign` signs the package with it');
      expect(packContents({ files: [{ path: 'a', bytes: 1, sha256: '' }, { path: 'b', bytes: 1, sha256: '' }, { path: 'c', bytes: 1, sha256: '' }], signed: true })).toBe('3 app files (+ digest, signature)');
      expect(packContents({ files: [{ path: 'a', bytes: 1, sha256: '' }], signed: false })).toBe('1 app file (+ digest)');
    } finally {
      project.remove();
    }
  });
});

describe('publish trust feedback', () => {
  let server: Server;
  let base = '';
  let trust: unknown = null;
  let lastBody: Buffer = Buffer.alloc(0);
  let project: TempProject;

  async function readAll(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        if (request.method === 'POST' && request.url === '/api/v2/apps/catalog/packages') {
          lastBody = await readAll(request);
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ app: { id: 'a1' }, version: { id: 'v1', version: '0.1.0', trust } }));
          return;
        }
        response.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    project = tempProject('publish-trust', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
  });
  afterAll(async () => {
    project?.remove();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const publish = (argv: string[]) =>
    run(['publish', '--org', '--server', base, ...argv], project.dir, { OLAN_TOKEN: 't', OLAN_APP_DEV_KEY: join(project.dir, 'home', 'dev.key.json') });

  it('warns when the server stored the version but will not install it', async () => {
    trust = { status: 'unsigned', keyName: null, keyFingerprint: null };
    const unsigned = await publish([]);
    expect(unsigned.code).toBe(0);
    expect(unsigned.out.result.trust).toEqual(trust);
    expect(unsigned.out.warnings?.map((item) => item.code)).toEqual(['publish.package_unsigned']);

    trust = { status: 'untrusted_key', keyName: null, keyFingerprint: 'abcd' };
    expect((await publish([])).out.warnings?.map((item) => item.code)).toEqual(['publish.package_untrusted_key']);

    trust = { status: 'trusted', keyName: 'dev-local', keyFingerprint: 'abcd' };
    expect((await publish([])).out.warnings).toBeUndefined();
  });

  it('--dev-sign packs with the development key before uploading', async () => {
    trust = { status: 'trusted', keyName: 'dev-local', keyFingerprint: 'abcd' };
    const signed = await publish(['--dev-sign']);
    expect(signed.code).toBe(0);
    expect(lastBody.toString('latin1')).toContain('signature.json');
    expect((await publish(['--dev-sign', '--file', 'x.olanapp'])).out.errors?.[0]?.code).toBe('publish.dev_sign_file');
  });
});

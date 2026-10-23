// @vitest-environment node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digestSchema, packageDigestInput, runStaticReviewChecks, signatureSchema, type OlanAppManifest } from '@olan-app/schema';

import { runCli } from '../src/cli';
import { generateSigningKey } from '../src/commands/keygen';
import { packApp, verifyPackageSignature } from '../src/commands/pack';
import { manifest, tempProject } from './helpers';

const APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="Paket"><Text text="Merhaba" /></Screen>; }
export default defineApp({ app: Home });
`;
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

describe('pack', () => {
  it('writes a reproducible package whose digest and Ed25519 signature verify independently', async () => {
    const project = tempProject('pack', {
      'olan-app.json': manifest({ icon: 'assets/icon.svg', permissions: [] }),
      'src/app.tsx': APP,
      'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'assets/.hidden': 'not packaged',
    });
    try {
      // keygen through the CLI (writes the key and git-ignores it)
      let stdout = '';
      const code = await runCli(['keygen', '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd: project.dir, env: {} });
      expect(code).toBe(0);
      const keygen = JSON.parse(stdout) as { result: { file: string; publicKey: string } };
      expect(keygen.result.file).toBe('olan-app.key.json');
      expect(readFileSync(join(project.dir, '.gitignore'), 'utf8')).toContain('olan-app.key.json');

      const result = await packApp(project.dir);
      expect(result).toMatchObject({ file: 'dist/com.example.test-app-0.1.0.olanapp', signed: true, publicKey: keygen.result.publicKey });
      const zip = unzipSync(readFileSync(join(project.dir, result.file)));
      expect(Object.keys(zip).sort()).toEqual(['assets/icon.svg', 'digest.json', 'dist/app.js', 'olan-app.json', 'signature.json']);

      const digest = digestSchema.parse(JSON.parse(strFromU8(zip['digest.json']!)));
      for (const [path, hex] of Object.entries(digest.files)) expect(sha256(zip[path]!), path).toBe(hex);
      expect(sha256(packageDigestInput(digest.files))).toBe(digest.package);
      expect(digest.package).toBe(result.sha256);

      const signature = signatureSchema.parse(JSON.parse(strFromU8(zip['signature.json']!)));
      const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(signature.publicKey, 'base64')]), format: 'der', type: 'spki' });
      expect(verify(null, Buffer.from(digest.package, 'utf8'), publicKey, Buffer.from(signature.signature, 'base64'))).toBe(true);
      expect(verifyPackageSignature(digest.package, signature)).toBe(true);
      expect(verifyPackageSignature(sha256('tampered'), signature)).toBe(false);
      const otherKey = generateSigningKey();
      expect(verifyPackageSignature(digest.package, { ...signature, publicKey: otherKey.publicKey })).toBe(false);

      // The bundle is a classic script (contract §5): no top-level import/export.
      const bundle = strFromU8(zip['dist/app.js']!);
      expect(bundle).not.toMatch(/^\s*(import|export)\s/m);

      // Same inputs → same digest (fixed ZIP timestamps, deterministic build).
      const again = await packApp(project.dir, { signKey: false });
      expect(again.sha256).toBe(result.sha256);
      expect(again.signed).toBe(false);
    } finally {
      project.remove();
    }
  });

  it('fails with pack.key_invalid for a key whose halves do not match', async () => {
    const project = tempProject('pack-key', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    try {
      const a = generateSigningKey();
      const b = generateSigningKey();
      project.write('bad.key.json', JSON.stringify({ ...a, publicKey: b.publicKey }));
      await expect(packApp(project.dir, { signKey: 'bad.key.json' })).rejects.toMatchObject({ issues: [{ code: 'pack.key_invalid' }] });
      await expect(packApp(project.dir, { signKey: 'missing.json' })).rejects.toMatchObject({ issues: [{ code: 'pack.key_missing' }] });
    } finally {
      project.remove();
    }
  });

  it('refuses to pack an app that fails `olan-app validate` unless --no-validate', async () => {
    const project = tempProject('pack-validate', { 'olan-app.json': manifest({ permissions: [], icon: 'assets/missing.svg' }), 'src/app.tsx': APP });
    try {
      await expect(packApp(project.dir, { signKey: false })).rejects.toMatchObject({
        issues: [{ code: 'pack.validation_failed' }, { code: 'validate.icon_missing' }],
      });
      expect(existsSync(join(project.dir, 'dist', 'com.example.test-app-0.1.0.olanapp'))).toBe(false);

      let stdout = '';
      const code = await runCli(['pack', '--no-sign', '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd: project.dir, env: {} });
      expect(code).not.toBe(0);
      expect((JSON.parse(stdout) as { errors: { code: string }[] }).errors.map((item) => item.code)).toEqual(['pack.validation_failed', 'validate.icon_missing']);

      // --no-validate skips the checks; pack's own file checks still apply.
      await expect(packApp(project.dir, { signKey: false, validate: false })).rejects.toMatchObject({ issues: [{ code: 'pack.icon_missing' }] });
      project.write('assets/missing.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
      expect((await packApp(project.dir, { signKey: false })).signed).toBe(false);
    } finally {
      project.remove();
    }
  });
});

describe('pack license notices', () => {
  it('keeps the bundled license comments, so the marketplace licenses check finds notices (guideline 6.1)', async () => {
    const project = tempProject('pack-licenses', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    try {
      const result = await packApp(project.dir, { signKey: false });
      const zip = unzipSync(readFileSync(join(project.dir, result.file)));
      const files = Object.fromEntries(Object.entries(zip).map(([path, bytes]) => [path, strFromU8(bytes)]));
      const bundle = files['dist/app.js']!;
      expect(bundle).toMatch(/@license React/);
      const manifestJson = JSON.parse(files['olan-app.json']!) as OlanAppManifest;
      const licenses = runStaticReviewChecks({ manifest: manifestJson, files }).findings.filter((finding) => finding.check === 'licenses').map((finding) => finding.code);
      expect(licenses).not.toContain('licenses.notices_missing');
      expect(licenses).toContain('licenses.found');
    } finally {
      project.remove();
    }
  }, 60_000);
});

// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { signatureSchema } from '@olan-app/schema';

import { runCli } from '../src/cli';
import { packApp, verifyPackageSignature } from '../src/commands/pack';
import { MARKETPLACE_KEY_ID } from '../src/commands/sign';
import { manifest, tempProject } from './helpers';

/*
 * Internal `olan-app sign` (decision 2026-10-17): Olan signs its own apps with the Olan Marketplace
 * key from a PKCS#8 Ed25519 PEM. Tests use a throwaway key generated here.
 */

const APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="İmza"><Text text="Merhaba" /></Screen>; }
export default defineApp({ app: Home });
`;

async function run(argv: string[], cwd: string) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), cwd, env: {} });
  return { code, stdout, stderr };
}

async function runJson(argv: string[], cwd: string) {
  const { code, stdout, stderr } = await run([...argv, '--json'], cwd);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
  return { code, stdout, stderr, out: JSON.parse(stdout) as { ok: boolean; result?: any; errors?: { code: string }[] } };
}

function ed25519Pem() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    publicKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'),
  };
}

describe('sign (internal)', () => {
  it('signs an unsigned package in place with keyId, replaces an existing signature and never prints the key', async () => {
    const project = tempProject('sign', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    try {
      const packed = await packApp(project.dir, { signKey: false });
      expect(packed.signed).toBe(false);
      const first = ed25519Pem();
      writeFileSync(join(project.dir, 'marketplace.pem'), first.pem);
      const before = unzipSync(readFileSync(join(project.dir, packed.file)));
      const pemBody = first.pem.split('\n')[1]!;

      const signed = await runJson(['sign', '--key', 'marketplace.pem', '--key-id', MARKETPLACE_KEY_ID, packed.file], project.dir);
      expect(signed.code).toBe(0);
      expect(signed.out.result).toMatchObject({ file: packed.file, sha256: packed.sha256, publicKey: first.publicKey, keyId: MARKETPLACE_KEY_ID, replaced: false });
      expect(signed.stdout + signed.stderr).not.toContain(pemBody);

      const zip = unzipSync(readFileSync(join(project.dir, packed.file)));
      expect(Object.keys(zip)).toEqual([...Object.keys(before), 'signature.json']);
      const signature = signatureSchema.parse(JSON.parse(strFromU8(zip['signature.json']!)));
      expect(signature).toMatchObject({ algorithm: 'ed25519', publicKey: first.publicKey, keyId: MARKETPLACE_KEY_ID });
      expect(verifyPackageSignature(packed.sha256, signature)).toBe(true);
      // Only signature.json was added: every other entry is byte-identical.
      for (const [path, data] of Object.entries(before)) expect(Buffer.from(data).equals(Buffer.from(zip[path]!)), path).toBe(true);

      // Re-signing with another key (no key id) replaces the signature.
      const second = ed25519Pem();
      writeFileSync(join(project.dir, 'second.pem'), second.pem);
      const human = await run(['sign', '--key', 'second.pem', packed.file], project.dir);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('Re-signed');
      expect(human.stdout + human.stderr).not.toContain(second.pem.split('\n')[1]!);
      const resigned = signatureSchema.parse(JSON.parse(strFromU8(unzipSync(readFileSync(join(project.dir, packed.file)))['signature.json']!)));
      expect(resigned.publicKey).toBe(second.publicKey);
      expect(resigned).not.toHaveProperty('keyId');
      expect(verifyPackageSignature(packed.sha256, resigned)).toBe(true);
    } finally {
      project.remove();
    }
  });

  it('refuses non-Ed25519, non-PKCS#8 and encrypted keys, bad key ids and tampered packages', async () => {
    const project = tempProject('sign-refuse', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    try {
      const packed = await packApp(project.dir, { signKey: false });
      const { pem } = ed25519Pem();
      writeFileSync(join(project.dir, 'good.pem'), pem);
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
      writeFileSync(join(project.dir, 'ec.pem'), ec);
      const sec1 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'sec1' }) as string;
      writeFileSync(join(project.dir, 'sec1.pem'), sec1);
      const encrypted = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'test' }) as string;
      writeFileSync(join(project.dir, 'encrypted.pem'), encrypted);
      writeFileSync(join(project.dir, 'public.pem'), generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }) as string);

      const code = async (argv: string[]) => (await runJson(argv, project.dir)).out.errors?.[0]?.code;
      expect(await code(['sign', packed.file])).toBe('sign.key_required');
      expect(await code(['sign', '--key', 'good.pem'])).toBe('sign.package_required');
      expect(await code(['sign', '--key', 'missing.pem', packed.file])).toBe('sign.key_missing');
      expect(await code(['sign', '--key', 'good.pem', 'missing.olanapp'])).toBe('sign.package_missing');
      const ecResult = await runJson(['sign', '--key', 'ec.pem', packed.file], project.dir);
      expect(ecResult.out.errors?.[0]?.code).toBe('sign.key_not_ed25519');
      expect(ecResult.stdout).not.toContain(ec.split('\n')[1]!);
      expect(await code(['sign', '--key', 'sec1.pem', packed.file])).toBe('sign.key_invalid');
      expect(await code(['sign', '--key', 'public.pem', packed.file])).toBe('sign.key_invalid');
      expect(await code(['sign', '--key', 'encrypted.pem', packed.file])).toBe('sign.key_encrypted');
      expect(await code(['sign', '--key', 'good.pem', '--key-id', 'has space', packed.file])).toBe('sign.key_id_invalid');
      // Nothing was signed by the refused attempts.
      expect(Object.keys(unzipSync(readFileSync(join(project.dir, packed.file))))).not.toContain('signature.json');

      // A file changed after packing fails the digest check.
      const entries = unzipSync(readFileSync(join(project.dir, packed.file)));
      entries['dist/app.js'] = strToU8('/* tampered */');
      writeFileSync(join(project.dir, 'tampered.olanapp'), zipSync(entries));
      expect(await code(['sign', '--key', 'good.pem', 'tampered.olanapp'])).toBe('sign.digest_mismatch');
      writeFileSync(join(project.dir, 'not-a-zip.olanapp'), 'hello');
      expect(await code(['sign', '--key', 'good.pem', 'not-a-zip.olanapp'])).toBe('sign.package_invalid');
    } finally {
      project.remove();
    }
  });

  it('is listed as internal in help', async () => {
    const help = await run(['--help'], process.cwd());
    expect(help.stdout).toMatch(/sign\s+Internal:/);
  });
});

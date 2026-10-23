import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { booleanFlag, stringFlag } from '../args';
import type { Command } from '../command';
import { devKeyAdvice, devKeyPath, ensureDevKey } from '../dev-key';
import { fail } from '../errors';
import { displayPath } from '../paths';
import { findProjectDir, KEY_FILE } from '../project';
import type { SigningKeyFile } from './pack';

/** Appends `entry` to `<dir>/.gitignore` unless a line already ignores it. Returns whether it changed. */
export function ensureGitignored(dir: string, entry: string): boolean {
  const path = join(dir, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return false;
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${current}${prefix}# Olan app signing key: never commit it\n${entry}\n`);
  return true;
}

export function generateSigningKey(): SigningKeyFile {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return {
    algorithm: 'ed25519',
    publicKey: raw.toString('base64'),
    privateKey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
  };
}

export const keygenCommand: Command = {
  name: 'keygen',
  summary: 'Create an Ed25519 signing key (--dev: your local development key) and print how to trust it',
  usage: 'olan-app keygen [--dev] [--out olan-app.key.json] [--force]',
  options: [
    '--dev         Create (or show) your development key in ~/.olan (OLAN_APP_DEV_KEY overrides) and print the',
    '              OLAN_APPS_TRUSTED_KEYS line for a local Olan; `olan-app pack --dev-sign` signs with it',
    '--out <file>  Where to write the key (default olan-app.key.json in the app directory)',
    '--force       Replace an existing key',
  ],
  spec: { strings: ['out'], booleans: ['force', 'dev'], aliases: { o: 'out' } },
  async run(args, context) {
    if (booleanFlag(args, 'dev')) {
      if (stringFlag(args, 'out')) fail('keygen.dev_out', '--dev keeps the key in ~/.olan; set OLAN_APP_DEV_KEY to choose another file');
      const devKey = ensureDevKey(context.env, { force: booleanFlag(args, 'force') });
      return {
        result: { file: devKeyPath(context.env), publicKey: devKey.key.publicKey, fingerprint: devKey.fingerprint, created: devKey.created, envLine: devKey.envLine },
        human: [
          `${devKey.created ? 'Created' : 'Using'} development key ${devKey.path}`,
          `  public key ${devKey.key.publicKey}`,
          ...devKeyAdvice(devKey),
          '  Sign with it: `olan-app pack --dev-sign`.',
        ],
      };
    }
    const baseDir = findProjectDir(context.cwd) ?? context.cwd;
    const out = resolve(baseDir, stringFlag(args, 'out') ?? KEY_FILE);
    if (existsSync(out) && !booleanFlag(args, 'force')) {
      fail('keygen.exists', `${displayPath(baseDir, out)} already exists`, { hint: 'Keep it (packages signed with it stay verifiable) or pass --force to replace it.' });
    }
    const key = generateSigningKey();
    writeFileSync(out, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
    const ignored = ensureGitignored(dirname(out), basename(out));
    return {
      result: { file: displayPath(baseDir, out), publicKey: key.publicKey, gitignored: true, gitignoreUpdated: ignored },
      human: [
        `Wrote ${displayPath(baseDir, out)} (public key ${key.publicKey})`,
        '  Keep it secret and backed up; `olan-app pack` signs with it automatically.',
        '  An Olan server installs packages signed with it only if its OLAN_APPS_TRUSTED_KEYS lists this key',
        '  (production servers trust the Olan Marketplace key only; for local work use `olan-app keygen --dev`).',
      ],
    };
  },
};

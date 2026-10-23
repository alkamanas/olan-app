import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { generateSigningKey } from './commands/keygen';
import { readSigningKey, type SigningKeyFile } from './commands/pack';

/*
 * The local development signing key (decision 2026-10-17). An Olan server installs only packages
 * signed with a key on its trusted list (`OLAN_APPS_TRUSTED_KEYS`); in production that is the Olan
 * Marketplace key alone. For a local Olan, a developer creates one personal key, adds its public
 * half to the local server's list, and signs with `olan-app pack --dev-sign`. The key lives outside
 * every app (one key, one env line, for all of a developer's apps) and never goes to production.
 */

/** Name the printed env line gives the key on the server's list. */
export const DEV_KEY_NAME = 'dev-local';

/** `OLAN_APP_DEV_KEY`, else `~/.olan/olan-app-dev.key.json`. */
export function devKeyPath(env: NodeJS.ProcessEnv): string {
  const override = env.OLAN_APP_DEV_KEY?.trim();
  if (override) return resolve(override);
  return join(env.USERPROFILE || env.HOME || homedir(), '.olan', 'olan-app-dev.key.json');
}

/** First 16 hex of sha256(raw public key): the id the server shows and publishes in `/.well-known/olan`. */
export function keyFingerprint(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 16);
}

/** The line to add to the local Platform API environment so it trusts `publicKey`. */
export function trustedKeysEnvLine(publicKey: string, name = DEV_KEY_NAME): string {
  return `OLAN_APPS_TRUSTED_KEYS=${name}=${publicKey}`;
}

export interface DevKey {
  path: string;
  key: SigningKeyFile;
  created: boolean;
  fingerprint: string;
  envLine: string;
}

/** Reuses the development key, or creates it (mode 0600) when there is none or `force` is set. */
export function ensureDevKey(env: NodeJS.ProcessEnv, options: { force?: boolean } = {}): DevKey {
  const path = devKeyPath(env);
  let key: SigningKeyFile;
  let created = false;
  if (existsSync(path) && !options.force) {
    key = readSigningKey(path).key;
  } else {
    key = generateSigningKey();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
    created = true;
  }
  return { path, key, created, fingerprint: keyFingerprint(key.publicKey), envLine: trustedKeysEnvLine(key.publicKey) };
}

/** Human lines that explain what to do with the development key. */
export function devKeyAdvice(devKey: Pick<DevKey, 'envLine' | 'fingerprint'>): string[] {
  return [
    `  Development key ${devKey.fingerprint}. A local Olan installs these packages only when its Platform API trusts the key:`,
    `    ${devKey.envLine}`,
    '  (append it after a comma when OLAN_APPS_TRUSTED_KEYS already lists keys, then restart the API).',
    '  Never add a development key to a production server: production installs only Olan Marketplace-signed packages.',
  ];
}

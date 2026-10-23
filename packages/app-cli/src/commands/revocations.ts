import { createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseRevocationPayload,
  REVOCATION_VALIDITY_MS,
  revocationEntrySchema,
  type RevocationDocument,
  type RevocationEntry,
  type RevocationPayload,
} from '@olan-app/schema';

import { booleanFlag, stringFlag } from '../args';
import type { Command } from '../command';
import { DEV_KEY_NAME, devKeyAdvice, ensureDevKey } from '../dev-key';
import { fail } from '../errors';
import { displayPath } from '../paths';
import { readSigningKey } from './pack';

/*
 * `olan-app revocations sign --dev` (Phase 2 server contract §3, §5): signs a revocation list with
 * the local development key, for a local Olan server (`OLAN_APPS_REVOCATIONS_FILE`) and the mobile
 * development build. Production lists are signed only by the Olan Marketplace; production clients
 * reject anything else.
 */

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** What `--in` may hold: the entries array, or a payload with some fields left out. */
interface RevocationInput {
  version?: number;
  issuedAt?: string;
  expiresAt?: string;
  sequence?: number;
  entries: unknown[];
}

function readInput(path: string, shown: string): RevocationInput {
  if (!existsSync(path)) fail('revocations.input_missing', `${shown} does not exist`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    fail('revocations.input_invalid', `${shown} is not valid JSON`);
  }
  if (Array.isArray(value)) return { entries: value };
  if (typeof value === 'object' && value !== null && Array.isArray((value as { entries?: unknown }).entries)) return value as RevocationInput;
  fail('revocations.input_invalid', `${shown} must be an array of entries or { "entries": [...] }`, {
    hint: 'Entries look like { "appId": "com.example.app", "versions": ["1.0.0"], "reason": "…" } (docs/cli.md#revocations).',
  });
}

/**
 * Builds the payload: `version` 1, `issuedAt` now, `expiresAt` issuedAt + 48 h, `sequence` the
 * issue time in seconds (so later lists always have a higher one) and each entry's `revokedAt`
 * the issue time, unless the input sets them.
 */
export function buildRevocationPayload(input: RevocationInput, now = new Date()): RevocationPayload {
  const issuedAt = input.issuedAt ?? now.toISOString();
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs)) fail('revocations.input_invalid', 'issuedAt must be an ISO 8601 time');
  const entries: RevocationEntry[] = input.entries.map((raw, index) => {
    const entry = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { revokedAt: issuedAt, reason: '', ...(raw as object) } : raw;
    const result = revocationEntrySchema.safeParse(entry);
    if (!result.success) {
      const first = result.error.issues[0];
      fail('revocations.entry_invalid', `entries[${index}]${first?.path.length ? `.${first.path.join('.')}` : ''}: ${first?.message ?? 'invalid'}`, {
        hint: '{ "appId": "com.example.app", "versions"?: ["1.0.0"], "packageSha256"?: "<digest.package>", "reason": "…", "revokedAt"?: "<ISO>" }',
      });
    }
    return result.data as RevocationEntry;
  });
  const payload = {
    version: input.version ?? 1,
    issuedAt,
    expiresAt: input.expiresAt ?? new Date(issuedMs + REVOCATION_VALIDITY_MS).toISOString(),
    sequence: input.sequence ?? Math.floor(issuedMs / 1000),
    entries,
  };
  const checked = parseRevocationPayload(JSON.stringify(payload));
  if (!checked.ok) fail('revocations.input_invalid', checked.message);
  return checked.payload;
}

/** Signs the payload text (UTF-8 bytes) with an Ed25519 key. */
export function signRevocationPayload(payload: RevocationPayload, privateKey: Parameters<typeof sign>[2], keyId: string): RevocationDocument {
  const text = JSON.stringify(payload);
  return { payload: text, signature: { keyId, algorithm: 'ed25519', signature: sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64') } };
}

/** Whether `document.signature` is a valid signature of `document.payload` by `publicKey` (raw base64). */
export function verifyRevocationDocument(document: RevocationDocument, publicKey: string): boolean {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(document.payload, 'utf8'), key, Buffer.from(document.signature.signature, 'base64'));
}

export const revocationsCommand: Command = {
  name: 'revocations',
  summary: 'Development only: sign a revocation list with your development key (revocations sign --dev)',
  usage: 'olan-app revocations sign --dev --in list.json [--out revocations.json]',
  options: [
    '--dev          Required: sign with your development key (~/.olan/olan-app-dev.key.json, OLAN_APP_DEV_KEY overrides;',
    `               keyId "${DEV_KEY_NAME}"). Production lists are signed only by the Olan Marketplace.`,
    '--in <file>    The entries ([{ appId, versions?, packageSha256?, reason, revokedAt? }]) or { issuedAt?, expiresAt?,',
    '               sequence?, entries }; missing times default to now, expiresAt to +48 h, sequence to the time in seconds',
    '--out <file>   Where to write the signed document (default revocations.json)',
  ],
  spec: { strings: ['in', 'out'], booleans: ['dev'] },
  async run(args, context) {
    if (args.positionals[0] !== 'sign' || args.positionals.length !== 1) {
      fail('cli.usage', 'Usage: olan-app revocations sign --dev --in list.json [--out revocations.json]');
    }
    if (!booleanFlag(args, 'dev')) {
      fail('revocations.dev_required', 'Only the Olan Marketplace signs production revocation lists; pass --dev to sign a development list');
    }
    const inFlag = stringFlag(args, 'in');
    if (!inFlag) fail('revocations.input_required', 'Pass the list: --in list.json');
    const inPath = resolve(context.cwd, inFlag);
    const outPath = resolve(context.cwd, stringFlag(args, 'out') ?? `revocations.json`);
    const payload = buildRevocationPayload(readInput(inPath, displayPath(context.cwd, inPath)));
    const devKey = ensureDevKey(context.env);
    const { privateKey } = readSigningKey(devKey.path);
    const document = signRevocationPayload(payload, privateKey, DEV_KEY_NAME);
    if (!verifyRevocationDocument(document, devKey.key.publicKey)) fail('revocations.signature_failed', 'The new signature does not verify');
    writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
    const shown = displayPath(context.cwd, outPath);
    return {
      result: {
        file: shown,
        keyId: DEV_KEY_NAME,
        publicKey: devKey.key.publicKey,
        fingerprint: devKey.fingerprint,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        sequence: payload.sequence,
        entries: payload.entries.length,
      },
      human: [
        `Signed ${shown} with your development key ${devKey.fingerprint} (${payload.entries.length} entr${payload.entries.length === 1 ? 'y' : 'ies'}, sequence ${payload.sequence})`,
        `  valid until ${payload.expiresAt}; clients treat it as stale 24 h after ${payload.issuedAt}`,
        ...(devKey.created ? [`  Created ${devKey.path}`] : []),
        ...devKeyAdvice(devKey),
        '  A local server serves it with OLAN_APPS_REVOCATIONS_FILE; only development builds accept development-signed lists.',
      ],
    };
  },
};

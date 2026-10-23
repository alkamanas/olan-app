import { createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import {
  TEST_REPORT_MAX_BYTES,
  TEST_REPORT_MAX_TESTS,
  testReportPayloadSchema,
  verifyTestReport,
  type TestReportDocument,
  type TestReportPayload,
  type TestReportVerification,
  type TestStatus,
} from '@olan-app/schema';

import { readSigningKey } from './commands/pack';
import { keyFingerprint } from './dev-key';
import { fail } from './errors';
import { CLI_VERSION } from './version';

/*
 * Signed test reports (decision 2026-10-17, contract §27). `olan-app test --report <file>` binds
 * the results of the developer's own tests to one package (`packageSha256` = `digest.package` of the
 * packed `.olanapp`) and signs the payload text's UTF-8 bytes with the developer key
 * (`~/.olan/olan-app-dev.key.json`, the `olan-app keygen --dev` key). `olan-app publish --marketplace
 * --test-report <file>` attaches it; the marketplace verifies it with the same `verifyTestReport`.
 */

/** DER SubjectPublicKeyInfo prefix of a raw Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 verification over raw base64 keys (what `verifyTestReport` expects). */
export function verifyEd25519(message: Uint8Array, publicKey: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
    return verify(null, message, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** What a package says about itself: manifest id and version, and `digest.package`. */
export interface PackageIdentity {
  appId: string;
  appVersion: string;
  packageSha256: string;
}

/** Reads `olan-app.json` and `digest.json` of a `.olanapp` (no full verification: the marketplace does that). */
export function readPackageIdentity(file: string): PackageIdentity {
  if (!existsSync(file)) fail('package.missing', `${file} does not exist`, { hint: 'Run `olan-app pack` first.' });
  type Manifest = { id?: unknown; version?: unknown };
  type Digest = { package?: unknown };
  let manifest = null as Manifest | null;
  let digest = null as Digest | null;
  try {
    const files = unzipSync(readFileSync(file), { filter: (entry) => entry.name === 'olan-app.json' || entry.name === 'digest.json' });
    if (files['olan-app.json']) manifest = JSON.parse(strFromU8(files['olan-app.json'])) as Manifest;
    if (files['digest.json']) digest = JSON.parse(strFromU8(files['digest.json'])) as Digest;
  } catch {
    manifest = null;
  }
  if (typeof manifest?.id !== 'string' || typeof manifest.version !== 'string' || typeof digest?.package !== 'string') {
    fail('package.unreadable', `${basename(file)} is not an Olan app package (no readable olan-app.json and digest.json)`, { hint: 'Pack it with `olan-app pack`.' });
  }
  return { appId: manifest.id, appVersion: manifest.version, packageSha256: digest.package };
}

export interface TestResult {
  file: string;
  name: string;
  status: TestStatus;
  durationMs?: number;
  error?: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The report payload for `results` against `identity` (field limits of `testReportPayloadSchema` applied). */
export function testReportPayload(identity: PackageIdentity, results: readonly TestResult[], durationMs: number, generatedAt = new Date()): TestReportPayload {
  if (results.length > TEST_REPORT_MAX_TESTS) {
    fail('test.report_too_many', `A test report holds at most ${TEST_REPORT_MAX_TESTS} tests; this run has ${results.length}`, { hint: 'Merge small tests or split the suite.' });
  }
  const tests = results.map((test) => ({
    file: clip(test.file || 'tests', 300),
    name: clip(test.name || '(unnamed)', 500),
    status: test.status,
    ...(test.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(test.durationMs)) } : {}),
    ...(test.error ? { error: clip(test.error, 4000) } : {}),
  }));
  const count = (status: TestStatus) => tests.filter((test) => test.status === status).length;
  return {
    version: 1,
    appId: identity.appId,
    appVersion: identity.appVersion,
    packageSha256: identity.packageSha256,
    generatedAt: generatedAt.toISOString(),
    tool: { cli: clip(`olan-app ${CLI_VERSION}`, 64), runner: clip(`node:test ${process.version}`, 64) },
    summary: { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), durationMs: Math.max(0, Math.round(durationMs)) },
    tests,
  };
}

/**
 * Signs `payload` with the Ed25519 key in `keyPath`: `{ payload: <JSON text>, signature: { algorithm,
 * publicKey, signature, keyId } }`, the signature over the payload text's UTF-8 bytes. Error texts are
 * shortened when the document would exceed the marketplace limit.
 */
export function signTestReport(payload: TestReportPayload, keyPath: string): TestReportDocument {
  const parsed = testReportPayloadSchema.safeParse(payload);
  if (!parsed.success) fail('test.report_invalid', `The test report is not valid: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > TEST_REPORT_MAX_BYTES) {
    text = JSON.stringify({ ...payload, tests: payload.tests.map((test) => (test.error ? { ...test, error: clip(test.error, 200) } : test)) });
  }
  if (Buffer.byteLength(text, 'utf8') > TEST_REPORT_MAX_BYTES) fail('test.report_too_large', `The test report is over ${TEST_REPORT_MAX_BYTES / 1024} KiB`, { hint: 'Shorten test names or split the suite.' });
  const { key, privateKey } = readSigningKey(keyPath);
  return {
    payload: text,
    signature: {
      algorithm: 'ed25519',
      publicKey: key.publicKey,
      signature: sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64'),
      keyId: keyFingerprint(key.publicKey),
    },
  };
}

/** Reads a report file written by `olan-app test --report`. */
export function readTestReport(file: string): unknown {
  if (!existsSync(file)) fail('publish.test_report_missing', `${file} does not exist`, { hint: 'Write it with `olan-app test --report <file>` after packing.' });
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return fail('publish.test_report_invalid', `${basename(file)} is not JSON`, { hint: 'Write it with `olan-app test --report <file>`.' });
  }
}

/** `verifyTestReport` with node:crypto: the check the marketplace runs on attach. */
export function checkTestReport(document: unknown, identity: PackageIdentity): TestReportVerification {
  return verifyTestReport(document, identity, verifyEd25519);
}

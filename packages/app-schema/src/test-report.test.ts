import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTestReport } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ed25519 = (message: Uint8Array, key: string, signature: string) =>
  verify(null, message, createPublicKey({ key: Buffer.concat([PREFIX, Buffer.from(key, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'));

const target = { appId: 'com.acme.timesheet', appVersion: '1.0.0', packageSha256: 'a'.repeat(64) };
const payload = {
  version: 1, ...target, generatedAt: '2026-10-17T10:00:00Z', tool: { cli: '1.3.0', runner: 'vitest 4.1.5' },
  summary: { passed: 1, failed: 1, skipped: 0, durationMs: 120 },
  tests: [{ file: 'tests/app.test.ts', name: 'opens', status: 'passed' }, { file: 'tests/app.test.ts', name: 'saves', status: 'failed', error: 'expected 1' }],
};
const signed = (body: object) => {
  const text = JSON.stringify(body);
  return { payload: text, signature: { algorithm: 'ed25519', publicKey: raw, signature: sign(null, Buffer.from(text), privateKey).toString('base64') } };
};

describe('signed test report', () => {
  it('verifies a report for the package', () => {
    expect(verifyTestReport(signed(payload), target, ed25519)).toMatchObject({ ok: true, publicKey: raw, payload: { summary: { failed: 1 } } });
  });

  it('refuses tampering, other packages and wrong summaries', () => {
    const document = signed(payload);
    expect(verifyTestReport({ ...document, payload: document.payload.replace('"failed":1', '"failed":0') }, target, ed25519)).toMatchObject({ ok: false, code: 'test_report_signature_invalid' });
    expect(verifyTestReport(signed(payload), { ...target, packageSha256: 'b'.repeat(64) }, ed25519)).toMatchObject({ ok: false, code: 'test_report_mismatch' });
    expect(verifyTestReport(signed({ ...payload, summary: { ...payload.summary, failed: 0 } }), target, ed25519)).toMatchObject({ ok: false, code: 'test_report_invalid' });
    expect(verifyTestReport({ payload: '{}' }, target, ed25519)).toMatchObject({ ok: false, code: 'test_report_invalid' });
  });
});

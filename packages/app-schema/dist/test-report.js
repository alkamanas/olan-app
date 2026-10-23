import { z } from 'zod';
import { APP_ID_PATTERN } from './manifest.js';
import { isSemver } from './semver.js';
/*
 * Signed test report (decision 2026-10-17): the developer's own `olan-app test` suites need the
 * app's source, which a package does not contain, so the marketplace never runs them. Instead
 * `olan-app test --report <file>` writes a report bound to the exact package (`packageSha256` =
 * `digest.package`) and signs it with the developer's Ed25519 key (the same key format as
 * `olan-app keygen`). `olan-app publish` attaches it; reviewers see it next to the automatic checks.
 * Same envelope as the revocation list: `payload` is JSON text, the signature covers its UTF-8 bytes.
 */
export const TEST_REPORT_MAX_TESTS = 2000;
export const TEST_REPORT_MAX_BYTES = 512 * 1024;
const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 time');
const count = z.number().int().nonnegative();
export const testReportPayloadSchema = z
    .strictObject({
    version: z.literal(1),
    appId: z.string().regex(APP_ID_PATTERN),
    appVersion: z.string().refine(isSemver, 'must be a semantic version'),
    packageSha256: z.string().regex(/^[0-9a-f]{64}$/),
    generatedAt: isoTime,
    tool: z.strictObject({ cli: z.string().min(1).max(64), runner: z.string().max(64).optional() }),
    summary: z.strictObject({ passed: count, failed: count, skipped: count, durationMs: count }),
    tests: z
        .array(z.strictObject({
        file: z.string().min(1).max(300),
        name: z.string().min(1).max(500),
        status: z.enum(['passed', 'failed', 'skipped']),
        durationMs: count.optional(),
        error: z.string().max(4000).optional(),
    }))
        .max(TEST_REPORT_MAX_TESTS),
})
    .refine((payload) => payload.summary.passed === payload.tests.filter((test) => test.status === 'passed').length &&
    payload.summary.failed === payload.tests.filter((test) => test.status === 'failed').length &&
    payload.summary.skipped === payload.tests.filter((test) => test.status === 'skipped').length, { message: 'summary must count the tests', path: ['summary'] });
export const testReportDocumentSchema = z.strictObject({
    payload: z.string().min(1).max(TEST_REPORT_MAX_BYTES),
    signature: z.strictObject({
        algorithm: z.literal('ed25519'),
        publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
        signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
        keyId: z.string().max(64).optional(),
    }),
});
export function parseTestReportPayload(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return { ok: false, message: 'payload is not JSON' };
    }
    const result = testReportPayloadSchema.safeParse(value);
    if (!result.success) {
        const first = result.error.issues[0];
        return { ok: false, message: `payload${first?.path.length ? `.${first.path.join('.')}` : ''}: ${first?.message ?? 'invalid'}` };
    }
    return { ok: true, payload: result.data };
}
/**
 * Verifies a test report for one package. Pure: the caller passes an Ed25519 `verify(message,
 * publicKeyBase64, signatureBase64)` (node:crypto on the server, WebCrypto in a browser). Whether the
 * signing key belongs to the developer is the caller's decision (the marketplace checks the keys the
 * developer account registered).
 */
export function verifyTestReport(value, expected, verify) {
    const document = testReportDocumentSchema.safeParse(value);
    if (!document.success) {
        const first = document.error.issues[0];
        return { ok: false, code: 'test_report_invalid', message: `${first?.path.join('.') || 'document'}: ${first?.message ?? 'invalid'}` };
    }
    const { payload, signature } = document.data;
    if (!verify(new TextEncoder().encode(payload), signature.publicKey, signature.signature)) {
        return { ok: false, code: 'test_report_signature_invalid', message: 'The signature does not verify against the payload.' };
    }
    const parsed = parseTestReportPayload(payload);
    if (!parsed.ok)
        return { ok: false, code: 'test_report_invalid', message: parsed.message };
    const report = parsed.payload;
    if (report.appId !== expected.appId || report.appVersion !== expected.appVersion || report.packageSha256 !== expected.packageSha256) {
        return { ok: false, code: 'test_report_mismatch', message: `The report is for ${report.appId} ${report.appVersion} (${report.packageSha256.slice(0, 12)}…), not this package.` };
    }
    return { ok: true, payload: report, publicKey: signature.publicKey };
}

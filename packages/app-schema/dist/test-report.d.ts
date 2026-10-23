import { z } from 'zod';
export declare const TEST_REPORT_MAX_TESTS = 2000;
export declare const TEST_REPORT_MAX_BYTES: number;
export type TestStatus = 'passed' | 'failed' | 'skipped';
export interface TestReportPayload {
    version: 1;
    appId: string;
    /** App version (manifest `version`). */
    appVersion: string;
    /** `digest.package` of the package the tests ran against. */
    packageSha256: string;
    generatedAt: string;
    /** CLI that ran the tests (`olan-app` version) and the runner (`vitest` version). */
    tool: {
        cli: string;
        runner?: string;
    };
    summary: {
        passed: number;
        failed: number;
        skipped: number;
        durationMs: number;
    };
    tests: {
        file: string;
        name: string;
        status: TestStatus;
        durationMs?: number;
        error?: string;
    }[];
}
export interface TestReportDocument {
    payload: string;
    signature: {
        algorithm: 'ed25519';
        /** Base64 raw 32-byte public key of the developer key that signed. */
        publicKey: string;
        /** Base64 Ed25519 signature over the UTF-8 bytes of `payload`. */
        signature: string;
        keyId?: string;
    };
}
export declare const testReportPayloadSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    appId: z.ZodString;
    appVersion: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
    packageSha256: z.ZodString;
    generatedAt: z.ZodString;
    tool: z.ZodObject<{
        cli: z.ZodString;
        runner: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    summary: z.ZodObject<{
        passed: z.ZodNumber;
        failed: z.ZodNumber;
        skipped: z.ZodNumber;
        durationMs: z.ZodNumber;
    }, z.core.$strict>;
    tests: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        name: z.ZodString;
        status: z.ZodEnum<{
            passed: "passed";
            failed: "failed";
            skipped: "skipped";
        }>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const testReportDocumentSchema: z.ZodObject<{
    payload: z.ZodString;
    signature: z.ZodObject<{
        algorithm: z.ZodLiteral<"ed25519">;
        publicKey: z.ZodString;
        signature: z.ZodString;
        keyId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare function parseTestReportPayload(text: string): {
    ok: true;
    payload: TestReportPayload;
} | {
    ok: false;
    message: string;
};
export type TestReportVerification = {
    ok: true;
    payload: TestReportPayload;
    publicKey: string;
} | {
    ok: false;
    code: 'test_report_invalid' | 'test_report_signature_invalid' | 'test_report_mismatch';
    message: string;
};
/**
 * Verifies a test report for one package. Pure: the caller passes an Ed25519 `verify(message,
 * publicKeyBase64, signatureBase64)` (node:crypto on the server, WebCrypto in a browser). Whether the
 * signing key belongs to the developer is the caller's decision (the marketplace checks the keys the
 * developer account registered).
 */
export declare function verifyTestReport(value: unknown, expected: {
    appId: string;
    appVersion: string;
    packageSha256: string;
}, verify: (message: Uint8Array, publicKey: string, signature: string) => boolean): TestReportVerification;

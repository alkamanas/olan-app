import { describe, expect, it } from 'vitest';
import { isRevoked, parseRevocationPayload, REVOCATION_VALIDITY_MS, revocationDocumentSchema } from './index.js';

const payload = {
  version: 1,
  issuedAt: '2026-10-17T10:00:00Z',
  expiresAt: '2026-10-19T10:00:00Z',
  sequence: 42,
  entries: [
    { appId: 'com.x.y', versions: ['1.0.0'], reason: 'Güvenlik açığı', revokedAt: '2026-10-17T09:00:00Z' },
    { appId: 'com.x.z', reason: 'Withdrawn', revokedAt: '2026-10-17T09:00:00Z' },
    { appId: 'com.x.w', packageSha256: 'a'.repeat(64), reason: 'Bad build', revokedAt: '2026-10-17T09:00:00Z' },
  ],
};

describe('revocation list (Phase 2 server contract §3)', () => {
  it('parses the contract payload and matches entries', () => {
    const parsed = parseRevocationPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { entries } = parsed.payload;
    expect(isRevoked(entries, { appId: 'com.x.y', version: '1.0.0' })?.reason).toBe('Güvenlik açığı');
    expect(isRevoked(entries, { appId: 'com.x.y', version: '1.0.1' })).toBeNull();
    expect(isRevoked(entries, { appId: 'com.x.z', version: '9.9.9' })?.reason).toBe('Withdrawn');
    expect(isRevoked(entries, { appId: 'com.x.w', version: '1.0.0', packageSha256: 'a'.repeat(64) })?.reason).toBe('Bad build');
    expect(isRevoked(entries, { appId: 'com.x.w', version: '1.0.0', packageSha256: 'b'.repeat(64) })).toBeNull();
    expect(REVOCATION_VALIDITY_MS).toBe(48 * 3600 * 1000);
  });

  it('rejects malformed payloads and documents', () => {
    expect(parseRevocationPayload('{').ok).toBe(false);
    expect(parseRevocationPayload(JSON.stringify({ ...payload, version: 2 })).ok).toBe(false);
    expect(parseRevocationPayload(JSON.stringify({ ...payload, expiresAt: payload.issuedAt })).ok).toBe(false);
    expect(parseRevocationPayload(JSON.stringify({ ...payload, entries: [{ appId: 'nope', reason: '', revokedAt: payload.issuedAt }] }))).toMatchObject({ ok: false, message: expect.stringContaining('entries.0.appId') });
    expect(revocationDocumentSchema.safeParse({ payload: '{}', signature: { keyId: 'dev-local', algorithm: 'ed25519', signature: 'AA==' } }).success).toBe(true);
    expect(revocationDocumentSchema.safeParse({ payload: {}, signature: { keyId: 'dev-local', algorithm: 'ed25519', signature: 'AA==' } }).success).toBe(false);
  });
});

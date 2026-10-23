import { describe, expect, it } from 'vitest';
import { marketplaceKeySetDocumentSchema, MARKETPLACE_KEY_SET_VALIDITY_MS, parseMarketplaceKeySetPayload } from './index.js';

const key = (keyId: string, fill: string, status: 'active' | 'retired' | 'revoked' = 'active') => ({
  keyId,
  publicKey: Buffer.alloc(32, fill).toString('base64'),
  fingerprint: '0123456789abcdef',
  status,
});

const payload = {
  version: 1,
  issuedAt: '2026-10-17T10:00:00Z',
  expiresAt: '2026-10-19T10:00:00Z',
  sequence: 7,
  keys: [key('olan-marketplace-2026-10-17', 'a', 'retired'), key('olan-marketplace-2027-01-01', 'b')],
};

describe('marketplace key set (Phase 4a)', () => {
  it('parses a key set', () => {
    const parsed = parseMarketplaceKeySetPayload(JSON.stringify(payload));
    expect(parsed).toMatchObject({ ok: true, payload: { sequence: 7, keys: [{ status: 'retired' }, { status: 'active' }] } });
    expect(MARKETPLACE_KEY_SET_VALIDITY_MS).toBe(48 * 3600 * 1000);
  });

  it('rejects malformed key sets', () => {
    expect(parseMarketplaceKeySetPayload('[').ok).toBe(false);
    expect(parseMarketplaceKeySetPayload(JSON.stringify({ ...payload, keys: [] })).ok).toBe(false);
    expect(parseMarketplaceKeySetPayload(JSON.stringify({ ...payload, keys: [payload.keys[1], payload.keys[1]] })).ok).toBe(false);
    expect(parseMarketplaceKeySetPayload(JSON.stringify({ ...payload, keys: [{ ...payload.keys[0], publicKey: 'AA==' }] })).ok).toBe(false);
    expect(parseMarketplaceKeySetPayload(JSON.stringify({ ...payload, keys: [{ ...payload.keys[0], status: 'lost' }] })).ok).toBe(false);
    expect(parseMarketplaceKeySetPayload(JSON.stringify({ ...payload, extra: true })).ok).toBe(false);
    expect(marketplaceKeySetDocumentSchema.safeParse({ payload: '{}', signature: { keyId: 'k', algorithm: 'ed25519', signature: 'AA==' } }).success).toBe(true);
  });
});

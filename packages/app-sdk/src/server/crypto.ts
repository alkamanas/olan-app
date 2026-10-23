/*
 * WebCrypto helpers for `@olan-app/sdk/server`: base64/base64url, PEM, key import and JWK
 * handling. No Node-specific APIs: runs on Node ≥ 22, Deno, Bun and edge runtimes.
 */

export type AssertionAlgorithm = 'EdDSA' | 'ES256' | 'RS256';

/**
 * A JSON Web Key. Declared here (instead of the DOM `JsonWebKey`) so the module type-checks in
 * Node-only projects whose `lib` has no DOM.
 */
export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
  [member: string]: unknown;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlJson(value: unknown): string {
  return toBase64Url(utf8(JSON.stringify(value)));
}

/** DER bytes of a PEM block (`-----BEGIN PRIVATE KEY-----`, PKCS#8). */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!match) throw new TypeError('privateKeyPem must be a PEM block ("-----BEGIN PRIVATE KEY-----")');
  if (match[1] !== 'PRIVATE KEY') {
    throw new TypeError(`privateKeyPem must be PKCS#8 ("BEGIN PRIVATE KEY"), not "${match[1]}"; convert it with \`openssl pkcs8 -topk8 -nocrypt\``);
  }
  return fromBase64(match[2]!);
}

export function derToPem(der: Uint8Array, label = 'PRIVATE KEY'): string {
  const body = toBase64(der).replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export interface SigningKey {
  key: CryptoKey;
  alg: AssertionAlgorithm;
  /** The public JWK (no private members, no `kid`). */
  publicJwk: Jwk;
}

const CANDIDATES: Array<{ alg: AssertionAlgorithm; params: { name: string; namedCurve?: string; hash?: string } }> = [
  { alg: 'EdDSA', params: { name: 'Ed25519' } },
  { alg: 'ES256', params: { name: 'ECDSA', namedCurve: 'P-256' } },
  { alg: 'RS256', params: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } },
];

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'key_ops', 'ext'];

/** Imports a PKCS#8 PEM private key: Ed25519 (EdDSA), P-256 (ES256) or RSA (RS256). */
export async function importSigningKey(pem: string): Promise<SigningKey> {
  const der = pemToDer(pem);
  for (const candidate of CANDIDATES) {
    try {
      const key = await crypto.subtle.importKey('pkcs8', der, candidate.params, true, ['sign']);
      const jwk = await crypto.subtle.exportKey('jwk', key);
      const publicJwk: Jwk = { ...(jwk as Jwk) };
      for (const member of PRIVATE_MEMBERS) delete (publicJwk as Record<string, unknown>)[member];
      return { key, alg: candidate.alg, publicJwk };
    } catch {
      // try the next algorithm
    }
  }
  throw new TypeError('privateKeyPem is not an Ed25519, P-256 (ES256) or RSA (RS256) PKCS#8 private key');
}

export async function sign(signing: SigningKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const algorithm = signing.alg === 'EdDSA' ? { name: 'Ed25519' } : signing.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  // ECDSA signatures from WebCrypto are r||s (IEEE P1363), which is what JWS expects.
  return new Uint8Array(await crypto.subtle.sign(algorithm, signing.key, data));
}

/** RFC 7638 JWK thumbprint (base64url SHA-256), used as the default `kid`. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const members: Record<string, string[]> = { OKP: ['crv', 'kty', 'x'], EC: ['crv', 'kty', 'x', 'y'], RSA: ['e', 'kty', 'n'] };
  const names = members[jwk.kty ?? ''];
  if (!names) throw new TypeError(`Unsupported key type ${String(jwk.kty)}`);
  const canonical = `{${names.map((name) => `${JSON.stringify(name)}:${JSON.stringify((jwk as Record<string, unknown>)[name])}`).join(',')}}`;
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(canonical))));
}

/** Imports an Olan apps signing key (`{ kty: 'OKP', crv: 'Ed25519', x }`) for verification. */
export async function importVerifyKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string }, { name: 'Ed25519' }, false, ['verify']);
}

export async function verifyEd25519(key: CryptoKey, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
  } catch {
    return false;
  }
}

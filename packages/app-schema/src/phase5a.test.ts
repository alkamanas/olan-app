import { describe, expect, it } from 'vitest';
import {
  AI_TOOL_LIMITS,
  OLAN_CLOUD_ISSUER,
  PROFILE_ROLES,
  REMOTE_REQUEST_LIMITS,
  acceptsFile,
  aiToolTimeoutMs,
  appLinkUrl,
  appReturnUrl,
  describePermission,
  externalUrlProblem,
  hostMessageSchema,
  isAppReturnUrl,
  linkParams,
  methodAllowed,
  normalizePickOptions,
  parseAppLink,
  parseAppReturnUrl,
  parseRemoteAnswer,
  permissionCategory,
  profileRole,
  remoteEndpoint,
  remoteRequestOutcome,
  remoteRouteError,
  reviewPermissions,
  uploadTargetProblem,
  validateCard,
  validateManifest,
  validateRemoteRequest,
  validateUploadParams,
  type ManifestIssue,
} from './index.js';

const app = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'com.markanera.content',
  name: 'İçerik',
  version: '1.0.0',
  sdk: '^1.5.0',
  entry: 'dist/app.js',
  surfaces: { app: {} },
  ...extra,
});
const remote = { url: 'https://markanera.com/olan', jwksUrl: 'https://markanera.com/olan/jwks.json' };

function issues(input: unknown): ManifestIssue[] {
  const result = validateManifest(input);
  return result.ok ? [] : result.issues;
}
const codes = (input: unknown) => issues(input).map((issue) => issue.code);

describe('manifest (Phase 5a)', () => {
  it('accepts remote.requests, profile:read and files:pick', () => {
    const result = validateManifest(app({ remote: { ...remote, requests: true }, permissions: ['profile:read', 'files:pick', 'storage'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.remote?.requests).toBe(true);
    expect(codes(app({ remote: { ...remote, requests: 'yes' } }))).not.toEqual([]);
  });

  it('needs remote for profile:read', () => {
    expect(codes(app({ permissions: ['profile:read'] }))).toEqual(['manifest.profile_requires_remote']);
  });

  it('accepts ai.tools timeoutMs up to 60 s, read-only tools up to 15 s', () => {
    const tool = (extra: Record<string, unknown>) => app({ remote, ai: { tools: [{ name: 'draft_posts', description: 'AI draft', input: { type: 'object' }, ...extra }] } });
    expect(codes(tool({ timeoutMs: 60_000 }))).toEqual([]);
    expect(codes(tool({ timeoutMs: 60_001 }))).not.toEqual([]);
    expect(codes(tool({ timeoutMs: 20_000, readOnly: true }))).toEqual(['manifest.ai_tool_invalid']);
    expect(codes(tool({ timeoutMs: 15_000, readOnly: true }))).toEqual([]);
    expect(aiToolTimeoutMs({})).toBe(AI_TOOL_LIMITS.timeoutMs);
    expect(aiToolTimeoutMs({ timeoutMs: 45_000 })).toBe(45_000);
  });

  it('keeps old manifests valid', () => {
    expect(codes(app({ sdk: '^1.0.0', remote }))).toEqual([]);
  });
});

describe('permissions (Phase 5a)', () => {
  it('describes profile:read and files:pick in TR and EN', () => {
    expect(describePermission('profile:read', 'tr').label).toBe('Profilinizi görme');
    expect(describePermission('files:pick', 'en').description).toMatch(/files you pick/);
    expect(permissionCategory('profile:read')).toBe('read');
    expect(permissionCategory('files:pick')).toBe('data');
  });

  it('maps the new methods', () => {
    expect(methodAllowed('remote.request', ['remote'])).toBe(true);
    expect(methodAllowed('remote.request', [])).toBe(false);
    expect(methodAllowed('files.pick', ['files:pick'])).toBe(true);
    expect(methodAllowed('files.upload', [])).toBe(false);
    expect(methodAllowed('ui.openExternal', [])).toBe(true);
    expect(methodAllowed('timers.set', [])).toBe(true);
  });

  it('does not ask apps to list the implied remote permission', () => {
    const review = reviewPermissions({ manifest: { permissions: ['files:pick'] }, rpcMethods: ['remote.request', 'files.pick'] });
    expect(review.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
  });
});

describe('remote.request (Phase 5a §1)', () => {
  it('normalises a request', () => {
    const result = validateRemoteRequest({ method: 'POST', path: '/brands/b1/posts', query: { draft: true, channel: ['ig', 'tt'], page: 2 }, headers: { 'Idempotency-Key': 'k1' }, body: { text: 'Merhaba' } });
    expect(result).toEqual({
      ok: true,
      request: { method: 'POST', path: '/brands/b1/posts', query: { draft: 'true', channel: ['ig', 'tt'], page: '2' }, headers: { 'idempotency-key': 'k1' }, body: { text: 'Merhaba' }, timeoutMs: 30_000 },
    });
  });

  it('rejects bad paths, headers, bodies and timeouts', () => {
    const code = (input: unknown) => {
      const result = validateRemoteRequest(input);
      return result.ok ? 'ok' : result.code;
    };
    for (const path of ['brands', '//evil.example/x', '/a/../b', '/a/%2e%2e/b', '/a?x=1', '/a#b', '/a//b', '/a/%2Fb']) expect(code({ method: 'GET', path }), path).toBe('invalid_params');
    expect(code({ method: 'GET', path: '/a', headers: { authorization: 'x' } })).toBe('invalid_params');
    expect(code({ method: 'GET', path: '/a', body: { x: 1 } })).toBe('invalid_params');
    expect(code({ method: 'TRACE', path: '/a' })).toBe('invalid_params');
    expect(code({ method: 'GET', path: '/a', timeoutMs: 60_001 })).toBe('invalid_params');
    expect(code({ method: 'GET', path: '/a', timeoutMs: 60_000 })).toBe('ok');
    expect(code({ method: 'POST', path: '/a', body: 'x'.repeat(REMOTE_REQUEST_LIMITS.requestBodyBytes) })).toBe('payload_too_large');
  });

  it('parses the wrapped answer and maps it to the RPC outcome', () => {
    const answer = parseRemoteAnswer({ status: 201, headers: { 'Content-Type': 'application/json', etag: '"v1"', 'set-cookie': 'x' }, body: { id: 'p1' } });
    expect(answer).toEqual({ status: 201, headers: { 'content-type': 'application/json', etag: '"v1"' }, body: { id: 'p1' } });
    expect(remoteRequestOutcome(answer!)).toEqual({ ok: true, result: answer });
    expect(remoteRequestOutcome({ status: 422, headers: {}, body: { issues: [] } })).toMatchObject({ ok: false, error: { code: 'remote_rejected', details: { status: 422, body: { issues: [] } } } });
    expect(remoteRequestOutcome({ status: 503, headers: {}, body: null })).toMatchObject({ ok: false, error: { code: 'remote_unavailable', details: { status: 503, reason: 'http_status' } } });
    expect(parseRemoteAnswer({ status: 102 })).toBeNull();
    expect(parseRemoteAnswer('ok')).toBeNull();
    expect(parseRemoteAnswer({ status: 204 })).toEqual({ status: 204, headers: {}, body: null });
  });

  it('maps route errors', () => {
    expect(remoteRouteError(429, { error: 'rate_limited', message: 'slow down', details: { retryAfterSeconds: 12 } })).toEqual({ code: 'rate_limited', message: 'slow down', details: { status: 429, retryAfterSeconds: 12 } });
    expect(remoteRouteError(502, { error: 'remote_unavailable', message: 'timeout', details: { reason: 'timeout' } })).toEqual({ code: 'remote_unavailable', message: 'timeout', details: { status: 0, reason: 'timeout' } });
    expect(remoteRouteError(403, { error: 'feature_not_enabled', message: 'no', details: { feature: 'marketing' } }).details).toEqual({ status: 403, feature: 'marketing' });
  });

  it('maps users.role to the profile role', () => {
    expect(PROFILE_ROLES).toEqual(['admin', 'member']);
    expect(profileRole('tenant_admin')).toBe('admin');
    expect(profileRole('super_admin')).toBe('admin');
    expect(profileRole('domain_admin')).toBe('member');
    expect(profileRole(undefined)).toBe('member');
  });

  it('posts to {remote.url}/requests and knows the cloud issuer', () => {
    expect(remoteEndpoint('https://markanera.com/olan', 'requests')).toBe('https://markanera.com/olan/requests');
    expect(OLAN_CLOUD_ISSUER).toBe('https://api.olan.app');
  });
});

describe('files (Phase 5a §3)', () => {
  it('normalises pick options', () => {
    expect(normalizePickOptions(undefined)).toEqual({ ok: true, options: { accept: [], multiple: false, maxBytes: 100 * 1024 * 1024, maxFiles: 1, source: 'device' } });
    expect(normalizePickOptions({ accept: ['image/*', '.MOV'], multiple: true, maxBytes: 300 * 1024 * 1024 })).toMatchObject({ ok: true, options: { accept: ['image/*', '.mov'], maxFiles: 20 } });
    expect(normalizePickOptions({ accept: ['image'] }).ok).toBe(false);
    expect(normalizePickOptions({ maxBytes: 2 * 1024 * 1024 * 1024 }).ok).toBe(false);
    expect(normalizePickOptions({ source: 'olan-files' }).ok).toBe(false);
  });

  it('matches accept entries', () => {
    expect(acceptsFile(['image/*'], { name: 'a.jpg', type: 'image/jpeg' })).toBe(true);
    expect(acceptsFile(['video/mp4', '.mov'], { name: 'clip.MOV', type: '' })).toBe(true);
    expect(acceptsFile(['image/*'], { name: 'a.pdf', type: 'application/pdf' })).toBe(false);
    expect(acceptsFile([], { name: 'x', type: '' })).toBe(true);
  });

  it('allows uploads only to the remote origin or an http:<host> permission', () => {
    const context = { remoteUrl: 'https://markanera.com/olan', permissions: ['http:uploads.example.com'] };
    expect(uploadTargetProblem('https://markanera.com/api/v1/uploads/t1', context)).toBeNull();
    expect(uploadTargetProblem('https://uploads.example.com/put/1', context)).toBeNull();
    expect(uploadTargetProblem('https://cdn.markanera.com/x', context)).toBe('origin');
    expect(uploadTargetProblem('http://markanera.com/x', context)).toBe('http_public');
    expect(uploadTargetProblem('http://127.0.0.1:3200/olan/up', { remoteUrl: 'http://127.0.0.1:3200/olan', permissions: [], development: true })).toBeNull();
    expect(uploadTargetProblem('https://user:pw@markanera.com/x', context)).toBe('credentials');
  });

  it('checks upload params', () => {
    expect(validateUploadParams({ uploadId: 'upl_1', fileId: 'file_1', url: 'https://x.example/u' })).toEqual({
      ok: true,
      params: { uploadId: 'upl_1', fileId: 'file_1', url: 'https://x.example/u', method: 'PUT', headers: {}, formField: 'file', fields: {} },
    });
    expect(validateUploadParams({ uploadId: 'upl_1', fileId: 'file_1', url: 'https://x.example/u', method: 'POST', formField: 'media', fields: { brand: 'b1' }, headers: { 'X-Upload-Token': 't' } })).toMatchObject({
      ok: true,
      params: { method: 'POST', formField: 'media', fields: { brand: 'b1' }, headers: { 'x-upload-token': 't' } },
    });
    expect(validateUploadParams({ uploadId: 'upl_1', fileId: 'file_1', url: 'https://x.example/u', headers: { Cookie: 'a' } }).ok).toBe(false);
    expect(validateUploadParams({ uploadId: 'upl_1', fileId: 'file_1', url: 'https://x.example/u', headers: { 'x-olan-file-name': 'a' } }).ok).toBe(false);
    expect(validateUploadParams({ uploadId: 'upl_1', fileId: 'file_1', url: 'https://x.example/u', formField: 'f' }).ok).toBe(false);
    expect(validateUploadParams({ uploadId: 'x', fileId: 'file_1', url: 'https://x.example/u' }).ok).toBe(false);
  });
});

describe('links (Phase 5a §5, §8)', () => {
  it('builds and checks return addresses', () => {
    const url = appReturnUrl('https://olan.app/', 'inst-1');
    expect(url).toBe('https://olan.app/apps/return/inst-1');
    expect(isAppReturnUrl(`${url}?state=s1&marketing=connected`, 'https://olan.app', 'inst-1')).toBe(true);
    expect(isAppReturnUrl('https://evil.example/apps/return/inst-1', 'https://olan.app', 'inst-1')).toBe(false);
    expect(isAppReturnUrl('https://olan.app/apps/return/inst-2', 'https://olan.app', 'inst-1')).toBe(false);
    expect(parseAppReturnUrl(`${url}?state=s1&a=1&a=2#frag`)).toEqual({ installationId: 'inst-1', params: { state: 's1', a: '2' } });
  });

  it('parses permanent app addresses', () => {
    expect(parseAppLink('/apps/a/com.markanera.content?brand=b1&tab=posts')).toEqual({ appId: 'com.markanera.content', navigation: { screen: 'index', params: { brand: 'b1', tab: 'posts' } } });
    expect(parseAppLink('https://olan.app/apps/a/com.markanera.content/composer')).toEqual({ appId: 'com.markanera.content', navigation: { screen: 'composer', params: {} } });
    expect(parseAppLink('/apps/a/Not An Id')).toBeNull();
    expect(parseAppLink('/apps/a/com.x.y/a/b')).toBeNull();
    expect(appLinkUrl('https://olan.app', 'com.markanera.ads', { screen: 'campaign', params: { id: 'c1' } })).toBe('https://olan.app/apps/a/com.markanera.ads/campaign?id=c1');
    const many = new URLSearchParams(Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, 'v'])));
    expect(linkParams(many)).toBeNull();
  });

  it('checks openUrl / openExternal targets', () => {
    expect(externalUrlProblem('https://markanera.com')).toBeNull();
    expect(externalUrlProblem('javascript:alert(1)')).toBe('scheme');
    expect(externalUrlProblem('http://example.com')).toBe('http_public');
    expect(externalUrlProblem('http://localhost:3000/x', { development: true })).toBeNull();
  });
});

describe('protocol and cards (Phase 5a)', () => {
  it('accepts the new host messages and error details', () => {
    expect(hostMessageSchema.safeParse({ type: 'upload-progress', uploadId: 'upl_1', loaded: 10, total: 100 }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ type: 'timer', timerId: 'tmr_1' }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ type: 'rpc-result', id: 1, ok: false, error: { code: 'remote_rejected', message: 'x', details: { status: 404, body: null } } }).success).toBe(true);
    const init = {
      type: 'init',
      app: { id: 'com.x.y', version: '1.0.0', installationId: 'i1' },
      surface: 'app',
      params: { return: { state: 's' } },
      context: { theme: 'light', locale: 'tr', platform: 'web', permissions: [], settings: {}, development: false, user: { id: 'u1' } },
      navigation: { screen: 'composer', params: { brand: 'b1' } },
    };
    expect(hostMessageSchema.safeParse(init).success).toBe(true);
  });

  it('keeps Image and the other new components out of cards', () => {
    const result = validateCard({ version: 1, root: 1, fallbackText: 'x', nodes: [{ id: 1, type: 'Image', props: { src: 'https://x.example/a.png', alt: 'a' }, children: [] }] });
    expect(result.ok).toBe(false);
  });
});

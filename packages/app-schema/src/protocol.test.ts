import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  hostMessageSchema,
  isHandlerRef,
  propValueSchema,
  sandboxMessageSchema,
  uiNodeSchema,
  uiPatchBatchSchema,
  uiPatchSchema,
} from './index.js';

describe('UI patches', () => {
  it('accepts every patch op', () => {
    const batch = [
      { op: 'create', node: { id: 1, type: 'Screen', props: { title: 'x', actions: [{ key: 'a', label: 'A', onPress: { $handler: 4 } }] }, children: [] } },
      { op: 'create', node: { id: 2, type: '#text', props: { text: 'hi' }, children: [] } },
      { op: 'props', id: 1, set: { title: 'y' }, unset: ['subtitle'] },
      { op: 'children', id: 1, children: [2] },
      { op: 'remove', id: 2 },
      { op: 'root', id: 1 },
      { op: 'root', id: null },
    ];
    expect(uiPatchBatchSchema.safeParse(batch).success).toBe(true);
  });

  it('rejects malformed patches', () => {
    const bad = [
      { op: 'move', id: 1 },
      { op: 'props', id: 1, props: { title: 'x' } }, // wire form is set/unset
      { op: 'props', id: 1, set: {} }, // unset is required
      { op: 'children', id: -1, children: [] },
      { op: 'remove', id: 1.5 },
      { op: 'create', node: { id: 1, type: 'Screen', props: {} } }, // children missing
      { op: 'create', node: { id: 1, type: 'Screen', props: { onPress: () => 1 }, children: [] } },
      { op: 'create', node: { id: 1, type: 'Screen', props: { n: Number.NaN }, children: [] } },
      { op: 'root', id: 1, extra: true },
    ];
    for (const patch of bad) expect(uiPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
  });

  it('prop values cover JSON and handler refs', () => {
    expect(propValueSchema.safeParse({ a: [1, 'x', null, { $handler: 1 }], b: { c: true } }).success).toBe(true);
    expect(propValueSchema.safeParse(undefined).success).toBe(false);
    expect(isHandlerRef({ $handler: 3 })).toBe(true);
    expect(isHandlerRef({ $handler: 3, x: 1 })).toBe(false);
    expect(isHandlerRef({ $handler: -1 })).toBe(false);
    expect(uiNodeSchema.safeParse({ id: 1, type: '', props: {}, children: [] }).success).toBe(false);
  });
});

describe('sandbox messages', () => {
  it('accepts each message type', () => {
    const messages = [
      { type: 'ready', sdkVersion: '1.0.0', protocolVersion: PROTOCOL_VERSION },
      { type: 'ready', sdkVersion: '2.0.0', protocolVersion: 2 }, // newer protocols parse so the host can explain
      { type: 'patches', seq: 0, patches: [{ op: 'root', id: null }] },
      { type: 'rpc', id: 1, method: 'projects.list', params: { limit: 20 } },
      { type: 'log', level: 'warn', args: ['x', 1, { a: null }] },
      { type: 'error', message: 'boom', stack: 'at x', fatal: true },
      { type: 'error', message: 'boom' },
    ];
    for (const message of messages) expect(sandboxMessageSchema.safeParse(message).error?.issues ?? [], message.type).toEqual([]);
  });

  it('rejects invalid sandbox messages', () => {
    const bad = [
      { type: 'ready', sdkVersion: '1.0.0', protocolVersion: 0 },
      { type: 'patches', seq: 1, patches: [{ op: 'nope' }] },
      { type: 'rpc', id: 1, method: 'x', params: undefined },
      { type: 'log', level: 'trace', args: [] },
      { type: 'init' }, // host message
      { type: 'rpc', id: 1, method: 'x', params: null, token: 'secret' },
    ];
    for (const message of bad) expect(sandboxMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(false);
  });
});

describe('host messages', () => {
  const context = {
    theme: 'dark',
    locale: 'tr',
    platform: 'desktop',
    permissions: ['projects:read'],
    settings: { threshold: 3 },
    development: false,
    user: { id: '00000000-0000-4000-8000-000000000001' },
  };

  it('accepts each message type', () => {
    const messages = [
      { type: 'init', app: { id: 'com.example.x', version: '1.0.0', installationId: null }, surface: 'project.widget', params: { projectId: 'p1' }, context },
      { type: 'event', handlerId: 3, payload: { key: 'p1' } },
      { type: 'rpc-result', id: 1, ok: true, result: [] },
      { type: 'rpc-result', id: 2, ok: false, error: { code: 'permission_denied', message: 'no' } },
      { type: 'context', context: { theme: 'light' } },
      { type: 'context', context: {} },
      { type: 'context', context: { user: { id: 'u2' } } },
      { type: 'navigation', action: 'back' },
    ];
    for (const message of messages) expect(hostMessageSchema.safeParse(message).error?.issues ?? [], message.type).toEqual([]);
  });

  it('rejects invalid host messages', () => {
    const bad = [
      { type: 'init', app: { id: 'x', version: '1', installationId: null }, surface: 'chat.reaction', params: null, context },
      { type: 'init', app: { id: 'x', version: '1', installationId: null }, surface: 'app', params: null, context: { ...context, platform: 'windows' } },
      { type: 'rpc-result', id: 1, ok: true, error: { code: 'x', message: 'y' } },
      { type: 'rpc-result', id: 1, ok: false, result: 1 },
      { type: 'context', context: { theme: 'sepia' } },
      { type: 'context', context: { user: { id: '' } } },
      { type: 'context', context: { user: { id: 'u1', name: 'Utku' } } },
      // init carries the current user (Phase 2 server contract §10.1).
      { type: 'init', app: { id: 'x', version: '1', installationId: null }, surface: 'app', params: null, context: { ...context, user: undefined } },
      { type: 'navigation', action: 'forward' },
    ];
    for (const message of bad) expect(hostMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(false);
  });

  it('lists the contract error codes', () => {
    expect(RPC_ERROR_CODES).toEqual([
      'permission_denied', 'not_installed', 'invalid_params', 'unknown_method', 'host_error', 'http_blocked', 'cancelled',
      'quota_exceeded', 'conflict', 'forbidden_record', 'not_found', 'validation_failed',
      'backend_function_not_found', 'backend_error', 'backend_limit', 'backend_busy', 'payload_too_large', 'backend_unavailable',
      'backend_migrating',
      'remote_unavailable', 'remote_rejected', 'consent_required', 'rate_limited', 'feature_not_enabled', 'upload_failed',
      'project_not_enabled',
    ]);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors';
import { createMockHost, DEFAULT_USER, DEFAULT_USER_ID, defaultFixtures } from '../src/mock-server';

describe('mock host', () => {
  it('denies calls without their permission like the Olan host', async () => {
    const host = createMockHost({ fixtures: defaultFixtures(), permissions: [] });
    expect(await host.handle('projects.list', {})).toEqual({ ok: false, error: { code: 'permission_denied', message: 'The app needs the projects:read permission' } });
    expect((await host.handle('projects.updateTask', { projectId: 'p0', taskId: 'p0-t1', status: 'completed', revision: 1 })).ok).toBe(false);
    expect(await host.handle('storage.get', { key: 'a' })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await host.handle('chat.conversations', {})).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await host.handle('http.fetch', { url: 'https://api.example.com/x' })).toMatchObject({ ok: false, error: { code: 'http_blocked' } });
    // No permission needed:
    expect(await host.handle('settings.get', {})).toEqual({ ok: true, result: {} });
    expect(await host.handle('ui.toast', { text: 'Merhaba' })).toEqual({ ok: true, result: null });
    expect(host.calls.map((call) => call.ok)).toEqual([false, false, false, false, false, true, true]);
  });

  it('serves users.get from the default user and fixtures/users.json, with users:read', async () => {
    const ayse = { id: '00000000-0000-4000-8000-000000000002', displayName: 'Ayşe', email: 'ayse@example.com', team: 'Mobil' };
    const host = createMockHost({ fixtures: { users: [ayse] }, permissions: ['users:read'] });
    expect(host.userId).toBe(DEFAULT_USER_ID);
    expect(DEFAULT_USER).toMatchObject({ id: DEFAULT_USER_ID, displayName: 'Utku' });
    expect(await host.handle('users.get', { ids: [ayse.id, 'unknown', DEFAULT_USER_ID, ayse.id] })).toEqual({ ok: true, result: { users: [ayse, { ...DEFAULT_USER }] } });
    expect(await host.handle('users.get', { ids: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await host.handle('users.get', { ids: Array.from({ length: 101 }, (_, i) => String(i)) })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    host.permissions = ['projects:read'];
    expect(await host.handle('users.get', { ids: [DEFAULT_USER_ID] })).toEqual({ ok: false, error: { code: 'permission_denied', message: 'The app needs the users:read permission' } });
    expect(() => createMockHost({ fixtures: { users: [{ id: 'x' } as never] } })).toThrow(CliError);
    // The default member and task author is the default user.
    expect(createMockHost({ fixtures: defaultFixtures() }).data.projects[0]!.members[0]!.userId).toBe(DEFAULT_USER_ID);
  });

  it('matches http: permissions by host and port and never goes to the network', async () => {
    const host = createMockHost({
      permissions: ['http:api.example.com'],
      fixtures: { http: { 'https://api.example.com/x': { json: { a: 1 } }, 'POST https://api.example.com/y': { status: 201, body: 'created' } } },
    });
    expect(await host.handle('http.fetch', { url: 'https://api.example.com/x?page=2' })).toEqual({
      ok: true,
      result: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    });
    expect(await host.handle('http.fetch', { url: 'https://api.example.com/y', method: 'POST' })).toMatchObject({ ok: true, result: { status: 201, body: 'created' } });
    expect(await host.handle('http.fetch', { url: 'https://api.example.com:8443/x' })).toMatchObject({ ok: false, error: { code: 'http_blocked' } });
    expect(await host.handle('http.fetch', { url: 'https://www.example.com/x' })).toMatchObject({ ok: false, error: { code: 'http_blocked' } });
    expect(await host.handle('http.fetch', { url: 'https://api.example.com/unknown' })).toMatchObject({ ok: false, error: { code: 'http_blocked', message: expect.stringContaining('fixtures/http.json') } });
  });

  it('validates methods, params and task revisions', async () => {
    const host = createMockHost({ fixtures: defaultFixtures(), permissions: ['projects:read', 'projects:write', 'storage'] });
    expect(await host.handle('projects.delete', {})).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
    expect(await host.handle('projects.list', [] as never)).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await host.handle('projects.get', { projectId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    const stale = await host.handle('projects.updateTask', { projectId: 'p0', taskId: 'p0-t1', status: 'completed', revision: 7 });
    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict', message: 'The task changed; reload it' } });
    const updated = await host.handle('projects.updateTask', { projectId: 'p0', taskId: 'p0-t1', status: 'completed', revision: 1 });
    expect(updated).toMatchObject({ ok: true, result: { id: 'p0-t1', status: 'completed', revision: 2 } });
    expect(host.data.projects[0]!.tasks[1]!.status).toBe('completed');
    expect(await host.handle('projects.list', { limit: 2 })).toMatchObject({ ok: true, result: { nextCursor: '2' } });
    await host.handle('storage.set', { key: 'k', value: { a: [1, 2] } });
    expect(await host.handle('storage.get', { key: 'k' })).toEqual({ ok: true, result: { a: [1, 2] } });
    expect(await host.handle('storage.keys', {})).toEqual({ ok: true, result: ['k'] });
    expect(await host.handle('storage.set', { key: 'big', value: 'x'.repeat(70_000) })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });

  it('answers dialogs from the configured ui and records toasts and navigation', async () => {
    const host = createMockHost({ ui: { confirm: false, prompt: () => 'Yeni ad', menu: 'edit' } });
    expect(await host.handle('ui.confirm', { title: 'Emin misiniz?' })).toEqual({ ok: true, result: false });
    expect(await host.handle('ui.prompt', { title: 'Ad' })).toEqual({ ok: true, result: 'Yeni ad' });
    expect(await host.handle('ui.menu', { items: [] })).toEqual({ ok: true, result: 'edit' });
    expect(await host.handle('ui.datePicker', {})).toEqual({ ok: true, result: null });
    await host.handle('ui.toast', { text: 'Kaydedildi', tone: 'success' });
    await host.handle('navigation.push', { screen: 'task', params: { id: 1 } });
    await host.handle('navigation.pop', {});
    expect(host.toasts).toEqual([{ text: 'Kaydedildi', tone: 'success' }]);
    expect(host.navigation).toEqual([{ action: 'push', screen: 'task', params: { id: 1 } }, { action: 'pop' }]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { BACKEND_HOST_METHODS } from '@olan-app/schema';

import { BackendUnavailableError, defineBackend, isBackendModule, isOlanBackendError, olan, OlanBackendError } from '../src/backend/index';

type Bridge = { call(method: string, argsJson: string): Promise<string> };
const global = globalThis as { __olan?: Bridge };

function install(answer: (method: string, args: unknown) => unknown) {
  const calls: { method: string; args: unknown }[] = [];
  global.__olan = {
    async call(method, argsJson) {
      const args = JSON.parse(argsJson);
      calls.push({ method, args });
      return JSON.stringify(await answer(method, args));
    },
  };
  return calls;
}

afterEach(() => {
  delete global.__olan;
});

describe('@olan-app/sdk/backend', () => {
  it('defineBackend marks the module', () => {
    const module = defineBackend({ functions: { ping: () => 'pong' } });
    expect(isBackendModule(module)).toBe(true);
    expect(Object.isFrozen(module)).toBe(true);
  });

  it('rejects with backend_unavailable outside the runtime', async () => {
    const failure = await olan.secrets.get('apiToken').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackendUnavailableError);
    expect(isOlanBackendError(failure, 'backend_unavailable')).toBe(true);
  });

  it('maps every olan.* call to the UI RPC method names and params', async () => {
    const calls = install((method) => {
      if (method === 'db.query') return { rows: [], nextCursor: null };
      if (method === 'calendar.calendars') return { calendars: [] };
      if (method === 'calendar.events') return { events: [] };
      if (method === 'contacts.addressBooks') return { addressBooks: [] };
      if (method === 'contacts.search') return { contacts: [] };
      if (method === 'users.get') return { users: [] };
      if (method === 'http.fetch') return { status: 200, headers: {}, body: '{"a":1}' };
      return null;
    });
    const items = olan.db.collection('items');
    await olan.secrets.get('apiToken');
    await olan.settings.get();
    await items.insert({ title: 'x' });
    await items.get('r1');
    await items.query({ limit: 5 });
    await items.update('r1', { title: 'y' }, { revision: 1 });
    await items.delete('r1');
    await items.count({ title: 'y' });
    expect((await olan.http.fetch('https://api.example.com/x', { method: 'POST', body: '{}' })).json()).toEqual({ a: 1 });
    await olan.projects.list();
    await olan.projects.get('p1');
    await olan.projects.tasks('p1', { status: 'completed' });
    await olan.projects.createTask('p1', { title: 'T' });
    await olan.projects.updateTask('p1', 't1', { status: 'completed', revision: 2 });
    await olan.projects.deleteTask('p1', 't1', { revision: 3 });
    await olan.projects.deleteList('p1', 'l1', { revision: 1 });
    await olan.projects.create({ title: 'New' });
    await olan.projects.archive('p2');
    await olan.users.get(['u1', 'u1', 'u2']);
    await olan.chat.conversations();
    await olan.chat.messages('c1', { limit: 3 });
    await olan.chat.postCard({ conversationId: 'c1', card: { version: 1, root: 1, nodes: [], fallbackText: 'x' } as never });
    await olan.chat.updateCard('m1', { version: 1, root: 1, nodes: [], fallbackText: 'y' } as never);
    await olan.calendar.calendars();
    await olan.calendar.events({ from: '2026-10-01', to: '2026-10-31' });
    await olan.calendar.createEvent({ title: 'E', start: '2026-10-20T09:00:00Z' });
    await olan.calendar.updateEvent('e1', { title: 'E2' });
    await olan.calendar.deleteEvent('e1');
    await olan.contacts.addressBooks();
    await olan.contacts.search('ay', { limit: 5 });
    await olan.contacts.create({ name: 'Ayşe' });
    await olan.contacts.update('k1', { note: 'n' });
    await olan.contacts.delete('k1');
    await olan.meetings.get('m1');
    await olan.project.config.get('p1');
    await olan.project.config.set('p1', { brandId: 'b1' }, { revision: 2 });
    const target = { kind: 'task' as const, id: 't1' };
    const card = { version: 1, root: 1, nodes: [], fallbackText: 'x' } as never;
    await olan.project.statuses.list('p1');
    await olan.project.statuses.define('p1', [{ key: 'live', name: 'Yayında', category: 'completed' }]);
    await olan.project.statuses.remove('p1', 'live', { replacementKey: 'done' });
    await olan.project.labels.list('p1');
    await olan.project.labels.define('p1', [{ key: 'ig', name: 'Instagram' }]);
    await olan.project.labels.remove('p1', 'ig');
    await olan.project.fields.list('p1');
    await olan.project.fields.define('p1', [{ key: 'channel', name: 'Kanal', type: 'select', options: [{ id: 'ig', name: 'Instagram' }] }]);
    await olan.project.fields.remove('p1', 'channel');
    await olan.project.fields.values('p1', target);
    await olan.project.fields.setValues('p1', target, { channel: 'ig', reach: null });
    await olan.project.links.list('p1', target);
    await olan.project.links.upsert('p1', { target, externalId: 'post-1', card });
    await olan.project.links.setStatus('p1', 'l1', { statusKey: 'live' });
    await olan.project.links.remove('p1', 'l1');
    await olan.project.calendar.list('p1', { from: '2026-11-01', to: '2026-11-30' });
    await olan.project.calendar.upsert('p1', { externalId: 'post-1', title: 'Yayın', start: '2026-11-02', allDay: true });
    await olan.project.calendar.remove('p1', 'post-1');
    await olan.project.activity.post('p1', 'Yayınlandı', { target });
    await olan.project.approvals.list('p1', { state: 'pending' });
    await olan.project.approvals.request('p1', { title: 'Onay', approverIds: ['u1'] });
    await olan.project.approvals.cancel('p1', 'a1');
    const methods = calls.map((call) => call.method);
    // Every backend host method is reachable from olan.*, and nothing else is called.
    expect([...new Set(methods)].sort()).toEqual([...BACKEND_HOST_METHODS].sort());
    expect(calls.find((call) => call.method === 'db.update')!.args).toEqual({ collection: 'items', id: 'r1', patch: { title: 'y' }, revision: 1 });
    expect(calls.find((call) => call.method === 'projects.updateTask')!.args).toEqual({ projectId: 'p1', taskId: 't1', status: 'completed', revision: 2 });
    expect(calls.find((call) => call.method === 'users.get')!.args).toEqual({ ids: ['u1', 'u2'] });
    expect(calls.find((call) => call.method === 'project.config.set')!.args).toEqual({ projectId: 'p1', value: { brandId: 'b1' }, revision: 2 });
    expect(calls.find((call) => call.method === 'secrets.get')!.args).toEqual({ name: 'apiToken' });
    expect(calls.find((call) => call.method === 'project.links.setStatus')!.args).toEqual({ projectId: 'p1', linkId: 'l1', statusKey: 'live' });
    expect(calls.find((call) => call.method === 'project.activity.post')!.args).toEqual({ projectId: 'p1', text: 'Yayınlandı', target });
    expect(calls.find((call) => call.method === 'project.fields.setValues')!.args).toEqual({ projectId: 'p1', target, values: { channel: 'ig', reach: null } });
  });

  it('turns host errors into OlanBackendError with the code', async () => {
    global.__olan = {
      call: () => Promise.reject(Object.assign(new Error('The app needs the db permission'), { code: 'permission_denied' })),
    };
    const failure = await olan.db.collection('items').count().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OlanBackendError);
    expect(failure).toMatchObject({ code: 'permission_denied', message: 'The app needs the db permission' });
  });
});

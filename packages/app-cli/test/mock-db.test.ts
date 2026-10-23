// @vitest-environment node
import type { DataSchema } from '@olan-app/schema';
import { DB_CONTRACT_PROJECT_IDS, defineDbContractTests, type DbContractUser } from '@olan-app/sdk/db-contract';
import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors';
import { createMockHost, defaultFixtures, DEFAULT_USER_ID, normalizeProject, type MockHost } from '../src/mock-server';

const USERS: Record<DbContractUser, string> = { a: 'user-a', b: 'user-b' };

// The shared olan.db contract suite, against the CLI mock host: every call goes through
// `host.handle` (permission check, RPC result/error shape) like the sandbox's calls do.
// User b, another member of the same installation, acts on the host's database as b (`host.db.as`).
defineDbContractTests({ describe, it }, async ({ schema, quota }) => {
  const projects = DB_CONTRACT_PROJECT_IDS.map((id, index) => ({ id, name: `Contract ${index}` }));
  const host: MockHost = createMockHost({ data: schema, userId: USERS.a, permissions: ['db'], fixtures: { projects }, ...(quota ? { quota } : {}) });
  const viewB = host.db.as(USERS.b);
  return {
    userIds: USERS,
    async call(user, method, params) {
      if (user === 'b') return viewB.call(method, params);
      const outcome = await host.handle(method, params as never);
      if (outcome.ok) return outcome.result;
      throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code });
    },
  };
});

const SCHEMA: DataSchema = {
  version: 1,
  collections: {
    decisions: {
      scope: 'organization',
      fields: {
        title: { type: 'string', required: true, maxLength: 200, indexed: true },
        status: { type: 'string', enum: ['open', 'done'], indexed: true },
        projectId: { type: 'ref:project', indexed: true },
      },
      rules: { read: 'any', update: 'any', delete: 'owner' },
    },
    pins: { scope: 'user', fields: { decisionId: { type: 'string', indexed: true } } },
  },
};
const ROW_ID = '5a0c7c1e-8a4b-4f43-9a7d-0d5e3b2c1a00';

describe('mock host olan.db', () => {
  it('seeds fixtures/db.json with defaults and keeps host.data.db live', async () => {
    const host = createMockHost({
      data: SCHEMA,
      permissions: ['db'],
      now: '2026-10-17T09:00:00Z',
      fixtures: { db: { decisions: [{ id: ROW_ID, data: { title: 'Seed', status: 'open' } }], pins: [{ data: { decisionId: ROW_ID }, createdBy: 'u2' }] } },
    });
    expect(host.data.db.decisions).toEqual([
      { id: ROW_ID, data: { title: 'Seed', status: 'open' }, revision: 1, createdAt: '2026-10-17T09:00:00.000Z', updatedAt: '2026-10-17T09:00:00.000Z', createdBy: DEFAULT_USER_ID },
    ]);
    const inserted = await host.handle('db.insert', { collection: 'decisions', data: { title: 'Yeni' } });
    expect(inserted).toMatchObject({ ok: true, result: { data: { title: 'Yeni' }, revision: 1, createdBy: DEFAULT_USER_ID } });
    expect(host.data.db.decisions).toHaveLength(2);
    // user collections: the default user does not see u2's pin
    expect(await host.handle('db.count', { collection: 'pins' })).toEqual({ ok: true, result: 0 });
    expect(await host.handle('db.query', { collection: 'decisions', orderBy: { field: 'createdAt', direction: 'asc' } })).toMatchObject({
      ok: true,
      result: { rows: [{ id: ROW_ID }, { data: { title: 'Yeni' } }], nextCursor: null },
    });
    expect(host.calls.map((call) => call.method)).toEqual(['db.insert', 'db.count', 'db.query']);
  });

  it('answers with the contract error codes and audits deletions', async () => {
    const host = createMockHost({ data: SCHEMA, permissions: ['db'], fixtures: { db: { decisions: [{ id: ROW_ID, data: { title: 'Seed' } }] } } });
    expect(await host.handle('db.insert', { collection: 'decisions', data: {} })).toMatchObject({ ok: false, error: { code: 'validation_failed', message: 'data.title: row.required' } });
    expect(await host.handle('db.insert', { collection: 'decisions', data: { title: 'x', projectId: 'p1' } })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await host.handle('db.query', { collection: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await host.handle('db.update', { collection: 'decisions', id: ROW_ID, patch: { status: 'done' }, revision: 3 })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await host.db.as('u2').call('db.delete', { collection: 'decisions', id: ROW_ID }).catch((error: { code: string }) => error.code)).toBe('forbidden_record');
    expect(await host.handle('db.delete', { collection: 'decisions', id: ROW_ID, revision: 1 })).toEqual({ ok: true, result: null });
    expect(await host.handle('db.get', { collection: 'decisions', id: ROW_ID })).toEqual({ ok: true, result: null });
    expect(host.audit()).toEqual([{ action: 'db.delete', detail: { collection: 'decisions', rowId: ROW_ID } }]);

    const denied = createMockHost({ data: SCHEMA, permissions: [] });
    expect(await denied.handle('db.query', { collection: 'decisions' })).toEqual({ ok: false, error: { code: 'permission_denied', message: 'The app needs the db permission' } });
    const noData = createMockHost({ permissions: ['db'] });
    expect(await noData.handle('db.count', { collection: 'decisions' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    const full = createMockHost({ data: SCHEMA, permissions: ['db'], quota: { rows: 0 } });
    expect(await full.handle('db.insert', { collection: 'decisions', data: { title: 'x' } })).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
  });

  it('rejects fixtures/db.json rows that do not match the manifest', () => {
    const codes = (db: Record<string, unknown>, data: DataSchema | null = SCHEMA) => {
      try {
        createMockHost({ data, fixtures: { db: db as never } });
        return [];
      } catch (error) {
        return (error as CliError).issues.map((item) => item.code);
      }
    };
    expect(codes({ decisions: [{ data: { title: 'ok' } }] })).toEqual([]);
    expect(codes({ decisions: [{ data: {} }] })).toEqual(['fixtures.db_invalid']);
    expect(codes({ decisions: [{ data: { title: 'x', projectId: 'p1' } }] })).toEqual(['fixtures.db_invalid']);
    expect(codes({ decisions: [{ id: 'a', data: { title: 'x' } }, { id: 'a', data: { title: 'y' } }] })).toEqual(['fixtures.db_invalid']);
    expect(codes({ notes: [] })).toEqual(['fixtures.db_unknown_collection']);
    expect(codes({ decisions: [] }, null)).toEqual(['fixtures.db_unknown_collection']);
    expect(() => createMockHost({ data: SCHEMA, fixtures: { db: { decisions: [{ data: {} }] } } })).toThrow(CliError);
  });
});

describe('mock host record writes', () => {
  const PERMISSIONS = ['projects:read', 'tasks:write', 'tasks:delete', 'projects:delete'];
  const project = () => ({
    id: 'site',
    name: 'Site',
    lists: [
      { id: 'todo', name: 'Yapılacaklar' },
      { id: 'later', name: 'Sonra' },
      { id: 'parent', name: 'Üst' },
      { id: 'child', name: 'Alt', parentId: 'parent' },
    ],
    tasks: [{ id: 'human', title: 'İnsan görevi', listId: 'later' }],
  });

  it('marks the first work package as the default one', () => {
    expect(normalizeProject(project()).lists.map((list) => [list.id, list.isDefault, list.revision, list.parentId])).toEqual([
      ['todo', true, 1, null],
      ['later', false, 1, null],
      ['parent', false, 1, null],
      ['child', false, 1, 'parent'],
    ]);
    expect(normalizeProject({ id: 'x', name: 'X', lists: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', isDefault: true }] }).lists.map((list) => list.isDefault)).toEqual([false, true]);
    expect(createMockHost({ fixtures: defaultFixtures() }).data.projects[0]!.lists).toEqual([{ id: 'p0-l0', name: 'Görevler', isDefault: true, revision: 1, parentId: null }]);
  });

  it('creates tasks in the default work package and deletes them with an audit line', async () => {
    const host = createMockHost({ fixtures: { projects: [project()] }, permissions: PERMISSIONS, appId: 'com.example.decisions' });
    const created = await host.handle('projects.createTask', { projectId: 'site', title: '  Karar görevi ' });
    expect(created).toMatchObject({ ok: true, result: { title: 'Karar görevi', listId: 'todo', status: 'needs-action', revision: 1, createdByApp: 'com.example.decisions', createdBy: DEFAULT_USER_ID } });
    const task = (created as unknown as { result: { id: string } }).result;
    expect(await host.handle('projects.createTask', { projectId: 'site', title: 'x', listId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await host.handle('projects.createTask', { projectId: 'site', title: ' ' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    expect(await host.handle('projects.deleteTask', { projectId: 'site', taskId: task.id, revision: 2 })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await host.handle('projects.deleteTask', { projectId: 'site', taskId: task.id, revision: 1 })).toEqual({ ok: true, result: null });
    expect(await host.handle('projects.deleteTask', { projectId: 'site', taskId: task.id, revision: 1 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(host.data.projects[0]!.tasks.map((item) => item.id)).toEqual(['human']);
    expect(host.audit()).toEqual([{ action: 'record.delete', detail: { kind: 'task', projectId: 'site', recordId: task.id, title: 'Karar görevi' } }]);
  });

  it('protects the default and non-empty work packages and archives empty ones', async () => {
    const host = createMockHost({ fixtures: { projects: [project()] }, permissions: PERMISSIONS });
    const remove = (listId: string, revision = 1) => host.handle('projects.deleteList', { projectId: 'site', listId, revision });
    expect(await remove('todo')).toEqual({ ok: false, error: { code: 'forbidden_record', message: 'The default work package cannot be removed' } });
    expect(await remove('later')).toMatchObject({ ok: false, error: { code: 'forbidden_record' } });
    expect(await remove('parent')).toMatchObject({ ok: false, error: { code: 'forbidden_record' } });
    expect(await remove('child', 5)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await remove('child')).toEqual({ ok: true, result: null });
    expect(await remove('parent')).toEqual({ ok: true, result: null });
    expect(host.data.projects[0]!.lists.map((list) => list.id)).toEqual(['todo', 'later']);
    expect(host.audit()).toEqual([
      { action: 'record.delete_denied', detail: { kind: 'list', projectId: 'site', recordId: 'todo', reason: 'default_record' } },
      { action: 'record.delete_denied', detail: { kind: 'list', projectId: 'site', recordId: 'later', reason: 'not_empty' } },
      { action: 'record.delete_denied', detail: { kind: 'list', projectId: 'site', recordId: 'parent', reason: 'not_empty' } },
      { action: 'record.delete', detail: { kind: 'list', projectId: 'site', recordId: 'child', title: 'Alt' } },
      { action: 'record.delete', detail: { kind: 'list', projectId: 'site', recordId: 'parent', title: 'Üst' } },
    ]);
  });

  it('deletes only its own tasks when the admin requires it, and checks each permission', async () => {
    const host = createMockHost({ fixtures: { projects: [project()] }, permissions: PERMISSIONS, deleteOwnRecordsOnly: true, appId: 'com.example.a' });
    expect(await host.handle('projects.deleteTask', { projectId: 'site', taskId: 'human', revision: 1 })).toMatchObject({ ok: false, error: { code: 'forbidden_record' } });
    expect(await host.handle('projects.deleteList', { projectId: 'site', listId: 'child', revision: 1 })).toMatchObject({ ok: false, error: { code: 'forbidden_record' } });
    const own = (await host.handle('projects.createTask', { projectId: 'site', title: 'Benim' })) as unknown as { result: { id: string } };
    expect(await host.handle('projects.deleteTask', { projectId: 'site', taskId: own.result.id, revision: 1 })).toEqual({ ok: true, result: null });
    expect(host.audit().map((entry) => [entry.action, entry.detail.reason ?? null])).toEqual([
      ['record.delete_denied', 'not_created_by_app'],
      ['record.delete_denied', 'not_created_by_app'],
      ['record.delete', null],
    ]);

    const readOnly = createMockHost({ fixtures: { projects: [project()] }, permissions: ['projects:read'] });
    for (const [method, permission] of [
      ['projects.createTask', 'tasks:write'],
      ['projects.updateTask', 'tasks:write'],
      ['projects.deleteTask', 'tasks:delete'],
      ['projects.deleteList', 'projects:delete'],
    ] as const) {
      expect(await readOnly.handle(method, { projectId: 'site', taskId: 'human', listId: 'child', title: 'x', revision: 1 }), method).toEqual({
        ok: false,
        error: { code: 'permission_denied', message: `The app needs the ${permission} permission` },
      });
    }
    // projects:write still opens updateTask (apps written before tasks:write).
    const legacy = createMockHost({ fixtures: { projects: [project()] }, permissions: ['projects:write'] });
    expect(await legacy.handle('projects.updateTask', { projectId: 'site', taskId: 'human', status: 'completed', revision: 1 })).toMatchObject({ ok: true });
    expect(await legacy.handle('projects.deleteTask', { projectId: 'site', taskId: 'human', revision: 2 })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
  });
});

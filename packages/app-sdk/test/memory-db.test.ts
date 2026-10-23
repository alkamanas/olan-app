import { describe, expect, it } from 'vitest';

import { createMemoryDb, MemoryDbError, type MemoryDb } from '../src/memory-db';
import { DB_CONTRACT_SCHEMA, defineDbContractTests, type DbContractUser } from './db-contract';

const USERS: Record<DbContractUser, string> = { a: 'user-a', b: 'user-b' };

// The shared contract suite, against the in-memory implementation.
defineDbContractTests({ describe, it }, async ({ schema, quota }) => {
  const db = createMemoryDb({ data: schema, userId: USERS.a, ...(quota ? { quota } : {}) });
  const views: Record<DbContractUser, MemoryDb> = { a: db, b: db.as(USERS.b) };
  return { userIds: USERS, call: (user, method, params) => views[user].call(method, params) };
});

describe('createMemoryDb', () => {
  const clock = () => {
    let tick = Date.UTC(2026, 9, 17, 9, 0, 0);
    return () => new Date((tick += 1000));
  };

  it('seeds fixture rows with defaults and validates them', () => {
    const db = createMemoryDb({
      data: DB_CONTRACT_SCHEMA,
      userId: 'u1',
      now: () => '2026-10-17T09:00:00Z',
      rows: { decisions: [{ id: 'd1', data: { title: 'Seed', status: 'open' } }], pins: [{ data: { decisionId: 'd1' }, createdBy: 'u2' }] },
    });
    expect(db.get({ collection: 'decisions', id: 'd1' })).toEqual({
      id: 'd1', data: { title: 'Seed', status: 'open' }, revision: 1, createdAt: '2026-10-17T09:00:00.000Z', updatedAt: '2026-10-17T09:00:00.000Z', createdBy: 'u1',
    });
    // The u2 pin belongs to u2.
    expect(db.count({ collection: 'pins' })).toBe(0);
    expect(db.as('u2').count({ collection: 'pins' })).toBe(1);
    expect(db.rows('pins')[0]).toMatchObject({ collection: 'pins', ownerUserId: 'u2', createdBy: 'u2' });
    expect(Object.keys(db.snapshot())).toEqual(['decisions', 'secrets', 'pins']);
    expect(() => createMemoryDb({ data: DB_CONTRACT_SCHEMA, userId: 'u1', rows: { decisions: [{ data: {} }] } })).toThrow(/decisions\[0\]\.data\.title: row\.required/);
    expect(() => createMemoryDb({ data: DB_CONTRACT_SCHEMA, userId: 'u1', rows: { nope: [{ data: {} }] } })).toThrow(MemoryDbError);
  });

  it('reports usage and errors with codes', async () => {
    const db = createMemoryDb({ data: DB_CONTRACT_SCHEMA, userId: 'u1', quota: { rows: 1 }, now: clock() });
    db.insert({ collection: 'decisions', data: { title: 'x' } });
    expect(db.usage()).toMatchObject({ rows: 1, rowLimit: 1, byteLimit: 100 * 1024 * 1024 });
    expect(db.usage().bytes).toBe(JSON.stringify({ title: 'x' }).length);
    await expect(db.call('db.insert', { collection: 'decisions', data: { title: 'y' } })).rejects.toMatchObject({ code: 'quota_exceeded', limit: 'rows' });
    await expect(db.call('db.drop', {})).rejects.toMatchObject({ code: 'unknown_method' });
    await expect(db.call('db.get', null)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(createMemoryDb({ data: null, userId: 'u1' }).call('db.count', { collection: 'decisions' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notifies subscribers, resets and applies compatible schema changes', () => {
    const db = createMemoryDb({ data: DB_CONTRACT_SCHEMA, userId: 'u1', now: clock() });
    const changes: string[] = [];
    const stop = db.subscribe((change) => changes.push(change.type));
    const row = db.insert({ collection: 'decisions', data: { title: 'x' } });
    db.as('u2').update({ collection: 'decisions', id: row.id, patch: { title: 'y' }, revision: 1 });
    db.delete({ collection: 'decisions', id: row.id });
    db.reset({ decisions: [{ data: { title: 'fresh' } }] });
    expect(db.count({ collection: 'decisions' })).toBe(1);
    const bad = db.setSchema({ ...DB_CONTRACT_SCHEMA, version: 2, collections: { decisions: DB_CONTRACT_SCHEMA.collections.decisions! } });
    expect(bad.ok).toBe(false);
    expect(db.schema?.version).toBe(1);
    const next = { ...DB_CONTRACT_SCHEMA, version: 2, collections: { ...DB_CONTRACT_SCHEMA.collections, notes: { scope: 'user' as const, fields: { body: { type: 'string' as const } } } } };
    expect(db.setSchema(next)).toMatchObject({ ok: true, changed: true });
    expect(db.insert({ collection: 'notes', data: { body: 'hi' } }).data).toEqual({ body: 'hi' });
    stop();
    db.insert({ collection: 'notes', data: {} });
    expect(changes).toEqual(['insert', 'update', 'delete', 'reset', 'schema', 'insert']);
  });
});

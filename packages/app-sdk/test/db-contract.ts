/**
 * Shared contract tests for `olan.db` (Phase 1b contract §3.1, §8 "aynı sözleşme test paketi").
 *
 * The same assertions run against every implementation of the `db.*` semantics: the in-memory
 * database (`@olan-app/sdk/memory-db`, see `memory-db.test.ts`), the Platform server routes and
 * the CLI mock server. Each implementation provides a `CreateDbContractTarget`:
 *
 * ```ts
 * import { defineDbContractTests } from '@olan-app/sdk/db-contract';
 * import { describe, it } from 'vitest';               // or node:test
 * defineDbContractTests({ describe, it }, async ({ schema, quota }) => {
 *   // a fresh, empty database for `schema` (an installation with `data: schema`), two users
 *   return { userIds: { a, b }, call: (user, method, params) => …, dispose: () => … };
 * });
 * ```
 *
 * `call` must resolve with the RPC result (`DbRow`, `DbRow | null`, `{ rows, nextCursor }`,
 * `number`, `null`) and reject with an error whose `code` is the RPC error code (server: map the
 * HTTP error with the §3.2 table). Framework-agnostic: only `describe`/`it` are needed;
 * assertions use `node:assert/strict`.
 */
import assert from 'node:assert/strict';

import type { DataSchema, DbQueryResult, DbRow, JsonValue } from '@olan-app/schema';

export type DbContractUser = 'a' | 'b';
export type DbContractMethod = 'db.insert' | 'db.get' | 'db.query' | 'db.update' | 'db.delete' | 'db.count';

export interface DbContractTarget {
  /** The two signed-in users the suite acts as (both members of the same organization). */
  userIds: Record<DbContractUser, string>;
  /** Calls `method` as `user`; rejects with an error carrying the RPC `code`. */
  call(user: DbContractUser, method: DbContractMethod, params: Record<string, unknown>): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

export interface DbContractSetup {
  /** The manifest `data` of the installation under test (always `DB_CONTRACT_SCHEMA`). */
  schema: DataSchema;
  /** Quota override for this database (installation `db_row_limit` / `db_byte_limit`). */
  quota?: { rows?: number; bytes?: number };
}

export type CreateDbContractTarget = (setup: DbContractSetup) => Promise<DbContractTarget>;

export interface DbContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>, timeout?: number): void;
}

export interface DbContractOptions {
  /** Per-test timeout passed to `it` (default 30 s). */
  timeout?: number;
  /** Test names to leave out (report why in the caller). */
  skip?: readonly string[];
}

/** Schema every contract test installs. */
export const DB_CONTRACT_SCHEMA: DataSchema = Object.freeze({
  version: 1,
  collections: {
    decisions: {
      scope: 'organization',
      fields: {
        title: { type: 'string', required: true, maxLength: 200, indexed: true },
        status: { type: 'string', enum: ['open', 'done'], indexed: true },
        score: { type: 'number', integer: true, min: 0, max: 10, indexed: true },
        decidedOn: { type: 'date', indexed: true },
        at: { type: 'datetime', indexed: true },
        projectId: { type: 'ref:project' },
        note: { type: 'string', maxLength: 2000 },
        meta: { type: 'json' },
      },
    },
    secrets: {
      scope: 'organization',
      fields: { title: { type: 'string', required: true, maxLength: 100, indexed: true } },
      rules: { read: 'owner', update: 'owner', delete: 'owner' },
    },
    pins: {
      scope: 'user',
      fields: {
        decisionId: { type: 'string', required: true, maxLength: 64, indexed: true },
        starred: { type: 'boolean', indexed: true },
        projectId: { type: 'ref:project', indexed: true },
      },
    },
  },
}) as DataSchema;

const PROJECT_A = '6f1c1b1e-6d5a-4c8e-9a43-0b7f4c1f2a10';
const PROJECT_B = '0a7e4c38-1b2d-4f6e-8c9a-3d5e7f9a1b2c';

/**
 * Projects the suite stores in `ref:project` fields. Targets that check references (Phase 3 §9:
 * the referenced project must exist and be visible) must give both users access to them.
 */
export const DB_CONTRACT_PROJECT_IDS: readonly string[] = Object.freeze([PROJECT_A, PROJECT_B]);
const MISSING_ID = '3b9d6c0e-5a4f-4e2d-9c1b-7a8e6f5d4c3b';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Row = DbRow<Record<string, JsonValue>>;

async function rejectsWith(promise: Promise<unknown>, code: string, messagePrefix?: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected the call to fail with ${code}`);
  assert.equal((error as { code?: unknown }).code, code, `expected ${code}, got ${String((error as { code?: unknown }).code)}: ${String((error as Error).message)}`);
  if (messagePrefix !== undefined) assert.ok(String((error as Error).message).startsWith(messagePrefix), `message "${(error as Error).message}" should start with "${messagePrefix}"`);
}

function sortedBy(rows: Row[], key: (row: Row) => string | number, direction: 'asc' | 'desc') {
  for (let index = 1; index < rows.length; index += 1) {
    const [a, b] = [key(rows[index - 1]!), key(rows[index]!)];
    const ordered = direction === 'asc' ? a <= b : a >= b;
    assert.ok(ordered, `rows are not in ${direction} order at ${index}: ${String(a)} / ${String(b)}`);
  }
}

/** Registers the contract tests with `api.describe`/`api.it`. */
export function defineDbContractTests(api: DbContractTestApi, create: CreateDbContractTarget, options: DbContractOptions = {}): void {
  const timeout = options.timeout ?? 30_000;
  const test = (name: string, setup: Omit<DbContractSetup, 'schema'>, body: (db: DbContractTarget & { as: (user: DbContractUser) => Client }) => Promise<void>) => {
    if (options.skip?.includes(name)) return;
    api.it(
      name,
      async () => {
        const target = await create({ schema: DB_CONTRACT_SCHEMA, ...setup });
        try {
          await body({ ...target, as: (user) => client(target, user) });
        } finally {
          await target.dispose?.();
        }
      },
      timeout,
    );
  };

  api.describe('olan.db contract', () => {
    test('insert returns the stored row and get reads it back', {}, async (db) => {
      const a = db.as('a');
      const row = await a.insert('decisions', {
        title: 'Ship it',
        status: 'open',
        score: 7,
        decidedOn: '2026-10-17',
        at: '2026-10-17T12:30:00+03:00',
        projectId: PROJECT_A.toUpperCase(),
        note: null,
        meta: { tags: ['a', 'b'], n: 1 },
      });
      assert.equal(typeof row.id, 'string');
      assert.ok(row.id.length > 0);
      assert.equal(row.revision, 1);
      assert.equal(row.createdBy, db.userIds.a);
      assert.match(row.createdAt, ISO);
      assert.equal(row.updatedAt, row.createdAt);
      // datetime → UTC toISOString, ref UUID → lower case, null → not stored.
      assert.deepEqual(row.data, {
        title: 'Ship it',
        status: 'open',
        score: 7,
        decidedOn: '2026-10-17',
        at: '2026-10-17T09:30:00.000Z',
        projectId: PROJECT_A,
        meta: { tags: ['a', 'b'], n: 1 },
      });
      assert.deepEqual(await a.get('decisions', row.id), row);
      assert.equal(await a.get('decisions', MISSING_ID), null);
    });

    test('insert validates rows (validation_failed, "data.<field>: row.<code>")', {}, async (db) => {
      const a = db.as('a');
      await rejectsWith(a.insert('decisions', {}), 'validation_failed', 'data.title: row.required');
      await rejectsWith(a.insert('decisions', { title: 'x', extra: 1 }), 'validation_failed', 'data.extra: row.unknown_field');
      await rejectsWith(a.insert('decisions', { title: 1 }), 'validation_failed', 'data.title: row.type');
      await rejectsWith(a.insert('decisions', { title: 'x'.repeat(201) }), 'validation_failed', 'data.title: row.max_length');
      await rejectsWith(a.insert('decisions', { title: 'x', status: 'later' }), 'validation_failed', 'data.status: row.enum');
      await rejectsWith(a.insert('decisions', { title: 'x', score: 11 }), 'validation_failed', 'data.score: row.range');
      await rejectsWith(a.insert('decisions', { title: 'x', score: 2.5 }), 'validation_failed', 'data.score: row.not_integer');
      await rejectsWith(a.insert('decisions', { title: 'x', decidedOn: '2026-02-30' }), 'validation_failed', 'data.decidedOn: row.type');
      await rejectsWith(a.insert('decisions', { title: 'x', at: '2026-10-17T10:00:00' }), 'validation_failed', 'data.at: row.type');
      await rejectsWith(a.insert('decisions', { title: 'x', projectId: 'p1' }), 'validation_failed', 'data.projectId: row.type');
      await rejectsWith(a.insert('decisions', { title: 'x', meta: { s: 'x'.repeat(17 * 1024) } }), 'validation_failed', 'data.meta: row.json_too_large');
      assert.equal(await a.count('decisions'), 0);
    });

    test('unknown collections and bad parameters are invalid_params', {}, async (db) => {
      const a = db.as('a');
      await rejectsWith(a.insert('nope', { title: 'x' }), 'invalid_params');
      await rejectsWith(a.query('nope'), 'invalid_params');
      await rejectsWith(a.count('nope'), 'invalid_params');
      const row = await a.insert('decisions', { title: 'x' });
      await rejectsWith(db.call('a', 'db.update', { collection: 'decisions', id: row.id, patch: { title: 'y' } }), 'invalid_params');
    });

    test('update merges the patch, bumps revision and detects conflicts', {}, async (db) => {
      const a = db.as('a');
      const row = await a.insert('decisions', { title: 'Draft', status: 'open', score: 3 });
      const updated = await a.update('decisions', row.id, { status: 'done', score: null }, row.revision);
      assert.equal(updated.id, row.id);
      assert.equal(updated.revision, 2);
      assert.equal(updated.createdAt, row.createdAt);
      assert.ok(updated.updatedAt >= row.updatedAt);
      assert.deepEqual(updated.data, { title: 'Draft', status: 'done' });
      assert.deepEqual(await a.get('decisions', row.id), updated);
      await rejectsWith(a.update('decisions', row.id, { title: 'Stale' }, row.revision), 'conflict');
      await rejectsWith(a.update('decisions', row.id, { title: null }, updated.revision), 'validation_failed', 'data.title: row.required');
      await rejectsWith(a.update('decisions', row.id, { color: 'red' }, updated.revision), 'validation_failed', 'data.color: row.unknown_field');
      await rejectsWith(a.update('decisions', MISSING_ID, { title: 'x' }, 1), 'not_found');
      assert.equal((await a.get('decisions', row.id))?.revision, 2);
    });

    test('delete checks the optional revision and removes the row', {}, async (db) => {
      const a = db.as('a');
      const row = await a.insert('decisions', { title: 'Gone soon' });
      await rejectsWith(a.delete('decisions', row.id, row.revision + 1), 'conflict');
      assert.equal(await a.delete('decisions', row.id, row.revision), null);
      assert.equal(await a.get('decisions', row.id), null);
      await rejectsWith(a.delete('decisions', row.id), 'not_found');
      await rejectsWith(a.update('decisions', row.id, { title: 'x' }, 1), 'not_found');
      const other = await a.insert('decisions', { title: 'No revision' });
      assert.equal(await a.delete('decisions', other.id), null);
      assert.equal(await a.count('decisions'), 0);
    });

    test('query filters on indexed fields with eq, in, ranges and null', {}, async (db) => {
      const a = db.as('a');
      const seed: Record<string, JsonValue>[] = [
        { title: 'alpha', status: 'open', score: 1, decidedOn: '2026-01-10' },
        { title: 'beta', status: 'done', score: 5, decidedOn: '2026-02-10' },
        { title: 'gamma', status: 'open', score: 9, at: '2026-03-01T00:00:00Z' },
        { title: 'delta', score: 5 },
      ];
      for (const data of seed) await a.insert('decisions', data);
      const titles = async (where: Record<string, unknown>) =>
        (await a.query('decisions', { where, orderBy: { field: 'title', direction: 'asc' } })).rows.map((row) => row.data.title);
      assert.deepEqual(await titles({ status: 'open' }), ['alpha', 'gamma']);
      assert.deepEqual(await titles({ status: { eq: 'done' } }), ['beta']);
      assert.deepEqual(await titles({ status: { in: ['done', null] } }), ['beta', 'delta']);
      assert.deepEqual(await titles({ status: null }), ['delta']);
      assert.deepEqual(await titles({ score: { gte: 5 } }), ['beta', 'delta', 'gamma']);
      assert.deepEqual(await titles({ score: { gt: 1, lt: 9 } }), ['beta', 'delta']);
      assert.deepEqual(await titles({ score: 5, status: 'done' }), ['beta']);
      assert.deepEqual(await titles({ decidedOn: { lt: '2026-02-01' } }), ['alpha']);
      assert.deepEqual(await titles({ at: { gte: '2026-03-01T03:00:00+03:00' } }), ['gamma']);
      assert.deepEqual(await titles({ title: { gte: 'b', lt: 'e' } }), ['beta', 'delta']);
      assert.deepEqual(await titles({ createdBy: db.userIds.a }), ['alpha', 'beta', 'delta', 'gamma']);
      assert.deepEqual(await titles({ createdBy: db.userIds.b }), []);
      assert.equal(await a.count('decisions', { score: 5 }), 2);
      assert.equal(await a.count('decisions'), 4);
    });

    test('query rejects what the contract forbids (invalid_params)', {}, async (db) => {
      const a = db.as('a');
      await rejectsWith(a.query('decisions', { where: { note: 'x' } }), 'invalid_params'); // not indexed
      await rejectsWith(a.query('decisions', { where: { meta: 1 } }), 'invalid_params');
      await rejectsWith(a.query('decisions', { where: { score: 'high' } }), 'invalid_params'); // wrong type
      await rejectsWith(a.query('decisions', { where: { createdBy: { gt: 'a' } } }), 'invalid_params'); // eq/in only
      await rejectsWith(a.query('decisions', { orderBy: { field: 'note' } }), 'invalid_params');
      await rejectsWith(a.query('decisions', { limit: 0 }), 'invalid_params');
      await rejectsWith(a.query('decisions', { limit: 101 }), 'invalid_params');
      await rejectsWith(a.query('pins', { where: { starred: { gt: false } } }), 'invalid_params');
      await rejectsWith(a.query('pins', { where: { projectId: { lt: PROJECT_A } } }), 'invalid_params');
      await rejectsWith(a.count('decisions', { note: 'x' }), 'invalid_params');
    });

    test('orderBy sorts by one field, rows without a value last, default createdAt desc', {}, async (db) => {
      const a = db.as('a');
      for (const [title, score] of [['a', 3], ['b', null], ['c', 1], ['d', 3], ['e', 10]] as const) {
        await a.insert('decisions', score === null ? { title } : { title, score });
      }
      const asc = (await a.query('decisions', { orderBy: { field: 'score', direction: 'asc' } })).rows;
      assert.deepEqual(asc.map((row) => row.data.score ?? null), [1, 3, 3, 10, null]);
      const desc = (await a.query('decisions', { orderBy: { field: 'score', direction: 'desc' } })).rows;
      assert.deepEqual(desc.map((row) => row.data.score ?? null), [10, 3, 3, 1, null]);
      // Ties break on id in the sort direction.
      const ties = asc.filter((row) => row.data.score === 3).map((row) => row.id);
      assert.deepEqual(ties, [...ties].sort());
      const all = (await a.query('decisions')).rows;
      assert.equal(all.length, 5);
      sortedBy(all, (row) => `${row.createdAt}|${row.id}`, 'desc');
      const byTitle = (await a.query('decisions', { orderBy: { field: 'title' } })).rows.map((row) => row.data.title);
      assert.deepEqual(byTitle, ['a', 'b', 'c', 'd', 'e']);
    });

    test('cursor pagination walks every row once and is bound to its query', {}, async (db) => {
      const a = db.as('a');
      for (let index = 0; index < 7; index += 1) await a.insert('decisions', { title: `t${index}`, score: index % 3 });
      const query = { where: { score: { gte: 0 } }, orderBy: { field: 'score', direction: 'asc' as const }, limit: 3 };
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: DbQueryResult = await a.query('decisions', { ...query, ...(cursor ? { cursor } : {}) });
        assert.ok(page.rows.length <= 3);
        seen.push(...page.rows.map((row) => row.id));
        cursor = page.nextCursor;
        if (cursor !== null) assert.ok(cursor.length > 0 && cursor.length <= 512);
        pages += 1;
      } while (cursor && pages < 10);
      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 7);
      const first = await a.query('decisions', query);
      assert.ok(first.nextCursor);
      await rejectsWith(a.query('decisions', { ...query, where: { score: { gte: 1 } }, cursor: first.nextCursor }), 'invalid_params');
      await rejectsWith(a.query('decisions', { ...query, orderBy: { field: 'title' }, cursor: first.nextCursor }), 'invalid_params');
      await rejectsWith(a.query('decisions', { ...query, cursor: 'not-a-cursor' }), 'invalid_params');
      const last = await a.query('decisions', { limit: 100 });
      assert.equal(last.nextCursor, null);
    });

    test('user collections are private to their owner', {}, async (db) => {
      const a = db.as('a');
      const b = db.as('b');
      const pin = await a.insert('pins', { decisionId: 'd1', starred: true, projectId: PROJECT_A });
      assert.equal(pin.createdBy, db.userIds.a);
      assert.equal(await b.get('pins', pin.id), null);
      assert.deepEqual((await b.query('pins')).rows, []);
      assert.equal(await b.count('pins'), 0);
      await rejectsWith(b.update('pins', pin.id, { starred: false }, pin.revision), 'not_found');
      await rejectsWith(b.delete('pins', pin.id), 'not_found');
      const own = await b.insert('pins', { decisionId: 'd1', starred: false, projectId: PROJECT_B });
      assert.deepEqual((await a.query('pins', { where: { decisionId: 'd1' } })).rows.map((row) => row.id), [pin.id]);
      assert.deepEqual((await b.query('pins', { where: { starred: false } })).rows.map((row) => row.id), [own.id]);
      assert.deepEqual((await a.query('pins', { where: { projectId: { in: [PROJECT_A.toUpperCase()] } } })).rows.map((row) => row.id), [pin.id]);
      assert.equal(await a.count('pins'), 1);
    });

    test('organization rules: default read/update any, delete owner', {}, async (db) => {
      const a = db.as('a');
      const b = db.as('b');
      const row = await a.insert('decisions', { title: 'Shared' });
      assert.deepEqual(await b.get('decisions', row.id), row);
      assert.equal(await b.count('decisions'), 1);
      const changed = await b.update('decisions', row.id, { status: 'done' }, row.revision);
      assert.equal(changed.createdBy, db.userIds.a);
      await rejectsWith(b.delete('decisions', row.id), 'forbidden_record');
      assert.equal(await a.delete('decisions', row.id, changed.revision), null);
    });

    test('organization rules: owner-only rows are hidden and protected', {}, async (db) => {
      const a = db.as('a');
      const b = db.as('b');
      const secret = await a.insert('secrets', { title: 'Mine' });
      assert.equal(await b.get('secrets', secret.id), null);
      assert.deepEqual((await b.query('secrets')).rows, []);
      assert.equal(await b.count('secrets'), 0);
      await rejectsWith(b.update('secrets', secret.id, { title: 'Theirs' }, secret.revision), 'forbidden_record');
      await rejectsWith(b.delete('secrets', secret.id), 'forbidden_record');
      const theirs = await b.insert('secrets', { title: 'Theirs' });
      assert.deepEqual((await a.query('secrets')).rows.map((row) => row.id), [secret.id]);
      assert.deepEqual((await b.query('secrets')).rows.map((row) => row.id), [theirs.id]);
    });

    test('row quota: quota_exceeded until rows are deleted', { quota: { rows: 3 } }, async (db) => {
      const a = db.as('a');
      const b = db.as('b');
      const first = await a.insert('decisions', { title: '1' });
      await a.insert('pins', { decisionId: first.id });
      await b.insert('pins', { decisionId: first.id });
      // The quota covers the whole installation: every collection and every user.
      await rejectsWith(a.insert('decisions', { title: '4' }), 'quota_exceeded');
      await rejectsWith(b.insert('pins', { decisionId: 'x' }), 'quota_exceeded');
      assert.ok(await a.update('decisions', first.id, { title: 'one' }, first.revision));
      await a.delete('decisions', first.id);
      assert.ok(await a.insert('decisions', { title: '4' }));
    });

    test('byte quota: quota_exceeded for inserts and growing updates', { quota: { bytes: 1000 } }, async (db) => {
      const a = db.as('a');
      const note = 'n'.repeat(400);
      const first = await a.insert('decisions', { title: 'a', note });
      await a.insert('decisions', { title: 'b', note });
      await rejectsWith(a.insert('decisions', { title: 'c', note }), 'quota_exceeded');
      await rejectsWith(a.update('decisions', first.id, { note: 'n'.repeat(800) }, first.revision), 'quota_exceeded');
      const smaller = await a.update('decisions', first.id, { note: 'short' }, first.revision);
      assert.equal(smaller.revision, 2);
      assert.ok(await a.insert('decisions', { title: 'c', note }));
    });
  });
}

/** Typed helpers over `target.call` for one user. */
export interface Client {
  insert(collection: string, data: Record<string, JsonValue>): Promise<Row>;
  get(collection: string, id: string): Promise<Row | null>;
  query(collection: string, query?: Record<string, unknown>): Promise<{ rows: Row[]; nextCursor: string | null }>;
  update(collection: string, id: string, patch: Record<string, JsonValue>, revision: number): Promise<Row>;
  delete(collection: string, id: string, revision?: number): Promise<unknown>;
  count(collection: string, where?: Record<string, unknown>): Promise<number>;
}

export function client(target: DbContractTarget, user: DbContractUser): Client {
  const call = (method: DbContractMethod, params: Record<string, unknown>) => target.call(user, method, params);
  return {
    insert: (collection, data) => call('db.insert', { collection, data }) as Promise<Row>,
    get: (collection, id) => call('db.get', { collection, id }) as Promise<Row | null>,
    query: (collection, query = {}) => call('db.query', { collection, ...query }) as Promise<{ rows: Row[]; nextCursor: string | null }>,
    update: (collection, id, patch, revision) => call('db.update', { collection, id, patch, revision }) as Promise<Row>,
    delete: (collection, id, revision) => call('db.delete', { collection, id, ...(revision === undefined ? {} : { revision }) }),
    count: (collection, where) => call('db.count', { collection, ...(where === undefined ? {} : { where }) }) as Promise<number>,
  };
}

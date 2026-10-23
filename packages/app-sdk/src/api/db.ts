import type { JsonValue } from '../protocol';
import { OlanError, rpc } from './rpc-client';
import type { DbQuery, DbRow, DbWhere } from './types';

/*
 * `olan.db`: the app's own database (Phase 1b contract §3.1, §5). Collections are declared in the
 * manifest's `data`; every call needs the `db` permission. There are no live subscriptions:
 * mutations made through `olan.db` in this sandbox notify the hooks that read the same collection
 * (`useCollection`, `useRecord`); changes by other people arrive with `refetch`.
 */

/**
 * Row data of a collection. Any object type works (interfaces too); values must be JSON. Fields
 * that are not `required` in the manifest should be optional in `T`.
 */
export type DbData = object;

/** Update patch: shallow merge, `null` clears a field (clearing a required field fails). */
export type DbPatch<T> = { [K in keyof T]?: T[K] | null };

export interface DbCollection<T extends DbData = Record<string, JsonValue>> {
  readonly name: string;
  /** Adds a row; `data` is the whole row. Returns it with `id`, `revision` 1 and timestamps. */
  insert(data: T): Promise<DbRow<T>>;
  /** The row, or `null` when it does not exist or the collection's rules hide it. */
  get(id: string): Promise<DbRow<T> | null>;
  /** Rows matching `where` (indexed fields only), `orderBy` one indexed field; pages of `limit` (≤ 100). */
  query(query?: DbQuery): Promise<{ rows: DbRow<T>[]; nextCursor: string | null }>;
  /** Shallow-merges `patch`; `revision` must be the row's current one (else `conflict`). */
  update(id: string, patch: DbPatch<T>, options: { revision: number }): Promise<DbRow<T>>;
  /** Deletes the row; with `revision` only if it is still that revision (else `conflict`). */
  delete(id: string, options?: { revision?: number }): Promise<void>;
  /** Number of rows matching `where`. */
  count(where?: DbWhere): Promise<number>;
}

export type DbChangeKind = 'insert' | 'update' | 'delete';
export interface DbChange {
  collection: string;
  kind: DbChangeKind;
  id: string;
}
type DbListener = (change: DbChange) => void;

const listeners = new Map<string, Set<DbListener>>();

/** Subscribes to mutations this sandbox makes through `olan.db.collection(name)`. */
export function subscribeDbChanges(collection: string, listener: DbListener): () => void {
  let set = listeners.get(collection);
  if (!set) {
    set = new Set();
    listeners.set(collection, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(collection) === set) listeners.delete(collection);
  };
}

function notify(change: DbChange) {
  for (const listener of [...(listeners.get(change.collection) ?? [])]) {
    try {
      listener(change);
    } catch {
      // A failing listener must not fail the mutation that already succeeded.
    }
  }
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) throw new OlanError('invalid_params', 'olan.db.collection needs a collection name');
  return name;
}

function collection<T extends DbData = Record<string, JsonValue>>(name: string): DbCollection<T> {
  const collectionName = requireName(name);
  const data = (value: unknown) => value as Record<string, JsonValue>;
  return Object.freeze({
    name: collectionName,
    async insert(row: T) {
      const result = await rpc('db.insert', { collection: collectionName, data: data(row) });
      notify({ collection: collectionName, kind: 'insert', id: result.id });
      return result as unknown as DbRow<T>;
    },
    async get(id: string) {
      return (await rpc('db.get', { collection: collectionName, id })) as unknown as DbRow<T> | null;
    },
    async query(query: DbQuery = {}) {
      const result = await rpc('db.query', { collection: collectionName, ...query });
      return result as unknown as { rows: DbRow<T>[]; nextCursor: string | null };
    },
    async update(id: string, patch: DbPatch<T>, options: { revision: number }) {
      const result = await rpc('db.update', { collection: collectionName, id, patch: data(patch), revision: options?.revision });
      notify({ collection: collectionName, kind: 'update', id });
      return result as unknown as DbRow<T>;
    },
    async delete(id: string, options: { revision?: number } = {}) {
      await rpc('db.delete', { collection: collectionName, id, ...(options.revision === undefined ? {} : { revision: options.revision }) });
      notify({ collection: collectionName, kind: 'delete', id });
    },
    async count(where?: DbWhere) {
      return rpc('db.count', { collection: collectionName, ...(where === undefined ? {} : { where }) });
    },
  });
}

export const db = Object.freeze({
  /** A handle on a collection declared in the manifest's `data.collections`. Needs `db`. */
  collection,
});

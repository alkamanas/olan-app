/**
 * `@olan-app/sdk/memory-db`: the app database (`olan.db`) in memory (Phase 1b contract §3.1, §5).
 *
 * Plain TypeScript (Node, browsers, React Native). It applies the same rules, row validation,
 * query semantics, cursors, quota and error codes as the Olan server, using the shared
 * validators from `@olan-app/schema`. The CLI mock server, Studio's local environment and the
 * web host's development preview use it; `test/db-contract.ts` runs the same assertions against
 * it and against the server.
 *
 * Not for the app bundle: it imports `@olan-app/schema` (zod) at run time.
 */
import {
  DATA_LIMITS,
  applyRowPatch,
  compareDataSchemas,
  effectiveRules,
  jsonByteSize,
  normalizeDbDatetime,
  rowIssueMessage,
  validateDbQuery,
  validateRow,
  compareDbValues,
  matchesDbCondition,
  type CollectionSchema,
  type CompareDataSchemasResult,
  type DataSchema,
  type DbQueryResult,
  type DbRow,
  type DbScalar,
  type JsonValue,
  type NormalizedDbQuery,
  type RowIssue,
  type RpcErrorCode,
} from '@olan-app/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row as stored: the wire row plus its collection and owner (`user` collections). */
export interface StoredDbRow extends DbRow {
  collection: string;
  /** Owner of a row in a `user` collection (its creator); null in `organization` collections. */
  ownerUserId: string | null;
}

/** Seed row (fixtures): missing fields get defaults (`createdBy` = the database's user, times = `now`). */
export interface MemoryDbSeedRow {
  id?: string;
  data: Record<string, JsonValue>;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
}

export type MemoryDbSeed = Record<string, readonly MemoryDbSeedRow[]>;

export interface MemoryDbQuota {
  /** Default 100 000 (policy `db_row_limit`). */
  rows?: number;
  /** Default 100 MiB (policy `db_byte_limit`); rows are measured as UTF-8 JSON (`jsonByteSize`). */
  bytes?: number;
}

export interface MemoryDbOptions {
  /** The manifest's `data` section; without it every call fails with `invalid_params`. */
  data: DataSchema | null | undefined;
  /** The signed-in user (`createdBy`, owner of `user` rows, `owner` rules). */
  userId: string;
  /** Clock for timestamps; default `new Date()`. */
  now?: () => Date | string | number;
  quota?: MemoryDbQuota;
  /** Initial rows per collection. Invalid rows throw `MemoryDbError` (`validation_failed`). */
  rows?: MemoryDbSeed;
  /** Row id generator; default UUID v4. */
  generateId?: () => string;
}

export interface MemoryDbUsage {
  rows: number;
  bytes: number;
  rowLimit: number;
  byteLimit: number;
}

export type MemoryDbChange =
  | { type: 'insert' | 'update' | 'delete'; collection: string; id: string; userId: string }
  | { type: 'reset' | 'schema' };

/** Error of a `db.*` call; `code` is the RPC error code the host returns to the app. */
export class MemoryDbError extends Error {
  readonly code: RpcErrorCode;
  /** `validation_failed`: every row issue. */
  readonly issues?: RowIssue[];
  /** `quota_exceeded`: which limit. */
  readonly limit?: 'rows' | 'bytes';

  constructor(code: RpcErrorCode, message: string, extra: { issues?: RowIssue[]; limit?: 'rows' | 'bytes' } = {}) {
    super(message);
    this.name = 'MemoryDbError';
    this.code = code;
    if (extra.issues) this.issues = extra.issues;
    if (extra.limit) this.limit = extra.limit;
  }
}

export function isMemoryDbError(error: unknown): error is MemoryDbError {
  return error instanceof MemoryDbError;
}

export const DB_METHODS = ['db.insert', 'db.get', 'db.query', 'db.update', 'db.delete', 'db.count'] as const;
export type DbMethod = (typeof DB_METHODS)[number];

export function isDbMethod(method: unknown): method is DbMethod {
  return typeof method === 'string' && (DB_METHODS as readonly string[]).includes(method);
}

export interface MemoryDb {
  /** The user this view acts as. */
  readonly userId: string;
  /** The current data schema (null when the manifest has no `data`). */
  readonly schema: DataSchema | null;
  insert(params: { collection: string; data: unknown }): DbRow;
  get(params: { collection: string; id: string }): DbRow | null;
  query(params: { collection: string; where?: unknown; orderBy?: unknown; limit?: unknown; cursor?: unknown }): DbQueryResult;
  update(params: { collection: string; id: string; patch: unknown; revision: unknown }): DbRow;
  delete(params: { collection: string; id: string; revision?: unknown }): null;
  count(params: { collection: string; where?: unknown }): number;
  /**
   * Runs an RPC `db.*` call (`params` as the sandbox sent them). Resolves with the JSON result or
   * rejects with `MemoryDbError`; other methods reject with `unknown_method`. Results are copies.
   */
  call(method: string, params: unknown): Promise<JsonValue>;
  /** The same database seen by another user (user isolation, `owner` rules). */
  as(userId: string): MemoryDb;
  /** Every stored row (all users), oldest first; for Studio, exports and tests. Copies. */
  rows(collection?: string): StoredDbRow[];
  /** Rows per declared collection (all users), oldest first, as wire rows. Copies. */
  snapshot(): Record<string, DbRow[]>;
  usage(): MemoryDbUsage;
  /** Replaces all rows with `rows` (fixtures); quota is not enforced for seeds. */
  reset(rows?: MemoryDbSeed): void;
  /**
   * Switches to a new manifest `data` (Studio rebuilds). Applies when `compareDataSchemas` is ok
   * (rows stay; new collections start empty) and returns the comparison either way.
   */
  setSchema(next: DataSchema | null | undefined): CompareDataSchemasResult;
  /** Listens to changes from every view of this database (Studio data panel). */
  subscribe(listener: (change: MemoryDbChange) => void): () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function uuidV4(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** FNV-1a 32-bit, hex: binds a cursor to its query without putting the query in the cursor. */
function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toIso(value: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return normalizeDbDatetime(value) ?? new Date(value).toISOString();
}

interface SortKey {
  missing: boolean;
  value: DbScalar;
  id: string;
}

function sortValue(row: StoredDbRow, field: string): DbScalar | undefined {
  if (field === 'createdAt' || field === 'updatedAt' || field === 'createdBy') return row[field];
  const value = row.data[field];
  return value === undefined || value === null || typeof value === 'object' ? undefined : value;
}

function sortKey(row: StoredDbRow, field: string): SortKey {
  const value = sortValue(row, field);
  return { missing: value === undefined, value: value ?? null, id: row.id };
}

/** Rows without a value sort last in both directions; ties break on `id` in the same direction. */
function compareKeys(a: SortKey, b: SortKey, direction: 'asc' | 'desc'): number {
  if (a.missing !== b.missing) return a.missing ? 1 : -1;
  const sign = direction === 'asc' ? 1 : -1;
  if (!a.missing) {
    const diff = compareDbValues(a.value, b.value);
    if (diff !== 0) return diff * sign;
  }
  const idDiff = compareDbValues(a.id, b.id);
  return idDiff * sign;
}

const CURSOR_PREFIX = 'm1.';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Store {
  schema: DataSchema | null;
  rows: Map<string, StoredDbRow>;
  /** Anchors of issued cursors: `${hash}.${id}` → sort key of the last row of the page. */
  anchors: Map<string, SortKey>;
  quota: { rows: number; bytes: number };
  bytes: number;
  now: () => string;
  generateId: () => string;
  listeners: Set<(change: MemoryDbChange) => void>;
}

const MAX_ANCHORS = 2000;

function emit(store: Store, change: MemoryDbChange) {
  for (const listener of [...store.listeners]) {
    try {
      listener(change);
    } catch {
      // Listeners (UI panels) must not break the database.
    }
  }
}

function collectionOf(store: Store, name: unknown): CollectionSchema {
  if (!store.schema) throw new MemoryDbError('invalid_params', 'The app declares no data collections (manifest "data")');
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(store.schema.collections, name)) {
    throw new MemoryDbError('invalid_params', `Unknown collection ${JSON.stringify(name)}`);
  }
  return store.schema.collections[name]!;
}

function requireId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) throw new MemoryDbError('invalid_params', 'id must be a non-empty string');
  return id;
}

function requireRevision(revision: unknown, optional: boolean): number | undefined {
  if (revision === undefined || revision === null) {
    if (optional) return undefined;
    throw new MemoryDbError('invalid_params', 'revision is required');
  }
  if (!Number.isInteger(revision) || (revision as number) < 1) throw new MemoryDbError('invalid_params', 'revision must be a positive integer');
  return revision as number;
}

function wire(row: StoredDbRow): DbRow {
  return copy({ id: row.id, data: row.data, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, createdBy: row.createdBy });
}

function seedStore(store: Store, seed: MemoryDbSeed | undefined, userId: string) {
  store.rows.clear();
  store.anchors.clear();
  store.bytes = 0;
  if (!seed) return;
  for (const [name, rows] of Object.entries(seed)) {
    const collection = collectionOf(store, name);
    rows.forEach((seedRow, index) => {
      const checked = validateRow(collection, seedRow.data);
      if (!checked.ok) throw new MemoryDbError('validation_failed', `${name}[${index}].${rowIssueMessage(checked.issues)}`, { issues: checked.issues });
      const id = seedRow.id ?? store.generateId();
      if (store.rows.has(id)) throw new MemoryDbError('invalid_params', `${name}[${index}]: duplicate row id ${JSON.stringify(id)}`);
      const createdAt = seedRow.createdAt ? toIso(seedRow.createdAt) : store.now();
      const createdBy = seedRow.createdBy ?? userId;
      const row: StoredDbRow = {
        id,
        collection: name,
        ownerUserId: collection.scope === 'user' ? createdBy : null,
        data: checked.data,
        revision: seedRow.revision ?? 1,
        createdAt,
        updatedAt: seedRow.updatedAt ? toIso(seedRow.updatedAt) : createdAt,
        createdBy,
      };
      store.rows.set(id, row);
      store.bytes += jsonByteSize(row.data);
    });
  }
}

function createView(store: Store, userId: string): MemoryDb {
  /** The row if it exists in this user's part of the collection (user scope: own rows only). */
  const find = (name: string, collection: CollectionSchema, id: string): StoredDbRow | undefined => {
    const row = store.rows.get(id);
    if (!row || row.collection !== name) return undefined;
    if (collection.scope === 'user' && row.ownerUserId !== userId) return undefined;
    return row;
  };
  const readable = (collection: CollectionSchema, row: StoredDbRow) =>
    collection.scope === 'user' ? row.ownerUserId === userId : effectiveRules(collection).read === 'any' || row.createdBy === userId;
  const allowed = (collection: CollectionSchema, row: StoredDbRow, action: 'update' | 'delete') =>
    readable(collection, row) && (collection.scope === 'user' || effectiveRules(collection)[action] === 'any' || row.createdBy === userId);
  const visibleRows = (name: string, collection: CollectionSchema) =>
    [...store.rows.values()].filter((row) => row.collection === name && readable(collection, row));
  const matching = (name: string, collection: CollectionSchema, query: NormalizedDbQuery) =>
    visibleRows(name, collection).filter((row) => query.where.every((condition) => matchesDbCondition(sortValue(row, condition.field), condition)));
  const parsedQuery = (collection: CollectionSchema, params: Record<string, unknown>) => {
    const result = validateDbQuery(collection, params);
    if (!result.ok) throw new MemoryDbError('invalid_params', result.message);
    return result.query;
  };
  const checkQuota = (rowDelta: number, byteDelta: number) => {
    if (rowDelta > 0 && store.rows.size + rowDelta > store.quota.rows) {
      throw new MemoryDbError('quota_exceeded', `The app database is full: rows (limit ${store.quota.rows})`, { limit: 'rows' });
    }
    if (byteDelta > 0 && store.bytes + byteDelta > store.quota.bytes) {
      throw new MemoryDbError('quota_exceeded', `The app database is full: bytes (limit ${store.quota.bytes})`, { limit: 'bytes' });
    }
  };

  const view: MemoryDb = {
    userId,
    get schema() {
      return store.schema;
    },

    insert(params) {
      const name = params?.collection;
      const collection = collectionOf(store, name);
      const checked = validateRow(collection, params.data);
      if (!checked.ok) throw new MemoryDbError('validation_failed', rowIssueMessage(checked.issues), { issues: checked.issues });
      const bytes = jsonByteSize(checked.data);
      checkQuota(1, bytes);
      const now = store.now();
      let id = store.generateId();
      while (store.rows.has(id)) id = store.generateId();
      const row: StoredDbRow = {
        id,
        collection: name,
        ownerUserId: collection.scope === 'user' ? userId : null,
        data: checked.data,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
      };
      store.rows.set(id, row);
      store.bytes += bytes;
      emit(store, { type: 'insert', collection: name, id, userId });
      return wire(row);
    },

    get(params) {
      const collection = collectionOf(store, params?.collection);
      const id = requireId(params.id);
      const row = find(params.collection, collection, id);
      return row && readable(collection, row) ? wire(row) : null;
    },

    query(params) {
      const name = params?.collection;
      const collection = collectionOf(store, name);
      const query = parsedQuery(collection, params);
      const hash = hashKey(query.key);
      const { field, direction } = query.orderBy;
      let rows = matching(name, collection, query).sort((a, b) => compareKeys(sortKey(a, field), sortKey(b, field), direction));
      if (query.cursor !== null) {
        const parts = query.cursor.startsWith(CURSOR_PREFIX) ? query.cursor.slice(CURSOR_PREFIX.length).split('.') : [];
        const anchor = parts.length === 2 && parts[0] === hash ? store.anchors.get(`${hash}.${parts[1]}`) : undefined;
        if (!anchor) throw new MemoryDbError('invalid_params', 'cursor does not belong to this query (same collection, where and orderBy)');
        rows = rows.filter((row) => compareKeys(sortKey(row, field), anchor, direction) > 0);
      }
      const page = rows.slice(0, query.limit);
      let nextCursor: string | null = null;
      if (rows.length > query.limit) {
        const last = page[page.length - 1]!;
        const anchorId = `${hash}.${last.id}`;
        store.anchors.set(anchorId, sortKey(last, field));
        if (store.anchors.size > MAX_ANCHORS) store.anchors.delete(store.anchors.keys().next().value!);
        nextCursor = `${CURSOR_PREFIX}${anchorId}`;
      }
      return { rows: page.map(wire), nextCursor };
    },

    update(params) {
      const name = params?.collection;
      const collection = collectionOf(store, name);
      const id = requireId(params.id);
      const revision = requireRevision(params.revision, false)!;
      const patch = validateRow(collection, params.patch, { partial: true });
      if (!patch.ok) throw new MemoryDbError('validation_failed', rowIssueMessage(patch.issues), { issues: patch.issues });
      const row = find(name, collection, id);
      if (!row) throw new MemoryDbError('not_found', `No row ${id} in ${name}`);
      if (!allowed(collection, row, 'update')) throw new MemoryDbError('forbidden_record', `The collection's rules do not let this user change row ${id}`);
      if (row.revision !== revision) throw new MemoryDbError('conflict', `Row ${id} is at revision ${row.revision}, not ${revision}`);
      const merged = validateRow(collection, applyRowPatch(row.data, patch.data));
      if (!merged.ok) throw new MemoryDbError('validation_failed', rowIssueMessage(merged.issues), { issues: merged.issues });
      const before = jsonByteSize(row.data);
      const after = jsonByteSize(merged.data);
      checkQuota(0, after - before);
      row.data = merged.data;
      row.revision += 1;
      row.updatedAt = store.now();
      store.bytes += after - before;
      emit(store, { type: 'update', collection: name, id, userId });
      return wire(row);
    },

    delete(params) {
      const name = params?.collection;
      const collection = collectionOf(store, name);
      const id = requireId(params.id);
      const revision = requireRevision(params.revision, true);
      const row = find(name, collection, id);
      if (!row) throw new MemoryDbError('not_found', `No row ${id} in ${name}`);
      if (!allowed(collection, row, 'delete')) throw new MemoryDbError('forbidden_record', `The collection's rules do not let this user delete row ${id}`);
      if (revision !== undefined && row.revision !== revision) throw new MemoryDbError('conflict', `Row ${id} is at revision ${row.revision}, not ${revision}`);
      store.rows.delete(id);
      store.bytes -= jsonByteSize(row.data);
      emit(store, { type: 'delete', collection: name, id, userId });
      return null;
    },

    count(params) {
      const name = params?.collection;
      const collection = collectionOf(store, name);
      const query = parsedQuery(collection, { where: params.where });
      return matching(name, collection, query).length;
    },

    async call(method, params) {
      if (!isDbMethod(method)) throw new MemoryDbError('unknown_method', `Unknown method ${method}`);
      if (!isRecord(params)) throw new MemoryDbError('invalid_params', `${method} needs an object of parameters`);
      const p = params as never;
      switch (method) {
        case 'db.insert':
          return view.insert(p) as unknown as JsonValue;
        case 'db.get':
          return view.get(p) as unknown as JsonValue;
        case 'db.query':
          return view.query(p) as unknown as JsonValue;
        case 'db.update':
          return view.update(p) as unknown as JsonValue;
        case 'db.delete':
          return view.delete(p);
        case 'db.count':
          return view.count(p);
      }
    },

    as(otherUserId) {
      if (typeof otherUserId !== 'string' || otherUserId.length === 0) throw new MemoryDbError('invalid_params', 'userId must be a non-empty string');
      return createView(store, otherUserId);
    },

    rows(collection) {
      return [...store.rows.values()]
        .filter((row) => collection === undefined || row.collection === collection)
        .sort((a, b) => compareKeys(sortKey(a, 'createdAt'), sortKey(b, 'createdAt'), 'asc'))
        .map((row) => copy(row));
    },

    snapshot() {
      const out: Record<string, DbRow[]> = {};
      for (const name of Object.keys(store.schema?.collections ?? {})) out[name] = [];
      for (const row of view.rows()) (out[row.collection] ??= []).push(wire(row));
      return out;
    },

    usage() {
      return { rows: store.rows.size, bytes: store.bytes, rowLimit: store.quota.rows, byteLimit: store.quota.bytes };
    },

    reset(rows) {
      seedStore(store, rows, userId);
      emit(store, { type: 'reset' });
    },

    setSchema(next) {
      const result = compareDataSchemas(store.schema, next ?? null);
      if (result.ok) {
        store.schema = next ? copy(next) : null;
        store.anchors.clear();
        emit(store, { type: 'schema' });
      }
      return result;
    },

    subscribe(listener) {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  };
  return view;
}

/** Creates an empty (or seeded) in-memory app database for one manifest `data` section. */
export function createMemoryDb(options: MemoryDbOptions): MemoryDb {
  if (typeof options?.userId !== 'string' || options.userId.length === 0) throw new MemoryDbError('invalid_params', 'createMemoryDb needs a userId');
  const now = options.now ?? (() => new Date());
  const store: Store = {
    schema: options.data ? copy(options.data) : null,
    rows: new Map(),
    anchors: new Map(),
    quota: { rows: options.quota?.rows ?? DATA_LIMITS.defaultRowLimit, bytes: options.quota?.bytes ?? DATA_LIMITS.defaultByteLimit },
    bytes: 0,
    now: () => toIso(now()),
    generateId: options.generateId ?? uuidV4,
    listeners: new Set(),
  };
  seedStore(store, options.rows, options.userId);
  return createView(store, options.userId);
}

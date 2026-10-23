import { describe, expect, it } from 'vitest';
import {
  DATA_LIMITS,
  applyRowPatch,
  compareDataSchemas,
  dataSchema,
  effectiveRules,
  matchesDbCondition,
  normalizeDbDatetime,
  rowIssueMessage,
  validateDataSchema,
  validateDbQuery,
  validateManifest,
  validateRow,
  type CollectionSchema,
  type DataSchema,
} from './index.js';

/** The example from Phase 1b contract §1. */
const contractData = (): DataSchema => ({
  version: 1,
  collections: {
    decisions: {
      scope: 'organization',
      fields: {
        title: { type: 'string', required: true, maxLength: 200, indexed: true },
        status: { type: 'string', enum: ['open', 'done'], indexed: true },
        projectId: { type: 'ref:project', indexed: true },
        taskId: { type: 'ref:task' },
        decidedOn: { type: 'date', indexed: true },
        score: { type: 'number', integer: true, min: 0, max: 10 },
        meta: { type: 'json' },
      },
      rules: { read: 'any', update: 'any', delete: 'owner' },
    },
    pins: { scope: 'user', fields: { decisionId: { type: 'string', indexed: true, maxLength: 64 } } },
  },
});

const app = (data: unknown) => ({
  schemaVersion: 1,
  id: 'com.example.decisions',
  name: 'Decisions',
  version: '1.0.0',
  sdk: '^1.1.0',
  entry: 'dist/app.js',
  surfaces: { app: {} },
  permissions: ['db'],
  data,
});

function dataCodes(data: unknown): [string, string][] {
  const result = validateManifest(app(data));
  return result.ok ? [] : result.issues.map((issue) => [issue.code, issue.path]);
}

const UUID = '6f1c1b1e-6d5a-4c8e-9a43-0b7f4c1f2a10';

describe('manifest data', () => {
  it('accepts the contract example under schemaVersion 1', () => {
    const result = validateManifest(app(contractData()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.data).toEqual(contractData());
    expect(validateDataSchema(contractData()).ok).toBe(true);
    expect(dataSchema.safeParse(contractData()).success).toBe(true);
  });

  it('manifest.web_link_data', () => {
    const result = validateManifest({
      schemaVersion: 1, id: 'com.example.wiki', name: 'Wiki', version: '1.0.0', sdk: '*', kind: 'web-link', url: 'https://wiki.example.com', data: contractData(),
    });
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['manifest.web_link_data']);
  });

  it('version and collections', () => {
    expect(dataCodes({ ...contractData(), version: 0 })).toEqual([['manifest.data_version', 'data.version']]);
    expect(dataCodes({ ...contractData(), version: 1.5 })).toEqual([['manifest.data_version', 'data.version']]);
    expect(dataCodes({ version: 1, collections: {} })).toEqual([['manifest.data_collections_required', 'data.collections']]);
    expect(dataCodes('x')).toEqual([['manifest.data_collections_required', 'data']]);
    expect(dataCodes({ ...contractData(), indexes: [] })).toEqual([['manifest.unknown_field', 'data.indexes']]);
  });

  it('collection names, limits and scope', () => {
    const field = { fields: { a: { type: 'string' } } };
    expect(dataCodes({ version: 1, collections: { Bad: { scope: 'user', ...field } } })).toEqual([['manifest.data_collection_name', 'data.collections.Bad']]);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, { scope: 'user', ...field }]));
    expect(dataCodes({ version: 1, collections: many })).toEqual([['manifest.data_collection_limit', 'data.collections']]);
    expect(dataCodes({ version: 1, collections: { c: { scope: 'team', ...field } } })).toEqual([['manifest.data_scope', 'data.collections.c.scope']]);
    expect(dataCodes({ version: 1, collections: { c: { scope: 'user', ...field, unique: ['a'] } } })).toEqual([['manifest.unknown_field', 'data.collections.c.unique']]);
  });

  it('field names, reserved names, limits and types', () => {
    const c = (fields: unknown) => ({ version: 1, collections: { c: { scope: 'organization', fields } } });
    expect(dataCodes(c({ '1x': { type: 'string' } }))).toEqual([['manifest.data_field_name', 'data.collections.c.fields["1x"]']]);
    expect(dataCodes(c({ createdAt: { type: 'datetime' } }))).toEqual([['manifest.data_field_reserved', 'data.collections.c.fields.createdAt']]);
    expect(dataCodes(c({ id: { type: 'string' } }))).toEqual([['manifest.data_field_reserved', 'data.collections.c.fields.id']]);
    expect(dataCodes(c(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, { type: 'boolean' }]))))).toEqual([['manifest.data_field_limit', 'data.collections.c.fields']]);
    expect(dataCodes(c({ a: { type: 'text' } }))).toEqual([['manifest.data_field_type', 'data.collections.c.fields.a.type']]);
    expect(dataCodes(c({ a: 'string' }))).toEqual([['manifest.data_field_type', 'data.collections.c.fields.a']]);
    expect(dataCodes({ version: 1, collections: { c: { scope: 'user' } } })).toEqual([['manifest.data_field_type', 'data.collections.c.fields']]);
  });

  it('field options', () => {
    const c = (field: unknown) => ({ version: 1, collections: { c: { scope: 'organization', fields: { a: field } } } });
    expect(dataCodes(c({ type: 'number', maxLength: 3 }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.maxLength']]);
    expect(dataCodes(c({ type: 'string', unique: true }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.unique']]);
    expect(dataCodes(c({ type: 'string', maxLength: 10001 }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.maxLength']]);
    expect(dataCodes(c({ type: 'string', enum: [] }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.enum']]);
    expect(dataCodes(c({ type: 'string', enum: ['a', 'a'] }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.enum[1]']]);
    expect(dataCodes(c({ type: 'number', min: 5, max: 1 }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.min']]);
    expect(dataCodes(c({ type: 'boolean', required: 'yes' }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.required']]);
    expect(dataCodes(c({ type: 'date', label: 'x'.repeat(81) }))).toEqual([['manifest.data_field_option', 'data.collections.c.fields.a.label']]);
    expect(dataCodes(c({ type: 'date', label: 'Karar günü', required: true, indexed: true }))).toEqual([]);
  });

  it('indexes', () => {
    const c = (fields: unknown) => ({ version: 1, collections: { c: { scope: 'organization', fields } } });
    expect(dataCodes(c({ a: { type: 'json', indexed: true } }))).toEqual([['manifest.data_index_type', 'data.collections.c.fields.a.indexed']]);
    // Default maxLength 1000 is too long for an index; enum values or maxLength ≤ 512 fit.
    expect(dataCodes(c({ a: { type: 'string', indexed: true } }))).toEqual([['manifest.data_index_type', 'data.collections.c.fields.a.indexed']]);
    expect(dataCodes(c({ a: { type: 'string', maxLength: 512, indexed: true }, b: { type: 'string', enum: ['x'], indexed: true } }))).toEqual([]);
    const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, { type: 'number', indexed: true }]));
    expect(dataCodes(c(six))).toEqual([['manifest.data_index_limit', 'data.collections.c.fields']]);
  });

  it('rules', () => {
    const fields = { a: { type: 'string' } };
    expect(dataCodes({ version: 1, collections: { c: { scope: 'user', fields, rules: { read: 'any' } } } })).toEqual([['manifest.data_rules', 'data.collections.c.rules']]);
    expect(dataCodes({ version: 1, collections: { c: { scope: 'organization', fields, rules: { delete: 'admin' } } } })).toEqual([['manifest.data_rules', 'data.collections.c.rules.delete']]);
    expect(dataCodes({ version: 1, collections: { c: { scope: 'organization', fields, rules: { write: 'any' } } } })).toEqual([['manifest.unknown_field', 'data.collections.c.rules.write']]);
    expect(effectiveRules({ scope: 'organization' })).toEqual({ read: 'any', update: 'any', delete: 'owner' });
    expect(effectiveRules({ scope: 'organization', rules: { read: 'owner' } })).toEqual({ read: 'owner', update: 'any', delete: 'owner' });
    expect(effectiveRules({ scope: 'user' })).toEqual({ read: 'owner', update: 'owner', delete: 'owner' });
  });

  it('dataSchema (zod) reports the same codes', () => {
    const result = dataSchema.safeParse({ version: 1, collections: { c: { scope: 'organization', fields: { id: { type: 'string' } } } } });
    expect(result.success).toBe(false);
    expect((result.error?.issues[0] as { params?: unknown } | undefined)?.params).toMatchObject({ code: 'manifest.data_field_reserved' });
  });
});

describe('validateRow', () => {
  const decisions = contractData().collections.decisions!;

  it('accepts and normalises a full row', () => {
    const result = validateRow(decisions, { title: 'Ship', status: 'open', projectId: UUID.toUpperCase(), score: 3, meta: { a: [1] }, decidedOn: '2026-02-28', taskId: null });
    expect(result).toEqual({ ok: true, data: { title: 'Ship', status: 'open', projectId: UUID, score: 3, meta: { a: [1] }, decidedOn: '2026-02-28' } });
  });

  it('reports each row code', () => {
    const codes = (data: unknown, partial = false) => {
      const result = validateRow(decisions, data, { partial });
      return result.ok ? [] : result.issues.map((issue) => [issue.code, issue.path]);
    };
    expect(codes({})).toEqual([['row.required', 'data.title']]);
    expect(codes({ title: null })).toEqual([['row.required', 'data.title']]);
    expect(codes({ title: 'x', extra: 1 })).toEqual([['row.unknown_field', 'data.extra']]);
    expect(codes({ title: 5 })).toEqual([['row.type', 'data.title']]);
    expect(codes({ title: 'x'.repeat(201) })).toEqual([['row.max_length', 'data.title']]);
    expect(codes({ title: 'x', status: 'later' })).toEqual([['row.enum', 'data.status']]);
    expect(codes({ title: 'x', score: 11 })).toEqual([['row.range', 'data.score']]);
    expect(codes({ title: 'x', score: 1.5 })).toEqual([['row.not_integer', 'data.score']]);
    expect(codes({ title: 'x', score: Number.NaN })).toEqual([['row.type', 'data.score']]);
    expect(codes({ title: 'x', decidedOn: '2026-02-30' })).toEqual([['row.type', 'data.decidedOn']]);
    expect(codes({ title: 'x', projectId: 'p1' })).toEqual([['row.type', 'data.projectId']]);
    expect(codes({ title: 'x', meta: { big: 'x'.repeat(16 * 1024) } })).toEqual([['row.json_too_large', 'data.meta']]);
    expect(codes([])).toEqual([['row.type', 'data']]);
    // Partial (update patch): only the given fields; null clears, but not a required field.
    expect(codes({ score: 2 }, true)).toEqual([]);
    expect(codes({ title: null }, true)).toEqual([['row.required', 'data.title']]);
    expect(validateRow(decisions, { score: null }, { partial: true })).toEqual({ ok: true, data: { score: null } });
  });

  it('row.too_large for rows over 64 KiB', () => {
    const big: CollectionSchema = { scope: 'user', fields: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, { type: 'string', maxLength: 10000 }])) };
    const data = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, 'é'.repeat(5000)]));
    const result = validateRow(big, data);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['row.too_large']);
    expect(DATA_LIMITS.maxRowBytes).toBe(65536);
  });

  it('datetime values are normalised to UTC', () => {
    const c: CollectionSchema = { scope: 'user', fields: { at: { type: 'datetime' } } };
    expect(validateRow(c, { at: '2026-10-17T12:30:00+03:00' })).toEqual({ ok: true, data: { at: '2026-10-17T09:30:00.000Z' } });
    expect(validateRow(c, { at: '2026-10-17T12:30:00' }).ok).toBe(false);
    expect(normalizeDbDatetime('2026-10-17T24:00:00Z')).toBeNull();
  });

  it('rowIssueMessage and applyRowPatch', () => {
    const result = validateRow(decisions, {});
    expect(result.ok ? '' : rowIssueMessage(result.issues)).toBe('data.title: row.required');
    expect(applyRowPatch({ a: 1, b: 2 }, { b: null, c: 3 })).toEqual({ a: 1, c: 3 });
  });
});

describe('validateDbQuery', () => {
  const decisions = contractData().collections.decisions!;

  it('defaults', () => {
    const result = validateDbQuery(decisions, {});
    expect(result).toMatchObject({ ok: true, query: { where: [], orderBy: { field: 'createdAt', direction: 'desc' }, limit: 50, cursor: null } });
  });

  it('normalises where values and builds a stable key', () => {
    const a = validateDbQuery(decisions, { where: { status: 'open', projectId: { in: [UUID.toUpperCase(), null] } }, orderBy: { field: 'title' } });
    const b = validateDbQuery(decisions, { where: { projectId: { in: [UUID, null] }, status: { eq: 'open' } }, orderBy: { field: 'title', direction: 'asc' } });
    expect(a.ok && b.ok && a.query.key === b.query.key).toBe(true);
    if (a.ok) expect(a.query.where.find((c) => c.field === 'projectId')?.in).toEqual([UUID, null]);
  });

  it('rejects what the contract forbids (invalid_params)', () => {
    const bad = (input: Parameters<typeof validateDbQuery>[1]) => validateDbQuery(decisions, input).ok;
    expect(bad({ where: { taskId: UUID } })).toBe(false); // not indexed
    expect(bad({ where: { meta: 1 } })).toBe(false);
    expect(bad({ where: { projectId: { gt: UUID } } })).toBe(false); // ref: eq/in only
    expect(bad({ where: { createdBy: { gte: 'u' } } })).toBe(false);
    expect(bad({ where: { decidedOn: { gt: 'yesterday' } } })).toBe(false);
    expect(bad({ where: { title: { gt: null } } })).toBe(false);
    expect(bad({ where: { title: { like: 'x' } } })).toBe(false);
    expect(bad({ where: { status: { in: Array.from({ length: 51 }, () => 'open') } } })).toBe(false);
    expect(bad({ orderBy: { field: 'taskId' } })).toBe(false);
    expect(bad({ orderBy: { field: 'createdBy' } })).toBe(false);
    expect(bad({ orderBy: { field: 'title', direction: 'up' } as never })).toBe(false);
    expect(bad({ limit: 0 })).toBe(false);
    expect(bad({ limit: 101 })).toBe(false);
    expect(bad({ cursor: 'x'.repeat(513) })).toBe(false);
    expect(bad({ where: { createdAt: { gte: '2026-01-01T00:00:00Z' }, createdBy: 'u1', title: { gte: 'a', lt: 'b' } }, limit: 100 })).toBe(true);
  });

  it('matchesDbCondition', () => {
    const result = validateDbQuery(decisions, { where: { title: { gte: 'b', lt: 'd' }, status: null } });
    if (!result.ok) throw new Error(result.message);
    const [status, title] = result.query.where;
    expect(matchesDbCondition('c', title!)).toBe(true);
    expect(matchesDbCondition('d', title!)).toBe(false);
    expect(matchesDbCondition(undefined, title!)).toBe(false);
    expect(matchesDbCondition(undefined, status!)).toBe(true);
    expect(matchesDbCondition('open', status!)).toBe(false);
  });
});

describe('compareDataSchemas', () => {
  const codes = (next: DataSchema | null) => compareDataSchemas(contractData(), next).issues.map((issue) => [issue.code, issue.path]);
  const bumped = (change: (data: DataSchema) => void): DataSchema => {
    const data = contractData();
    data.version = 2;
    change(data);
    return data;
  };
  const decisions = (data: DataSchema) => data.collections.decisions!;

  it('same schema is no change; no stored schema is always fine', () => {
    expect(compareDataSchemas(contractData(), contractData())).toEqual({ ok: true, issues: [], changed: false });
    expect(compareDataSchemas(null, contractData())).toMatchObject({ ok: true, changed: true });
    expect(compareDataSchemas(contractData(), bumped(() => {}))).toEqual({ ok: true, issues: [], changed: false });
  });

  it('version must increase when the schema changes', () => {
    const changed = contractData();
    changed.collections.extra = { scope: 'user', fields: {} };
    expect(codes(changed)).toEqual([['data.version_not_bumped', 'data.version']]);
    expect(codes({ ...contractData(), version: 0 })).toEqual([['data.version_downgrade', 'data.version']]);
  });

  it('applies additive changes automatically', () => {
    const next = bumped((data) => {
      data.collections.extra = { scope: 'user', fields: { a: { type: 'string', required: true } } };
      const fields = decisions(data).fields;
      fields.note = { type: 'string' };
      fields.taskId = { type: 'ref:task', indexed: true, label: 'Görev' };
      fields.title = { type: 'string', required: false, maxLength: 300 };
      fields.status = { type: 'string', enum: ['open', 'done', 'later'], indexed: true };
      fields.score = { type: 'number', integer: true, min: -1, max: 20 };
      decisions(data).rules = { read: 'owner' };
    });
    expect(compareDataSchemas(contractData(), next)).toEqual({ ok: true, issues: [], changed: true });
  });

  it('rejects destructive changes', () => {
    expect(codes(bumped((data) => delete data.collections.pins))).toEqual([['data.collection_removed', 'data.collections.pins']]);
    expect(codes(bumped((data) => delete decisions(data).fields.meta))).toEqual([['data.field_removed', 'data.collections.decisions.fields.meta']]);
    expect(codes(bumped((data) => (decisions(data).fields.meta = { type: 'string' })))).toEqual([['data.type_changed', 'data.collections.decisions.fields.meta']]);
    expect(codes(bumped((data) => (data.collections.pins!.scope = 'organization')))).toEqual([['data.scope_changed', 'data.collections.pins.scope']]);
    expect(codes(bumped((data) => (decisions(data).fields.extra = { type: 'string', required: true })))).toEqual([['data.required_added', 'data.collections.decisions.fields.extra']]);
    expect(codes(bumped((data) => (decisions(data).fields.meta = { type: 'json', required: true })))).toEqual([['data.required_added', 'data.collections.decisions.fields.meta']]);
    for (const field of [
      { type: 'string', required: true, maxLength: 100, indexed: true },
    ] as const) {
      expect(codes(bumped((data) => (decisions(data).fields.title = { ...field })))).toEqual([['data.constraint_tightened', 'data.collections.decisions.fields.title']]);
    }
    expect(codes(bumped((data) => (decisions(data).fields.status = { type: 'string', enum: ['open'] })))).toEqual([['data.constraint_tightened', 'data.collections.decisions.fields.status']]);
    expect(codes(bumped((data) => (decisions(data).fields.score = { type: 'number', integer: true, min: 1, max: 10 })))).toEqual([['data.constraint_tightened', 'data.collections.decisions.fields.score']]);
    expect(codes(bumped((data) => (decisions(data).fields.score = { type: 'number', integer: true, min: 0, max: 9 })))).toEqual([['data.constraint_tightened', 'data.collections.decisions.fields.score']]);
    expect(codes(bumped((data) => (data.collections.pins!.fields.decisionId = { type: 'string', indexed: true, maxLength: 64, enum: ['a'] })))).toEqual([['data.constraint_tightened', 'data.collections.pins.fields.decisionId']]);
    const removedData = compareDataSchemas(contractData(), null);
    expect(removedData.issues.map((issue) => issue.code)).toEqual(['data.collection_removed', 'data.collection_removed']);
  });
});

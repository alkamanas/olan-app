import { z } from 'zod';
import { formatIssuePath } from './issue-path.js';
import type { JsonValue } from './json.js';

/*
 * App database (`olan.db`): the manifest `data` section, row validation and schema changes
 * (Phase 1b contract §1). The server, the CLI mock server, Studio and the in-memory database
 * (`@olan-app/sdk/memory-db`) all use these functions, so every implementation accepts and
 * rejects the same values.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DATA_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'datetime', 'json', 'ref:project', 'ref:task', 'ref:user'] as const;
export type DataFieldType = (typeof DATA_FIELD_TYPES)[number];

export const DATA_SCOPES = ['organization', 'user'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export type DataRule = 'any' | 'owner';

interface FieldSchemaBase {
  /** `null`/absent is allowed unless `required` (default false). */
  required?: boolean;
  /** Usable in `where` and `orderBy` (≤ 5 per collection; not for `json`). */
  indexed?: boolean;
  /** Shown in Studio and exports (≤ 80). */
  label?: string;
}

export interface StringFieldSchema extends FieldSchemaBase {
  type: 'string';
  /** Default 1000, at most 10000 characters (Unicode code points). */
  maxLength?: number;
  /** Allowed values (≤ 100 values of ≤ 100 characters). */
  enum?: string[];
}

export interface NumberFieldSchema extends FieldSchemaBase {
  type: 'number';
  integer?: boolean;
  min?: number;
  max?: number;
}

export interface PlainFieldSchema extends FieldSchemaBase {
  type: 'boolean' | 'date' | 'datetime' | 'json' | 'ref:project' | 'ref:task' | 'ref:user';
}

export type FieldSchema = StringFieldSchema | NumberFieldSchema | PlainFieldSchema;

export interface CollectionRules {
  read?: DataRule;
  update?: DataRule;
  delete?: DataRule;
}

export interface CollectionSchema {
  scope: DataScope;
  fields: Record<string, FieldSchema>;
  /** Only for `organization` collections; defaults `{ read: 'any', update: 'any', delete: 'owner' }`. */
  rules?: CollectionRules;
}

export interface DataSchema {
  /** 1..1000000; bump it whenever the schema changes. */
  version: number;
  collections: Record<string, CollectionSchema>;
}

/** Row metadata every collection has; `createdAt`, `updatedAt`, `createdBy` are implicitly indexed. */
export const DB_META_FIELDS = ['createdAt', 'updatedAt', 'createdBy'] as const;
export type DbMetaField = (typeof DB_META_FIELDS)[number];

export const DATA_LIMITS = Object.freeze({
  minVersion: 1,
  maxVersion: 1_000_000,
  maxCollections: 20,
  maxFields: 64,
  maxIndexedFields: 5,
  collectionNamePattern: /^[a-z][a-z0-9_]{0,39}$/,
  fieldNamePattern: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
  reservedFieldNames: Object.freeze(['id', 'createdAt', 'updatedAt', 'createdBy', 'revision'] as const),
  defaultStringMaxLength: 1000,
  maxStringMaxLength: 10_000,
  maxIndexedStringLength: 512,
  maxEnumValues: 100,
  maxEnumValueLength: 100,
  maxLabelLength: 80,
  /** Serialised (UTF-8 JSON) size of one `json` field value. */
  maxJsonBytes: 16 * 1024,
  /** Serialised (UTF-8 JSON) size of a row's `data`. */
  maxRowBytes: 64 * 1024,
  /** `db.query` */
  defaultQueryLimit: 50,
  maxQueryLimit: 100,
  maxWhereFields: 5,
  maxInValues: 50,
  maxCursorLength: 512,
  /** Default quota (policy `db_row_limit`, `db_byte_limit`). */
  defaultRowLimit: 100_000,
  defaultByteLimit: 100 * 1024 * 1024,
});

export const DEFAULT_COLLECTION_RULES: Readonly<Required<CollectionRules>> = Object.freeze({ read: 'any', update: 'any', delete: 'owner' });

/** The rules that apply to a collection (`user` collections: rows are only their owner's anyway). */
export function effectiveRules(collection: Pick<CollectionSchema, 'scope' | 'rules'>): Required<CollectionRules> {
  if (collection.scope === 'user') return { read: 'owner', update: 'owner', delete: 'owner' };
  return { ...DEFAULT_COLLECTION_RULES, ...collection.rules };
}

const STRING_OPTIONS = ['maxLength', 'enum'] as const;
const NUMBER_OPTIONS = ['integer', 'min', 'max'] as const;
const COMMON_OPTIONS = ['type', 'required', 'indexed', 'label'] as const;

/** Longest value a string field can hold: its enum's longest value, else `maxLength` (default 1000). */
export function effectiveMaxLength(field: StringFieldSchema): number {
  if (field.enum && field.enum.length > 0) return Math.max(...field.enum.map(codePointLength));
  return field.maxLength ?? DATA_LIMITS.defaultStringMaxLength;
}

/** Whether a field type may be `indexed` (json never; strings when their effective maxLength ≤ 512). */
export function isIndexableField(field: FieldSchema): boolean {
  if (field.type === 'json') return false;
  if (field.type === 'string') return effectiveMaxLength(field) <= DATA_LIMITS.maxIndexedStringLength;
  return true;
}

// ---------------------------------------------------------------------------
// Data schema validation (manifest `data`)
// ---------------------------------------------------------------------------

export type DataSchemaIssueCode =
  | 'manifest.data_version'
  | 'manifest.data_collections_required'
  | 'manifest.data_collection_name'
  | 'manifest.data_collection_limit'
  | 'manifest.data_scope'
  | 'manifest.data_field_name'
  | 'manifest.data_field_reserved'
  | 'manifest.data_field_limit'
  | 'manifest.data_field_type'
  | 'manifest.data_field_option'
  | 'manifest.data_index_limit'
  | 'manifest.data_index_type'
  | 'manifest.data_rules'
  | 'manifest.unknown_field';

export interface DataSchemaIssue {
  code: DataSchemaIssueCode;
  /** Path from the manifest root, e.g. `data.collections.decisions.fields.title.maxLength`. */
  path: string;
  message: string;
  hint?: string;
}

/** Issue with an unformatted path relative to the manifest root (used by `validateManifest`). */
export interface DataSchemaIssueRaw {
  code: DataSchemaIssueCode;
  path: (string | number)[];
  message: string;
  hint?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function fieldIssues(field: unknown, path: (string | number)[], push: (issue: DataSchemaIssueRaw) => void): boolean {
  if (!isRecord(field)) {
    push({ code: 'manifest.data_field_type', path, message: 'A field must be an object with "type".', hint: `Use e.g. { "type": "string" }. Types: ${DATA_FIELD_TYPES.join(', ')}.` });
    return false;
  }
  const type = field.type;
  if (typeof type !== 'string' || !(DATA_FIELD_TYPES as readonly string[]).includes(type)) {
    push({
      code: 'manifest.data_field_type',
      path: [...path, 'type'],
      message: type === undefined ? 'The field needs a "type".' : `Unknown field type ${JSON.stringify(type)}.`,
      hint: `Types: ${DATA_FIELD_TYPES.join(', ')}.`,
    });
    return false;
  }
  const allowed = new Set<string>([
    ...COMMON_OPTIONS,
    ...(type === 'string' ? STRING_OPTIONS : []),
    ...(type === 'number' ? NUMBER_OPTIONS : []),
  ]);
  const option = (key: string, message: string, hint?: string) =>
    push({ code: 'manifest.data_field_option', path: [...path, key], message, ...(hint ? { hint } : {}) });
  for (const key of Object.keys(field)) {
    if (!allowed.has(key)) {
      option(key, `"${key}" is not an option of ${type} fields.`, `Options for ${type}: ${[...allowed].filter((k) => k !== 'type').join(', ')}.`);
    }
  }
  for (const key of ['required', 'indexed'] as const) {
    if (own(field, key) && typeof field[key] !== 'boolean') option(key, `"${key}" must be true or false.`);
  }
  if (own(field, 'label') && !(typeof field.label === 'string' && field.label.trim().length > 0 && codePointLength(field.label) <= DATA_LIMITS.maxLabelLength)) {
    option('label', `"label" must be a non-empty string of at most ${DATA_LIMITS.maxLabelLength} characters.`);
  }
  let valid = true;
  if (type === 'string') {
    if (own(field, 'maxLength')) {
      const value = field.maxLength;
      if (!(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= DATA_LIMITS.maxStringMaxLength)) {
        option('maxLength', `"maxLength" must be an integer from 1 to ${DATA_LIMITS.maxStringMaxLength}.`);
        valid = false;
      }
    }
    if (own(field, 'enum')) {
      const values = field.enum;
      if (!Array.isArray(values) || values.length === 0 || values.length > DATA_LIMITS.maxEnumValues) {
        option('enum', `"enum" must be an array of 1 to ${DATA_LIMITS.maxEnumValues} strings.`);
        valid = false;
      } else {
        const seen = new Set<string>();
        values.forEach((value, index) => {
          if (typeof value !== 'string' || value.length === 0 || codePointLength(value) > DATA_LIMITS.maxEnumValueLength) {
            push({ code: 'manifest.data_field_option', path: [...path, 'enum', index], message: `Enum values are non-empty strings of at most ${DATA_LIMITS.maxEnumValueLength} characters.` });
            valid = false;
          } else if (seen.has(value)) {
            push({ code: 'manifest.data_field_option', path: [...path, 'enum', index], message: `Duplicate enum value ${JSON.stringify(value)}.` });
            valid = false;
          } else if (typeof field.maxLength === 'number' && codePointLength(value) > field.maxLength) {
            push({ code: 'manifest.data_field_option', path: [...path, 'enum', index], message: `Enum value ${JSON.stringify(value)} is longer than "maxLength".` });
            valid = false;
          }
          if (typeof value === 'string') seen.add(value);
        });
      }
    }
  }
  if (type === 'number') {
    if (own(field, 'integer') && typeof field.integer !== 'boolean') option('integer', '"integer" must be true or false.');
    for (const key of ['min', 'max'] as const) {
      if (own(field, key) && !isFiniteNumber(field[key])) {
        option(key, `"${key}" must be a finite number.`);
        valid = false;
      }
    }
    if (isFiniteNumber(field.min) && isFiniteNumber(field.max) && field.min > field.max) {
      option('min', '"min" is greater than "max".');
      valid = false;
    }
  }
  return valid;
}

function collectionIssues(name: string, collection: unknown, path: (string | number)[], push: (issue: DataSchemaIssueRaw) => void) {
  if (!isRecord(collection)) {
    push({ code: 'manifest.data_scope', path, message: 'A collection must be an object with "scope" and "fields".', hint: 'Use { "scope": "organization", "fields": { … } }.' });
    return;
  }
  for (const key of Object.keys(collection)) {
    if (key !== 'scope' && key !== 'fields' && key !== 'rules') {
      push({ code: 'manifest.unknown_field', path: [...path, key], message: `Unknown collection field "${key}".`, hint: 'Collections have "scope", "fields" and (organization only) "rules".' });
    }
  }
  const scope = collection.scope;
  if (scope !== 'organization' && scope !== 'user') {
    push({
      code: 'manifest.data_scope',
      path: [...path, 'scope'],
      message: `"scope" must be "organization" or "user"${scope === undefined ? '' : `, got ${JSON.stringify(scope)}`}.`,
      hint: '"organization": rows shared in the organization (with rules); "user": each person sees only their own rows.',
    });
  }
  if (own(collection, 'rules')) {
    const rules = collection.rules;
    if (scope === 'user') {
      push({ code: 'manifest.data_rules', path: [...path, 'rules'], message: '"user" collections cannot declare "rules": their rows are visible only to their owner.', hint: 'Remove "rules".' });
    } else if (!isRecord(rules)) {
      push({ code: 'manifest.data_rules', path: [...path, 'rules'], message: '"rules" must be an object like { "read": "any", "update": "any", "delete": "owner" }.' });
    } else {
      for (const [key, value] of Object.entries(rules)) {
        if (key !== 'read' && key !== 'update' && key !== 'delete') {
          push({ code: 'manifest.unknown_field', path: [...path, 'rules', key], message: `Unknown rule "${key}".`, hint: 'Rules are "read", "update" and "delete".' });
        } else if (value !== 'any' && value !== 'owner') {
          push({ code: 'manifest.data_rules', path: [...path, 'rules', key], message: `Rule "${key}" must be "any" or "owner".` });
        }
      }
    }
  }
  const fields = collection.fields;
  if (!isRecord(fields)) {
    push({ code: 'manifest.data_field_type', path: [...path, 'fields'], message: `Collection "${name}" needs "fields": an object of field definitions.`, hint: 'Use "fields": { "title": { "type": "string" } }.' });
    return;
  }
  const names = Object.keys(fields);
  if (names.length > DATA_LIMITS.maxFields) {
    push({ code: 'manifest.data_field_limit', path: [...path, 'fields'], message: `A collection has at most ${DATA_LIMITS.maxFields} fields (found ${names.length}).` });
  }
  let indexed = 0;
  for (const fieldName of names) {
    const fieldPath = [...path, 'fields', fieldName];
    if ((DATA_LIMITS.reservedFieldNames as readonly string[]).includes(fieldName)) {
      push({ code: 'manifest.data_field_reserved', path: fieldPath, message: `"${fieldName}" is a row property and cannot be a field name.`, hint: `Reserved: ${DATA_LIMITS.reservedFieldNames.join(', ')}.` });
      continue;
    }
    if (!DATA_LIMITS.fieldNamePattern.test(fieldName)) {
      push({ code: 'manifest.data_field_name', path: fieldPath, message: `Invalid field name "${fieldName}".`, hint: 'Start with a letter; use letters, digits and underscores (≤ 64).' });
      continue;
    }
    const field = fields[fieldName];
    const valid = fieldIssues(field, fieldPath, push);
    if (!valid || !isRecord(field) || field.indexed !== true) continue;
    indexed += 1;
    if (!isIndexableField(field as unknown as FieldSchema)) {
      push({
        code: 'manifest.data_index_type',
        path: [...fieldPath, 'indexed'],
        message: field.type === 'json' ? 'json fields cannot be indexed.' : `String fields can be indexed only with "maxLength" (or enum values) of at most ${DATA_LIMITS.maxIndexedStringLength}.`,
        hint: field.type === 'json' ? 'Remove "indexed".' : `Add "maxLength": ${DATA_LIMITS.maxIndexedStringLength} or less.`,
      });
    }
  }
  if (indexed > DATA_LIMITS.maxIndexedFields) {
    push({
      code: 'manifest.data_index_limit',
      path: [...path, 'fields'],
      message: `A collection has at most ${DATA_LIMITS.maxIndexedFields} indexed fields (found ${indexed}).`,
      hint: 'createdAt, updatedAt and createdBy are always indexed and do not count.',
    });
  }
}

/** Issues of a manifest `data` value; paths start at the manifest root (`['data', …]`). */
export function dataSchemaIssues(data: unknown): DataSchemaIssueRaw[] {
  const issues: DataSchemaIssueRaw[] = [];
  const push = (issue: DataSchemaIssueRaw) => issues.push(issue);
  const root: (string | number)[] = ['data'];
  if (!isRecord(data)) {
    push({ code: 'manifest.data_collections_required', path: root, message: '"data" must be an object: { "version": 1, "collections": { … } }.' });
    return issues;
  }
  for (const key of Object.keys(data)) {
    if (key !== 'version' && key !== 'collections') {
      push({ code: 'manifest.unknown_field', path: [...root, key], message: `Unknown field "${key}" in data.`, hint: '"data" has "version" and "collections".' });
    }
  }
  const version = data.version;
  if (!(Number.isInteger(version) && (version as number) >= DATA_LIMITS.minVersion && (version as number) <= DATA_LIMITS.maxVersion)) {
    push({
      code: 'manifest.data_version',
      path: [...root, 'version'],
      message: `"data.version" must be an integer from ${DATA_LIMITS.minVersion} to ${DATA_LIMITS.maxVersion}.`,
      hint: 'Start at 1 and increase it whenever the data schema changes.',
    });
  }
  const collections = data.collections;
  if (!isRecord(collections) || Object.keys(collections).length === 0) {
    push({ code: 'manifest.data_collections_required', path: [...root, 'collections'], message: '"data.collections" must declare at least one collection.', hint: 'Add "collections": { "items": { "scope": "organization", "fields": { … } } }.' });
    return issues;
  }
  const names = Object.keys(collections);
  if (names.length > DATA_LIMITS.maxCollections) {
    push({ code: 'manifest.data_collection_limit', path: [...root, 'collections'], message: `At most ${DATA_LIMITS.maxCollections} collections (found ${names.length}).` });
  }
  for (const name of names) {
    const path = [...root, 'collections', name];
    if (!DATA_LIMITS.collectionNamePattern.test(name)) {
      push({ code: 'manifest.data_collection_name', path, message: `Invalid collection name "${name}".`, hint: 'Start with a lowercase letter; use lowercase letters, digits and underscores (≤ 40).' });
      continue;
    }
    collectionIssues(name, collections[name], path, push);
  }
  return issues;
}

export type ValidateDataSchemaResult = { ok: true; data: DataSchema } | { ok: false; issues: DataSchemaIssue[] };

/** Validates a manifest `data` value (the server also checks it again on upload). */
export function validateDataSchema(data: unknown): ValidateDataSchemaResult {
  const issues = dataSchemaIssues(data);
  if (issues.length > 0) {
    return { ok: false, issues: issues.map((issue) => ({ code: issue.code, path: formatIssuePath(issue.path), message: issue.message, ...(issue.hint ? { hint: issue.hint } : {}) })) };
  }
  return { ok: true, data: data as unknown as DataSchema };
}

// ---------------------------------------------------------------------------
// zod schema (structure; `dataSchema` also runs the rules above)
// ---------------------------------------------------------------------------

const fieldCommon = {
  required: z.boolean().optional().describe('Value must be present and non-null (default false).'),
  indexed: z.boolean().optional().describe('Usable in where/orderBy (≤ 5 per collection, not json).'),
  label: z.string().min(1).max(DATA_LIMITS.maxLabelLength).optional().describe('Label for Studio and exports (≤ 80).'),
};

const fieldStructureSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('string'),
      ...fieldCommon,
      maxLength: z.number().int().min(1).max(DATA_LIMITS.maxStringMaxLength).optional().describe('Default 1000, ≤ 10000.'),
      enum: z.array(z.string().min(1).max(DATA_LIMITS.maxEnumValueLength)).min(1).max(DATA_LIMITS.maxEnumValues).optional(),
    }),
    z.strictObject({
      type: z.literal('number'),
      ...fieldCommon,
      integer: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
    ...(['boolean', 'date', 'datetime', 'json', 'ref:project', 'ref:task', 'ref:user'] as const).map((type) =>
      z.strictObject({ type: z.literal(type), ...fieldCommon }),
    ),
  ])
  .describe(`Field: ${DATA_FIELD_TYPES.join(', ')}.`);

const ruleSchema = z.enum(['any', 'owner']);

const collectionStructureSchema = z
  .strictObject({
    scope: z.enum(DATA_SCOPES).describe('"organization" (shared, with rules) or "user" (each person sees only their rows).'),
    fields: z.record(z.string().regex(DATA_LIMITS.fieldNamePattern), fieldStructureSchema),
    rules: z
      .strictObject({ read: ruleSchema.optional(), update: ruleSchema.optional(), delete: ruleSchema.optional() })
      .optional()
      .describe('Organization collections only. Default { read: "any", update: "any", delete: "owner" }.'),
  })
  .describe('Collection.');

/** Structural zod schema of the manifest `data` section (used inside the manifest schema). */
export const dataStructureSchema = z
  .strictObject({
    version: z.number().int().min(DATA_LIMITS.minVersion).max(DATA_LIMITS.maxVersion).describe('Data schema version; increase it whenever the schema changes.'),
    collections: z
      .record(z.string().regex(DATA_LIMITS.collectionNamePattern), collectionStructureSchema)
      .describe('Collections keyed by name (≤ 20).'),
  })
  .describe('App database (olan.db): collections and their fields.');

/** Zod schema of the manifest `data` section, including every `manifest.data_*` rule. */
export const dataSchema: z.ZodType<DataSchema> = dataStructureSchema.superRefine((value, ctx) => {
  for (const issue of dataSchemaIssues(value)) {
    ctx.addIssue({ code: 'custom', path: issue.path.slice(1), message: issue.message, params: { code: issue.code, hint: issue.hint } });
  }
}) as unknown as z.ZodType<DataSchema>;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** `YYYY-MM-DD` naming a real calendar day. */
export function isDbDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= (month === 2 ? (leap ? 29 : 28) : days);
}

/** Normalises an ISO date-time with an offset (`Z` or `±hh:mm`) to `toISOString()` form, or null. */
export function normalizeDbDatetime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return null;
  if (!isDbDate(`${match[1]}-${match[2]}-${match[3]}`)) return null;
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

/** UTF-8 size of a value's JSON text (rows are measured this way for limits and quota). */
export function jsonByteSize(value: JsonValue): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) => isJson(item, depth + 1));
  }
  return false;
}

export type RowIssueCode =
  | 'row.unknown_field'
  | 'row.required'
  | 'row.type'
  | 'row.max_length'
  | 'row.range'
  | 'row.enum'
  | 'row.not_integer'
  | 'row.json_too_large'
  | 'row.too_large';

export interface RowIssue {
  code: RowIssueCode;
  /** `data` or `data.<field>`. */
  path: string;
  message: string;
}

export type ValidateRowResult = { ok: true; data: Record<string, JsonValue> } | { ok: false; issues: RowIssue[] };

type ValueCheck = { ok: true; value: JsonValue } | { ok: false; code: RowIssueCode; message: string };

/**
 * Checks one non-null value against its field and returns the stored form (`datetime` normalised
 * to UTC `toISOString()`, ref UUIDs lower-cased).
 */
export function checkFieldValue(field: FieldSchema, value: unknown): ValueCheck {
  const typeError = (expected: string): ValueCheck => ({ ok: false, code: 'row.type', message: `must be ${expected}` });
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return typeError('a string');
      const max = field.maxLength ?? DATA_LIMITS.defaultStringMaxLength;
      if (codePointLength(value) > max) return { ok: false, code: 'row.max_length', message: `must be at most ${max} characters` };
      if (field.enum && !field.enum.includes(value)) return { ok: false, code: 'row.enum', message: `must be one of ${field.enum.join(', ')}` };
      return { ok: true, value };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return typeError('a finite number');
      if (field.integer && !Number.isInteger(value)) return { ok: false, code: 'row.not_integer', message: 'must be an integer' };
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        return { ok: false, code: 'row.range', message: `must be between ${field.min ?? '-∞'} and ${field.max ?? '∞'}` };
      }
      return { ok: true, value };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : typeError('true or false');
    case 'date':
      return isDbDate(value) ? { ok: true, value } : typeError('a date (YYYY-MM-DD)');
    case 'datetime': {
      const normalized = normalizeDbDatetime(value);
      return normalized ? { ok: true, value: normalized } : typeError('an ISO date-time with an offset (e.g. 2026-10-17T09:00:00Z)');
    }
    case 'json': {
      if (!isJson(value)) return typeError('JSON');
      if (jsonByteSize(value) > DATA_LIMITS.maxJsonBytes) return { ok: false, code: 'row.json_too_large', message: `must be at most ${DATA_LIMITS.maxJsonBytes} bytes as JSON` };
      return { ok: true, value };
    }
    case 'ref:project':
    case 'ref:task':
    case 'ref:user':
      return isUuid(value) ? { ok: true, value: value.toLowerCase() } : typeError('a UUID');
  }
}

/**
 * Validates row data for a collection (contract §1). Full rows (`insert`, or a merged update):
 * required fields must be present and non-null; `null` values are dropped from the result (a
 * missing value and `null` are the same). With `{ partial: true }` (an update `patch`) only the
 * given fields are checked and `null` stays in the result, meaning "clear this field"; clearing a
 * required field is `row.required`. The result is the stored form of the data.
 */
export function validateRow(collection: CollectionSchema, data: unknown, options: { partial?: boolean } = {}): ValidateRowResult {
  if (!isRecord(data)) return { ok: false, issues: [{ code: 'row.type', path: 'data', message: 'data must be an object' }] };
  const issues: RowIssue[] = [];
  const out: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(data)) {
    const path = `data.${name}`;
    const field = own(collection.fields, name) ? collection.fields[name] : undefined;
    if (!field) {
      issues.push({ code: 'row.unknown_field', path, message: `unknown field "${name}"` });
      continue;
    }
    if (value === null || value === undefined) {
      if (field.required && (options.partial ? value === null : true)) {
        issues.push({ code: 'row.required', path, message: `"${name}" is required` });
      } else if (options.partial && value === null) {
        out[name] = null;
      }
      continue;
    }
    const checked = checkFieldValue(field, value);
    if (checked.ok) out[name] = checked.value;
    else issues.push({ code: checked.code, path, message: `"${name}" ${checked.message}` });
  }
  if (!options.partial) {
    for (const [name, field] of Object.entries(collection.fields)) {
      if (field.required && (data[name] === undefined || data[name] === null) && own(collection.fields, name) && !issues.some((issue) => issue.path === `data.${name}`)) {
        issues.push({ code: 'row.required', path: `data.${name}`, message: `"${name}" is required` });
      }
    }
  }
  if (issues.length === 0 && jsonByteSize(out) > DATA_LIMITS.maxRowBytes) {
    issues.push({ code: 'row.too_large', path: 'data', message: `data must be at most ${DATA_LIMITS.maxRowBytes} bytes as JSON` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, data: out };
}

/** `"data.title: row.required"`: the RPC / HTTP `message` for a failed row validation. */
export function rowIssueMessage(issues: readonly RowIssue[]): string {
  const first = issues[0];
  return first ? `${first.path}: ${first.code}` : 'data: row.type';
}

/** Shallow merge of an update patch over stored data: `null` removes the field. */
export function applyRowPatch(data: Record<string, JsonValue>, patch: Record<string, JsonValue>): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...data };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Rows and queries (wire types, contract §3.1)
// ---------------------------------------------------------------------------

export type DbScalar = string | number | boolean | null;

export interface DbRow<T = Record<string, JsonValue>> {
  id: string;
  data: T;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface DbRangeCondition {
  eq?: DbScalar;
  in?: DbScalar[];
  gt?: DbScalar;
  gte?: DbScalar;
  lt?: DbScalar;
  lte?: DbScalar;
}

/** A plain value means `eq`; `null` (or `eq: null`) finds rows without a value. */
export type DbCondition = DbScalar | DbRangeCondition;

/** Conditions on indexed fields (and createdAt, updatedAt, createdBy), combined with AND. */
export type DbWhere = Record<string, DbCondition>;

export interface DbOrderBy {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface DbQuery {
  where?: DbWhere;
  orderBy?: DbOrderBy;
  limit?: number;
  cursor?: string;
}

export interface DbQueryResult<T = Record<string, JsonValue>> {
  rows: DbRow<T>[];
  nextCursor: string | null;
}

/** How an indexed value is stored and compared (server: value_text / value_num / value_ts). */
export type DbIndexKind = 'text' | 'number' | 'boolean' | 'timestamp';

/** A field `where`/`orderBy` may use. */
export interface DbQueryableField {
  name: string;
  kind: DbIndexKind;
  /** Only `eq`/`in` (boolean, ref:*, createdBy). */
  equalityOnly: boolean;
  /** Present for collection fields; absent for createdAt/updatedAt/createdBy. */
  field?: FieldSchema;
}

/** Fields of a collection usable in `where` (indexed fields + createdAt/updatedAt/createdBy). */
export function queryableField(collection: CollectionSchema, name: string): DbQueryableField | null {
  if (name === 'createdAt' || name === 'updatedAt') return { name, kind: 'timestamp', equalityOnly: false };
  if (name === 'createdBy') return { name, kind: 'text', equalityOnly: true };
  const field = own(collection.fields, name) ? collection.fields[name] : undefined;
  if (!field || field.indexed !== true || !isIndexableField(field)) return null;
  switch (field.type) {
    case 'number':
      return { name, kind: 'number', equalityOnly: false, field };
    case 'boolean':
      return { name, kind: 'boolean', equalityOnly: true, field };
    case 'datetime':
      return { name, kind: 'timestamp', equalityOnly: false, field };
    case 'ref:project':
    case 'ref:task':
    case 'ref:user':
      return { name, kind: 'text', equalityOnly: true, field };
    default:
      return { name, kind: 'text', equalityOnly: false, field };
  }
}

/** One normalised condition: every value already in stored form. `null` = "has no value". */
export interface NormalizedDbCondition {
  field: string;
  kind: DbIndexKind;
  eq?: DbScalar;
  in?: DbScalar[];
  gt?: Exclude<DbScalar, null>;
  gte?: Exclude<DbScalar, null>;
  lt?: Exclude<DbScalar, null>;
  lte?: Exclude<DbScalar, null>;
}

export interface NormalizedDbQuery {
  where: NormalizedDbCondition[];
  orderBy: { field: string; kind: DbIndexKind; direction: 'asc' | 'desc' };
  limit: number;
  cursor: string | null;
  /** Canonical text of `where` + `orderBy`; a cursor is valid only for the same key. */
  key: string;
}

export type ValidateDbQueryResult = { ok: true; query: NormalizedDbQuery } | { ok: false; message: string };

const CONDITION_KEYS = new Set(['eq', 'in', 'gt', 'gte', 'lt', 'lte']);

function normalizeConditionValue(queryable: DbQueryableField, value: unknown): { ok: true; value: DbScalar } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (queryable.name === 'createdBy') return typeof value === 'string' && value.length > 0 ? { ok: true, value } : { ok: false };
  if (queryable.name === 'createdAt' || queryable.name === 'updatedAt') {
    const normalized = normalizeDbDatetime(value);
    return normalized ? { ok: true, value: normalized } : { ok: false };
  }
  const field = queryable.field!;
  if (field.type === 'string') return typeof value === 'string' ? { ok: true, value } : { ok: false };
  const checked = checkFieldValue(field, value);
  return checked.ok ? { ok: true, value: checked.value as DbScalar } : { ok: false };
}

/**
 * Validates `where`, `orderBy`, `limit` and the cursor's length for `db.query`/`db.count`
 * (contract §3.1). Failures are `invalid_params` with `message`. Values come back in stored form
 * (datetimes normalised, ref UUIDs lower-cased). The cursor itself is opaque to this function:
 * each implementation encodes and checks its own against `query.key`.
 */
export function validateDbQuery(collection: CollectionSchema, input: { where?: unknown; orderBy?: unknown; limit?: unknown; cursor?: unknown }): ValidateDbQueryResult {
  const fail = (message: string): ValidateDbQueryResult => ({ ok: false, message });
  const where: NormalizedDbCondition[] = [];
  if (input.where !== undefined && input.where !== null) {
    if (!isRecord(input.where)) return fail('where must be an object');
    const entries = Object.entries(input.where);
    if (entries.length > DATA_LIMITS.maxWhereFields) return fail(`where: at most ${DATA_LIMITS.maxWhereFields} fields`);
    for (const [name, raw] of entries) {
      const queryable = queryableField(collection, name);
      if (!queryable) return fail(`where.${name}: not an indexed field`);
      const condition: NormalizedDbCondition = { field: name, kind: queryable.kind };
      const spec: Record<string, unknown> = isRecord(raw) ? raw : { eq: raw };
      const keys = Object.keys(spec);
      if (keys.length === 0) return fail(`where.${name}: empty condition`);
      for (const key of keys) {
        if (!CONDITION_KEYS.has(key)) return fail(`where.${name}.${key}: unknown operator`);
        const value = spec[key];
        if (key === 'in') {
          if (!Array.isArray(value) || value.length > DATA_LIMITS.maxInValues) return fail(`where.${name}.in: an array of at most ${DATA_LIMITS.maxInValues} values`);
          const values: DbScalar[] = [];
          for (const item of value) {
            const normalized = normalizeConditionValue(queryable, item);
            if (!normalized.ok) return fail(`where.${name}.in: value does not match the field type`);
            values.push(normalized.value);
          }
          condition.in = values;
          continue;
        }
        if (key !== 'eq' && queryable.equalityOnly) return fail(`where.${name}.${key}: this field supports only eq and in`);
        const normalized = normalizeConditionValue(queryable, value);
        if (!normalized.ok) return fail(`where.${name}.${key}: value does not match the field type`);
        if (key === 'eq') condition.eq = normalized.value;
        else if (normalized.value === null) return fail(`where.${name}.${key}: ranges need a value`);
        else condition[key as 'gt' | 'gte' | 'lt' | 'lte'] = normalized.value;
      }
      where.push(condition);
    }
  }
  let orderBy: NormalizedDbQuery['orderBy'] = { field: 'createdAt', kind: 'timestamp', direction: 'desc' };
  if (input.orderBy !== undefined && input.orderBy !== null) {
    if (!isRecord(input.orderBy) || typeof input.orderBy.field !== 'string') return fail('orderBy must be { field, direction? }');
    for (const key of Object.keys(input.orderBy)) if (key !== 'field' && key !== 'direction') return fail(`orderBy.${key}: unknown option`);
    const direction = input.orderBy.direction ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc') return fail('orderBy.direction must be "asc" or "desc"');
    const name = input.orderBy.field;
    const queryable = name === 'createdBy' ? null : queryableField(collection, name);
    if (!queryable) return fail(`orderBy.field: ${name} is not an indexed field, createdAt or updatedAt`);
    orderBy = { field: name, kind: queryable.kind, direction };
  }
  let limit: number = DATA_LIMITS.defaultQueryLimit;
  if (input.limit !== undefined && input.limit !== null) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > DATA_LIMITS.maxQueryLimit) {
      return fail(`limit must be an integer from 1 to ${DATA_LIMITS.maxQueryLimit}`);
    }
    limit = input.limit as number;
  }
  let cursor: string | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    if (typeof input.cursor !== 'string' || input.cursor.length === 0 || input.cursor.length > DATA_LIMITS.maxCursorLength) return fail('cursor is not valid');
    cursor = input.cursor;
  }
  const sortedWhere = [...where].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  const key = JSON.stringify({ w: sortedWhere.map((c) => [c.field, c.eq, c.in, c.gt, c.gte, c.lt, c.lte]), o: [orderBy.field, orderBy.direction] });
  return { ok: true, query: { where: sortedWhere, orderBy, limit, cursor, key } };
}

/**
 * Orders two stored values of the same kind the way the server's index does: text by Unicode
 * code point (Postgres `COLLATE "C"`), numbers and booleans (false < true) numerically,
 * timestamps by instant (normalised ISO strings compare as text).
 */
export function compareDbValues(a: DbScalar, b: DbScalar): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  const left = Array.from(x);
  const right = Array.from(y);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

/** Whether a stored value (`undefined`/`null` = no value) satisfies a normalised condition. */
export function matchesDbCondition(value: DbScalar | undefined, condition: NormalizedDbCondition): boolean {
  const present = value !== undefined && value !== null;
  if (condition.eq !== undefined) {
    if (condition.eq === null ? present : !present || compareDbValues(value, condition.eq) !== 0) return false;
  }
  if (condition.in !== undefined) {
    const hit = condition.in.some((item) => (item === null ? !present : present && compareDbValues(value, item) === 0));
    if (!hit) return false;
  }
  for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
    const bound = condition[op];
    if (bound === undefined) continue;
    if (!present) return false;
    const diff = compareDbValues(value, bound);
    if ((op === 'gt' && !(diff > 0)) || (op === 'gte' && !(diff >= 0)) || (op === 'lt' && !(diff < 0)) || (op === 'lte' && !(diff <= 0))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Schema changes
// ---------------------------------------------------------------------------

export type DataChangeIssueCode =
  | 'data.version_not_bumped'
  | 'data.version_downgrade'
  | 'data.collection_removed'
  | 'data.field_removed'
  | 'data.type_changed'
  | 'data.scope_changed'
  | 'data.required_added'
  | 'data.constraint_tightened';

export interface DataChangeIssue {
  code: DataChangeIssueCode;
  /** e.g. `data.collections.decisions.fields.title`. */
  path: string;
  message: string;
}

export interface CompareDataSchemasResult {
  ok: boolean;
  issues: DataChangeIssue[];
  /** Whether the schemas differ (apart from `version`). */
  changed: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fieldChangeIssues(previous: FieldSchema, next: FieldSchema, path: string, issues: DataChangeIssue[]) {
  if (previous.type !== next.type) {
    issues.push({ code: 'data.type_changed', path, message: `Field type changed from ${previous.type} to ${next.type}.` });
    return;
  }
  if (!previous.required && next.required) issues.push({ code: 'data.required_added', path, message: 'An existing field became required.' });
  const tightened = (what: string) => issues.push({ code: 'data.constraint_tightened', path, message: `${what} would reject stored rows.` });
  if (previous.type === 'string' && next.type === 'string') {
    if ((next.maxLength ?? DATA_LIMITS.defaultStringMaxLength) < (previous.maxLength ?? DATA_LIMITS.defaultStringMaxLength)) tightened('A smaller maxLength');
    if (next.enum && (!previous.enum || previous.enum.some((value) => !next.enum!.includes(value)))) tightened('Removing enum values');
  }
  if (previous.type === 'number' && next.type === 'number') {
    if (next.integer && !previous.integer) tightened('Adding integer');
    if (next.max !== undefined && (previous.max === undefined || next.max < previous.max)) tightened('A smaller max');
    if (next.min !== undefined && (previous.min === undefined || next.min > previous.min)) tightened('A larger min');
  }
}

/**
 * Compares a stored data schema with a new one (install, version switch, reattaching retained
 * data). Additive changes apply automatically when `version` increases; destructive ones fail
 * until Phase 3 brings migrations. `previous` null/undefined (no stored data) is always ok.
 */
export function compareDataSchemas(previous: DataSchema | null | undefined, next: DataSchema | null | undefined): CompareDataSchemasResult {
  const issues: DataChangeIssue[] = [];
  if (!previous) return { ok: true, issues, changed: Boolean(next) };
  const nextCollections = next?.collections ?? {};
  const changed = canonical(previous.collections) !== canonical(nextCollections);
  if (next) {
    if (next.version < previous.version) {
      issues.push({ code: 'data.version_downgrade', path: 'data.version', message: `data.version went down from ${previous.version} to ${next.version}.` });
    } else if (changed && next.version === previous.version) {
      issues.push({ code: 'data.version_not_bumped', path: 'data.version', message: `The data schema changed but data.version is still ${previous.version}; increase it.` });
    }
  }
  for (const [name, before] of Object.entries(previous.collections)) {
    const path = `data.collections.${name}`;
    const after = own(nextCollections, name) ? nextCollections[name] : undefined;
    if (!after) {
      issues.push({ code: 'data.collection_removed', path, message: `Collection "${name}" was removed; its rows would be lost.` });
      continue;
    }
    if (before.scope !== after.scope) issues.push({ code: 'data.scope_changed', path: `${path}.scope`, message: `Scope changed from ${before.scope} to ${after.scope}.` });
    for (const [fieldName, field] of Object.entries(before.fields)) {
      const fieldPath = `${path}.fields.${fieldName}`;
      const nextField = own(after.fields, fieldName) ? after.fields[fieldName] : undefined;
      if (!nextField) issues.push({ code: 'data.field_removed', path: fieldPath, message: `Field "${fieldName}" was removed.` });
      else fieldChangeIssues(field, nextField, fieldPath, issues);
    }
    for (const [fieldName, field] of Object.entries(after.fields)) {
      if (!own(before.fields, fieldName) && field.required) {
        issues.push({ code: 'data.required_added', path: `${path}.fields.${fieldName}`, message: `New field "${fieldName}" is required; existing rows have no value.` });
      }
    }
  }
  return { ok: issues.length === 0, issues, changed };
}

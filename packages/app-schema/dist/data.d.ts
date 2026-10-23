import { z } from 'zod';
import type { JsonValue } from './json.js';
export declare const DATA_FIELD_TYPES: readonly ["string", "number", "boolean", "date", "datetime", "json", "ref:project", "ref:task", "ref:user"];
export type DataFieldType = (typeof DATA_FIELD_TYPES)[number];
export declare const DATA_SCOPES: readonly ["organization", "user"];
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
export declare const DB_META_FIELDS: readonly ["createdAt", "updatedAt", "createdBy"];
export type DbMetaField = (typeof DB_META_FIELDS)[number];
export declare const DATA_LIMITS: Readonly<{
    minVersion: 1;
    maxVersion: 1000000;
    maxCollections: 20;
    maxFields: 64;
    maxIndexedFields: 5;
    collectionNamePattern: RegExp;
    fieldNamePattern: RegExp;
    reservedFieldNames: readonly ["id", "createdAt", "updatedAt", "createdBy", "revision"];
    defaultStringMaxLength: 1000;
    maxStringMaxLength: 10000;
    maxIndexedStringLength: 512;
    maxEnumValues: 100;
    maxEnumValueLength: 100;
    maxLabelLength: 80;
    /** Serialised (UTF-8 JSON) size of one `json` field value. */
    maxJsonBytes: number;
    /** Serialised (UTF-8 JSON) size of a row's `data`. */
    maxRowBytes: number;
    /** `db.query` */
    defaultQueryLimit: 50;
    maxQueryLimit: 100;
    maxWhereFields: 5;
    maxInValues: 50;
    maxCursorLength: 512;
    /** Default quota (policy `db_row_limit`, `db_byte_limit`). */
    defaultRowLimit: 100000;
    defaultByteLimit: number;
}>;
export declare const DEFAULT_COLLECTION_RULES: Readonly<Required<CollectionRules>>;
/** The rules that apply to a collection (`user` collections: rows are only their owner's anyway). */
export declare function effectiveRules(collection: Pick<CollectionSchema, 'scope' | 'rules'>): Required<CollectionRules>;
/** Longest value a string field can hold: its enum's longest value, else `maxLength` (default 1000). */
export declare function effectiveMaxLength(field: StringFieldSchema): number;
/** Whether a field type may be `indexed` (json never; strings when their effective maxLength ≤ 512). */
export declare function isIndexableField(field: FieldSchema): boolean;
export type DataSchemaIssueCode = 'manifest.data_version' | 'manifest.data_collections_required' | 'manifest.data_collection_name' | 'manifest.data_collection_limit' | 'manifest.data_scope' | 'manifest.data_field_name' | 'manifest.data_field_reserved' | 'manifest.data_field_limit' | 'manifest.data_field_type' | 'manifest.data_field_option' | 'manifest.data_index_limit' | 'manifest.data_index_type' | 'manifest.data_rules' | 'manifest.unknown_field';
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
/** Issues of a manifest `data` value; paths start at the manifest root (`['data', …]`). */
export declare function dataSchemaIssues(data: unknown): DataSchemaIssueRaw[];
export type ValidateDataSchemaResult = {
    ok: true;
    data: DataSchema;
} | {
    ok: false;
    issues: DataSchemaIssue[];
};
/** Validates a manifest `data` value (the server also checks it again on upload). */
export declare function validateDataSchema(data: unknown): ValidateDataSchemaResult;
/** Structural zod schema of the manifest `data` section (used inside the manifest schema). */
export declare const dataStructureSchema: z.ZodObject<{
    version: z.ZodNumber;
    collections: z.ZodRecord<z.ZodString, z.ZodObject<{
        scope: z.ZodEnum<{
            user: "user";
            organization: "organization";
        }>;
        fields: z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            maxLength: z.ZodOptional<z.ZodNumber>;
            enum: z.ZodOptional<z.ZodArray<z.ZodString>>;
            required: z.ZodOptional<z.ZodBoolean>;
            indexed: z.ZodOptional<z.ZodBoolean>;
            label: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"string">;
        }, z.core.$strict>, z.ZodObject<{
            integer: z.ZodOptional<z.ZodBoolean>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            required: z.ZodOptional<z.ZodBoolean>;
            indexed: z.ZodOptional<z.ZodBoolean>;
            label: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"number">;
        }, z.core.$strict>, ...z.ZodObject<{
            required: z.ZodOptional<z.ZodBoolean>;
            indexed: z.ZodOptional<z.ZodBoolean>;
            label: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"boolean" | "date" | "datetime" | "json" | "ref:project" | "ref:task" | "ref:user">;
        }, z.core.$strict>[]], "type">>;
        rules: z.ZodOptional<z.ZodObject<{
            read: z.ZodOptional<z.ZodEnum<{
                any: "any";
                owner: "owner";
            }>>;
            update: z.ZodOptional<z.ZodEnum<{
                any: "any";
                owner: "owner";
            }>>;
            delete: z.ZodOptional<z.ZodEnum<{
                any: "any";
                owner: "owner";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Zod schema of the manifest `data` section, including every `manifest.data_*` rule. */
export declare const dataSchema: z.ZodType<DataSchema>;
export declare function isUuid(value: unknown): value is string;
/** `YYYY-MM-DD` naming a real calendar day. */
export declare function isDbDate(value: unknown): value is string;
/** Normalises an ISO date-time with an offset (`Z` or `±hh:mm`) to `toISOString()` form, or null. */
export declare function normalizeDbDatetime(value: unknown): string | null;
/** UTF-8 size of a value's JSON text (rows are measured this way for limits and quota). */
export declare function jsonByteSize(value: JsonValue): number;
export type RowIssueCode = 'row.unknown_field' | 'row.required' | 'row.type' | 'row.max_length' | 'row.range' | 'row.enum' | 'row.not_integer' | 'row.json_too_large' | 'row.too_large';
export interface RowIssue {
    code: RowIssueCode;
    /** `data` or `data.<field>`. */
    path: string;
    message: string;
}
export type ValidateRowResult = {
    ok: true;
    data: Record<string, JsonValue>;
} | {
    ok: false;
    issues: RowIssue[];
};
type ValueCheck = {
    ok: true;
    value: JsonValue;
} | {
    ok: false;
    code: RowIssueCode;
    message: string;
};
/**
 * Checks one non-null value against its field and returns the stored form (`datetime` normalised
 * to UTC `toISOString()`, ref UUIDs lower-cased).
 */
export declare function checkFieldValue(field: FieldSchema, value: unknown): ValueCheck;
/**
 * Validates row data for a collection (contract §1). Full rows (`insert`, or a merged update):
 * required fields must be present and non-null; `null` values are dropped from the result (a
 * missing value and `null` are the same). With `{ partial: true }` (an update `patch`) only the
 * given fields are checked and `null` stays in the result, meaning "clear this field"; clearing a
 * required field is `row.required`. The result is the stored form of the data.
 */
export declare function validateRow(collection: CollectionSchema, data: unknown, options?: {
    partial?: boolean;
}): ValidateRowResult;
/** `"data.title: row.required"`: the RPC / HTTP `message` for a failed row validation. */
export declare function rowIssueMessage(issues: readonly RowIssue[]): string;
/** Shallow merge of an update patch over stored data: `null` removes the field. */
export declare function applyRowPatch(data: Record<string, JsonValue>, patch: Record<string, JsonValue>): Record<string, JsonValue>;
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
export declare function queryableField(collection: CollectionSchema, name: string): DbQueryableField | null;
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
    orderBy: {
        field: string;
        kind: DbIndexKind;
        direction: 'asc' | 'desc';
    };
    limit: number;
    cursor: string | null;
    /** Canonical text of `where` + `orderBy`; a cursor is valid only for the same key. */
    key: string;
}
export type ValidateDbQueryResult = {
    ok: true;
    query: NormalizedDbQuery;
} | {
    ok: false;
    message: string;
};
/**
 * Validates `where`, `orderBy`, `limit` and the cursor's length for `db.query`/`db.count`
 * (contract §3.1). Failures are `invalid_params` with `message`. Values come back in stored form
 * (datetimes normalised, ref UUIDs lower-cased). The cursor itself is opaque to this function:
 * each implementation encodes and checks its own against `query.key`.
 */
export declare function validateDbQuery(collection: CollectionSchema, input: {
    where?: unknown;
    orderBy?: unknown;
    limit?: unknown;
    cursor?: unknown;
}): ValidateDbQueryResult;
/**
 * Orders two stored values of the same kind the way the server's index does: text by Unicode
 * code point (Postgres `COLLATE "C"`), numbers and booleans (false < true) numerically,
 * timestamps by instant (normalised ISO strings compare as text).
 */
export declare function compareDbValues(a: DbScalar, b: DbScalar): number;
/** Whether a stored value (`undefined`/`null` = no value) satisfies a normalised condition. */
export declare function matchesDbCondition(value: DbScalar | undefined, condition: NormalizedDbCondition): boolean;
export type DataChangeIssueCode = 'data.version_not_bumped' | 'data.version_downgrade' | 'data.collection_removed' | 'data.field_removed' | 'data.type_changed' | 'data.scope_changed' | 'data.required_added' | 'data.constraint_tightened';
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
/**
 * Compares a stored data schema with a new one (install, version switch, reattaching retained
 * data). Additive changes apply automatically when `version` increases; destructive ones fail
 * until Phase 3 brings migrations. `previous` null/undefined (no stored data) is always ok.
 */
export declare function compareDataSchemas(previous: DataSchema | null | undefined, next: DataSchema | null | undefined): CompareDataSchemasResult;
export {};

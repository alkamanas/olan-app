/** Relative path of the committed JSON Schema file inside this package. */
export declare const MANIFEST_JSON_SCHEMA_FILE = "schemas/olan-app.v1.json";
/**
 * JSON Schema (draft 2020-12) for `olan-app.json` as authors write it.
 * Cross-field rules (kind-specific fields, duplicates) are only enforced by
 * `validateManifest`; the JSON Schema covers structure and formats.
 */
export declare function manifestJsonSchema(): Record<string, unknown>;
/** Serialised form written to `schemas/olan-app.v1.json`. */
export declare function manifestJsonSchemaText(): string;

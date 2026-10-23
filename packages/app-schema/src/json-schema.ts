import { z } from 'zod';
import { MANIFEST_SCHEMA_URL, RESERVED_MANIFEST_FIELDS, manifestBaseSchema } from './manifest.js';

/** Relative path of the committed JSON Schema file inside this package. */
export const MANIFEST_JSON_SCHEMA_FILE = 'schemas/olan-app.v1.json';

/**
 * JSON Schema (draft 2020-12) for `olan-app.json` as authors write it.
 * Cross-field rules (kind-specific fields, duplicates) are only enforced by
 * `validateManifest`; the JSON Schema covers structure and formats.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(manifestBaseSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  const { $schema, ...rest } = schema;
  // Reserved fields are listed (so editors explain them) but may not appear: `not: {}`.
  const properties: Record<string, unknown> = { ...(rest.properties as Record<string, unknown>) };
  rest.properties = properties;
  for (const reserved of Object.values(RESERVED_MANIFEST_FIELDS)) {
    properties[reserved.field] = {
      description: `Reserved for ${reserved.feature}; arrives in Olan Apps ${reserved.phase} and is not available in schema version 1.`,
      not: {},
    };
  }
  return {
    $schema,
    $id: MANIFEST_SCHEMA_URL,
    title: 'Olan app manifest (olan-app.json), schema version 1',
    description:
      'Manifest of an Olan app package. Cross-field rules (entry/url per kind, web-link restrictions, duplicate permissions, data limits such as at most 5 indexed fields, remote URLs, event and tool permissions) are checked by `olan-app validate`.',
    ...rest,
  };
}

/** Serialised form written to `schemas/olan-app.v1.json`. */
export function manifestJsonSchemaText(): string {
  return `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
}

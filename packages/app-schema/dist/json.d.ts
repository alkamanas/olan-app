import { z } from 'zod';
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/** Any JSON-serialisable value. Numbers must be finite. */
export declare const jsonValueSchema: z.ZodType<JsonValue>;
export declare const jsonObjectSchema: z.ZodType<Record<string, JsonValue>>;

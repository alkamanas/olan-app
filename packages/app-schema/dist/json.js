import { z } from 'zod';
/** Any JSON-serialisable value. Numbers must be finite. */
export const jsonValueSchema = z.lazy(() => z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
]));
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

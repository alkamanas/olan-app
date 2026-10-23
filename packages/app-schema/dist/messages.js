import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from './json.js';
import { uiPatchSchema } from './ui.js';
import { SURFACES } from './versions.js';
/*
 * Sandbox <-> host messages (contract §4). Everything is JSON-serialisable
 * and travels over a MessageChannel port.
 */
export const THEMES = ['light', 'dark'];
export const PLATFORMS = ['web', 'desktop', 'ios', 'android'];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const counter = z.number().int().nonnegative();
export const appContextSchema = z.strictObject({
    theme: z.enum(THEMES),
    locale: z.string().min(1),
    platform: z.enum(PLATFORMS),
    permissions: z.array(z.string()),
    settings: jsonObjectSchema,
    development: z.boolean(),
    user: z.strictObject({ id: z.string().min(1).max(128) }),
});
export const sandboxMessageSchema = z.discriminatedUnion('type', [
    // protocolVersion is any positive integer so the host can reject newer protocols with a clear message.
    z.strictObject({ type: z.literal('ready'), sdkVersion: z.string().min(1), protocolVersion: z.number().int().positive() }),
    z.strictObject({ type: z.literal('patches'), seq: counter, patches: z.array(uiPatchSchema) }),
    z.strictObject({ type: z.literal('rpc'), id: counter, method: z.string().min(1), params: jsonValueSchema }),
    z.strictObject({ type: z.literal('log'), level: z.enum(LOG_LEVELS), args: z.array(jsonValueSchema) }),
    z.strictObject({ type: z.literal('error'), message: z.string(), stack: z.string().optional(), fatal: z.boolean().optional() }),
]);
export const hostMessageSchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('init'),
        app: z.strictObject({ id: z.string().min(1), version: z.string().min(1), installationId: z.string().min(1).nullable() }),
        surface: z.enum(SURFACES),
        params: jsonValueSchema,
        context: appContextSchema,
        navigation: z.strictObject({ screen: z.string().min(1).max(64), params: jsonValueSchema }).optional(),
    }),
    z.strictObject({ type: z.literal('event'), handlerId: counter, payload: jsonValueSchema }),
    z.discriminatedUnion('ok', [
        z.strictObject({ type: z.literal('rpc-result'), id: counter, ok: z.literal(true), result: jsonValueSchema }),
        z.strictObject({
            type: z.literal('rpc-result'),
            id: counter,
            ok: z.literal(false),
            error: z.strictObject({ code: z.string().min(1), message: z.string(), details: jsonValueSchema.optional() }),
        }),
    ]),
    z.strictObject({ type: z.literal('context'), context: appContextSchema.partial(), params: jsonValueSchema.optional() }),
    z.strictObject({ type: z.literal('navigation'), action: z.enum(['pop', 'back']) }),
    z.strictObject({ type: z.literal('upload-progress'), uploadId: z.string().min(1), loaded: counter, total: counter }),
    z.strictObject({ type: z.literal('timer'), timerId: z.string().min(1) }),
]);

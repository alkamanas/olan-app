import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema, type JsonValue } from './json.js';
import { uiPatchSchema, type UiPatch } from './ui.js';
import { SURFACES, type Surface } from './versions.js';

/*
 * Sandbox <-> host messages (contract §4). Everything is JSON-serialisable
 * and travels over a MessageChannel port.
 */

export const THEMES = ['light', 'dark'] as const;
export const PLATFORMS = ['web', 'desktop', 'ios', 'android'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type Theme = (typeof THEMES)[number];
export type HostPlatform = (typeof PLATFORMS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The person using the app (Phase 2 server contract §10.1). `id` is the central Olan user id
 * (`users.id`, a UUID): the same value as `createdBy`, `assigneeId` and `ownerUserId` in every
 * app. Needs no permission; names and directory details come from `users.get` (`users:read`).
 */
export interface AppUser {
  id: string;
}

export interface AppContext {
  theme: Theme;
  locale: string;
  platform: HostPlatform;
  permissions: string[];
  settings: Record<string, JsonValue>;
  development: boolean;
  user: AppUser;
}

export interface AppIdentity {
  id: string;
  version: string;
  installationId: string | null;
}

// sandbox -> host
export type ReadyMessage = { type: 'ready'; sdkVersion: string; protocolVersion: number };
export type PatchesMessage = { type: 'patches'; seq: number; patches: UiPatch[] };
export type RpcMessage = { type: 'rpc'; id: number; method: string; params: JsonValue };
export type LogMessage = { type: 'log'; level: LogLevel; args: JsonValue[] };
export type ErrorMessage = { type: 'error'; message: string; stack?: string; fatal?: boolean };
export type SandboxMessage = ReadyMessage | PatchesMessage | RpcMessage | LogMessage | ErrorMessage;

// host -> sandbox
/**
 * `navigation` (Phase 5a §8, optional): the first screen and its params from a permanent app address
 * (`/apps/a/<appId>/<screen>?…`). `index` gives the first screen these params; another screen is
 * pushed over the first one.
 */
export type InitMessage = { type: 'init'; app: AppIdentity; surface: Surface; params: JsonValue; context: AppContext; navigation?: { screen: string; params: JsonValue } };
export type EventMessage = { type: 'event'; handlerId: number; payload: JsonValue };
/** `details` (Phase 5a §1.6, optional): machine-readable extras, e.g. `RemoteErrorDetails` of `remote.request`. */
export type RpcError = { code: string; message: string; details?: JsonValue };
export type RpcResultMessage =
  | { type: 'rpc-result'; id: number; ok: true; result: JsonValue }
  | { type: 'rpc-result'; id: number; ok: false; error: RpcError };
/**
 * Changed host context. Panels (`mail.sidebar`, `meeting.panel`) stay alive when the person opens
 * another object: the host then sends the new `params` here instead of a new `init` (Phase 3 §3.1).
 */
export type ContextMessage = { type: 'context'; context: Partial<AppContext>; params?: JsonValue };
export type NavigationMessage = { type: 'navigation'; action: 'pop' | 'back' };
/** Progress of a running `files.upload` (Phase 5a §3.2): at most every 250 ms, plus a final one. */
export type UploadProgressMessage = { type: 'upload-progress'; uploadId: string; loaded: number; total: number };
/** A tick of a `timers.set` timer (Phase 5a §7); none while the surface is not visible. */
export type TimerMessage = { type: 'timer'; timerId: string };
export type HostMessage = InitMessage | EventMessage | RpcResultMessage | ContextMessage | NavigationMessage | UploadProgressMessage | TimerMessage;

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

export const sandboxMessageSchema: z.ZodType<SandboxMessage> = z.discriminatedUnion('type', [
  // protocolVersion is any positive integer so the host can reject newer protocols with a clear message.
  z.strictObject({ type: z.literal('ready'), sdkVersion: z.string().min(1), protocolVersion: z.number().int().positive() }),
  z.strictObject({ type: z.literal('patches'), seq: counter, patches: z.array(uiPatchSchema) }),
  z.strictObject({ type: z.literal('rpc'), id: counter, method: z.string().min(1), params: jsonValueSchema }),
  z.strictObject({ type: z.literal('log'), level: z.enum(LOG_LEVELS), args: z.array(jsonValueSchema) }),
  z.strictObject({ type: z.literal('error'), message: z.string(), stack: z.string().optional(), fatal: z.boolean().optional() }),
]);

export const hostMessageSchema: z.ZodType<HostMessage> = z.discriminatedUnion('type', [
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

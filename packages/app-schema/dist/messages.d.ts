import { z } from 'zod';
import { type JsonValue } from './json.js';
import { type UiPatch } from './ui.js';
import { type Surface } from './versions.js';
export declare const THEMES: readonly ["light", "dark"];
export declare const PLATFORMS: readonly ["web", "desktop", "ios", "android"];
export declare const LOG_LEVELS: readonly ["debug", "info", "warn", "error"];
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
export type ReadyMessage = {
    type: 'ready';
    sdkVersion: string;
    protocolVersion: number;
};
export type PatchesMessage = {
    type: 'patches';
    seq: number;
    patches: UiPatch[];
};
export type RpcMessage = {
    type: 'rpc';
    id: number;
    method: string;
    params: JsonValue;
};
export type LogMessage = {
    type: 'log';
    level: LogLevel;
    args: JsonValue[];
};
export type ErrorMessage = {
    type: 'error';
    message: string;
    stack?: string;
    fatal?: boolean;
};
export type SandboxMessage = ReadyMessage | PatchesMessage | RpcMessage | LogMessage | ErrorMessage;
/**
 * `navigation` (Phase 5a §8, optional): the first screen and its params from a permanent app address
 * (`/apps/a/<appId>/<screen>?…`). `index` gives the first screen these params; another screen is
 * pushed over the first one.
 */
export type InitMessage = {
    type: 'init';
    app: AppIdentity;
    surface: Surface;
    params: JsonValue;
    context: AppContext;
    navigation?: {
        screen: string;
        params: JsonValue;
    };
};
export type EventMessage = {
    type: 'event';
    handlerId: number;
    payload: JsonValue;
};
/** `details` (Phase 5a §1.6, optional): machine-readable extras, e.g. `RemoteErrorDetails` of `remote.request`. */
export type RpcError = {
    code: string;
    message: string;
    details?: JsonValue;
};
export type RpcResultMessage = {
    type: 'rpc-result';
    id: number;
    ok: true;
    result: JsonValue;
} | {
    type: 'rpc-result';
    id: number;
    ok: false;
    error: RpcError;
};
/**
 * Changed host context. Panels (`mail.sidebar`, `meeting.panel`) stay alive when the person opens
 * another object: the host then sends the new `params` here instead of a new `init` (Phase 3 §3.1).
 */
export type ContextMessage = {
    type: 'context';
    context: Partial<AppContext>;
    params?: JsonValue;
};
export type NavigationMessage = {
    type: 'navigation';
    action: 'pop' | 'back';
};
/** Progress of a running `files.upload` (Phase 5a §3.2): at most every 250 ms, plus a final one. */
export type UploadProgressMessage = {
    type: 'upload-progress';
    uploadId: string;
    loaded: number;
    total: number;
};
/** A tick of a `timers.set` timer (Phase 5a §7); none while the surface is not visible. */
export type TimerMessage = {
    type: 'timer';
    timerId: string;
};
export type HostMessage = InitMessage | EventMessage | RpcResultMessage | ContextMessage | NavigationMessage | UploadProgressMessage | TimerMessage;
export declare const appContextSchema: z.ZodObject<{
    theme: z.ZodEnum<{
        light: "light";
        dark: "dark";
    }>;
    locale: z.ZodString;
    platform: z.ZodEnum<{
        web: "web";
        desktop: "desktop";
        ios: "ios";
        android: "android";
    }>;
    permissions: z.ZodArray<z.ZodString>;
    settings: z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>;
    development: z.ZodBoolean;
    user: z.ZodObject<{
        id: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const sandboxMessageSchema: z.ZodType<SandboxMessage>;
export declare const hostMessageSchema: z.ZodType<HostMessage>;

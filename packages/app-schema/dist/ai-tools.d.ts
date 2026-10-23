import type { JsonValue } from './json.js';
import type { EmbeddedAppToken } from './remote.js';
import type { ProfileRole } from './remote-requests.js';
export declare const AI_TOOL_LIMITS: Readonly<{
    /** Tools per app. */
    toolsPerApp: 16;
    /** Tools listed per person (all apps). */
    toolsPerPerson: 32;
    titleMax: 80;
    descriptionMax: 1024;
    /** `input` JSON Schema, serialised. */
    inputSchemaBytes: number;
    /** Response body. */
    resultBytes: number;
    summaryMax: 500;
    /** Default call timeout, and the most a `readOnly` tool may set. */
    timeoutMs: 15000;
    /** Phase 5a (G21): the most a tool's own `timeoutMs` may be. */
    maxTimeoutMs: 60000;
    minTimeoutMs: 1000;
    callsPerPersonPerMinute: 30;
}>;
/** A tool's manifest name: `^[a-z][a-z0-9_]{1,31}$`, unique in the app. */
export declare const AI_TOOL_NAME_PATTERN: RegExp;
/** Exposed names (MCP and Anthropic tool names): `^[a-z][a-z0-9_]{2,63}$`. */
export declare const EXPOSED_TOOL_NAME_PATTERN: RegExp;
/** Prefix reserved for app tools; Olan's own catalogue tools never start with it. */
export declare const APP_TOOL_PREFIX = "app_";
/** Manifest `ai.tools[]` entry (parsed: `readOnly`/`destructive` default to `false`). */
export interface AiToolDefinition {
    name: string;
    /** ≤ 80; shown on the confirmation card. */
    title?: string;
    /** 1–1024; goes to the model. */
    description: string;
    /** JSON Schema 2020-12 with `type: "object"` at the root (≤ 8 KiB, no external `$ref`). */
    input: Record<string, JsonValue>;
    /** Subset of the manifest permissions; the call's token carries only these. */
    permissions: string[];
    readOnly: boolean;
    destructive: boolean;
    /** Phase 5a (G21): call timeout, 1000–60000 (`readOnly` tools ≤ 15000); default 15000. */
    timeoutMs?: number;
}
/** The timeout Olan applies to a tool call (`timeoutMs`, else 15 s). */
export declare function aiToolTimeoutMs(tool: Pick<AiToolDefinition, 'timeoutMs'>): number;
export interface ManifestAi {
    tools?: AiToolDefinition[];
}
/** `[a-z0-9]` of the last segment of the app id, ≤ 16 (`com.example.team-standup` → `teamstandup`). */
export declare function appToolSlug(appId: string): string;
/**
 * Exposed name of an app tool (§6): `app_<slug>_<name>`. When two installations of one person
 * would expose the same name, pass `collision: installationId`: the name ends with
 * `_<first 4 hex of the installation id>`. Always ≤ 64 and matches `EXPOSED_TOOL_NAME_PATTERN`.
 */
export declare function appToolName(appId: string, toolName: string, options?: {
    collision?: string | null;
}): string;
export declare function isAppToolName(name: unknown): boolean;
/** `[<App name>] <description>`: the description the model sees. */
export declare function appToolDescription(appName: string, description: string): string;
export type AiToolChannel = 'assistant' | 'mcp';
/** Body of `POST {remote.url}/ai-tools/{name}`. */
export interface AiToolCallRequest {
    /** `call_<uuid>`; also the `webhook-id`. A read-only tool is retried once with the same id. */
    id: string;
    /** The manifest tool name. */
    tool: string;
    installationId: string;
    appId: string;
    issuer: string;
    channel: AiToolChannel;
    /** `email`, `displayName` and `role` only when the person consented to `profile:read`. */
    user: {
        id: string;
        locale: string;
        timeZone: string;
        email?: string;
        displayName?: string;
        role?: ProfileRole;
    };
    input: Record<string, JsonValue>;
    /** On behalf of the person; permissions = the tool's `permissions` ∩ the person's effective ones. */
    token: EmbeddedAppToken;
}
/** Response body (HTTP 200, ≤ 64 KiB). */
export type AiToolCallResponse = {
    ok: true;
    result: JsonValue;
    summary?: string;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
/** Errors Olan reports for an app tool call (`app_tool_timeout` after `aiToolTimeoutMs(tool)`). */
export declare const AI_TOOL_ERROR_CODES: readonly ["app_tool_timeout", "app_tool_failed", "app_tool_result_too_large", "app_tool_unavailable"];
export type AiToolErrorCode = (typeof AI_TOOL_ERROR_CODES)[number];
/** Problems of an `ai.tools[].input` JSON Schema (empty when it is acceptable). */
export declare function aiToolInputProblems(input: unknown): string[];

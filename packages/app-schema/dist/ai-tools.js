/*
 * Assistant tools (`ai.tools`, Phase 3 contract §6). In Phase 3 the app's own server runs them:
 * `POST {remote.url}/ai-tools/{name}`, signed like events (§5.3).
 */
export const AI_TOOL_LIMITS = Object.freeze({
    /** Tools per app. */
    toolsPerApp: 16,
    /** Tools listed per person (all apps). */
    toolsPerPerson: 32,
    titleMax: 80,
    descriptionMax: 1024,
    /** `input` JSON Schema, serialised. */
    inputSchemaBytes: 8 * 1024,
    /** Response body. */
    resultBytes: 64 * 1024,
    summaryMax: 500,
    /** Default call timeout, and the most a `readOnly` tool may set. */
    timeoutMs: 15_000,
    /** Phase 5a (G21): the most a tool's own `timeoutMs` may be. */
    maxTimeoutMs: 60_000,
    minTimeoutMs: 1_000,
    callsPerPersonPerMinute: 30,
});
/** A tool's manifest name: `^[a-z][a-z0-9_]{1,31}$`, unique in the app. */
export const AI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
/** Exposed names (MCP and Anthropic tool names): `^[a-z][a-z0-9_]{2,63}$`. */
export const EXPOSED_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
/** Prefix reserved for app tools; Olan's own catalogue tools never start with it. */
export const APP_TOOL_PREFIX = 'app_';
const SLUG_MAX = 16;
/** The timeout Olan applies to a tool call (`timeoutMs`, else 15 s). */
export function aiToolTimeoutMs(tool) {
    return typeof tool.timeoutMs === 'number' ? tool.timeoutMs : AI_TOOL_LIMITS.timeoutMs;
}
/** `[a-z0-9]` of the last segment of the app id, ≤ 16 (`com.example.team-standup` → `teamstandup`). */
export function appToolSlug(appId) {
    const last = appId.split('.').pop() ?? '';
    const slug = last.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, SLUG_MAX);
    return slug.length > 0 ? slug : 'app';
}
/**
 * Exposed name of an app tool (§6): `app_<slug>_<name>`. When two installations of one person
 * would expose the same name, pass `collision: installationId`: the name ends with
 * `_<first 4 hex of the installation id>`. Always ≤ 64 and matches `EXPOSED_TOOL_NAME_PATTERN`.
 */
export function appToolName(appId, toolName, options = {}) {
    const base = `${APP_TOOL_PREFIX}${appToolSlug(appId)}_${toolName}`;
    if (!options.collision)
        return base.slice(0, 64);
    const hex = options.collision.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 4) || '0000';
    return `${base.slice(0, 64 - 5)}_${hex}`;
}
export function isAppToolName(name) {
    return typeof name === 'string' && name.startsWith(APP_TOOL_PREFIX);
}
/** `[<App name>] <description>`: the description the model sees. */
export function appToolDescription(appName, description) {
    return `[${appName}] ${description}`;
}
/** Errors Olan reports for an app tool call (`app_tool_timeout` after `aiToolTimeoutMs(tool)`). */
export const AI_TOOL_ERROR_CODES = ['app_tool_timeout', 'app_tool_failed', 'app_tool_result_too_large', 'app_tool_unavailable'];
/** Problems of an `ai.tools[].input` JSON Schema (empty when it is acceptable). */
export function aiToolInputProblems(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
        return ['input must be a JSON Schema object'];
    const problems = [];
    if (input.type !== 'object')
        problems.push('input must have "type": "object" at the root');
    let size = 0;
    try {
        size = new TextEncoder().encode(JSON.stringify(input)).length;
    }
    catch {
        return ['input must be JSON'];
    }
    if (size > AI_TOOL_LIMITS.inputSchemaBytes)
        problems.push(`input is ${size} bytes; at most ${AI_TOOL_LIMITS.inputSchemaBytes}`);
    const visit = (value, path) => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(item, `${path}[${index}]`));
            return;
        }
        if (typeof value !== 'object' || value === null)
            return;
        for (const [key, child] of Object.entries(value)) {
            if ((key === '$ref' || key === '$dynamicRef') && (typeof child !== 'string' || !child.startsWith('#'))) {
                problems.push(`${path}.${key}: only local references ("#/…") are allowed`);
            }
            visit(child, `${path}.${key}`);
        }
    };
    visit(input, 'input');
    return problems;
}

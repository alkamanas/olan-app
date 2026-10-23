import { backendHookResponse } from '@olan-app/schema';
import type { JsonValue } from '@olan-app/runtime';

/** The request a hook function receives (`BackendHookRequest`): lower-case headers, raw body. */
export interface HookRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  query: Record<string, string>;
}

/** Lower-cases header names (first value of repeated headers). */
export function normalizeHeaders(headers: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : String(value);
  }
  return out;
}

export interface HookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** HTTP status of a failed hook function by its `backend.call` error code (as on the Olan server). */
const HOOK_ERROR_STATUS: Record<string, number> = {
  backend_function_not_found: 404,
  backend_error: 500,
  backend_limit: 503,
  backend_busy: 429,
  payload_too_large: 413,
  backend_unavailable: 503,
};

/**
 * The HTTP answer for a hook function's result, the same rule as the Olan server
 * (`backendHookResponse`, Phase 3 §8.1): `{ status, headers?, body? }` with status 200–599 is
 * answered (a string body as is, any other JSON value serialised as JSON; only `content-type`,
 * `cache-control`, `etag`, `last-modified` and `x-*` headers), anything else `202`. A failed
 * function answers its error (`500 backend_error`, `503 backend_limit`, …).
 */
export function hookResponse(outcome: { ok: true; value: JsonValue } | { ok: false; error?: { code: string; message: string } }): HookResponse {
  if (!outcome.ok) {
    const code = outcome.error?.code ?? 'backend_error';
    return { status: HOOK_ERROR_STATUS[code] ?? 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: code, message: outcome.error?.message ?? '' }) };
  }
  return backendHookResponse(outcome.value);
}

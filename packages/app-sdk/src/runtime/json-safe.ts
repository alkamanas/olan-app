import type { JsonValue } from '../protocol';

const MAX_DEPTH = 6;
const MAX_ITEMS = 100;
const MAX_STRING = 10_000;

/** A JSON copy of any value for `log` messages: errors, functions and cycles become readable text. */
export function toJsonSafe(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null || value === undefined) return value === null ? null : '[undefined]';
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value}n`;
    case 'function':
      return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
    case 'symbol':
      return value.toString();
    default:
      break;
  }
  const object = value as object;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null };
  if (value instanceof Date) return value.toISOString();
  if (seen.has(object)) return '[Circular]';
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(object);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => toJsonSafe(item, depth + 1, seen));
    if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`);
    return items;
  }
  const out: Record<string, JsonValue> = {};
  let count = 0;
  for (const key of Object.keys(object)) {
    if (count++ >= MAX_ITEMS) {
      out['…'] = 'more keys';
      break;
    }
    out[key] = toJsonSafe((object as Record<string, unknown>)[key], depth + 1, seen);
  }
  return out;
}

export function errorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name, ...(error.stack ? { stack: error.stack } : {}) };
  return { message: typeof error === 'string' ? error : JSON.stringify(toJsonSafe(error)) };
}

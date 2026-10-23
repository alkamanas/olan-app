import type { JsonValue, PropValue } from '../protocol';

/** Allocates and frees handler ids; implemented by the UI root (one registry per root). */
export interface HandlerAllocator {
  register(fn: (payload: JsonValue) => unknown): number;
  update(id: number, fn: (payload: JsonValue) => unknown): void;
  release(id: number): void;
}

/**
 * Handler ids of one node, keyed by the prop path that holds the function (`onPress`,
 * `actions.0.onPress`). Keeping the id per path means a new arrow function on every render
 * reuses the id and produces no patch.
 */
export type HandlerSlots = Map<string, number>;

/** Props that never cross the wire. */
const RESERVED = new Set(['children', 'key', 'ref']);

/**
 * Converts React props into wire props: functions become `{ $handler: id }`, `undefined` entries
 * are dropped, non-finite numbers become `null`, dates become ISO strings. Slots for paths that
 * no longer hold a function are released.
 */
export function serializeProps(props: Record<string, unknown>, slots: HandlerSlots, handlers: HandlerAllocator): Record<string, PropValue> {
  const seen = new Set<string>();
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(props)) {
    if (RESERVED.has(key)) continue;
    const value = serializeValue(props[key], key, slots, handlers, seen, 0);
    if (value !== undefined) out[key] = value;
  }
  for (const [path, id] of slots) {
    if (!seen.has(path)) {
      handlers.release(id);
      slots.delete(path);
    }
  }
  return out;
}

const MAX_DEPTH = 32;

function serializeValue(
  value: unknown,
  path: string,
  slots: HandlerSlots,
  handlers: HandlerAllocator,
  seen: Set<string>,
  depth: number,
): PropValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'function': {
      const fn = value as (payload: JsonValue) => unknown;
      seen.add(path);
      const existing = slots.get(path);
      if (existing !== undefined) {
        handlers.update(existing, fn);
        return { $handler: existing };
      }
      const id = handlers.register(fn);
      slots.set(path, id);
      return { $handler: id };
    }
    case 'object':
      break;
    default:
      // undefined and symbols are dropped.
      return undefined;
  }
  if (depth >= MAX_DEPTH) throw new Error(`Prop "${path}" is nested too deeply to send to the host`);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item, index) => serializeValue(item, `${path}.${index}`, slots, handlers, seen, depth + 1) ?? null);
  }
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(value as object)) {
    const item = serializeValue((value as Record<string, unknown>)[key], `${path}.${key}`, slots, handlers, seen, depth + 1);
    if (item !== undefined) out[key] = item;
  }
  return out;
}

/** Structural equality for wire values. */
export function propEquals(a: PropValue | undefined, b: PropValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!propEquals(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const bo = b as Record<string, PropValue>;
  for (const key of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!propEquals((a as Record<string, PropValue>)[key], bo[key])) return false;
  }
  return true;
}

/** The keys to set and unset to turn `prev` into `next`; `null` when nothing changed. */
export function diffProps(prev: Record<string, PropValue>, next: Record<string, PropValue>): { set: Record<string, PropValue>; unset: string[] } | null {
  const set: Record<string, PropValue> = {};
  const unset: string[] = [];
  let changed = false;
  for (const key of Object.keys(next)) {
    if (!propEquals(prev[key], next[key])) {
      set[key] = next[key];
      changed = true;
    }
  }
  for (const key of Object.keys(prev)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      unset.push(key);
      changed = true;
    }
  }
  return changed ? { set, unset } : null;
}

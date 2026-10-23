/**
 * Engine contract tests (§15.2 "Sözleşme test paketi"). Every {@link AppRuntime} (both engines,
 * and the process client) must pass them:
 *
 * ```ts
 * import { runContractSuite } from '@olan-app/runtime/contract-suite';
 * runContractSuite('isolated-vm', () => createRuntime({ engine: 'isolated-vm' }));
 * ```
 *
 * Requires vitest. Limits are kept small so the suite stays fast.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppRuntime, HostCall, InvocationKind, InvocationRequest, InvocationResult, JsonValue, RuntimeLimits } from './types.js';

/** A hand-written stand-in for an esbuild IIFE (`globalName: '__olanBackendModule'`). */
export const CONTRACT_BUNDLE = String.raw`"use strict";
var __olanBackendModule = (() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const definition = {
    functions: {
      echo: (args, ctx) => ({ args, installationId: ctx.installationId, appId: ctx.appId, identity: ctx.identity, hasSignal: typeof ctx.signal === 'object' }),
      hostEcho: async (args) => JSON.parse(await __olan.call('echo', JSON.stringify(args))),
      hostFail: async () => {
        try { await __olan.call('forbidden', '{}'); return 'no error'; }
        catch (error) { return { isError: error instanceof Error, code: error.code, message: error.message }; }
      },
      jsonOnly: () => ({ date: new Date(0), fn() {}, missing: undefined, list: [1, undefined, () => 1], nan: NaN }),
      undefinedResult: () => undefined,
      bigint: () => 1n,
      throws: () => { throw new TypeError('bad input'); },
      rejects: async () => { throw 'plain string'; },
      loop: () => { for (;;) {} },
      loopAfterAwait: async () => { await __olan.call('echo', '1'); for (;;) {} },
      loopInTimer: async () => { await new Promise(() => setTimeout(() => { for (;;) {} }, 1)); },
      alloc: () => { const keep = []; for (let i = 0; ; i++) keep.push(new Array(65536).fill(i)); },
      hang: () => new Promise(() => {}),
      timer: async () => {
        const order = [];
        const cancelled = setTimeout(() => order.push('cancelled'), 5);
        clearTimeout(cancelled);
        await new Promise((resolve) => setTimeout(() => { order.push('a'); resolve(); }, 10));
        const value = await new Promise((resolve) => setTimeout(resolve, 5, 'arg'));
        order.push(value);
        return order;
      },
      waitLong: async (args) => { await sleep(args.ms); return 'woke'; },
      leaveTimer: (args) => { setTimeout(() => { __olan.call('late', '{}'); }, args.ms); return 'returned'; },
      slow: async (args) => { await sleep(args.ms); return args.tag; },
      globals: () => {
        const names = Object.getOwnPropertyNames(globalThis).filter((name) => typeof globalThis[name] !== 'undefined');
        let escaped;
        try { escaped = ({}).constructor.constructor('return typeof process')(); } catch (error) { escaped = 'threw'; }
        let olanWritable = true;
        try { __olan.call = null; olanWritable = __olan.call === null; } catch (error) { olanWritable = false; }
        return {
          gc: typeof gc, process: typeof process, WebAssembly: typeof WebAssembly, Atomics: typeof Atomics, require: typeof require, fetch: typeof fetch,
          setInterval: typeof setInterval, clearInterval: typeof clearInterval, module: typeof module,
          setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, console: typeof console,
          olanKeys: Object.getOwnPropertyNames(__olan), olanFrozen: Object.isFrozen(__olan), olanWritable,
          escaped, names,
          textRoundTrip: new TextDecoder().decode(new TextEncoder().encode('Olan ğüş 😀')),
          base64: btoa('olan'), unbase64: atob('b2xhbg=='),
        };
      },
      setGlobal: (args) => { globalThis.sharedValue = args.value; Object.prototype.polluted = args.value; return globalThis.sharedValue; },
      getGlobal: () => ({ shared: typeof globalThis.sharedValue === 'undefined' ? null : globalThis.sharedValue, polluted: typeof ({}).polluted === 'undefined' ? null : ({}).polluted }),
      counter: () => { globalThis.count = (globalThis.count || 0) + 1; return globalThis.count; },
      big: (args) => 'x'.repeat(args.bytes),
      spam: (args) => { for (let i = 0; i < args.lines; i++) console.log('line', i); return args.lines; },
      longLine: () => { console.log('y'.repeat(10000)); return null; },
      levels: () => { console.log('l'); console.info('i'); console.warn('w'); console.error('e'); console.debug('d'); console.log({ a: 1 }, [2], 3); return null; },
      fallbackTarget: (payload, ctx) => ({ via: 'functions', payload, appId: ctx.appId }),
    },
    schedules: {
      daily: (ctx) => ({ via: 'schedules', schedule: ctx.schedule, scheduledAt: ctx.scheduledAt, appId: ctx.appId, actor: ctx.identity.actor }),
    },
    events: {
      'project.task.created': (event, ctx) => ({ via: 'events', type: event.type, appId: ctx.appId }),
    },
    hooks: {
      github: (request) => ({ status: 204, body: request.body, via: 'hooks' }),
    },
    migrate: (fromVersion, ctx) => ({ migratedFrom: fromVersion, appId: ctx.appId }),
  };
  return { default: Object.freeze({ ...definition, $olanBackend: 1 }) };
})();
`;

/** Minimal bundle without `migrate`. */
export const MINIMAL_BUNDLE = `var __olanBackendModule = { default: { $olanBackend: 1, functions: { ping: () => 'pong' } } };`;

export const DEFAULT_TEST_LIMITS: RuntimeLimits = { cpuMs: 1000, wallMs: 5000, memoryMb: 64, concurrency: 4 };

export const digestOf = (source: string) => createHash('sha256').update(source).digest('hex');

export interface ContractHarness {
  runtime: AppRuntime;
  hostCalls: { installationId: string; method: string; args: string }[];
  codeCalls: number;
  invoke(options: {
    installationId?: string;
    kind?: InvocationKind;
    name: string;
    fallback?: string;
    payload?: JsonValue;
    limits?: Partial<RuntimeLimits>;
    source?: string;
    code?: () => Promise<string>;
  }): Promise<InvocationResult>;
}

export function createContractHarness(runtime: AppRuntime): ContractHarness {
  const harness: ContractHarness = {
    runtime,
    hostCalls: [],
    codeCalls: 0,
    invoke({ installationId = 'inst-a', kind = 'function', name, fallback, payload = null, limits, source = CONTRACT_BUNDLE, code }) {
      const host: HostCall = async (id, method, args) => {
        harness.hostCalls.push({ installationId: id, method, args });
        if (method === 'echo') return args;
        throw { code: 'permission_denied', message: `${method} is not allowed` };
      };
      const request: InvocationRequest = {
        installationId,
        digest: digestOf(source),
        kind,
        name,
        fallback,
        payload,
        context: { appId: 'com.example.contract', identity: { actor: 'user', userId: 'u-1', permissions: ['tasks:read'] } },
        limits: { ...DEFAULT_TEST_LIMITS, ...limits },
      };
      return runtime.invoke(request, code ?? (async () => { harness.codeCalls++; return source; }), host);
    },
  };
  return harness;
}

const expectError = (result: InvocationResult, code: string) => {
  expect(result.ok, JSON.stringify(result).slice(0, 500)).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
};

const expectValue = (result: InvocationResult): JsonValue => {
  expect(result.ok, JSON.stringify(result).slice(0, 500)).toBe(true);
  return result.ok ? result.value : null;
};

const FORBIDDEN_GLOBAL = /^(gc|process|WebAssembly|Atomics|require|module|exports|global|fetch|setInterval|clearInterval|setImmediate|Buffer|ivm|Reference|ExternalCopy|Callback|Isolate|_ivm.*|\$\d+)$/;

export function runContractSuite(label: string, createRuntime: () => Promise<AppRuntime>): void {
  describe(`AppRuntime contract: ${label}`, () => {
    let h: ContractHarness;

    beforeAll(async () => {
      h = createContractHarness(await createRuntime());
    });

    afterAll(async () => {
      await h?.runtime.dispose();
    });

    it('invokes a function with payload and context', async () => {
      const result = await h.invoke({ name: 'echo', payload: { n: 1, s: 'x' } });
      expect(expectValue(result)).toEqual({
        args: { n: 1, s: 'x' },
        installationId: 'inst-a',
        appId: 'com.example.contract',
        identity: { actor: 'user', userId: 'u-1', permissions: ['tasks:read'] },
        hasSignal: true,
      });
      expect(result.cpuMs).toBeGreaterThanOrEqual(0);
      expect(result.wallMs).toBeGreaterThanOrEqual(0);
      expect(h.runtime.stats()).toMatchObject({ engine: h.runtime.engine });
      expect(h.runtime.stats().installations).toBeGreaterThanOrEqual(1);
    });

    it('loads code once per digest, again for a new digest and after unload', async () => {
      const source = `${CONTRACT_BUNDLE}\n// digest-test`;
      const before = h.codeCalls;
      expectValue(await h.invoke({ installationId: 'inst-digest', name: 'counter', source }));
      expect(await h.invoke({ installationId: 'inst-digest', name: 'counter', source })).toMatchObject({ ok: true, value: 2 });
      expect(h.codeCalls - before).toBe(1);
      expect(await h.invoke({ installationId: 'inst-digest', name: 'counter', source: `${source}\n// v2` })).toMatchObject({ ok: true, value: 1 });
      expect(h.codeCalls - before).toBe(2);
      await h.runtime.unload('inst-digest');
      expect(await h.invoke({ installationId: 'inst-digest', name: 'counter', source: `${source}\n// v2` })).toMatchObject({ ok: true, value: 1 });
      expect(h.codeCalls - before).toBe(3);
    });

    it('round-trips a host call (strings only, installation bound by the host)', async () => {
      const result = await h.invoke({ name: 'hostEcho', payload: { hello: 'world' } });
      expect(expectValue(result)).toEqual({ hello: 'world' });
      expect(h.hostCalls.at(-1)).toEqual({ installationId: 'inst-a', method: 'echo', args: '{"hello":"world"}' });
    });

    it('surfaces host errors as Error with code and message', async () => {
      expect(expectValue(await h.invoke({ name: 'hostFail' }))).toEqual({ isError: true, code: 'permission_denied', message: 'forbidden is not allowed' });
    });

    it('returns JSON only', async () => {
      expect(expectValue(await h.invoke({ name: 'jsonOnly' }))).toEqual({ date: '1970-01-01T00:00:00.000Z', list: [1, null, null], nan: null });
      expect(expectValue(await h.invoke({ name: 'undefinedResult' }))).toBeNull();
      const bigint = await h.invoke({ name: 'bigint' });
      expectError(bigint, 'handler_error');
      if (!bigint.ok) expect(bigint.error.message).toMatch(/not JSON/);
    });

    it('reports handler errors with their message', async () => {
      const thrown = await h.invoke({ name: 'throws' });
      expectError(thrown, 'handler_error');
      if (!thrown.ok) expect(thrown.error.message).toBe('TypeError: bad input');
      const rejected = await h.invoke({ name: 'rejects' });
      expectError(rejected, 'handler_error');
      if (!rejected.ok) expect(rejected.error.message).toBe('plain string');
    });

    it('stops an infinite loop with cpu_limit; the next call and other installations still work', async () => {
      const limits = { cpuMs: 100, wallMs: 5000 };
      const started = performance.now();
      const result = await h.invoke({ installationId: 'inst-loop', name: 'loop', limits });
      expectError(result, 'cpu_limit');
      expect(performance.now() - started).toBeLessThan(3000);
      expect(result.cpuMs).toBeGreaterThanOrEqual(100);
      expect(await h.invoke({ installationId: 'inst-loop', name: 'echo', payload: 1 })).toMatchObject({ ok: true });
      expect(await h.invoke({ installationId: 'inst-other', name: 'echo', payload: 2 })).toMatchObject({ ok: true });
    });

    it('stops a loop that starts after an await with cpu_limit', async () => {
      const result = await h.invoke({ installationId: 'inst-await-loop', name: 'loopAfterAwait', limits: { cpuMs: 100, wallMs: 5000 } });
      expectError(result, 'cpu_limit');
      expect(await h.invoke({ installationId: 'inst-await-loop', name: 'echo' })).toMatchObject({ ok: true });
    });

    it('stops a loop inside a timer callback with cpu_limit', async () => {
      expectError(await h.invoke({ installationId: 'inst-timer-loop', name: 'loopInTimer', limits: { cpuMs: 100, wallMs: 5000 } }), 'cpu_limit');
    });

    it('stops runaway allocation with memory_limit and recreates the sandbox', async () => {
      const before = h.codeCalls;
      const result = await h.invoke({ installationId: 'inst-oom', name: 'alloc', limits: { memoryMb: 32, cpuMs: 10_000, wallMs: 20_000 } });
      expectError(result, 'memory_limit');
      expect(await h.invoke({ installationId: 'inst-oom', name: 'echo', limits: { memoryMb: 32 } })).toMatchObject({ ok: true });
      expect(h.codeCalls - before).toBe(2);
      expect(await h.invoke({ installationId: 'inst-a', name: 'echo' })).toMatchObject({ ok: true });
    }, 30_000);

    it('times out a promise that never resolves', async () => {
      const started = performance.now();
      const result = await h.invoke({ installationId: 'inst-hang', name: 'hang', limits: { wallMs: 200 } });
      expectError(result, 'timeout');
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(190);
      expect(elapsed).toBeLessThan(2000);
      expect(await h.invoke({ installationId: 'inst-hang', name: 'echo' })).toMatchObject({ ok: true });
    });

    it('runs setTimeout/clearTimeout inside the call', async () => {
      expect(expectValue(await h.invoke({ name: 'timer' }))).toEqual(['a', 'arg']);
    });

    it('never fires a timer beyond the wall clock', async () => {
      const result = await h.invoke({ installationId: 'inst-wall-timer', name: 'waitLong', payload: { ms: 1000 }, limits: { wallMs: 200 } });
      expectError(result, 'timeout');
      expect(result.wallMs).toBeLessThan(900);
    });

    it('cancels pending timers when the call ends', async () => {
      const before = h.hostCalls.length;
      expect(await h.invoke({ installationId: 'inst-left-timer', name: 'leaveTimer', payload: { ms: 30 } })).toMatchObject({ ok: true, value: 'returned' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(h.hostCalls.slice(before).filter((call) => call.method === 'late')).toEqual([]);
    });

    it('exposes only ES builtins plus console, timers, text/base64 helpers and a frozen __olan', async () => {
      const value = expectValue(await h.invoke({ name: 'globals' })) as Record<string, JsonValue>;
      expect(value).toMatchObject({
        gc: 'undefined', process: 'undefined', WebAssembly: 'undefined', Atomics: 'undefined', require: 'undefined', fetch: 'undefined', setInterval: 'undefined',
        clearInterval: 'undefined', module: 'undefined', setTimeout: 'function', clearTimeout: 'function', console: 'object',
        olanKeys: ['call'], olanFrozen: true, olanWritable: false, escaped: 'undefined',
        textRoundTrip: 'Olan ğüş 😀', base64: 'b2xhbg==', unbase64: 'olan',
      });
      const leaked = (value.names as string[]).filter((name) => FORBIDDEN_GLOBAL.test(name));
      expect(leaked).toEqual([]);
      expect(value.names).not.toContain('__olanInvoke');
    });

    it('does not share global state across installations', async () => {
      expect(await h.invoke({ installationId: 'inst-g1', name: 'setGlobal', payload: { value: 42 } })).toMatchObject({ ok: true, value: 42 });
      expect(expectValue(await h.invoke({ installationId: 'inst-g2', name: 'getGlobal' }))).toEqual({ shared: null, polluted: null });
      expect(expectValue(await h.invoke({ installationId: 'inst-g1', name: 'getGlobal' }))).toEqual({ shared: 42, polluted: 42 });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects calls beyond the installation concurrency limit', async () => {
      const limits = { concurrency: 2 };
      const first = h.invoke({ installationId: 'inst-conc', name: 'slow', payload: { ms: 150, tag: 'a' }, limits });
      const second = h.invoke({ installationId: 'inst-conc', name: 'slow', payload: { ms: 150, tag: 'b' }, limits });
      const third = await h.invoke({ installationId: 'inst-conc', name: 'slow', payload: { ms: 10, tag: 'c' }, limits });
      expectError(third, 'concurrency_limit');
      expect(await first).toMatchObject({ ok: true, value: 'a' });
      expect(await second).toMatchObject({ ok: true, value: 'b' });
      expect(await h.invoke({ installationId: 'inst-conc', name: 'slow', payload: { ms: 1, tag: 'd' }, limits })).toMatchObject({ ok: true, value: 'd' });
    });

    it('caps payload and result at 256 KiB', async () => {
      expectError(await h.invoke({ name: 'echo', payload: 'x'.repeat(256 * 1024 + 1) }), 'payload_too_large');
      expectError(await h.invoke({ name: 'big', payload: { bytes: 300 * 1024 } }), 'payload_too_large');
      expect(await h.invoke({ name: 'big', payload: { bytes: 200 * 1024 } })).toMatchObject({ ok: true });
    });

    it('captures console lines with levels and truncates', async () => {
      const levels = await h.invoke({ name: 'levels' });
      expect(levels.logs.map((line) => [line.level, line.message])).toEqual([
        ['log', 'l'], ['info', 'i'], ['warn', 'w'], ['error', 'e'], ['log', 'd'], ['log', '{"a":1} [2] 3'],
      ]);
      expect(typeof levels.logs[0]!.at).toBe('string');
      const spam = await h.invoke({ name: 'spam', payload: { lines: 1200 } });
      expect(spam.ok).toBe(true);
      expect(spam.logs).toHaveLength(1001);
      expect(spam.logs[999]!.message).toBe('line 999');
      expect(spam.logs[1000]!.message).toMatch(/truncated/);
      const long = await h.invoke({ name: 'longLine' });
      expect(Buffer.byteLength(long.logs[0]!.message)).toBeLessThanOrEqual(4096);
    });

    it('resolves handlers per §15.1, with fallback and not_found', async () => {
      expect(expectValue(await h.invoke({ kind: 'schedule', name: 'daily', fallback: 'fallbackTarget', payload: { schedule: 'daily', scheduledAt: '2026-10-17T09:00:00Z' } })))
        .toEqual({ via: 'schedules', schedule: 'daily', scheduledAt: '2026-10-17T09:00:00Z', appId: 'com.example.contract', actor: 'user' });
      expect(expectValue(await h.invoke({ kind: 'schedule', name: 'weekly', fallback: 'fallbackTarget', payload: { schedule: 'weekly', scheduledAt: 't' } })))
        .toEqual({ via: 'functions', payload: { schedule: 'weekly', scheduledAt: 't' }, appId: 'com.example.contract' });
      expect(expectValue(await h.invoke({ kind: 'event', name: 'project.task.created', fallback: 'fallbackTarget', payload: { type: 'project.task.created' } })))
        .toEqual({ via: 'events', type: 'project.task.created', appId: 'com.example.contract' });
      expect(expectValue(await h.invoke({ kind: 'event', name: 'chat.message.created', fallback: 'fallbackTarget', payload: { type: 'chat.message.created' } })))
        .toMatchObject({ via: 'functions' });
      expect(expectValue(await h.invoke({ kind: 'hook', name: 'github', payload: { method: 'POST', headers: {}, body: 'b', query: {} } })))
        .toEqual({ status: 204, body: 'b', via: 'hooks' });
      expect(expectValue(await h.invoke({ kind: 'hook', name: 'stripe', fallback: 'fallbackTarget', payload: { body: '' } })))
        .toMatchObject({ via: 'functions' });
      expect(expectValue(await h.invoke({ kind: 'migrate', name: 'migrate', payload: { fromVersion: '1.0.0' } })))
        .toEqual({ migratedFrom: '1.0.0', appId: 'com.example.contract' });
      // backend.call only reaches `functions`; a missing name or fallback is not_found.
      expectError(await h.invoke({ kind: 'function', name: 'daily' }), 'not_found');
      expectError(await h.invoke({ kind: 'function', name: 'toString' }), 'not_found');
      expectError(await h.invoke({ kind: 'schedule', name: 'weekly', fallback: 'nope' }), 'not_found');
      expectError(await h.invoke({ kind: 'event', name: 'chat.message.created' }), 'not_found');
      expectError(await h.invoke({ kind: 'hook', name: 'stripe' }), 'not_found');
      expectError(await h.invoke({ installationId: 'inst-minimal', kind: 'migrate', name: 'migrate', payload: { fromVersion: '1.0.0' }, source: MINIMAL_BUNDLE }), 'not_found');
    });

    it('reports bundle_error for bad bundles and does not cache them', async () => {
      expectError(await h.invoke({ installationId: 'inst-bad', name: 'ping', source: 'var x = ;' }), 'bundle_error');
      expectError(await h.invoke({ installationId: 'inst-bad', name: 'ping', source: 'var __olanBackendModule = { default: {} };' }), 'bundle_error');
      expectError(await h.invoke({ installationId: 'inst-bad', name: 'ping', source: 'throw new Error("boom at load")' }), 'bundle_error');
      expectError(await h.invoke({ installationId: 'inst-bad', name: 'ping', source: 'x1', code: () => Promise.reject(new Error('storage down')) }), 'bundle_error');
      expect(await h.invoke({ installationId: 'inst-bad', name: 'ping', source: MINIMAL_BUNDLE })).toMatchObject({ ok: true, value: 'pong' });
    });
  });
}

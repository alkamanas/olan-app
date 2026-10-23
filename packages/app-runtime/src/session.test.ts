import { describe, expect, it } from 'vitest';
import { CODE_GENERATION_BLOCKED, createSandboxSession, type SandboxSessionOptions } from './session.js';
import type { EngineName } from './types.js';

const PRELUDE = String.raw`(function (host) {
  globalThis.send = function (name, data) { return host.call(name, data); };
  return {
    echo: function (value) { return host.call('echo', String(value)); },
    run: function (name) { return globalThis[name](); },
    caught: function () {
      try { var keep = []; for (var i = 0; ; i++) keep.push(new Array(65536).fill(i)); }
      catch (error) { if (host.fault(error)) return 'fault'; return 'caught: ' + error; }
    },
    later: function () { Promise.resolve().then(function () { host.call('micro', 'done'); }); return 'sync'; },
  };
})`;

function open(engine: EngineName, calls: [string, string][] = [], overrides: Partial<SandboxSessionOptions> = {}) {
  return createSandboxSession({
    engine,
    memoryMb: 32,
    prelude: PRELUDE,
    onCall: (name, data) => {
      calls.push([name, data]);
      return name === 'echo' ? `host:${data}` : undefined;
    },
    ...overrides,
  });
}

for (const engine of ['isolated-vm', 'quickjs'] as const) {
  describe(`sandbox session (${engine})`, () => {
    it('bridges strings both ways and runs microtasks inside the entry', async () => {
      const calls: [string, string][] = [];
      const session = await open(engine, calls);
      expect(session.engine).toBe(engine);
      expect(await session.call('echo', [7], { timeoutMs: 1000 })).toEqual({ ok: true, value: 'host:7' });
      expect(await session.call('later', [], { timeoutMs: 1000 })).toEqual({ ok: true, value: 'sync' });
      expect(calls).toEqual([['echo', '7'], ['micro', 'done']]);
      expect(await session.evaluate('globalThis.x = send("echo", "from script");', { filename: 'x.js', timeoutMs: 1000 })).toEqual({ ok: true, value: undefined });
      expect(calls.at(-1)).toEqual(['echo', 'from script']);
      session.dispose();
      expect(await session.call('echo', [1], { timeoutMs: 1000 })).toMatchObject({ ok: false, reason: 'disposed' });
    });

    it('exposes no engine or Node globals and blocks code generation from strings', async () => {
      const calls: [string, string][] = [];
      const session = await open(engine, calls);
      const probe = String.raw`
        const blocked = (fn) => { try { fn(); return 'allowed'; } catch (error) { return error.name + ': ' + error.message; } };
        send('probe', JSON.stringify({
          globals: ['process', 'require', 'fetch', 'gc', 'WebAssembly', 'Atomics', 'module', 'XMLHttpRequest', 'WebSocket', 'setInterval'].map((name) => typeof globalThis[name]),
          eval: blocked(() => eval('1 + 1')),
          fn: blocked(() => Function('return 1')),
          ctor: blocked(() => send.constructor('return process')()),
          asyncCtor: blocked(() => (async () => {}).constructor('return 1')),
          genCtor: blocked(() => (function* () {}).constructor('return 1')),
          instance: (() => {}) instanceof Function,
          encoding: [new TextDecoder().decode(new TextEncoder().encode('ğüş')), btoa('olan'), atob('b2xhbg==')],
        }));`;
      expect(await session.evaluate(probe, { filename: 'probe.js', timeoutMs: 2000 })).toEqual({ ok: true, value: undefined });
      const report = JSON.parse(calls.find(([name]) => name === 'probe')![1]);
      const evalError = `EvalError: ${CODE_GENERATION_BLOCKED}`;
      expect(report).toEqual({
        globals: Array(10).fill('undefined'),
        eval: evalError,
        fn: evalError,
        ctor: evalError,
        asyncCtor: evalError,
        genCtor: evalError,
        instance: true,
        encoding: ['ğüş', 'b2xhbg==', 'olan'],
      });
      session.dispose();
    });

    it('reports thrown errors and keeps the session', async () => {
      const session = await open(engine);
      const outcome = await session.evaluate('throw new Error("broken bundle")', { filename: 'app.js', timeoutMs: 1000 });
      expect(outcome).toMatchObject({ ok: false, reason: 'error', message: 'broken bundle' });
      const syntax = await session.evaluate('function (', { filename: 'app.js', timeoutMs: 1000 });
      expect(syntax).toMatchObject({ ok: false, reason: 'error' });
      expect(session.disposed).toBe(false);
      session.dispose();
    });

    it('disposes the sandbox when an entry runs past its budget (loops and microtask loops)', async () => {
      const session = await open(engine);
      await session.evaluate('globalThis.spin = () => { for (;;) {} }; globalThis.chain = () => { const f = () => Promise.resolve().then(f); f(); };', { filename: 'a.js', timeoutMs: 1000 });
      const started = Date.now();
      expect(await session.call('run', ['spin'], { timeoutMs: 200 })).toMatchObject({ ok: false, reason: 'timeout' });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(session.disposed).toBe(true);
      const second = await open(engine, [], { memoryMb: 256 });
      await second.evaluate('globalThis.chain = () => { let n = 0; const f = () => { n++; return Promise.resolve().then(f); }; f(); };', { filename: 'a.js', timeoutMs: 1000 });
      expect(await second.call('run', ['chain'], { timeoutMs: 200 })).toMatchObject({ ok: false });
      expect(second.disposed).toBe(true);
    });

    it('disposes the sandbox at the memory limit', async () => {
      const session = await open(engine);
      const outcome = await session.evaluate('const keep = []; for (let i = 0; ; i++) keep.push(new Array(65536).fill(i));', { filename: 'alloc.js', timeoutMs: 10_000 });
      expect(outcome).toMatchObject({ ok: false, reason: 'memory_limit' });
      expect(session.disposed).toBe(true);
      // QuickJS raises a catchable InternalError; prelude code reports it with host.fault.
      const second = await open(engine);
      expect(await second.call('caught', [], { timeoutMs: 10_000 })).toMatchObject({ ok: false, reason: 'memory_limit' });
      expect(second.disposed).toBe(true);
    });
  });
}

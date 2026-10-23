/**
 * Process model (§15.1): the runtime child is forked from the compiled entry (`dist/main.js`,
 * kept fresh by dist.test.ts), with a scrubbed env and without --expose-gc; TCP mode with token.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChildEnv, buildExecArgv, connectRuntime, forkRuntime, RUNTIME_ENTRY, type RuntimeClient } from './client.js';
import { createContractHarness, runContractSuite } from './contract-suite.js';
import { decodeFrame, encodeFrame, ProtocolError } from './protocol.js';
import { listenRuntime } from './server.js';
import type { EngineName } from './types.js';

for (const engine of ['isolated-vm', 'quickjs'] as EngineName[]) {
  runContractSuite(`fork ${engine}`, () => forkRuntime({ engine, maxOldSpaceMb: 256 }));
}

describe('protocol frames', () => {
  it('round-trips and validates frames', () => {
    const frame = { type: 'host', id: 1, callId: 2, method: 'db.get', args: '{}' } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    expect(() => decodeFrame('not json')).toThrow(ProtocolError);
    expect(() => decodeFrame('{"type":"rm -rf"}')).toThrow(ProtocolError);
    expect(() => decodeFrame('{"type":"invoke"}')).toThrow(/without id/);
    expect(() => decodeFrame('{"type":"host_result","ok":true}')).toThrow(/callId/);
  });
});

describe('child process hardening', () => {
  it('builds the child env from an allowlist only', () => {
    const env = buildChildEnv({
      PATH: '/bin', Path: 'C:\\bin', NODE_ENV: 'production', TZ: 'UTC', SystemRoot: 'C:\\Windows',
      DATABASE_URL: 'postgres://secret', SECRET_X: 'x', NODE_OPTIONS: '--expose-gc', HOME: '/root',
      OLAN_APP_RUNTIME_ENGINE: 'quickjs', OLAN_APP_RUNTIME_TOKEN: 'token-of-the-main-service', OLAN_APP_RUNTIME_URL: 'tcp://x:1',
    }, { OLAN_APP_RUNTIME_X: '1', DATABASE_URL: 'nope' });
    expect(env).toEqual({
      PATH: '/bin', Path: 'C:\\bin', NODE_ENV: 'production', TZ: 'UTC', SystemRoot: 'C:\\Windows',
      OLAN_APP_RUNTIME_ENGINE: 'quickjs', OLAN_APP_RUNTIME_X: '1',
    });
  });

  it('strips --expose-gc and other isolate-visible V8 flags from execArgv', () => {
    expect(buildExecArgv({
      maxOldSpaceMb: 300,
      inherited: ['--expose-gc', '--expose_gc', '--js-flags=--expose-gc', '--js-flags', '--expose-gc', '--allow-natives-syntax',
        '--inspect=9229', '--max-old-space-size=8000', '--no-node-snapshot', '--enable-source-maps', '--conditions=dev'],
    })).toEqual(['--no-node-snapshot', '--max-old-space-size=300', '--enable-source-maps', '--conditions=dev']);
  });

  it('drops flags that would replace the child entry (a parent run with node -e must not re-run itself)', () => {
    expect(buildExecArgv({
      maxOldSpaceMb: 64,
      inherited: ['--input-type=module', '-e', 'import x from "y"; --fake', '--eval=1', '-p', '2', '--print', '-3',
        '--input-type', 'module', '--test', '--test-reporter', 'spec', '--watch', '--watch-path', 'src', '--enable-source-maps'],
    })).toEqual(['--no-node-snapshot', '--max-old-space-size=64', '--enable-source-maps']);
  });

  it('refuses to start the entry with --expose-gc', async () => {
    const child = spawn(process.execPath, ['--no-node-snapshot', '--expose-gc', RUNTIME_ENTRY], {
      env: buildChildEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(78);
    expect(stderr).toMatch(/expose-gc/);
  });

  describe('forked child with secrets and --expose-gc in the parent', () => {
    let client: RuntimeClient;
    const saved = { DATABASE_URL: process.env.DATABASE_URL, SECRET_X: process.env.SECRET_X, NODE_OPTIONS: process.env.NODE_OPTIONS };

    beforeAll(async () => {
      process.env.DATABASE_URL = 'postgres://user:pass@db/olan';
      process.env.SECRET_X = 'top-secret';
      process.env.NODE_OPTIONS = '--expose-gc';
      client = await forkRuntime({ engine: 'isolated-vm', execArgv: [...process.execArgv, '--expose-gc', '--js-flags=--expose-gc'] });
    });

    afterAll(async () => {
      await client?.dispose();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('starts the child without secrets, NODE_OPTIONS or --expose-gc', async () => {
      const info = await client.introspect();
      expect(info.engine).toBe('isolated-vm');
      expect(info.pid).not.toBe(process.pid);
      expect(info.envKeys).not.toContain('DATABASE_URL');
      expect(info.envKeys).not.toContain('SECRET_X');
      expect(info.envKeys).not.toContain('NODE_OPTIONS');
      // NODE_CHANNEL_* is added by Node for the fork IPC channel; on Windows libuv always adds
      // its required variables (uv process.c `required_vars`) to a child environment.
      const added = process.platform === 'win32' ? '|HOMEDRIVE|HOMEPATH|LOGONSERVER|SYSTEMDRIVE|TEMP|USERDOMAIN|USERNAME|USERPROFILE|WINDIR' : '';
      const allowed = new RegExp(`^(PATH|NODE_ENV|TZ|SYSTEMROOT|OLAN_APP_RUNTIME_.*|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE${added})$`, 'i');
      expect(info.envKeys.filter((key) => !allowed.test(key))).toEqual([]);
      expect(info.execArgv).toContain('--no-node-snapshot');
      expect(info.execArgv.some((arg) => /expose[-_]gc/.test(arg))).toBe(false);
      expect(info.gc).toBe('undefined');
    });

    it('app code sees no gc, process or env', async () => {
      const h = createContractHarness(client);
      const result = await h.invoke({ name: 'globals' });
      expect(result).toMatchObject({ ok: true, value: { gc: 'undefined', process: 'undefined', escaped: 'undefined' } });
      const names = (result as unknown as { value: { names: string[] } }).value.names;
      expect(names.join(' ')).not.toMatch(/DATABASE_URL|SECRET_X|top-secret/);
    });
  });

  it('restarts the child after a crash; in-flight calls get runtime_unavailable', async () => {
    const restarts: string[] = [];
    const client = await forkRuntime({ engine: 'isolated-vm', onRestart: (reason) => restarts.push(reason) });
    try {
      const h = createContractHarness(client);
      expect(await h.invoke({ name: 'echo', payload: 1 })).toMatchObject({ ok: true });
      const firstPid = client.pid!;
      const inFlight = h.invoke({ name: 'hang', limits: { wallMs: 20_000 } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(firstPid, 'SIGKILL');
      const started = performance.now();
      const lost = await inFlight;
      expect(lost).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } });
      expect(performance.now() - started).toBeLessThan(5000);
      const again = await h.invoke({ name: 'echo', payload: 2 });
      expect(again).toMatchObject({ ok: true });
      expect(client.pid).toBeDefined();
      expect(client.pid).not.toBe(firstPid);
      expect(restarts.length).toBeGreaterThanOrEqual(1);
      expect(h.codeCalls).toBe(2);
    } finally {
      await client.dispose();
    }
  });
});

describe('client does not keep the parent alive', () => {
  it('a script that invokes (connected and while restarting) and disposes exits promptly', async () => {
    const index = pathToFileURL(join(dirname(RUNTIME_ENTRY), 'index.js')).href;
    const script = `
      import { forkRuntime } from ${JSON.stringify(index)};
      const bundle = "var __olanBackendModule = { default: { $olanBackend: 1, functions: { ping: () => 'pong' } } };";
      const request = { installationId: 'i', digest: 'd', kind: 'function', name: 'ping', payload: null,
        context: { appId: 'a', identity: { actor: 'app', userId: null, permissions: [] } },
        limits: { cpuMs: 1000, wallMs: 5000, memoryMb: 32, concurrency: 1 } };
      const host = async () => 'null';
      let restarted;
      const lost = new Promise((resolve) => { restarted = resolve; });
      const client = await forkRuntime({ engine: 'quickjs', onRestart: () => restarted() });
      const first = await client.invoke(request, async () => bundle, host);
      process.kill(client.pid, 'SIGKILL');
      // No connection right now: this invoke takes the ready()-vs-timeout race path.
      await lost;
      const second = await client.invoke(request, async () => bundle, host);
      await client.dispose();
      process.stdout.write(JSON.stringify([first.ok && first.value, second.ok && second.value]));
    `;
    const started = performance.now();
    const child = spawn(process.execPath, ['--no-node-snapshot', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const guard = setTimeout(() => child.kill(), 10_000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    clearTimeout(guard);
    const elapsed = performance.now() - started;
    expect(code, `stdout: ${stdout}
stderr: ${stderr}`).toBe(0);
    expect(JSON.parse(stdout)).toEqual(['pong', 'pong']);
    // Before the fix a never-cleared 10 s ready timer kept the process alive after each call.
    expect(elapsed).toBeLessThan(5000);
  }, 20_000);
});

describe('tcp transport', () => {
  const token = 'test-token-0123456789abcdef';

  it('serves invocations to a client with the shared token', async () => {
    const listener = await listenRuntime({ port: 0, token, engine: 'quickjs' });
    const client = await connectRuntime({ url: `tcp://127.0.0.1:${listener.port}`, token });
    try {
      expect(client.engine).toBe('quickjs');
      const h = createContractHarness(client);
      expect(await h.invoke({ name: 'hostEcho', payload: { over: 'tcp' } })).toMatchObject({ ok: true, value: { over: 'tcp' } });
      expect(client.stats()).toEqual({ installations: 1, engine: 'quickjs' });
      await client.unload('inst-a');
      expect(client.stats().installations).toBe(0);
    } finally {
      await client.dispose();
      await listener.close();
    }
  });

  it('rejects a wrong token', async () => {
    const listener = await listenRuntime({ port: 0, token, engine: 'quickjs' });
    try {
      await expect(connectRuntime({ url: `tcp://127.0.0.1:${listener.port}`, token: 'wrong-token-0123456789' })).rejects.toThrow(/refused|closed/);
    } finally {
      await listener.close();
    }
  });
});

#!/usr/bin/env node
/**
 * app-runtime process entry (`node --no-node-snapshot dist/main.js`).
 *
 * - Forked by the main service (`forkRuntime`): serves the protocol over the IPC channel and
 *   exits when the parent goes away.
 * - Separate container: `OLAN_APP_RUNTIME_LISTEN=[host:]port` and `OLAN_APP_RUNTIME_TOKEN`
 *   serve the same protocol over TCP (`listenRuntime`).
 *
 * `OLAN_APP_RUNTIME_ENGINE=auto|isolated-vm|quickjs` selects the engine (default auto).
 * Refuses to start with `--expose-gc`: V8 would expose `gc` to every isolate.
 */
import { ipcTransport } from './protocol.js';
import { createRuntime, hostExposesGc } from './runtime.js';
import { listenRuntime, serveRuntime } from './server.js';
function fail(message, code) {
    process.stderr.write(`[olan-app-runtime] ${message}\n`);
    process.exit(code);
}
async function main() {
    if (hostExposesGc())
        fail('refusing to start with --expose-gc (gc would leak into app isolates)', 78);
    const engine = (process.env.OLAN_APP_RUNTIME_ENGINE || 'auto');
    if (!['auto', 'isolated-vm', 'quickjs'].includes(engine))
        fail(`unknown OLAN_APP_RUNTIME_ENGINE ${engine}`, 64);
    const warnings = [];
    if (engine !== 'quickjs' && !process.execArgv.includes('--no-node-snapshot')) {
        warnings.push('the app runtime should run with --no-node-snapshot (required by isolated-vm on Node 20+)');
    }
    const listen = process.env.OLAN_APP_RUNTIME_LISTEN;
    if (listen) {
        const token = process.env.OLAN_APP_RUNTIME_TOKEN ?? '';
        const match = /^(?:(.+):)?(\d+)$/.exec(listen);
        if (!match)
            fail(`OLAN_APP_RUNTIME_LISTEN must be [host:]port, got ${listen}`, 64);
        const listener = await listenRuntime({
            port: Number(match[2]),
            host: match[1] ?? '0.0.0.0',
            token,
            engine,
            onWarning: (message) => process.stderr.write(`[olan-app-runtime] ${message}\n`),
        });
        for (const message of warnings)
            process.stderr.write(`[olan-app-runtime] ${message}\n`);
        process.stderr.write(`[olan-app-runtime] ${listener.runtime.engine} engine listening on ${match[1] ?? '0.0.0.0'}:${listener.port}\n`);
        const stop = () => { listener.close().finally(() => process.exit(0)); };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
        return;
    }
    if (typeof process.send !== 'function')
        fail('start me with child_process.fork (IPC) or set OLAN_APP_RUNTIME_LISTEN', 64);
    const runtime = await createRuntime({ engine, onWarning: (message) => warnings.push(message) });
    const session = serveRuntime({ transport: ipcTransport(process), runtime, warnings });
    session.closed.then(() => process.exit(0));
}
main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error), 1));

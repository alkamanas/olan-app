/**
 * Engine-neutral part of the runtime: installation registry (one sandbox per installation,
 * cached by digest), concurrency, payload caps, per-call CPU/wall enforcement, console capture
 * and timers. Engines only provide a {@link Sandbox}: load code, run the bootstrap API, report
 * cumulative CPU time and tear down.
 */
import { MAX_LOG_LINE_BYTES, MAX_LOG_LINES, MAX_PAYLOAD_BYTES, } from './types.js';
export class BundleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BundleError';
    }
}
const WATCHDOG_INTERVAL_MS = 5;
const nowMs = () => performance.now();
const round = (value) => Math.round(value * 1000) / 1000;
function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}
function clipBytes(text, max) {
    if (byteLength(text) <= max)
        return text;
    const buffer = Buffer.from(text, 'utf8').subarray(0, max);
    // Drop a partially cut multi-byte sequence at the end.
    return buffer.toString('utf8').replace(/�$/, '');
}
function hostErrorEnvelope(error) {
    const record = (typeof error === 'object' && error !== null ? error : {});
    const code = typeof record.code === 'string' && record.code ? record.code : 'host_error';
    const message = typeof record.message === 'string' ? record.message : String(error);
    return JSON.stringify({ ok: false, code, message });
}
const LEVELS = new Set(['log', 'info', 'warn', 'error']);
export class SandboxRuntime {
    driver;
    engine;
    slots = new Map();
    retired = new Set();
    active = new Map();
    nextCallId = 0;
    disposed = false;
    constructor(driver) {
        this.driver = driver;
        this.engine = driver.name;
    }
    stats() {
        return { installations: this.slots.size, engine: this.engine };
    }
    async unload(installationId) {
        const slot = this.slots.get(installationId);
        if (slot)
            this.kill(slot, new Map(), `installation ${installationId} was unloaded`);
    }
    async dispose() {
        this.disposed = true;
        for (const slot of [...this.slots.values(), ...this.retired])
            this.kill(slot, new Map(), 'the runtime was disposed');
    }
    async invoke(request, code, host) {
        const started = nowMs();
        const early = (code, message) => ({
            ok: false, error: { code, message }, logs: [], cpuMs: 0, wallMs: round(nowMs() - started),
        });
        if (this.disposed)
            return early('runtime_unavailable', 'the runtime was disposed');
        const { limits } = request;
        let payloadJson;
        try {
            payloadJson = JSON.stringify(request.payload ?? null);
        }
        catch (error) {
            return early('handler_error', `payload is not JSON: ${error.message}`);
        }
        if (byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
            return early('payload_too_large', `payload is ${byteLength(payloadJson)} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
        }
        const running = this.active.get(request.installationId) ?? 0;
        if (running >= limits.concurrency) {
            return early('concurrency_limit', `installation already runs ${running} invocation(s); the limit is ${limits.concurrency}`);
        }
        this.active.set(request.installationId, running + 1);
        try {
            return await this.run(request, payloadJson, code, host, started);
        }
        finally {
            const left = (this.active.get(request.installationId) ?? 1) - 1;
            if (left > 0)
                this.active.set(request.installationId, left);
            else
                this.active.delete(request.installationId);
        }
    }
    run(request, payloadJson, code, host, started) {
        return new Promise((resolve) => {
            const slot = this.slotFor(request, code);
            const call = {
                id: ++this.nextCallId,
                installationId: request.installationId,
                host,
                cpuMs: request.limits.cpuMs,
                startCpu: 0,
                startWall: started,
                deadline: started + request.limits.wallMs,
                logs: [],
                truncated: false,
                timers: new Map(),
                wallTimer: null,
                settled: false,
                resolve,
            };
            slot.calls.set(call.id, call);
            call.startCpu = slot.sandbox ? slot.sandbox.cpuTimeMs() : 0;
            call.wallTimer = setTimeout(() => this.enforce(slot, true), request.limits.wallMs + 1);
            this.startWatchdog(slot);
            const contextJson = JSON.stringify({
                installationId: request.installationId,
                appId: request.context.appId,
                identity: request.context.identity,
            });
            slot.ready.then(async () => {
                if (call.settled)
                    return;
                const sandbox = slot.sandbox;
                if (!sandbox || slot.dead)
                    return this.finish(slot, call, { code: 'runtime_unavailable', message: 'the installation sandbox was reset' });
                let envelope;
                try {
                    envelope = await sandbox.invoke(call.id, request.kind, request.name, request.fallback ?? '', payloadJson, contextJson);
                }
                catch (error) {
                    this.fault(slot, error instanceof Error ? error.message : String(error));
                    return;
                }
                if (call.settled)
                    return;
                if (typeof envelope !== 'string' || !envelope) {
                    return this.finish(slot, call, { code: 'handler_error', message: 'the sandbox returned an invalid result' });
                }
                if (envelope[0] === '1') {
                    const json = envelope.slice(1);
                    if (byteLength(json) > MAX_PAYLOAD_BYTES) {
                        return this.finish(slot, call, { code: 'payload_too_large', message: `result is ${byteLength(json)} bytes; the limit is ${MAX_PAYLOAD_BYTES}` });
                    }
                    return this.finish(slot, call, null, JSON.parse(json));
                }
                const failure = JSON.parse(envelope.slice(1));
                this.finish(slot, call, { code: failure.code, message: clipBytes(String(failure.message), MAX_LOG_LINE_BYTES) });
            }, (error) => {
                if (call.settled)
                    return;
                const reason = this.limitReasons(slot).get(call.id);
                this.finish(slot, call, reason ?? { code: 'bundle_error', message: error instanceof Error ? error.message : String(error) });
            });
        });
    }
    /** The installation's sandbox for this digest, created (and loaded) when missing or stale. */
    slotFor(request, code) {
        const existing = this.slots.get(request.installationId);
        if (existing && !existing.dead) {
            const reusable = existing.digest === request.digest && existing.memoryMb === request.limits.memoryMb;
            if (reusable)
                return existing;
            // New code or a new memory limit: let running calls finish on the old sandbox.
            existing.retired = true;
            this.retired.add(existing);
            this.slots.delete(request.installationId);
            if (existing.calls.size === 0)
                this.kill(existing, new Map(), 'replaced');
        }
        const slot = {
            installationId: request.installationId,
            digest: request.digest,
            memoryMb: request.limits.memoryMb,
            sandbox: null,
            ready: Promise.resolve(),
            calls: new Map(),
            timerOwners: new Map(),
            watchdog: null,
            dead: false,
            retired: false,
        };
        this.slots.set(request.installationId, slot);
        slot.ready = this.load(slot, code);
        // A failed load must not be cached: the next call retries with fresh code.
        slot.ready.catch(() => {
            if (this.slots.get(slot.installationId) === slot)
                this.slots.delete(slot.installationId);
            slot.dead = true;
            this.stopWatchdog(slot);
            try {
                slot.sandbox?.dispose();
            }
            catch { /* already gone */ }
        });
        return slot;
    }
    async load(slot, code) {
        let source;
        try {
            source = await code();
        }
        catch (error) {
            throw new BundleError(`could not fetch the bundle: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (typeof source !== 'string')
            throw new BundleError('the bundle must be a string');
        if (slot.dead)
            throw new BundleError('the installation was unloaded while loading');
        let sandbox;
        try {
            sandbox = await this.driver.createSandbox({ memoryMb: slot.memoryMb, hooks: this.hooksFor(slot) });
        }
        catch (error) {
            throw new BundleError(`could not create a sandbox: ${error instanceof Error ? error.message : String(error)}`);
        }
        slot.sandbox = sandbox;
        for (const call of slot.calls.values())
            call.startCpu = sandbox.cpuTimeMs();
        const first = slot.calls.values().next().value;
        try {
            await sandbox.load(source, first?.id ?? 0);
        }
        catch (error) {
            if (error instanceof BundleError)
                throw error;
            throw new BundleError(error instanceof Error ? error.message : String(error));
        }
        if (slot.dead)
            throw new BundleError('the installation sandbox was reset while loading');
    }
    hooksFor(slot) {
        const callFor = (callId) => slot.calls.get(callId) ?? slot.calls.values().next().value;
        return {
            host: (callId, hostCallId, method, argsJson) => {
                const call = callFor(callId);
                const answer = (envelope) => {
                    if (slot.dead || !slot.sandbox)
                        return;
                    slot.sandbox.settleHost(hostCallId, envelope);
                };
                if (!call) {
                    answer(JSON.stringify({ ok: false, code: 'no_invocation', message: 'host calls are only available during an invocation' }));
                    return;
                }
                let pending;
                try {
                    pending = call.host(call.installationId, method, argsJson);
                }
                catch (error) {
                    pending = Promise.reject(error);
                }
                Promise.resolve(pending).then((value) => {
                    if (typeof value !== 'string')
                        throw { code: 'host_error', message: 'host returned a non-string value' };
                    answer(JSON.stringify({ ok: true, value }));
                }).catch((error) => answer(hostErrorEnvelope(error)));
            },
            log: (callId, level, message) => {
                const call = callFor(callId);
                if (!call || call.settled)
                    return;
                if (call.logs.length >= MAX_LOG_LINES) {
                    if (!call.truncated) {
                        call.truncated = true;
                        call.logs.push({ level: 'warn', message: `[olan] log truncated: more than ${MAX_LOG_LINES} lines in this invocation`, at: new Date().toISOString() });
                    }
                    return;
                }
                call.logs.push({
                    level: LEVELS.has(level) ? level : 'log',
                    message: clipBytes(String(message), MAX_LOG_LINE_BYTES),
                    at: new Date().toISOString(),
                });
            },
            timerSet: (callId, timerId, delayMs) => {
                const call = callFor(callId);
                if (!call || call.settled)
                    return;
                // Never fire after the wall deadline: such a timer is simply never armed.
                if (nowMs() + delayMs >= call.deadline)
                    return;
                const handle = setTimeout(() => {
                    call.timers.delete(timerId);
                    slot.timerOwners.delete(timerId);
                    if (call.settled || slot.dead || !slot.sandbox)
                        return;
                    slot.sandbox.fireTimer(timerId);
                }, delayMs);
                call.timers.set(timerId, handle);
                slot.timerOwners.set(timerId, call);
            },
            timerClear: (timerId) => {
                const call = slot.timerOwners.get(timerId);
                if (!call)
                    return;
                slot.timerOwners.delete(timerId);
                const handle = call.timers.get(timerId);
                if (handle)
                    clearTimeout(handle);
                call.timers.delete(timerId);
            },
            shouldInterrupt: () => this.limitReasons(slot).size > 0,
            fault: (message) => this.fault(slot, message),
        };
    }
    startWatchdog(slot) {
        if (slot.watchdog)
            return;
        slot.watchdog = setInterval(() => this.enforce(slot, false), WATCHDOG_INTERVAL_MS);
    }
    stopWatchdog(slot) {
        if (slot.watchdog)
            clearInterval(slot.watchdog);
        slot.watchdog = null;
    }
    /** Calls that are over their CPU or wall budget. */
    limitReasons(slot) {
        const reasons = new Map();
        if (slot.calls.size === 0)
            return reasons;
        const cpu = slot.sandbox ? slot.sandbox.cpuTimeMs() : 0;
        const now = nowMs();
        for (const call of slot.calls.values()) {
            if (cpu - call.startCpu > call.cpuMs) {
                reasons.set(call.id, { code: 'cpu_limit', message: `CPU budget of ${call.cpuMs} ms exceeded` });
            }
            else if (now >= call.deadline) {
                reasons.set(call.id, { code: 'timeout', message: `wall-clock budget of ${round(call.deadline - call.startWall)} ms exceeded` });
            }
        }
        return reasons;
    }
    enforce(slot, _fromWallTimer) {
        if (slot.dead)
            return;
        const reasons = this.limitReasons(slot);
        if (reasons.size)
            this.kill(slot, reasons, [...reasons.values()][0].message);
    }
    fault(slot, message) {
        if (slot.dead)
            return;
        const reasons = this.limitReasons(slot);
        if (!reasons.size) {
            const code = this.driver.classifyFault(message);
            const text = code === 'memory_limit' ? `memory limit of ${slot.memoryMb} MB exceeded` : `sandbox failure: ${message}`;
            for (const call of slot.calls.values())
                reasons.set(call.id, { code, message: text });
        }
        this.kill(slot, reasons, message);
    }
    /** Tears the sandbox down; calls in `reasons` get their code, the rest `runtime_unavailable`. */
    kill(slot, reasons, why) {
        if (slot.dead)
            return;
        slot.dead = true;
        this.stopWatchdog(slot);
        if (this.slots.get(slot.installationId) === slot)
            this.slots.delete(slot.installationId);
        this.retired.delete(slot);
        const cpuAtDeath = slot.sandbox ? slot.sandbox.cpuTimeMs() : 0;
        try {
            slot.sandbox?.dispose();
        }
        catch { /* already gone */ }
        for (const call of [...slot.calls.values()]) {
            const reason = reasons.get(call.id) ?? { code: 'runtime_unavailable', message: `the installation sandbox was reset: ${why}` };
            this.finish(slot, call, reason, undefined, cpuAtDeath);
        }
        slot.sandbox = null;
    }
    finish(slot, call, error, value, cpuNow) {
        if (call.settled)
            return;
        call.settled = true;
        if (call.wallTimer)
            clearTimeout(call.wallTimer);
        for (const [timerId, handle] of call.timers) {
            clearTimeout(handle);
            slot.timerOwners.delete(timerId);
        }
        call.timers.clear();
        slot.calls.delete(call.id);
        const cpu = cpuNow ?? (slot.sandbox && !slot.dead ? slot.sandbox.cpuTimeMs() : call.startCpu);
        const cpuMs = round(Math.max(0, cpu - call.startCpu));
        const wallMs = round(nowMs() - call.startWall);
        if (slot.calls.size === 0) {
            this.stopWatchdog(slot);
            if (slot.retired && !slot.dead)
                this.kill(slot, new Map(), 'replaced');
        }
        call.resolve(error
            ? { ok: false, error, logs: call.logs, cpuMs, wallMs }
            : { ok: true, value: value ?? null, logs: call.logs, cpuMs, wallMs });
    }
}

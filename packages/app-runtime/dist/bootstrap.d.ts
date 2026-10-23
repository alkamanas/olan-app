/**
 * Removes engine globals that must never reach app code (both engines). Shared by
 * {@link BOOTSTRAP_SOURCE} and the sandbox session bootstrap (`session.ts`); expects `G` and
 * `defineProperty` in scope.
 */
export declare const FORBIDDEN_GLOBALS_SOURCE: string;
/**
 * UTF-8 `TextEncoder` / `TextDecoder`, `atob` / `btoa`. Shared like {@link FORBIDDEN_GLOBALS_SOURCE};
 * expects `define`, `defineProperty`, `StringCtor` and `ErrorCtor` in scope.
 */
export declare const ENCODING_GLOBALS_SOURCE: string;
/**
 * Source evaluated inside every sandbox (both engines) before the app bundle.
 *
 * It is a function expression taking the engine primitives `P` (fire-and-forget calls to the
 * host, strings and numbers only):
 *   P.host(callId, hostCallId, method, argsJson)   start a host call; answered via `settleHost`
 *   P.log(callId, level, message)                  one console line
 *   P.timerSet(callId, timerId, delayMs)           arm a timer; fired via `fireTimer`
 *   P.timerClear(timerId)
 *   P.done(callId, envelope)                       optional: invocation finished (QuickJS)
 *
 * It installs the app-visible globals (`console`, `setTimeout`, `clearTimeout`, frozen `__olan`,
 * `queueMicrotask`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`) and returns the runtime-only API
 * `{ load, invoke, settleHost, fireTimer }`. `P` and the API stay in this closure: nothing the
 * engine hands over (isolated-vm `Reference`, QuickJS host functions) is reachable from app code.
 *
 * Envelopes are strings: `'1' + valueJson` on success, `'0' + JSON({ code, message })` on failure.
 * `current` tracks which invocation the running code belongs to: it is set on every entry
 * (invoke, host-call settlement, timer) so console lines, host calls and timers are attributed
 * to the right invocation even with concurrent calls on one installation.
 */
export declare const BOOTSTRAP_SOURCE: string;

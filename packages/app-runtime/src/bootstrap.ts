/**
 * Removes engine globals that must never reach app code (both engines). Shared by
 * {@link BOOTSTRAP_SOURCE} and the sandbox session bootstrap (`session.ts`); expects `G` and
 * `defineProperty` in scope.
 */
export const FORBIDDEN_GLOBALS_SOURCE = String.raw`  // Engine globals that must never reach app code. A host started with --expose-gc leaks
  // gc into isolates; the process entry refuses to start that way, this is the second line.
  ['gc', 'process', 'require', 'module', 'exports', 'global', 'fetch', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate', 'std', 'os', 'print', 'scriptArgs',
    // WebAssembly.Memory is allocated outside the isolate heap limit; Atomics.wait blocks the
    // isolate thread without consuming CPU time.
    'WebAssembly', 'Atomics'].forEach(function (name) {
    if (!(name in G)) return;
    try { delete G[name]; } catch (e) {}
    if (name in G) {
      try { defineProperty(G, name, { value: undefined, writable: false, configurable: false, enumerable: false }); }
      catch (e) { try { G[name] = undefined; } catch (e2) {} }
    }
  });`;

/**
 * UTF-8 `TextEncoder` / `TextDecoder`, `atob` / `btoa`. Shared like {@link FORBIDDEN_GLOBALS_SOURCE};
 * expects `define`, `defineProperty`, `StringCtor` and `ErrorCtor` in scope.
 */
export const ENCODING_GLOBALS_SOURCE = String.raw`  // --- TextEncoder / TextDecoder (UTF-8 only), atob / btoa -----------------------------------
  function TextEncoder() {}
  defineProperty(TextEncoder.prototype, 'encoding', { get: function () { return 'utf-8'; } });
  TextEncoder.prototype.encode = function (input) {
    var s = input === undefined ? '' : StringCtor(input);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        else c = 0xfffd;
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  function TextDecoder(label) {
    var l = label === undefined ? 'utf-8' : StringCtor(label).toLowerCase();
    if (l !== 'utf-8' && l !== 'utf8') throw new RangeError('TextDecoder: only utf-8 is supported');
  }
  defineProperty(TextDecoder.prototype, 'encoding', { get: function () { return 'utf-8'; } });
  TextDecoder.prototype.decode = function (input) {
    if (input === undefined) return '';
    var bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    var out = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i++], cp = 0xfffd, need = 0;
      if (b < 0x80) { cp = b; }
      else if (b >= 0xc2 && b < 0xe0) { cp = b & 31; need = 1; }
      else if (b >= 0xe0 && b < 0xf0) { cp = b & 15; need = 2; }
      else if (b >= 0xf0 && b < 0xf5) { cp = b & 7; need = 3; }
      var ok = true;
      for (var k = 0; k < need; k++) {
        var n = bytes[i];
        if (n === undefined || (n & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (n & 63); i++;
      }
      if (!ok || (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff))) cp = 0xfffd;
      out += StringCtor.fromCodePoint(cp);
    }
    return out;
  };
  define('TextEncoder', TextEncoder);
  define('TextDecoder', TextDecoder);

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function invalidCharacter(what) {
    var e = new ErrorCtor(what + ': the string contains invalid characters');
    e.name = 'InvalidCharacterError';
    return e;
  }
  define('btoa', function btoa(input) {
    var s = StringCtor(input), out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw invalidCharacter('btoa');
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
        + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  });
  define('atob', function atob(input) {
    var s = StringCtor(input).replace(/[\t\n\f\r ]/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw invalidCharacter('atob');
    var out = '', bits = 0, value = 0;
    for (var i = 0; i < s.length; i++) {
      value = (value << 6) | B64.indexOf(s[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out += StringCtor.fromCharCode((value >> bits) & 255); }
    }
    return out;
  });`;

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
export const BOOTSTRAP_SOURCE = String.raw`(function (P) {
  'use strict';
  var G = globalThis;
  var stringify = JSON.stringify, parse = JSON.parse, freeze = Object.freeze;
  var hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  var defineProperty = Object.defineProperty;
  var PromiseCtor = Promise, ErrorCtor = Error, StringCtor = String;
  var MAX_LINE = 4096;
  var current = 0;
  var backend = null;
  var hostSeq = 0, timerSeq = 0;
  var hostWaiters = new Map();
  var timers = new Map();

  function define(name, value) {
    defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: false });
  }

  function describe(error) {
    try {
      if (error && typeof error === 'object' && typeof error.message === 'string') {
        var name = typeof error.name === 'string' && error.name && error.name !== 'Error' ? error.name + ': ' : '';
        return (name + error.message).slice(0, MAX_LINE);
      }
      return StringCtor(error).slice(0, MAX_LINE);
    } catch (e) {
      return 'unknown error';
    }
  }

  function format(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (value instanceof ErrorCtor) return value.stack ? StringCtor(value.stack) : describe(value);
    if (typeof value === 'bigint') return StringCtor(value) + 'n';
    if (typeof value === 'symbol') return value.toString();
    try {
      var json = stringify(value);
      return json === undefined ? StringCtor(value) : json;
    } catch (e) {
      try { return StringCtor(value); } catch (e2) { return '[unprintable]'; }
    }
  }

  function writer(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(format(arguments[i]));
      var message = parts.join(' ');
      if (message.length > MAX_LINE) message = message.slice(0, MAX_LINE);
      P.log(current, level, message);
    };
  }

${FORBIDDEN_GLOBALS_SOURCE}

  define('console', {
    log: writer('log'), info: writer('info'), warn: writer('warn'), error: writer('error'), debug: writer('log'),
  });

  define('setTimeout', function setTimeout(callback) {
    if (typeof callback !== 'function') throw new TypeError('setTimeout: callback must be a function');
    var delay = Number(arguments[1]);
    if (!(delay > 0)) delay = 0;
    var args = [];
    for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
    var id = ++timerSeq;
    timers.set(id, { callback: callback, args: args, owner: current });
    P.timerSet(current, id, delay);
    return id;
  });

  define('clearTimeout', function clearTimeout(id) {
    if (timers.delete(id)) P.timerClear(id);
  });

  define('queueMicrotask', function queueMicrotask(callback) {
    if (typeof callback !== 'function') throw new TypeError('queueMicrotask: callback must be a function');
    var owner = current;
    PromiseCtor.resolve().then(function () { current = owner; callback(); });
  });

  defineProperty(G, '__olan', {
    value: freeze({
      call: function call(method, argsJson) {
        var name = StringCtor(method);
        var args = argsJson === undefined ? 'null' : StringCtor(argsJson);
        var id = ++hostSeq;
        var owner = current;
        return new PromiseCtor(function (resolve, reject) {
          hostWaiters.set(id, { resolve: resolve, reject: reject, owner: owner });
          P.host(owner, id, name, args);
        });
      },
    }),
    writable: false, configurable: false, enumerable: false,
  });

${ENCODING_GLOBALS_SOURCE}

  // --- runtime API --------------------------------------------------------------------------
  function failure(code, message) { return '0' + stringify({ code: code, message: message }); }

  function own(map, key) {
    if (!map || typeof map !== 'object' || typeof key !== 'string' || !key || !hasOwn(map, key)) return undefined;
    var fn = map[key];
    return typeof fn === 'function' ? fn : undefined;
  }

  function signal() {
    // The sandbox is torn down at the wall deadline, so this signal never aborts while code runs.
    return freeze({
      aborted: false, reason: undefined, onabort: null,
      addEventListener: function () {}, removeEventListener: function () {}, throwIfAborted: function () {},
    });
  }

  function finish(callId) {
    timers.forEach(function (timer, id) {
      if (timer.owner === callId) { timers.delete(id); P.timerClear(id); }
    });
    hostWaiters.forEach(function (waiter, id) { if (waiter.owner === callId) hostWaiters.delete(id); });
  }

  return {
    load: function (callId) {
      current = callId;
      var module = G.__olanBackendModule;
      var definition = module && (typeof module === 'object' || typeof module === 'function') ? module.default : undefined;
      if (!definition || typeof definition !== 'object' || definition.$olanBackend !== 1) {
        return 'dist/server.js must be an IIFE with globalName "__olanBackendModule" whose default export is defineBackend({ ... })';
      }
      backend = definition;
      return '';
    },

    invoke: function (callId, kind, name, fallback, payloadJson, contextJson) {
      current = callId;
      var done = function (envelope) {
        finish(callId);
        if (P.done) P.done(callId, envelope);
        return envelope;
      };
      var fn, args;
      try {
        var payload = parse(payloadJson);
        var raw = parse(contextJson);
        var context = { installationId: raw.installationId, appId: raw.appId, identity: freeze(raw.identity), signal: signal() };
        var b = backend || {};
        if (kind === 'function') {
          fn = own(b.functions, name); args = [payload, context];
        } else if (kind === 'schedule') {
          fn = own(b.schedules, name);
          if (fn) {
            var scheduleContext = { installationId: context.installationId, appId: context.appId, identity: context.identity, signal: context.signal };
            if (payload && typeof payload === 'object') {
              scheduleContext.schedule = payload.schedule; scheduleContext.scheduledAt = payload.scheduledAt;
            }
            args = [scheduleContext];
          } else { fn = own(b.functions, fallback); args = [payload, context]; }
        } else if (kind === 'event' || kind === 'hook') {
          fn = own(kind === 'event' ? b.events : b.hooks, name) || own(b.functions, fallback); args = [payload, context];
        } else if (kind === 'migrate') {
          fn = typeof b.migrate === 'function' ? b.migrate : undefined;
          args = [payload && typeof payload === 'object' ? payload.fromVersion : payload, context];
        }
      } catch (error) {
        return PromiseCtor.resolve(done(failure('handler_error', describe(error))));
      }
      if (!fn) {
        var label = kind === 'migrate' ? 'migrate' : kind + ' "' + name + '"' + (fallback && kind !== 'function' ? ' (fallback function "' + fallback + '")' : '');
        return PromiseCtor.resolve(done(failure('not_found', 'no handler for ' + label)));
      }
      var pending;
      try { pending = PromiseCtor.resolve(fn.apply(undefined, args)); }
      catch (error) { pending = PromiseCtor.reject(error); }
      return pending.then(function (value) {
        current = callId;
        var json;
        try { json = stringify(value === undefined ? null : value); }
        catch (error) { return done(failure('handler_error', 'the result is not JSON: ' + describe(error))); }
        return done('1' + (json === undefined ? 'null' : json));
      }, function (error) {
        current = callId;
        return done(failure('handler_error', describe(error)));
      });
    },

    settleHost: function (hostCallId, envelope) {
      var waiter = hostWaiters.get(hostCallId);
      if (!waiter) return;
      hostWaiters.delete(hostCallId);
      current = waiter.owner;
      var result = parse(envelope);
      if (result.ok) { waiter.resolve(result.value); return; }
      var error = new ErrorCtor(result.message);
      error.code = result.code;
      waiter.reject(error);
    },

    fireTimer: function (timerId) {
      var timer = timers.get(timerId);
      if (!timer) return;
      timers.delete(timerId);
      current = timer.owner;
      try { timer.callback.apply(undefined, timer.args); }
      catch (error) { P.log(timer.owner, 'error', 'Uncaught in setTimeout callback: ' + format(error)); }
    },
  };
})`;

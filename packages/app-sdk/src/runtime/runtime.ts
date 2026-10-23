import { createElement, useSyncExternalStore, type ReactElement } from 'react';

import { dispatchTimer, dispatchUploadProgress, resetHostEvents } from '../api/host-events';
import { createRpcClient, setActiveRpcClient } from '../api/rpc-client';
import type { AppDefinition, SurfaceComponent } from '../define-app';
import { PROTOCOL_VERSION, SDK_VERSION, type HostToSandboxMessage, type InitMessage, type LogLevel, type SandboxToHostMessage } from '../protocol';
import { createUiRoot, type UiRoot } from '../reconciler/ui-root';
import { errorDetails, toJsonSafe } from './json-safe';
import { INITIAL_SCREEN, SessionContext, SessionStore, setActiveSession } from './session';
import type { Transport } from './transport';

export interface RuntimeOptions {
  /** Forward `console.*` as `log` messages (default `true`). */
  captureConsole?: boolean;
  /** Report uncaught errors and unhandled rejections of the global scope (default `true`). */
  captureGlobalErrors?: boolean;
}

export interface RuntimeHandle {
  /** The UI root once `init` mounted the surface. */
  readonly root: UiRoot | null;
  readonly session: SessionStore | null;
  /** Unmounts the surface, rejects pending calls and restores `console`. */
  dispose(): void;
}

const CONSOLE_LEVELS: Record<'debug' | 'log' | 'info' | 'warn' | 'error', LogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/** Renders the surface with the session's current params (panels get new params without a new `init`). */
function SurfaceRoot({ surface, session }: { surface: SurfaceComponent; session: SessionStore }): ReactElement {
  const params = useSyncExternalStore(session.subscribe, () => session.get().params, () => session.get().params);
  return createElement(surface, { params });
}

interface GlobalEvents {
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

/**
 * The sandbox-side runtime. Posts `ready`, waits for `init`, mounts `app.surfaces[init.surface]`,
 * sends one `patches` batch per commit, routes `event` messages to handlers and settles `olan.*`
 * calls from `rpc-result`. The same code runs in the Worker (`workerTransport()`) and in Node
 * tests (`createMemoryChannel().sandbox`).
 */
export function startRuntime(transport: Transport, app: AppDefinition, options: RuntimeOptions = {}): RuntimeHandle {
  const post = (message: SandboxToHostMessage) => transport.post(message);
  const rpc = createRpcClient(post);
  setActiveRpcClient(rpc);

  let root: UiRoot | null = null;
  let session: SessionStore | null = null;
  let disposed = false;
  const cleanups: (() => void)[] = [];

  const reportError = (error: unknown, fatal: boolean) => {
    const details = errorDetails(error);
    post({ type: 'error', message: details.message, ...(details.stack ? { stack: details.stack } : {}), ...(fatal ? { fatal } : {}) });
  };

  if (options.captureConsole !== false) cleanups.push(captureConsole(post));
  if (options.captureGlobalErrors !== false) cleanups.push(captureGlobalErrors(reportError));

  const mount = (message: InitMessage) => {
    if (root) {
      reportError(new Error('The surface is already initialised'), false);
      return;
    }
    const Surface = app.surfaces[message.surface];
    if (!Surface) {
      reportError(new Error(`The app does not define the "${message.surface}" surface`), true);
      return;
    }
    // Phase 5a §8: an app address names the first screen; another screen goes over the first one.
    const start = message.navigation;
    const stack =
      !start || start.screen === INITIAL_SCREEN
        ? [{ screen: INITIAL_SCREEN, params: start ? start.params : message.params }]
        : [{ screen: INITIAL_SCREEN, params: message.params }, { screen: start.screen, params: start.params }];
    session = new SessionStore({
      app: message.app,
      surface: message.surface,
      params: message.params,
      // Hosts older than SDK 1.2 send no `user`; an empty id never matches a row's `createdBy`.
      context: message.context.user ? message.context : { ...message.context, user: { id: '' } },
      stack,
    });
    setActiveSession(session);
    root = createUiRoot({
      onPatches: (seq, patches) => post({ type: 'patches', seq, patches }),
      onUncaughtError: (error) => reportError(error, true),
      onRecoverableError: (error) => reportError(error, false),
    });
    try {
      root.render(createElement(SessionContext.Provider, { value: session }, createElement(SurfaceRoot, { surface: Surface, session })));
    } catch (error) {
      reportError(error, true);
    }
  };

  const handle = (message: HostToSandboxMessage) => {
    if (disposed) return;
    switch (message.type) {
      case 'init':
        mount(message);
        return;
      case 'event': {
        if (!root) return;
        try {
          const result = root.dispatch(message.handlerId, message.payload);
          if (!result.found) {
            post({ type: 'log', level: 'debug', args: [`Ignored an event for removed handler ${message.handlerId}`] });
          } else if (isPromiseLike(result.value)) {
            result.value.then(undefined, (error: unknown) => reportError(error, false));
          }
        } catch (error) {
          reportError(error, false);
        }
        return;
      }
      case 'rpc-result':
        rpc.settle(message.id, message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error });
        return;
      case 'context':
        session?.mergeContext(message.context);
        if (message.params !== undefined) session?.setParams(message.params);
        return;
      case 'navigation':
        session?.pop();
        return;
      case 'upload-progress':
        dispatchUploadProgress(message.uploadId, { loaded: message.loaded, total: message.total });
        return;
      case 'timer':
        dispatchTimer(message.timerId);
        return;
      default:
        post({ type: 'log', level: 'warn', args: ['Unknown host message', toJsonSafe(message)] });
    }
  };

  cleanups.push(transport.onMessage(handle));
  post({ type: 'ready', sdkVersion: SDK_VERSION, protocolVersion: PROTOCOL_VERSION });

  return {
    get root() {
      return root;
    },
    get session() {
      return session;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        root?.unmount();
      } catch {
        // The tree is going away either way.
      }
      rpc.cancelAll('The app was closed');
      resetHostEvents();
      setActiveRpcClient(null);
      setActiveSession(null);
      for (const cleanup of cleanups.reverse()) cleanup();
    },
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function captureConsole(post: (message: SandboxToHostMessage) => void): () => void {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals: Record<string, (...args: unknown[]) => void> = {};
  let forwarding = false;
  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = target[method];
    originals[method] = original;
    target[method] = (...args: unknown[]) => {
      original?.apply(console, args);
      if (forwarding) return;
      forwarding = true;
      try {
        post({ type: 'log', level, args: args.map((arg) => toJsonSafe(arg)) });
      } finally {
        forwarding = false;
      }
    };
  }
  return () => {
    for (const [method, original] of Object.entries(originals)) target[method] = original;
  };
}

function captureGlobalErrors(report: (error: unknown, fatal: boolean) => void): () => void {
  const scope = globalThis as unknown as GlobalEvents;
  if (typeof scope.addEventListener !== 'function' || typeof scope.removeEventListener !== 'function') return () => {};
  const onError = (event: unknown) => report((event as { error?: unknown; message?: string }).error ?? (event as { message?: string }).message, false);
  const onRejection = (event: unknown) => report((event as { reason?: unknown }).reason, false);
  scope.addEventListener('error', onError);
  scope.addEventListener('unhandledrejection', onRejection);
  return () => {
    scope.removeEventListener?.('error', onError);
    scope.removeEventListener?.('unhandledrejection', onRejection);
  };
}

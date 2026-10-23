import type { HostToSandboxMessage, SandboxToHostMessage } from '../protocol';

/** The sandbox side of the message channel. */
export interface Transport {
  post(message: SandboxToHostMessage): void;
  /** Subscribes to host messages; returns the unsubscribe function. */
  onMessage(listener: (message: HostToSandboxMessage) => void): () => void;
}

/** The host side of an in-memory channel (tests, headless rendering). */
export interface HostEndpoint {
  post(message: HostToSandboxMessage): void;
  onMessage(listener: (message: SandboxToHostMessage) => void): () => void;
}

export interface MemoryChannel {
  sandbox: Transport;
  host: HostEndpoint;
}

/**
 * Two connected endpoints in one process. Delivery is asynchronous (a microtask) and every
 * message is copied through JSON, as `postMessage` would clone it, so tests catch values that
 * cannot cross the sandbox boundary.
 */
export function createMemoryChannel(): MemoryChannel {
  const toHost = new Set<(message: SandboxToHostMessage) => void>();
  const toSandbox = new Set<(message: HostToSandboxMessage) => void>();
  const deliver = <T>(listeners: Set<(message: T) => void>, message: T) => {
    const copy = JSON.parse(JSON.stringify(message)) as T;
    queueMicrotask(() => {
      for (const listener of listeners) listener(copy);
    });
  };
  return {
    sandbox: {
      post: (message) => deliver(toHost, message),
      onMessage(listener) {
        toSandbox.add(listener);
        return () => toSandbox.delete(listener);
      },
    },
    host: {
      post: (message) => deliver(toSandbox, message),
      onMessage(listener) {
        toHost.add(listener);
        return () => toHost.delete(listener);
      },
    },
  };
}

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  __olanTransport?: Transport;
}

/**
 * The transport inside a Worker. The Olan sandbox bootstrap installs `__olanTransport` (a
 * MessagePort to the host) before the app module runs; without it (a plain dedicated worker, as
 * `olan-app dev` may use) the worker's own `postMessage` channel is used.
 */
export function workerTransport(): Transport {
  const scope = globalThis as unknown as WorkerScope;
  if (scope.__olanTransport) return scope.__olanTransport;
  return {
    post: (message) => scope.postMessage(message),
    onMessage(listener) {
      const handler = (event: { data: unknown }) => listener(event.data as HostToSandboxMessage);
      scope.addEventListener('message', handler);
      return () => scope.removeEventListener('message', handler);
    },
  };
}

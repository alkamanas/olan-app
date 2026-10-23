import type { ReactNode } from 'react';
import { ConcurrentRoot } from 'react-reconciler/constants';

import type { JsonValue, UiPatch } from '../protocol';
import { reconciler, runWithDiscretePriority } from './host-config';
import { UiContainer } from './ui-container';

export interface UiRootOptions {
  /** Receives one batch per React commit. */
  onPatches: (seq: number, patches: UiPatch[]) => void;
  /** An error no error boundary caught; the tree is unmounted. */
  onUncaughtError?: (error: unknown) => void;
  /** Errors caught by a boundary and recoverable render errors. */
  onRecoverableError?: (error: unknown) => void;
}

export interface DispatchResult {
  /** The handler id was known (a stale id from an already removed node returns `false`). */
  found: boolean;
  /** The handler's return value (a promise for async handlers). */
  value?: unknown;
}

export interface UiRoot {
  readonly container: UiContainer;
  /** Renders synchronously: the first batch is emitted before this returns. */
  render(element: ReactNode): void;
  /** Calls a handler with discrete priority; state updates it makes flush in a microtask. */
  dispatch(handlerId: number, payload: JsonValue): DispatchResult;
  unmount(): void;
}

let rootCount = 0;

export function createUiRoot(options: UiRootOptions): UiRoot {
  const container = new UiContainer(options.onPatches);
  const report = (handler: ((error: unknown) => void) | undefined) => (error: unknown) => {
    if (handler) handler(error);
    else console.error(error);
  };
  const fiberRoot = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    `olan${rootCount++}-`,
    report(options.onUncaughtError),
    report(options.onRecoverableError),
    report(options.onRecoverableError),
    () => {},
    null,
  );

  return {
    container,
    render(element) {
      reconciler.updateContainerSync(element, fiberRoot, null, null);
      reconciler.flushSyncWork();
    },
    dispatch(handlerId, payload) {
      const handler = container.getHandler(handlerId);
      if (!handler) return { found: false };
      const value = runWithDiscretePriority(() => reconciler.batchedUpdates(() => handler(payload), undefined));
      return { found: true, value };
    },
    unmount() {
      reconciler.updateContainerSync(null, fiberRoot, null, null);
      reconciler.flushSyncWork();
    },
  };
}

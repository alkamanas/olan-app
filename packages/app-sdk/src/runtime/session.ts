import { createContext } from 'react';

import type { AppContext, AppIdentity, JsonValue, Surface } from '../protocol';

export interface NavigationEntry {
  screen: string;
  params: JsonValue;
}

/** Name of the first screen of every surface (`useNavigation().screen` before any `push`). */
export const INITIAL_SCREEN = 'index';

export interface SessionState {
  app: AppIdentity;
  surface: Surface;
  params: JsonValue;
  context: AppContext;
  /** Navigation stack; the last entry is the visible screen. Never empty. */
  stack: NavigationEntry[];
}

/**
 * State of one running surface: what `init` said, later `context` updates, and the navigation
 * stack. Hooks read it through `useSyncExternalStore`; a new state object is published on every
 * change.
 */
export class SessionStore {
  private state: SessionState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: SessionState) {
    this.state = initial;
  }

  get = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(change: (state: SessionState) => SessionState): void {
    const next = change(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  mergeContext(context: Partial<AppContext>): void {
    this.update((state) => ({ ...state, context: { ...state.context, ...context } }));
  }

  /** New surface params (a panel moved to another object, Phase 3 §3.1); the first screen gets them too. */
  setParams(params: JsonValue): void {
    this.update((state) => ({ ...state, params, stack: [{ ...state.stack[0]!, params }, ...state.stack.slice(1)] }));
  }

  push(entry: NavigationEntry): void {
    this.update((state) => ({ ...state, stack: [...state.stack, entry] }));
  }

  replace(entry: NavigationEntry): void {
    this.update((state) => ({ ...state, stack: [...state.stack.slice(0, -1), entry] }));
  }

  /** Returns `false` when already on the first screen. */
  pop(): boolean {
    if (this.state.stack.length <= 1) return false;
    this.update((state) => ({ ...state, stack: state.stack.slice(0, -1) }));
    return true;
  }
}

export const SessionContext = createContext<SessionStore | null>(null);

/* The running session, for the non-hook APIs (`olan.navigation`). One app runs per worker. */
let activeSession: SessionStore | null = null;

export function setActiveSession(session: SessionStore | null): void {
  activeSession = session;
}

export function getActiveSession(): SessionStore | null {
  return activeSession;
}

import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DependencyList } from 'react';

import { subscribeDbChanges, type DbData } from '../api/db';
import { nextTimerId, onTimer } from '../api/host-events';
import { olan } from '../api/olan';
import { isOlanError, OlanError, rpc } from '../api/rpc-client';
import type { DbQuery, DbRow, DirectoryUser, ProjectConfig, ProjectConfigSetOptions } from '../api/types';
import type { AppContext, AppUser, JsonValue, Platform, Surface, SurfaceParams, Theme } from '../protocol';
import { SessionContext, type SessionState, type SessionStore } from '../runtime/session';

function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (!store) throw new Error('Olan hooks only work inside a surface started by the Olan app runtime');
  return store;
}

function useSession<T>(select: (state: SessionState) => T): T {
  const store = useSessionStore();
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}

const selectContext = (state: SessionState): AppContext => state.context;
const selectTheme = (state: SessionState): Theme => state.context.theme;
const selectLocale = (state: SessionState): string => state.context.locale;
const selectPlatform = (state: SessionState): Platform => state.context.platform;
const selectSettings = (state: SessionState) => state.context.settings;
const selectUser = (state: SessionState): AppUser => state.context.user;
const selectTop = (state: SessionState) => state.stack[state.stack.length - 1];
const selectParams = (state: SessionState): JsonValue => state.params;
const selectDepth = (state: SessionState) => state.stack.length;

/** `'light'` or `'dark'`; follows the host. Colours themselves stay with the host. */
export function useTheme(): Theme {
  return useSession(selectTheme);
}

/** BCP 47 locale of the host UI (`tr`, `en-US`, …). */
export function useLocale(): string {
  return useSession(selectLocale);
}

/** Where the app runs: `web`, `desktop`, `ios` or `android`. */
export function usePlatform(): Platform {
  return useSession(selectPlatform);
}

/** The app's settings as the host last sent them (updates when an admin changes them). */
export function useSettings(): Record<string, JsonValue> {
  return useSession(selectSettings);
}

/**
 * The person using the app: `{ id }`, the central Olan user id (the same value as `createdBy`,
 * `assigneeId` and member `userId` everywhere). Needs no permission. Compare it with
 * `row.createdBy` to show actions only on the user's own rows. Names come from `useUsers`.
 */
export function useUser(): AppUser {
  return useSession(selectUser);
}

/**
 * What the host opened the surface with, typed per surface (Phase 3 §3.1):
 *
 * ```tsx
 * const { conversationId, message } = useSurfaceParams<'chat.action'>();
 * ```
 *
 * `chat.action` → `{ conversationId, message }`, `chat.command` → `{ conversationId, text, threadRootId? }`,
 * `chat.card` → `{ conversationId, messageId, payload }`, `mail.sidebar`/`mail.action` → the open
 * message's summary, `calendar.event.action` → the event, `meeting.panel` → the meeting,
 * `project.widget`/`project.tab`/`project.settings` → `{ projectId }`, `app`/`settings` → `null`.
 * These summaries need no permission.
 * Panels (`mail.sidebar`, `meeting.panel`) re-render with new params when the person opens another object.
 * The type parameter is not checked at runtime: pass the surface the component is registered for.
 */
export function useSurfaceParams<S extends Surface>(): SurfaceParams[S] {
  return useSession(selectParams) as unknown as SurfaceParams[S];
}

/** The whole host context (theme, locale, platform, granted permissions, settings, development, user). */
export function useAppContext(): AppContext {
  return useSession(selectContext);
}

export interface NavigationState {
  screen: string;
  params: JsonValue;
  /** Screens on the stack (1 on the first screen). */
  depth: number;
  push: typeof olan.navigation.push;
  pop: typeof olan.navigation.pop;
  replace: typeof olan.navigation.replace;
}

/** The visible screen of the surface's navigation stack, plus the navigation actions. */
export function useNavigation(): NavigationState {
  const top = useSession(selectTop);
  const depth = useSession(selectDepth);
  return {
    screen: top.screen,
    params: top.params,
    depth,
    push: olan.navigation.push,
    pop: olan.navigation.pop,
    replace: olan.navigation.replace,
  };
}

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** True while any run is in flight, including silent `refetchIntervalMs` refreshes (`loading` stays false for those). */
  fetching: boolean;
  /** Runs the query again; resolves when it settles. Keeps the previous `data` while loading. */
  refetch: () => Promise<void>;
}

export interface QueryOptions {
  /**
   * Runs the query again every this many ms (at least 5000; smaller values are raised), quietly:
   * `loading` stays false and `data` stays until the new result. The host drives the timer and
   * pauses it while the app is not visible. `0`, `false`, `null` or `undefined` turns it off.
   */
  refetchIntervalMs?: number | false | null;
}

/** Smallest refetch interval (`RPC_LIMITS.timerMinIntervalMs` of @olan-app/schema). */
export const MIN_REFETCH_INTERVAL_MS = 5000;

/**
 * A host timer (`timers.set`) that calls `tick` every `intervalMs`; an older host without timers
 * (`unknown_method`) gets a sandbox interval instead. Returns the cleanup.
 */
function startRefetchTimer(intervalMs: number, tick: () => void): () => void {
  const timerId = nextTimerId();
  let fallback: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const unsubscribe = onTimer(timerId, tick);
  rpc('timers.set', { timerId, intervalMs }).catch((error: unknown) => {
    if (stopped || !isOlanError(error, 'unknown_method')) return;
    fallback = setInterval(tick, intervalMs);
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (fallback !== null) clearInterval(fallback);
    else rpc('timers.clear', { timerId }).catch(() => undefined);
  };
}

/**
 * Runs an async function (usually an `olan.*` call) when the component mounts and whenever `deps`
 * change. Results of superseded runs are ignored. `options.refetchIntervalMs` refreshes it quietly
 * on a host timer (Phase 5a §7).
 */
export function useQuery<T>(fn: () => Promise<T>, deps: DependencyList = [], options: QueryOptions = {}): QueryState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: Error | undefined; loading: boolean; fetching: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
    fetching: true,
  });
  const fnRef = useRef(fn);
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const execute = useCallback(async (quiet: boolean) => {
    const id = ++runRef.current;
    inFlightRef.current = true;
    setState((previous) => {
      if (quiet) return previous.fetching ? previous : { ...previous, fetching: true };
      return previous.loading && previous.fetching ? previous : { ...previous, loading: true, fetching: true };
    });
    try {
      const data = await fnRef.current();
      if (id === runRef.current) inFlightRef.current = false;
      if (mountedRef.current && id === runRef.current) setState({ data, error: undefined, loading: false, fetching: false });
    } catch (error) {
      if (id === runRef.current) inFlightRef.current = false;
      if (mountedRef.current && id === runRef.current) {
        setState((previous) => ({ data: previous.data, error: error instanceof Error ? error : new Error(String(error)), loading: false, fetching: false }));
      }
    }
  }, []);
  const run = useCallback(() => execute(false), [execute]);

  const requested = options.refetchIntervalMs;
  const intervalMs = typeof requested === 'number' && requested > 0 ? Math.max(MIN_REFETCH_INTERVAL_MS, Math.floor(requested)) : 0;
  useEffect(() => {
    if (intervalMs === 0) return undefined;
    return startRefetchTimer(intervalMs, () => {
      // A tick while a run is still in flight is skipped.
      if (mountedRef.current && !inFlightRef.current) void execute(true);
    });
  }, [intervalMs, execute]);

  // Declared before the query effect, so the query (and `refetch`) see this render's `fn`.
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    mountedRef.current = true;
    void run();
    return () => {
      mountedRef.current = false;
    };
    // `deps` is the caller's dependency list, as with useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refetch: run };
}

export interface ProjectConfigState extends QueryState<ProjectConfig> {
  /** The stored configuration, `{}` until it is first set (or while loading). */
  value: Record<string, JsonValue>;
  /**
   * Replaces the configuration (`olan.project.config.set`) based on the loaded `revision`, so a
   * change someone made meanwhile fails with `conflict` instead of being overwritten. The state
   * holds the saved configuration afterwards.
   */
  save: (value: Record<string, JsonValue>, options?: ProjectConfigSetOptions) => Promise<ProjectConfig>;
}

const EMPTY_CONFIG: Record<string, JsonValue> = Object.freeze({}) as Record<string, JsonValue>;

/**
 * The app's configuration of a project (Phase 6, `olan.project.config`). Without `projectId` it uses
 * the project the surface was opened for (`project.widget`, `project.tab`, `project.settings`).
 * Fails with `project_not_enabled` when the app was not added to the project.
 *
 * ```tsx
 * const config = useProjectConfig();
 * const brandId = typeof config.value.brandId === 'string' ? config.value.brandId : null;
 * ```
 */
export function useProjectConfig(projectId?: string): ProjectConfigState {
  const params = useSession(selectParams);
  const fromSurface = typeof params === 'object' && params !== null && !Array.isArray(params) && typeof params.projectId === 'string' ? params.projectId : null;
  const id = projectId ?? fromSurface;
  const query = useQuery(() => {
    if (!id) return Promise.reject(new OlanError('invalid_params', 'useProjectConfig needs a projectId outside the project surfaces'));
    return olan.project.config.get(id);
  }, [id]);
  const [saved, setSaved] = useState<ProjectConfig | null>(null);
  // A save wins over the loaded state until the next load of the same project.
  const current = saved && saved.projectId === id && (!query.data || saved.revision >= query.data.revision) ? saved : query.data;
  const revision = current?.revision;
  const save = useCallback(async (value: Record<string, JsonValue>, options: ProjectConfigSetOptions = {}) => {
    if (!id) throw new OlanError('invalid_params', 'useProjectConfig needs a projectId outside the project surfaces');
    const next = await olan.project.config.set(id, value, { revision: options.revision ?? revision });
    setSaved(next);
    return next;
  }, [id, revision]);
  return { ...query, data: current, value: current?.value ?? EMPTY_CONFIG, save };
}

export interface UsersState extends QueryState<DirectoryUser[]> {
  /** The loaded entries by id (empty while loading). Ids missing here are unknown or not visible. */
  byId: ReadonlyMap<string, DirectoryUser>;
}

const EMPTY_USERS: DirectoryUser[] = [];

/**
 * Directory entries for `ids` (`olan.users.get`), loaded when the component mounts and whenever
 * the set of ids changes (order and duplicates do not matter). An empty list makes no call.
 * Needs `users:read`.
 */
export function useUsers(ids: readonly string[]): UsersState {
  const key = JSON.stringify([...new Set(ids)].sort());
  const query = useQuery(() => olan.users.get(JSON.parse(key) as string[]), [key]);
  const { data } = query;
  const byId = useMemo(() => new Map((data ?? EMPTY_USERS).map((user) => [user.id, user] as const)), [data]);
  return { ...query, byId };
}

export interface CollectionState<T> {
  /** Rows of every page loaded so far (the first page, plus `loadMore` pages). */
  rows: DbRow<T>[];
  /** Cursor of the next page, or null on the last page. */
  nextCursor: string | null;
  loading: boolean;
  error: OlanError | undefined;
  /** Loads the first page again (keeps the previous rows while loading). */
  refetch: () => Promise<void>;
  /** Appends the next page; does nothing on the last page or while loading. */
  loadMore: () => Promise<void>;
}

function toOlanError(error: unknown): OlanError {
  if (isOlanError(error)) return error;
  return new OlanError('host_error', error instanceof Error ? error.message : String(error));
}

/**
 * Rows of a collection (`olan.db.collection(name).query(query)`), loaded when the component
 * mounts and whenever `name`, `query` (compared by value) or `deps` change. Inserts, updates and
 * deletes made through `olan.db.collection(name)` in this app reload it; changes made by other
 * people arrive with `refetch`. Needs the `db` permission.
 */
export function useCollection<T extends DbData = Record<string, JsonValue>>(
  name: string,
  query: Omit<DbQuery, 'cursor'> = {},
  deps: DependencyList = [],
): CollectionState<T> {
  const [state, setState] = useState<{ rows: DbRow<T>[]; nextCursor: string | null; loading: boolean; error: OlanError | undefined }>({
    rows: [],
    nextCursor: null,
    loading: true,
    error: undefined,
  });
  const queryKey = JSON.stringify(query ?? {});
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const refetch = useCallback(async () => {
    const id = ++runRef.current;
    setState((previous) => (previous.loading ? previous : { ...previous, loading: true }));
    try {
      const page = await olan.db.collection<T>(name).query(JSON.parse(queryKey) as DbQuery);
      if (mountedRef.current && id === runRef.current) setState({ rows: page.rows, nextCursor: page.nextCursor, loading: false, error: undefined });
    } catch (error) {
      if (mountedRef.current && id === runRef.current) setState((previous) => ({ ...previous, loading: false, error: toOlanError(error) }));
    }
  }, [name, queryKey]);

  const loadMore = useCallback(async () => {
    const { nextCursor, loading } = stateRef.current;
    if (!nextCursor || loading) return;
    const id = ++runRef.current;
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const page = await olan.db.collection<T>(name).query({ ...(JSON.parse(queryKey) as DbQuery), cursor: nextCursor });
      if (mountedRef.current && id === runRef.current) {
        setState((previous) => ({ rows: [...previous.rows, ...page.rows], nextCursor: page.nextCursor, loading: false, error: undefined }));
      }
    } catch (error) {
      if (mountedRef.current && id === runRef.current) setState((previous) => ({ ...previous, loading: false, error: toOlanError(error) }));
    }
  }, [name, queryKey]);

  useEffect(() => {
    mountedRef.current = true;
    void refetch();
    const unsubscribe = subscribeDbChanges(name, () => void refetch());
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
    // `deps` is the caller's dependency list, as with useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch, name, ...deps]);

  return { ...state, refetch, loadMore };
}

/**
 * One row (`olan.db.collection(name).get(id)`), reloaded when it changes through `olan.db` in this
 * app. `id` null skips the call (`data` null). `data` is null when the row does not exist.
 */
export function useRecord<T extends DbData = Record<string, JsonValue>>(name: string, id: string | null): QueryState<DbRow<T> | null> {
  const query = useQuery<DbRow<T> | null>(() => (id === null ? Promise.resolve(null) : olan.db.collection<T>(name).get(id)), [name, id]);
  const { refetch } = query;
  useEffect(() => {
    if (id === null) return undefined;
    return subscribeDbChanges(name, (change) => {
      if (change.id === id) void refetch();
    });
  }, [name, id, refetch]);
  return query;
}

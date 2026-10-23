# Hooks

```ts
import { useQuery, useCollection, useRecord, useUser, useUsers, useNavigation, useSurfaceParams, useProjectConfig, useSettings, useTheme, useLocale, usePlatform, useAppContext } from '@olan-app/sdk';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';   // React hooks work as usual
```

Hooks only work inside components rendered by a surface (they read the running session), and
only in named components (`function Projects() { … }`), following the React hook rules.

## useQuery(fn, deps?, options?)

Runs an async function when the component mounts and again whenever `deps` change (like
`useEffect`). Results of superseded runs are ignored. `options.refetchIntervalMs` refreshes it
regularly (SDK 1.5, below).

```ts
const projects = useQuery(() => olan.projects.list({ limit: 50 }));
const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
```

Returns `QueryState<T>`:

| Field | Type | Notes |
|---|---|---|
| `data` | `T \| undefined` | Last successful result; kept while refetching and after an error |
| `error` | `Error \| undefined` | The rejection (an `OlanError` for `olan.*` failures) |
| `loading` | `boolean` | `true` on the first render and during a refetch |
| `fetching` | `boolean` | `true` while any run is in flight, including the quiet interval refreshes (SDK 1.5) |
| `refetch` | `() => Promise<void>` | Runs it again (e.g. after `updateTask`) |

Typical shape:

```tsx
function Projects() {
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  if (projects.error) {
    return (
      <Screen title="Projeler">
        <EmptyState title="Projeler yüklenemedi" description={projects.error.message} action={{ label: 'Tekrar dene', onPress: () => projects.refetch() }} />
      </Screen>
    );
  }
  const items = (projects.data?.items ?? []).map((p) => ({ key: p.id, title: p.name }));
  return (
    <Screen title="Projeler" loading={projects.loading}>
      <List items={items} emptyText="Henüz proje yok" />
    </Screen>
  );
}
```

After a change, update and refetch:

```ts
await olan.projects.updateTask(projectId, task.id, { status: 'completed', revision: task.revision });
await tasks.refetch();
```

### Refreshing on an interval (`refetchIntervalMs`)

```tsx
const posts = useQuery(
  () => olan.remote.request({ method: 'GET', path: '/posts' }),
  [brandId],
  { refetchIntervalMs: hasPending ? 10_000 : undefined },      // poll only while something is publishing
);
```

- At least 5000 ms; smaller values are raised to 5000. `undefined`, `0`, `false` or `null` turns
  it off; changing the value restarts the timer.
- Interval runs are quiet: `loading` stays `false`, `data` stays until the new result, a failure
  goes to `error` (and the old `data` stays). `fetching` is `true` while one runs. A tick while a run
  is still in flight is skipped.
- Olan drives the timer, not the sandbox: there are no ticks while the surface is not visible (a
  hidden browser tab, a closed panel, the app in the background on a phone). When it becomes visible
  and the interval has passed, a tick comes at once, then the timer continues.
- At most 16 timers per sandbox. On an Olan server before 1.5 the SDK falls back to a timer inside
  the sandbox.
- Tests: `app.fireTimers()` sends one tick (testing.md).

## useCollection(name, query?, deps?)

Rows of an `olan.db` collection (database.md), loaded on mount and whenever `name`, `query`
(compared by value) or `deps` change. Needs `db`.

```ts
const list = useCollection<Decision>('decisions', { where: { status }, orderBy: { field: 'title' }, limit: 20 });
```

| Field | Type | Notes |
|---|---|---|
| `rows` | `DbRow<T>[]` | The first page plus every page `loadMore` added |
| `nextCursor` | `string \| null` | `null` on the last page |
| `loading` | `boolean` | `true` on the first render, while refetching and during `loadMore` |
| `error` | `OlanError \| undefined` | e.g. `permission_denied`, `invalid_params` |
| `refetch` | `() => Promise<void>` | Loads the first page again |
| `loadMore` | `() => Promise<void>` | Appends the next page (no-op on the last page) |

`insert`, `update` and `delete` through `olan.db.collection(name)` anywhere in the app reload every
`useCollection`/`useRecord` of that collection; there are no live updates from other people, so
offer a refresh action (`refetch`).

## useRecord(name, id)

One row: `QueryState<DbRow<T> | null>` (`data` is `null` when the row does not exist or is
hidden). `id` `null` skips the call. Reloads when the row changes through `olan.db` in the app.

```ts
const decision = useRecord<Decision>('decisions', params.id);
```

## useUser()

The person using the app: `{ id }`, the central Olan user id (a UUID). It is the same value as
`row.createdBy`, `task.assigneeId`, `task.createdBy` and `member.userId`, so compare with it to show
actions only where they will work. Needs no permission.

```tsx
const me = useUser();
const mine = row.createdBy === me.id;   // e.g. hide "Sil" on other people's rows of a delete: 'owner' collection
const myTasks = tasks.filter((task) => task.assigneeId === me.id);
```

## useUsers(ids)

Directory entries (`olan.users.get`) for a set of ids: `QueryState<DirectoryUser[]>` plus `byId`
(a `Map`). Reloads when the set changes (order and duplicates do not matter); `[]` makes no call.
Unknown or inaccessible ids are missing from the result. Needs `users:read`.

```tsx
const people = useUsers(rows.map((row) => row.createdBy));
const name = (id: string) => people.byId.get(id)?.displayName ?? '—';
```

## useNavigation()

The visible screen of the surface's navigation stack and the navigation actions (navigation.md).

```ts
const { screen, params, depth, push, pop, replace } = useNavigation();
```

| Field | Type | Notes |
|---|---|---|
| `screen` | `string` | `'index'` on the first screen |
| `params` | `JsonValue` | Params of the visible screen (first screen: the surface params, or the query of an app address, links.md) |
| `depth` | `number` | Screens on the stack (1 on the first screen) |
| `push(screen, params?)` | `Promise<void>` | Same as `olan.navigation.push` |
| `pop()` | `Promise<void>` | |
| `replace(screen, params?)` | `Promise<void>` | |

## useSurfaceParams<S>()

What the host opened the surface on, typed per surface (surfaces.md):

```ts
const { conversationId, message } = useSurfaceParams<'chat.action'>();
const mail = useSurfaceParams<'mail.sidebar'>();
// { messageId, threadId: string | null, subject, from: { name: string | null, email }, to: same[], cc: same[], receivedAt: ISO date-time }
const returned = useSurfaceParams<'app'>()?.return;   // SDK 1.5: an external flow came back with no pending openExternal (links.md)
```

Exact shapes and which fields may be `null`: surfaces.md. In tests they come from the fixtures
(testing.md, "Surface params in tests").

Panels (`mail.sidebar`, `meeting.panel`) re-render with new params when the person opens another
object; use the params as `useQuery` deps. The type argument is not checked at run time.

## useProjectConfig(projectId?)

SDK 1.6: the app's configuration of a project (`olan.project.config`, api.md). Without `projectId`
it uses the project the surface was opened for (`project.widget`, `project.tab`, `project.settings`; SDK 1.7 also `task.action`, `issue.action`, `record.card`).
A `useQuery` state plus `value` (`{}` until set) and `save(value, { revision? })`, which writes on the
loaded `revision` so a change someone made meanwhile fails with `conflict` (then `refetch()`).

```tsx
const config = useProjectConfig();
const brandId = typeof config.value.brandId === 'string' ? config.value.brandId : null;
await config.save({ ...config.value, brandId: 'b2' });   // config.data.revision + 1 afterwards
if (isOlanError(config.error, 'project_not_enabled')) { /* the app was not added to this project */ }
```

## useSettings()

`Record<string, JsonValue>`: the app's settings (manifest `settings` with defaults applied).
Re-renders when an admin changes them.

```ts
const settings = useSettings();
const threshold = typeof settings.threshold === 'number' ? settings.threshold : 3;
```

## useTheme(), useLocale(), usePlatform()

- `useTheme()` → `'light' | 'dark'` (colours stay with the host; use it only for content choices).
- `useLocale()` → the host UI's BCP 47 locale, e.g. `'tr'` or `'en-US'`. Use it with
  `Intl.DateTimeFormat`/`Intl.NumberFormat` and to pick your strings.
- `usePlatform()` → `'web' | 'desktop' | 'ios' | 'android'`.

## useAppContext()

The whole host context: `{ theme, locale, platform, permissions: string[], settings, development: boolean, user: { id } }`.
`permissions` are the permissions the installation granted; `development` is `true` in Studio and
in tests; `user` is what `useUser()` returns.

```ts
const { permissions } = useAppContext();
const canDelete = permissions.includes('tasks:delete');
```

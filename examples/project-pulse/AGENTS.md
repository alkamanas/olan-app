# Project Pulse — an Olan App

App id `com.olan.examples.project-pulse` (template `list-detail`).

An Olan App is React + TypeScript that runs in a sandbox: it describes its UI with
`@olan-app/sdk` components (Olan draws them natively on web, desktop, iOS and Android) and gets
data through `olan.*` calls that Olan permission-checks.

Full offline docs: `node_modules/@olan-app/sdk/docs/` (start with `getting-started.md`), a one-file
digest in `node_modules/@olan-app/sdk/llms.txt`, search with `npx olan-app docs <query>`. Complete
example apps: `node_modules/@olan-app/sdk/docs/examples.md`.

## Done

The task is done only when both pass (exit code 0):

```sh
npx olan-app validate --strict   # manifest, build, TypeScript, renders every surface, permissions
npx olan-app test                # tests/**/*.test.ts against the mock Olan host
```

Loop: edit → `npx olan-app validate --strict --json` → fix every error (each has `code`, `file`,
`line`, `hint`; codes in `docs/errors.md`) → `npx olan-app test --json` → fix → repeat. Add or
update tests in `tests/` for every behaviour you build.

## Files

- `src/app.tsx` — the app. Ends with `export default defineApp({ app: Home })`.
- `olan-app.json` — id, name, version, `surfaces`, `permissions`, `settings` (`docs/manifest.md`).
  Keep `id` stable; bump `version` before each publish. Keep `minServerVersion` at `0.1.0`
  (the oldest Olan server with Olan Apps) unless the app needs a newer server.
- `tests/*.test.ts` — `node:test` + `renderApp` from `@olan-app/cli/testing` (`docs/testing.md`).
- `fixtures/*.json` — mock data: `projects.json`, `chat.json`, `settings.json`, `storage.json`,
  `http.json`. Used by tests, `validate --strict` and `dev`.

## Rules

1. Surfaces are named components: `defineApp({ app: Home, 'project.widget': Widget, settings: SettingsScreen })`.
   Never inline arrow functions. Surface names: `app` (full screen), `project.widget` (card on a
   project page, `params = { projectId }`), `settings`. Declare each in `olan-app.json` `surfaces`.
2. No DOM or React Native: no `<div>`/`<span>`, no `react-dom`, no `react-native`, no Node modules,
   no `style`/`className`/colours. Only the components below.
3. Strings go inside `<Text>` (`<Text text="…" />` or `<Text>…</Text>`), never directly in
   `Screen`/`Stack`/`Card`/`Form`.
4. No `fetch`, `window`, `document`, `localStorage`, `XMLHttpRequest`, `WebSocket`: use `olan.*`.
5. Every `olan.*` call needs its permission in `olan-app.json` (table below). Handle failures:
   `useQuery` puts the `OlanError` (with `.code`) in `query.error`; show an `EmptyState`.
6. Unique `key` on every `List` item, `Table` row, `Menu` item and `Action`. Every `Button` has a
   `label`; every `Menu` has a `label`.
7. React hooks (`useState`, `useEffect`, `useMemo`) work. Load data with
   `useQuery(() => olan.….(), [deps])`; call `olan.*` only in effects, handlers or `useQuery`.

## Components (`import { … } from '@olan-app/sdk'`)

`Tone` = `default|muted|accent|danger|success|warning`; `Spacing` = `none|xs|sm|md|lg`; `Key` = string | number;
`Action` = `{ key, label, icon?, onPress }`. Required props in **bold**.

| Component | Props |
|---|---|
| `Screen` | `title`, `subtitle`, `actions: Action[]`, `loading`, `scroll`; children |
| `Stack` | `direction: 'vertical'\|'horizontal'`, `gap: Spacing`, `align: start\|center\|end\|stretch`, `justify: start\|center\|end\|between`, `wrap`, `padding: Spacing`; children |
| `Card` | `title`, `subtitle`, `actions`, `padding`; children |
| `Text` | `text` (or text children), `variant: title\|heading\|body\|caption\|label`, `tone`, `weight: regular\|medium\|semibold\|bold`, `truncate` |
| `Badge` | **`text`**, `tone` |
| `EmptyState` | **`title`**, `description`, `icon`, `action: { label, onPress }` |
| `List` | **`items`**: `{ key, title, subtitle?, meta?, badge?: { text, tone? }, icon?, disabled? }[]`, `onSelect({ key })`, `emptyText`, `loading` |
| `Table` | **`columns`**: `{ key, title, width?, align? }[]`, **`rows`**: `{ key, cells: { [columnKey]: string\|number\|null } }[]`, `onSelectRow({ key })`, `emptyText` |
| `Chart` | **`kind`**: `bar\|line`, **`series`**: `{ name, points: { x: string, y: number }[] }[]`, `height` |
| `Form` | **`onSubmit({ values })`** (`values: Record<name, string>`), `submitLabel`, `cancelLabel`, `onCancel`; children |
| `TextField` | **`name`**, **`label`**, `value`, `placeholder`, `multiline`, `secure`, `required`, `error`, `onChange({ value })` |
| `Select` | **`name`**, **`label`**, **`options`**: `{ value, label }[]`, `value: string\|null`, `placeholder`, `onChange({ value })` |
| `DatePicker` | **`name`**, **`label`**, `value` (ISO date/date-time or null), `mode: date\|datetime`, `onChange({ value })` |
| `Button` | **`label`**, **`onPress`**, `variant: primary\|secondary\|ghost\|danger`, `icon`, `disabled`, `loading` |
| `Menu` | **`label`** (or `icon`), **`items`**: `{ key, label, icon?, destructive?, disabled? }[]`, **`onSelect({ key })`** |

Details and icon names: `docs/components.md`.

## `olan.*` API (`import { olan, OlanError } from '@olan-app/sdk'`)

| Call | Returns | Permission |
|---|---|---|
| `olan.projects.list({ limit?, cursor? })` | `{ items: Project[], nextCursor? }` | `projects:read` |
| `olan.projects.get(projectId)` | `{ project, members, lists, tasks }` | `projects:read` |
| `olan.projects.tasks(projectId, { status? })` | `ProjectTask[]` | `projects:read` |
| `olan.projects.updateTask(projectId, taskId, { status?, due?, assigneeId?, revision })` | `ProjectTask` | `projects:write` |
| `olan.chat.conversations()` / `olan.chat.messages(id, { limit? })` | `Conversation[]` / `Message[]` | `chat:read` |
| `olan.storage.get(key)` / `set(key, value)` / `remove(key)` / `keys()` | JSON / void / void / `string[]` | `storage` |
| `olan.settings.get()` | the app's settings | none |
| `olan.http.fetch(url, { method?, headers?, body? })` | `{ status, headers, body, json() }` | `http:<host>` |
| `olan.ui.confirm({ title, message?, confirmLabel?, cancelLabel?, destructive? })` | `boolean` | none |
| `olan.ui.prompt({ title, message?, placeholder?, defaultValue? })` | `string \| null` | none |
| `olan.ui.toast({ text, tone? })`, `olan.ui.menu({ items })`, `olan.ui.datePicker({ value?, mode? })`, `olan.ui.share({ text, url? })` | void, key \| null, ISO \| null, void | none |
| `olan.navigation.push(screen, params?)` / `pop()` / `replace(screen, params?)` | void | none |

`ProjectTask`: `{ id, projectId, title, description, status: 'needs-action'|'in-process'|'completed'|'cancelled', due: string|null, assigneeId, revision, … }`.
`updateTask` needs the task's current `revision`. Hooks: `useQuery`, `useNavigation`, `useSettings`,
`useTheme`, `useLocale`, `usePlatform`, `useAppContext` (`docs/hooks.md`, `docs/api.md`).

## Navigation

One surface component switches on `useNavigation().screen` (`'index'` first); `push('task', { id })`
opens a screen, Olan's back control pops it (`docs/navigation.md`).

```tsx
function App() {
  const { screen, params } = useNavigation();
  if (screen === 'project') return <ProjectScreen projectId={(params as { projectId: string }).projectId} />;
  return <ProjectsScreen />;   // List onSelect={({ key }) => navigation.push('project', { projectId: String(key) })}
}
```

## Tests

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '@olan-app/cli/testing';

test('works', async () => {
  const app = await renderApp({ surface: 'app' });          // options: params, fixtures, permissions, settings, ui, now
  app.expectText('Web sitesi');
  await app.press('Web sitesi');                             // Button label, List item title, Menu item, action, Form submitLabel
  await app.fill('Başlık', 'Rapor'); await app.select('Durum', 'completed');
  assert.equal(app.calls('projects.list')[0]?.ok, true);    // also toasts(), navigation(), tree(), host.data
  await app.dispose();
});
```

Built-in data when `fixtures/projects.json` is absent: projects `p0` "Web sitesi", `p1` "Mobil
uygulama", `p2` "Ofis taşınması", tasks "Görev 1…4" due 2026-10-10…13 (first completed).

## Commands

```sh
npm install
npx olan-app validate --strict      # add --json for machine-readable errors
npx olan-app test                   # npx olan-app test <pattern>
npx olan-app dev                    # dev server for Olan Studio → Geliştirme sunucuları
npx olan-app pack                   # dist/com.olan.examples.project-pulse-<version>.olanapp (signed if olan-app.key.json exists)
npx olan-app docs <query>           # search the SDK docs
```

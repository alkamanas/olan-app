# Getting started

An Olan App is a small React program that runs in a sandbox (a Web Worker on web/desktop, an
isolated JS engine on mobile). It does not draw anything itself: it describes its screen with the
components of `@olan-app/sdk`, and Olan draws them with its own native controls on every platform.
Data comes from `olan.*` calls that Olan answers after checking the app's permissions.

Formerly @olan/app-sdk; the old name still builds.

## Create an app

```sh
npx olan-app init "Geciken görevler" --template list-detail   # or: olan app init …
cd geciken-gorevler
npm install
npx olan-app validate --strict
npx olan-app test
npx olan-app dev        # serve it to Olan Studio (Geliştirme sunucuları)
```

Templates: `blank` (one screen), `list-detail` (projects → tasks → task), `project-widget` (a card on
the project page), `project-tab` (a project tab and project settings with `olan.project.config`), `project-records`
(the app's records on tasks: a task action, a record card, the app's status, calendar items, feed
lines, approvals and a project template; SDK 1.7), `external-api` (`olan.http.fetch` with an `http:<host>` permission), `data-list`
(`olan.db`), `backend` (`--backend`: UI + backend code that Olan runs, backend.md).

## Project layout

```
olan-app.json          manifest: id, name, version, surfaces, permissions, settings (manifest.md)
src/app.tsx            the app; must `export default defineApp({ ... })`
tests/*.test.ts        headless tests (node:test + @olan-app/cli/testing) (testing.md)
fixtures/*.json        mock data for tests, validate --strict and dev (testing.md#fixtures)
assets/icon.png        icon referenced by the manifest
dist/app.js            build output (generated, git-ignored)
AGENTS.md, CLAUDE.md   instructions for coding agents
```

## The smallest app

```tsx
import { useState } from 'react';
import { Button, Screen, Stack, Text, defineApp, olan } from '@olan-app/sdk';

function Home() {
  const [count, setCount] = useState(0);
  return (
    <Screen title="Sayaç">
      <Stack gap="md" padding="md">
        <Text text={`Düğmeye ${count} kez bastınız.`} />
        <Button label="Bas" variant="primary" onPress={() => setCount((value) => value + 1)} />
        <Button label="Bildirim" onPress={() => olan.ui.toast({ text: 'Merhaba!', tone: 'success' })} />
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Home });
```

```json
{
  "schemaVersion": 1,
  "id": "com.example.counter",
  "name": "Sayaç",
  "version": "0.1.0",
  "sdk": "^1.8.0",
  "entry": "dist/app.js",
  "surfaces": { "app": { "title": "Sayaç" } },
  "permissions": []
}
```

## Rules (the sandbox enforces them; `validate --strict` reports them)

1. **Surfaces are named components.** `defineApp({ app: Home })`, never an inline arrow function
   (the React hook rules only apply to named components). Surface names: `app`,
   `project.widget`, `project.tab`, `project.settings`, `settings` (and the in-context surfaces of
   surfaces.md) — and each one used must be declared in `olan-app.json` `surfaces`.
2. **Only SDK components.** No DOM elements (`<div>`, `<span>`), no `react-dom`, no
   `react-native`, no Node built-ins (`fs`, `path`, …). There is no `style` or `className`: Olan
   owns colours, fonts and spacing. Use `tone`, `variant`, `gap` and `padding` props instead.
3. **Text lives in `<Text>`.** A string directly inside `Screen`, `Stack`, `Card` or `Form` is an
   error (`tree.text_outside_text`). Write `<Text text="…" />` or `<Text>…</Text>`.
4. **No browser globals for I/O.** `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`,
   `indexedDB`, `window`, `document` do not exist. Use `olan.http.fetch`, `olan.storage`,
   `olan.settings`.
5. **Every `olan.*` call needs its permission** in `olan-app.json` `permissions` (permissions.md).
   Without it the call rejects with `OlanError` code `permission_denied` (`http_blocked` for HTTP).
6. **Keys are unique.** Every `List` item, `Table` row, `Menu` item and `Action` has a unique `key`
   (string or number); events give it back as `{ key }`.
7. **Every `Button` has a `label`.** Every `Menu` has a `label` (or at least an `icon`).
8. **Use React normally:** `useState`, `useEffect`, `useMemo`, custom hooks, context. Load data with
   `useQuery(() => olan.….(), [deps])` (hooks.md).

## Done means

```sh
npx olan-app validate --strict   # manifest, build, TypeScript, every surface rendered, no missing permission
npx olan-app test                # all tests pass
```

Both exit with code 0. Add `--json` for machine-readable output (cli.md).

## Running it in Olan

During development the app runs unsigned, but only in development mode: Studio, `olan-app dev`
and "Olan'da dene" (`/apps/dev`), for people an administrator gave the `developer` grant, under
a "Geliştirme" label. **Studio** is in the Olan web app: sign in at your Olan web address (e.g. `https://olan.example.com`) with an account that has the `developer` grant (Yönetim → Kullanıcılar) and open `<Olan web address>/tr/studio`; `/tr/studio?section=publish` opens Yayınla (marketplace publishing).

Installing it (for yourself or the organization) needs a signed package. An Olan server installs a
package only when its signature verifies and the signing key is on the server's trusted key list.
Every Olan server ships with the Olan Marketplace key built in (`olan-marketplace-2026-10-17`), and
in production that is the only trusted key, so apps reach real organizations through Olan
Marketplace review. An unsigned package can be uploaded, but it is listed as "İmzasız" and
cannot be installed. For your own local Olan:

```sh
npx olan-app keygen --dev        # once; prints OLAN_APPS_TRUSTED_KEYS=dev-local=<key> for the local API
npx olan-app validate --strict   # first: pack runs only the non-strict checks (and refuses on errors)
npx olan-app pack --dev-sign     # dist/<id>-<version>.olanapp, signed with your development key
```

Then upload it in Olan → Yönetim → Uygulamalar → Katalog (or `olan-app publish --org --dev-sign`)
and install it there (cli.md#signing-and-publishing). Uploading and, by default, installing are for organization admins: an organization without an install policy is "admin only" until an admin lets members install apps.

For real organizations, submit it to Olan Marketplace (automatic checks, review, signing;
marketplace.md):

```sh
npx olan-app login --marketplace --server https://api.example.com   # once: signs you in in the browser
npx olan-app developer create --marketplace --slug acme --name "Acme Ltd" --accept-agreement   # once
npx olan-app publish --marketplace --age-rating 4+   # age rating (4+, 9+, 13+): required before release
npx olan-app release --marketplace <appId> <version>  # after approval (`olan-app status` prints the exact command)
```

With an Olan CLI that has the `app` command and is signed in, `olan app login --marketplace` works too. CI does not sign in: it uses the saved session as `OLAN_MARKETPLACE_SESSION` (marketplace.md#signing-in).

## Where to read next

- components.md — every component and its props
- api.md — `olan.*` (projects, chat, storage, settings, http, ui, navigation)
- hooks.md, navigation.md — `useQuery`, `useNavigation`, multi-screen apps
- permissions.md, manifest.md — what to declare in `olan-app.json`
- server.md, remote-requests.md, files.md, links.md — the app's own server, requests as the person,
  file uploads, external sign-in flows and app addresses
- testing.md — `renderApp`, fixtures, assertions
- cli.md, errors.md — commands and every error code with its fix
- marketplace.md, review-guidelines.md — sign-in, publishing, the automatic checks and the review rules
- examples.md — complete apps to copy from

---
name: olan-app
description: Build, change, test and package this Olan App (React + @olan-app/sdk running in Olan's sandbox). Use for any change to src/app.tsx, olan-app.json, fixtures or tests, and before calling the work done.
---

# Olan App workflow

This directory is an Olan App (`olan-app.json` + `src/app.tsx`). Read `AGENTS.md` first: it lists
the rules, every component with its props, every `olan.*` call with its permission, and the test
API. Details are offline in `node_modules/@olan-app/sdk/docs/` (`components.md`, `api.md`,
`hooks.md`, `navigation.md`, `permissions.md`, `manifest.md`, `testing.md`, `errors.md`,
`examples.md`) and in `node_modules/@olan-app/sdk/llms.txt`.

## Loop

1. Change `src/app.tsx` (named surface components, only SDK components, text inside `<Text>`,
   data via `useQuery(() => olan.…)`), and `olan-app.json` (`surfaces`, `permissions`, `settings`).
2. Add or update `fixtures/*.json` and `tests/*.test.ts` for the behaviour.
3. `npx olan-app validate --strict --json` — fix every error by its `code`, `file:line` and `hint`
   (`docs/errors.md` explains each code).
4. `npx olan-app test --json` — fix failures (messages include the visible text and what can be
   pressed).
5. Repeat until both return `"ok": true`. Only then is the task done.

## Useful commands

- `npx olan-app docs <query>` — search the SDK docs (e.g. `docs Menu`, `docs updateTask`).
- `npx olan-app dev` — dev server for Olan Studio (Geliştirme sunucuları); stop it when done.
- `npx olan-app pack` — `dist/<id>-<version>.olanapp` for upload.
- `olan app publish --org` — upload to the organization catalog (admins; the Olan CLI signs in).

## Do not

- Import `react-dom`, `react-native`, Node modules, or use `fetch`/`window`/`localStorage`.
- Use `style`, `className`, colours or DOM elements.
- Write surfaces as inline arrow functions.
- Leave an `olan.*` call without its permission in `olan-app.json`.
- Change `id`, or raise `minServerVersion` above `0.1.0` unless the app needs a newer Olan server.

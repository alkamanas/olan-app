---
name: olan-app
description: Build, change, test and package this Olan App (React + @olan-app/sdk running in Olan's sandbox). Use for any change to src/app.tsx, olan-app.json, fixtures or tests, and before calling the work done.
---

# Olan App workflow

This directory is an Olan App (`olan-app.json` + `src/app.tsx`). Read `AGENTS.md` first: it lists
the rules, every component with its props, every `olan.*` call with its permission, and the test
API. Details are offline in `node_modules/@olan-app/sdk/docs/` (`components.md`, `api.md`,
`hooks.md`, `navigation.md`, `database.md`, `permissions.md`, `manifest.md`, `testing.md`,
`errors.md`, `examples.md`) and in `node_modules/@olan-app/sdk/llms.txt`.

## Loop

1. Change `src/app.tsx` (named surface components, only SDK components, text inside `<Text>`,
   data via `useQuery(() => olan.…)` or `useCollection('<collection>')`), and `olan-app.json`
   (`surfaces`, `permissions`, `settings`, `data` for `olan.db` — bump `data.version` on every
   schema change).
2. Add or update `fixtures/*.json` (`db.json` rows must match `data`; `ref:*` values are UUIDs,
   the built-in `p0` project ids are not; the default user is `00000000-0000-4000-8000-000000000001`,
   more people go in `users.json`) and `tests/*.test.ts` for the behaviour
   (`app.host.data.db`, `app.host.audit()`; `calls()[n].params` is `JsonValue`: cast it, because
   `validate` type-checks tests).
3. `npx olan-app validate --strict --json` — fix every error by its `code`, `file:line` and `hint`
   (`docs/errors.md` explains each code).
4. `npx olan-app test --json` — fix failures (messages include the visible text and what can be
   pressed).
5. Repeat until both return `"ok": true`. Only then is the task done.

## Useful commands

- `npx olan-app docs <query>` — search the SDK docs (e.g. `docs Menu`, `docs updateTask`).
- `npx olan-app dev` — dev server for Olan Studio (Geliştirme sunucuları); stop it when done.
- `npx olan-app pack --dev-sign` — `dist/<id>-<version>.olanapp` signed with the developer's local key.
  Servers install only packages signed with a key they trust (production: Olan Marketplace only;
  a local Olan: the key from `npx olan-app keygen --dev`). Unsigned packages upload but never install.
- `olan app publish --org --dev-sign` — upload to a (development) organization catalog (admins; the Olan CLI signs in).

## Do not

- Import `react-dom`, `react-native`, Node modules, or use `fetch`/`window`/`localStorage`.
- Use `style`, `className`, colours or DOM elements.
- Write surfaces as inline arrow functions.
- Leave an `olan.*` call without its permission in `olan-app.json` (`tasks:write`, `tasks:delete`,
  `projects:delete`, `db` for writes, deletions and `olan.db`).
- Retry a `forbidden_record`: default work packages, non-empty work packages and records the
  admin protects cannot be deleted; tell the user "Bu kayıt korunuyor".
- Lower `"sdk"` below `"^1.2.0"` (the current SDK; `olan.db` needs ^1.1.0, `useUser`/`olan.users` ^1.2.0).
- Guess who is signed in: use `useUser().id` (compare with `createdBy`/`assigneeId`); names need `users:read`.
- Change `id`, or raise `minServerVersion` above `0.1.0` unless the app needs a newer Olan server.

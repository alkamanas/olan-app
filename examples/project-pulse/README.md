# Project Pulse

Example Olan App (`com.olan.examples.project-pulse`): projects → a project's tasks with status
badges → one task, whose status changes from a `Menu` through `olan.projects.updateTask`.

- Surface: `app` (full screen), three screens on the `useNavigation()` stack (`index`, `project`,
  `task`).
- Permissions: `projects:read`, `projects:write`.
- Shows: `useQuery` + `refetch`, `List` with `badge`/`meta`, `Badge`, `Card`, `Menu` with disabled
  and destructive items, optimistic concurrency with `revision`, `OlanError` handling, toasts.
- Test data: `fixtures/projects.json`; tests: `tests/app.test.ts`.

```sh
npm install                       # installs @olan-app/sdk and @olan-app/cli from npm
npx olan-app validate --strict
npx olan-app test
npx olan-app pack --dev-sign      # dist/com.olan.examples.project-pulse-0.1.0.olanapp, signed with your development key
npx olan-app dev                  # then Olan → Studio → Geliştirme sunucuları → http://localhost:5178
```


A local Olan installs the package only if its Platform API trusts your development key: run
`npx olan-app keygen --dev` once and add the printed `OLAN_APPS_TRUSTED_KEYS=dev-local=<key>` line
to the API environment (then restart it). A plain `npx olan-app pack` is unsigned: it can be
uploaded and is listed as "İmzasız", but it cannot be installed. Production servers trust only the
Olan Marketplace key.

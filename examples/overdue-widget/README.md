# Geciken görevler (overdue widget)

Example Olan App (`com.olan.examples.overdue-widget`): a `project.widget` card on every project
page listing that project's open tasks whose due date has passed, most overdue first.

- Surface: `project.widget`; Olan opens it with `params = { projectId }`.
- Permission: `projects:read` (`olan.projects.tasks`).
- Setting: `graceDays` (number, default 0), read with `useSettings()`; Olan generates its form.
- Tests freeze the clock with `renderApp({ now })` and override settings per test.
- Test data: `fixtures/projects.json`; tests: `tests/app.test.ts`.

```sh
npm install                       # installs @olan-app/sdk and @olan-app/cli from npm
npx olan-app validate --strict    # renders the widget with the first fixture project
npx olan-app test
npx olan-app pack --dev-sign      # dist/com.olan.examples.overdue-widget-0.1.0.olanapp, signed with your development key
```


A local Olan installs the package only if its Platform API trusts your development key: run
`npx olan-app keygen --dev` once and add the printed `OLAN_APPS_TRUSTED_KEYS=dev-local=<key>` line
to the API environment (then restart it). A plain `npx olan-app pack` is unsigned: it can be
uploaded and is listed as "İmzasız", but it cannot be installed. Production servers trust only the
Olan Marketplace key.

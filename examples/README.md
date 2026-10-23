# Example Olan Apps

Complete apps built with [`@olan-app/sdk`](https://www.npmjs.com/package/@olan-app/sdk). Each one
passes `npx olan-app validate --strict` and `npx olan-app test`, and installs the published SDK and
CLI from npm:

```sh
cd project-pulse
npm install
npx olan-app validate --strict
npx olan-app test
npx olan-app dev
```

| App | What it shows |
|---|---|
| [`project-pulse`](project-pulse) | Full-screen app with a navigation stack, status badges, `olan.projects.updateTask` with `revision` |
| [`overdue-widget`](overdue-widget) | `project.widget` surface, manifest settings, date logic tested with a frozen clock |
| [`exchange-rates`](exchange-rates) | `olan.http.fetch` with `http:<host>`, `Table`, `Chart`, a settings surface, HTTP fixtures |
| [`decision-log`](decision-log) | The app's own database (`olan.db`), `useCollection`, `useRecord`, creating tasks |
| [`ops-inbox`](ops-inbox) | Backend code on Olan: `olan.backend.call`, schedules, events, a verified webhook, secrets |
| [`media-desk`](media-desk) | The app's own server (`olan.remote.request`), file upload, external sign-in, `Tabs`, `Chart` |
| [`team-standup`](team-standup) | A remote server with chat cards and the meeting and chat surfaces |
| [`field-kit`](field-kit) | Every component and `olan.ui.*` call (the mobile acceptance app) |

More in the documentation: https://docs.olan.app/examples/

The examples are released under the MIT License ([LICENSE](LICENSE)).

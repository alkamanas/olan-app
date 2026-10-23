# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `project-records` template: the app's
own records (here purchase requests) linked to project tasks, in the projects the app was added to.

- `task.action` ("Kayda bağla" in a task's "…" menu, `params = { projectId, task }`): links a record
  to the task with a card (`olan.project.links.upsert`), defines the app's "Onay bekliyor" status
  (`olan.project.statuses.define`) and moves the task to it (`olan.project.links.setStatus`), adds the
  delivery date to the project calendar (`olan.project.calendar.upsert`), writes a line in the project
  feed (`olan.project.activity.post`) and can ask a manager to approve (`olan.project.approvals.request`).
- `record.card` (the card's "Kaydı aç" button, `params = { projectId, linkId, target, externalId, payload }`):
  the record with its approvals and calendar item; "Teslim alındı" completes the task through the link.
- `project.tab` ("Kayıtlar"): every record the app linked in the project.
- `projectTemplates`: a "Satın alma" project template in "Yeni proje"; projects made from it have the app added.

Needs `projects:read`, `tasks:write` and `projects:extend`. Test data: `fixtures/projects.json`
(`"statuses"`, `"links"`, `"calendarItems"`, `"approvals"` are what the app already added to the project;
`"enabled": false` a project the app was not added to).

```sh
npm install
npm run validate   # olan-app validate --strict (renders the surfaces with the first fixture project)
npm test           # olan-app test
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/` (`surfaces.md`, "Records on tasks and issues"; `api.md`, "olan.project").

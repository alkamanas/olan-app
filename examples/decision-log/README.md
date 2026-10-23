# Karar defteri

An [Olan](https://olan.app) example app (`com.visetra.decision-log`): decisions tied to projects,
kept in the app's own database (`olan.db`), with writes to Olan's own records.

- **Decisions** (`decisions`, organization scope): list with a status filter and "Daha fazla"
  pages (`useCollection`), an add form (`insert`), a detail screen that updates (`revision`) and
  deletes rows. The collection's rules let everyone read and change decisions; only the person
  who created one may delete it (`forbidden_record` otherwise).
- **Pins** (`pins`, user scope): "Sabitle" is personal; nobody else sees your pins.
- **Göreve dönüştür** creates a task in the decision's project (`olan.projects.createTask`, the
  project's default work package) and stores its id in `taskId` (`ref:task`); **Görevi sil**
  deletes that task (`olan.projects.deleteTask`). Olan records the creating app on the task
  (`createdByApp`) and writes every deletion to the audit log.
- **Boş iş paketlerini temizle** (project screen) removes empty work packages
  (`olan.projects.deleteList`, which archives them). It tries the default work package too:
  Olan refuses it (`forbidden_record`) and the app shows "Varsayılan iş paketi korunuyor".

Permissions: `projects:read`, `db`, `tasks:write`, `tasks:delete`, `projects:delete`. Test data:
`fixtures/projects.json` (UUID ids, because `ref:*` fields hold UUIDs) and `fixtures/db.json`.

```sh
npm install
npm run validate                 # olan-app validate --strict
npm test                         # olan-app test (mock Olan host with the in-memory database)
npm run dev                      # dev server for Olan Studio → Geliştirme sunucuları
npx olan-app pack --dev-sign     # dist/com.visetra.decision-log-0.1.0.olanapp for a local Olan
```

`platform/e2e/olan-apps-phase1b.spec.ts` installs this package on a local Olan and runs the same
flow against the real server. Agents: read `AGENTS.md`.

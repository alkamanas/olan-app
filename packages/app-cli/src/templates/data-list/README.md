# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `data-list` template: notes kept
in the app's own database (`olan.db`). The `notes` collection is declared in `olan-app.json`
`data`; the app lists them with `useCollection` (newest first, "Daha fazla" pages), adds them with
a form, and opens a detail screen that updates (`revision`) and deletes them. Needs `db`. Test
data: `fixtures/db.json`.

```sh
npm install
npm run validate   # olan-app validate --strict
npm test           # olan-app test
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Change the schema by editing `data` and increasing `data.version` (only additive changes install
over existing data). Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/database.md`.

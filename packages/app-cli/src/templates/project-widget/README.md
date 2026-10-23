# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `project-widget` template: a card
on each project page (`project.widget` surface, `params = { projectId }`) listing the project's open
tasks. Needs `projects:read`. Test data: `fixtures/projects.json`.

```sh
npm install
npm run validate   # olan-app validate --strict (renders the widget with the first fixture project)
npm test           # olan-app test
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/`.

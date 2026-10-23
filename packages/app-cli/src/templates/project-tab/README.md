# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `project-tab` template: a tab on each
project page the app was added to (`project.tab`, `params = { projectId }`) showing the project's goal
and the progress of the work package that tracks it, and the app's settings of one project
(`project.settings`), where a member writes the goal. Both are kept per project with
`olan.project.config` (`useProjectConfig()`). Needs `projects:read`. Test data: `fixtures/projects.json`
(`"config"` is the stored project configuration, `"enabled": false` a project the app was not added to).

```sh
npm install
npm run validate   # olan-app validate --strict (renders both surfaces with the first fixture project)
npm test           # olan-app test
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/` (`surfaces.md`, "Project extensions").

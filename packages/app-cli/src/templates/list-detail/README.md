# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `list-detail` template: projects →
a project's tasks → task detail, with the navigation stack of `useNavigation()`. Needs
`projects:read`. Test data: `fixtures/projects.json`.

```sh
npm install
npm run validate   # olan-app validate --strict
npm test           # olan-app test
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/` (`navigation.md`, `components.md`).

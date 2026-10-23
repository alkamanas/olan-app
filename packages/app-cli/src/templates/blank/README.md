# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `blank` template: one screen with a
counter and a toast.

```sh
npm install
npm run validate   # olan-app validate --strict: manifest, build, types, headless render
npm test           # olan-app test: tests/*.test.ts against the mock Olan host
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Write the app in `src/app.tsx`, declare surfaces and permissions in `olan-app.json`. Agents: read
`AGENTS.md`. Full docs: `node_modules/@olan-app/sdk/docs/` (start with `getting-started.md`).

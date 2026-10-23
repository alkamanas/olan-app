# {{appName}}

An [Olan](https://olan.app) app (`{{appId}}`), created from the `external-api` template: it reads a
JSON API with `olan.http.fetch`. The sandbox has no network; Olan forwards the request only to
hosts listed as `http:<host>` permissions (here `http:status.example.com`). Replace the URL in
`src/app.tsx`, the permission in `olan-app.json` and the canned response in `fixtures/http.json`.

```sh
npm install
npm run validate   # olan-app validate --strict
npm test           # olan-app test (responses come from fixtures/http.json, never the network)
npm run dev        # dev server for Olan Studio → Geliştirme sunucuları
npm run pack       # dist/{{appId}}-<version>.olanapp (run validate first; pack refuses on errors)
```

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/api.md` (`olan.http`).

# @olan-app/cli

`olan-app`: create, build, validate, test, pack and publish Olan Apps. Every app has it as a dev
dependency, so `npx olan-app <command>` works offline. Node.js 22 or newer.

```sh
npx --yes --package @olan-app/cli olan-app init "Geciken görevler" --template list-detail
cd geciken-gorevler && npm install
npx olan-app validate --strict
npx olan-app test
npx olan-app dev
```

Headless test helpers: `import { renderApp } from '@olan-app/cli/testing'`.

Documentation: https://docs.olan.app (CLI reference: https://docs.olan.app/cli/). Source:
https://github.com/alkamanas/olan-app.

Full command reference: `docs/cli.md` of [`@olan-app/sdk`](https://www.npmjs.com/package/@olan-app/sdk)
(`node_modules/@olan-app/sdk/docs/cli.md` in an app), or `npx olan-app --help`.

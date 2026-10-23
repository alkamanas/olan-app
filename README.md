# Olan Apps

Build apps for [Olan](https://olan.app) with TypeScript and React. An Olan App describes its UI with
the SDK's components; Olan draws them with its own native controls on web, desktop, iOS and
Android. Apps run in a sandbox and reach Olan data (projects, chat, mail, calendar, files and their
own database) only through permission-checked `olan.*` calls. Apps can also bring their own server
or run backend code on Olan, and are distributed through the
[Olan Marketplace](https://marketplace.olan.app).

**Documentation: https://docs.olan.app**

## Packages

| Package | npm | What it is |
|---|---|---|
| [`packages/app-sdk`](packages/app-sdk) | [`@olan-app/sdk`](https://www.npmjs.com/package/@olan-app/sdk) | `defineApp`, the 23 UI components, hooks, the `olan.*` APIs; `@olan-app/sdk/server` for app servers, `@olan-app/sdk/backend` for backend code |
| [`packages/app-cli`](packages/app-cli) | [`@olan-app/cli`](https://www.npmjs.com/package/@olan-app/cli) | `olan-app`: init, build, validate, test, dev server, pack, sign and publish; `@olan-app/cli/testing` for headless tests |
| [`packages/app-schema`](packages/app-schema) | [`@olan-app/schema`](https://www.npmjs.com/package/@olan-app/schema) | The manifest (`olan-app.json`), UI tree, permission and protocol schemas (zod + JSON Schema) |
| [`packages/app-runtime`](packages/app-runtime) | [`@olan-app/runtime`](https://www.npmjs.com/package/@olan-app/runtime) | The backend runtime (isolated-vm and QuickJS engines) that runs an app's server code |

## Quick start

Node.js 22 or newer:

```sh
npx @olan-app/cli init "My first app"
cd my-first-app
npm install
npx olan-app validate --strict
npx olan-app test
npx olan-app dev
```

Then read [Getting started](https://docs.olan.app/getting-started/). Coding agents can read the
whole documentation in one file: [llms.txt](https://docs.olan.app/llms.txt).

## Repository layout

| Path | Contents |
|---|---|
| `packages/` | The four npm packages (npm workspaces) |
| `examples/` | Complete example apps; each passes `olan-app validate --strict` and `olan-app test` |
| `docs/` | The SDK documentation (the same files ship in `@olan-app/sdk/docs`) |
| `site/` | The generator and Dockerfile for https://docs.olan.app |

## Working on the packages

```sh
npm install            # installs the workspaces (no lockfile is committed)
npm run typecheck
npm test               # @olan-app/schema and @olan-app/sdk
npm run test:all       # every package (the runtime and CLI tests need isolated-vm, an optional native module)
npm run site           # builds the docs site into site/dist
```

Each example installs the published packages from npm:

```sh
cd examples/project-pulse && npm install && npx olan-app validate --strict && npx olan-app test
```

## Contributing

This repository is a read-only mirror of Olan's internal repository, regenerated on every change.
Issues and questions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The packages, examples, documentation and site in this repository are released under the
[MIT License](LICENSE).

/**
 * `@olan-app/cli` programmatic API (the `olan-app` binary is `bin/olan-app.js` → `dist/cli.js`).
 * Headless testing lives in `@olan-app/cli/testing`.
 */
export { COMMANDS, helpText, main, runCli, type CliIo } from './cli';
export type { Command, CommandContext, CommandOutput } from './command';
export { CliError, type Issue } from './errors';
export { buildApp, type BuildResult } from './commands/build';
export { initApp, slugify, TEMPLATES, type InitOptions, type InitResult, type TemplateName } from './commands/init';
export { generateSigningKey } from './commands/keygen';
export { packApp, signPackage, verifyPackageSignature, type PackResult, type SigningKeyFile } from './commands/pack';
export { publishApp, type PublishResult } from './commands/publish';
export { MARKETPLACE_KEY_ID, signPackageFile, type SignResult } from './commands/sign';
export { runTests, type TestSummary } from './commands/test';
export { validateApp, type ValidateResult } from './commands/validate';
export { formatBackendEvent, startDevServer, type DevServer } from './commands/dev';
export { createBackendHarness } from './backend/harness';
export { createMcpServer } from './commands/mcp';
export { eventsCommand, toolsCommand } from './commands/remote';
export { DEV_ISSUER_PORT, DEV_INSTALLATION_ID, startDevIssuer, sendDevEvent, callDevTool, sampleEventData, toolInputProblems, type DevIssuer, type SendEventResult, type CallToolResult } from './remote-dev';
export { searchDocs, type DocsHit } from './docs-search';
export { CLI_VERSION } from './version';

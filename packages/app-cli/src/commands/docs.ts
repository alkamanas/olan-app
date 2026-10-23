import { integerFlag } from '../args';
import type { Command } from '../command';
import { fail } from '../errors';
import { searchDocs } from '../docs-search';
import { findProjectDir } from '../project';

export const docsCommand: Command = {
  name: 'docs',
  summary: 'Search the offline SDK docs (node_modules/@olan-app/sdk/docs, llms.txt)',
  usage: 'olan-app docs <query> [--limit 8] [--json]',
  options: ['--limit <n>  Number of sections (default 8)'],
  spec: { strings: ['limit'] },
  async run(args, context) {
    const query = args.positionals.join(' ').trim();
    if (!query) fail('docs.query_required', 'Pass what to look for, e.g. `olan-app docs useNavigation`');
    const projectDir = findProjectDir(context.cwd) ?? context.cwd;
    const { sdkDir, results } = searchDocs(query, projectDir, integerFlag(args, 'limit', 8, 1, 50));
    if (!sdkDir) fail('docs.sdk_missing', '@olan-app/sdk is not installed here', { hint: 'Run `npm install` in the app directory.' });
    const human = results.length
      ? results.flatMap((hit) => [`── ${hit.file}:${hit.line}  ${hit.heading}`, hit.excerpt, ''])
      : [`No matches for "${query}" in ${sdkDir}/docs`];
    return { result: { query, sdkDir, results }, human };
  },
};

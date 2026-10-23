import { booleanFlag, stringFlag } from '../args';
import type { Command } from '../command';
import { marketplaceFail, marketplaceRequest, requireSession } from '../marketplace';

/** `GET /api/v1/developer/me` (only what the CLI reads; `--json` prints the whole body). */
interface DeveloperMe {
  user: { userRef: string; email: string | null; name: string | null };
  developers: { slug: string; role: string; agreementAccepted?: boolean }[];
  agreement: { currentVersion: string };
  invites?: { id: string; developer: { slug: string; name: string }; role: string; expiresAt: string }[];
}

/** `POST /api/v1/developer/accounts` answer. */
interface CreatedAccount {
  developer: { slug: string; name: string; kind: string } & Record<string, unknown>;
}

/** The marketplace's developer name rule (`routes-developer.ts`). */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const developerCommand: Command = {
  name: 'developer',
  summary: 'Create or list your Olan Marketplace developer accounts',
  usage: 'olan-app developer create --marketplace [url] --slug <slug> --name <name> [--kind person|company] --accept-agreement\n       olan-app developer list [--marketplace [url]]',
  options: [
    'create               Create a developer account; you become its owner (needs `olan-app login --marketplace`)',
    'list                 Your developer accounts, roles, agreement state and pending invites',
    '--marketplace [url]  Marketplace address (default: OLAN_MARKETPLACE_URL, the session\'s, https://marketplace.olan.app)',
    '--slug <slug>        Developer name in app pages and URLs: a-z, 0-9 and -, 2-63 characters (olan… is reserved)',
    '--name <name>        Display name (person or company name)',
    '--kind <kind>        person or company (default: company)',
    '--accept-agreement   Accept the current Olan developer agreement (required to create an account)',
    '',
    '--json prints the marketplace answer unchanged.',
  ],
  spec: { optionalUrls: ['marketplace'], strings: ['slug', 'name', 'kind'], booleans: ['accept-agreement'] },
  async run(args, context) {
    const action = args.positionals[0];
    if (action !== 'create' && action !== 'list') {
      marketplaceFail('action_required', 'Choose an action: olan-app developer create|list', 'olan-app developer create --marketplace --slug <slug> --name <name> --accept-agreement');
    }
    const { url, session } = await requireSession(args.flags.marketplace, context.env);
    const me = await marketplaceRequest<DeveloperMe>(url, '/api/v1/developer/me', { token: session.token });

    if (action === 'list') {
      const developers = me.developers ?? [];
      const invites = me.invites ?? [];
      return {
        result: me,
        raw: true,
        human: [
          `Developer accounts on ${url}:`,
          ...(developers.length
            ? developers.map((entry) => `  ${entry.slug} (${entry.role})${entry.agreementAccepted === false ? ` · agreement ${me.agreement.currentVersion} not accepted` : ''}`)
            : ['  none: create one with `olan-app developer create --marketplace --slug <slug> --name <name> --accept-agreement`']),
          ...invites.map((invite) => `  Invite: ${invite.developer.slug} (${invite.developer.name}) as ${invite.role}, until ${invite.expiresAt} (accept in Studio → Yayınla)`),
        ],
      };
    }

    const slug = stringFlag(args, 'slug');
    const name = stringFlag(args, 'name')?.trim();
    const kind = stringFlag(args, 'kind') ?? 'company';
    if (!slug || !name) marketplaceFail('invalid_option', 'developer create needs --slug <slug> and --name <name>', 'olan-app developer create --marketplace --slug acme --name "Acme Ltd" --accept-agreement');
    if (!SLUG.test(slug)) marketplaceFail('invalid_option', `--slug "${slug}" is not a developer name: a-z, 0-9 and -, 2-63 characters, starting with a letter or digit`);
    if (kind !== 'person' && kind !== 'company') marketplaceFail('invalid_option', '--kind must be person or company');
    const agreementVersion = me.agreement?.currentVersion;
    if (!agreementVersion) marketplaceFail('agreement_unknown', `${url} did not name its developer agreement`);
    if (!booleanFlag(args, 'accept-agreement')) {
      marketplaceFail('agreement_required', `Creating a developer account accepts the Olan developer agreement (version ${agreementVersion})`, 'Read the agreement, then run the command again with --accept-agreement.');
    }

    const created = await marketplaceRequest<CreatedAccount>(url, '/api/v1/developer/accounts', { method: 'POST', token: session.token, json: { slug, name, kind, agreementVersion } });
    return {
      result: created,
      raw: true,
      human: [
        `Created developer account ${created.developer.slug} (${created.developer.name}) on ${url}; you are its owner.`,
        `  Accepted the developer agreement ${agreementVersion}.`,
        '  Publish an app with `olan-app publish --marketplace`.',
      ],
    };
  },
};

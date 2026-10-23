export interface LocalizedText {
  tr: string;
  en: string;
}

/**
 * Consent screens group permissions by category, in this order: read, write, delete (its own
 * heading in a warning tone), app data, network, settings.
 */
export const PERMISSION_CATEGORIES = ['read', 'write', 'delete', 'data', 'network', 'settings'] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDefinition {
  /** Permission string, or `http:*` for the host pattern entry. */
  id: string;
  label: LocalizedText;
  description: LocalizedText;
  /** OAuth scope the app token receives for this permission, or null when the host enforces it. */
  scope: string | null;
  /** Consent screen group (`PERMISSION_CATEGORIES` order). */
  category: PermissionCategory;
  /**
   * Still valid for existing apps; new apps use the replacement (`projects:write` → `tasks:write`).
   * No error or warning is raised.
   */
  legacy?: boolean;
  /** Set on the pattern entry (`http:<host>`). */
  pattern?: 'http';
  /**
   * Implied by the manifest (Phase 3 §1: `remote`, `ai:tools`; see `impliedPermissions`), never
   * written in `permissions`. Shown at consent, part of the effective permissions and blockable by
   * policy. `{host}` in its texts is the app server's host (`describePermission(id, locale, { host })`).
   */
  implied?: true;
}

/** Placeholder replaced with the host name in `http:*` texts. */
const HOST_PLACEHOLDER = '{host}';

/**
 * Grantable permissions (contract §2 table, Phase 1b contract §2). Extension point: a new
 * permission is one entry here (TR/EN texts, `category` + OAuth `scope`, which `permissionScope`
 * reads), the RPC methods it unlocks in `rpc.ts` (`METHOD_PERMISSIONS`), and removing its id from
 * `RESERVED_PERMISSIONS`. Families: `<resource>:read`, `<resource>:write` (create/update),
 * `<resource>:delete` (always a separate permission, shown separately at install), plus
 * single-word ids (`storage`, `db`) for app-owned data.
 */
const PERMISSION_LIST: PermissionDefinition[] = [
  {
    id: 'projects:read',
    label: { tr: 'Projeleri okuma', en: 'Read projects' },
    description: {
      tr: 'Projelerinizi ve görevlerinizi okuyabilir',
      en: 'Can read your projects and tasks',
    },
    scope: 'projects:read',
    category: 'read',
  },
  {
    id: 'projects:write',
    label: { tr: 'Görevleri değiştirme', en: 'Change tasks' },
    description: { tr: 'Proje görevlerini değiştirebilir', en: 'Can change project tasks' },
    scope: 'projects:write',
    category: 'write',
    legacy: true,
  },
  {
    id: 'tasks:write',
    label: { tr: 'Görev oluşturma ve değiştirme', en: 'Create and change tasks' },
    description: {
      tr: 'Erişebildiğiniz projelerde görev oluşturabilir ve görevleri değiştirebilir',
      en: 'Can create and change tasks in projects you can access',
    },
    scope: 'projects:write',
    category: 'write',
  },
  {
    id: 'tasks:delete',
    label: { tr: 'Görev silme', en: 'Delete tasks' },
    description: {
      tr: 'Erişebildiğiniz projelerdeki görevleri silebilir; her silme denetim kaydına yazılır',
      en: 'Can delete tasks in projects you can access; every deletion is written to the audit log',
    },
    scope: 'projects:write',
    category: 'delete',
  },
  {
    id: 'projects:delete',
    label: { tr: 'İş paketi kaldırma', en: 'Remove work packages' },
    description: {
      tr: 'Erişebildiğiniz projelerde boş iş paketlerini kaldırabilir (arşivler). Proje ve varsayılan iş paketi kaldırılamaz',
      en: 'Can remove empty work packages in projects you can access (archives them). Projects and the default work package cannot be removed',
    },
    scope: 'projects:write',
    category: 'delete',
  },
  {
    id: 'projects:create',
    label: { tr: 'Proje oluşturma', en: 'Create projects' },
    description: {
      tr: 'Proje oluşturabilir; her proje kendi sohbetini, takvimini ve iş paketini açar',
      en: 'Can create projects; each project opens its own chat, calendar and work package',
    },
    scope: 'projects:write',
    category: 'write',
  },
  {
    // Phase 3 §2: a separate id, so the 1b meaning of `projects:delete` (empty work packages) never grows.
    id: 'projects:archive',
    label: { tr: 'Proje kaldırma', en: 'Remove projects' },
    description: {
      tr: 'Yalnız bu uygulamanın oluşturduğu projeleri kaldırabilir (arşivler)',
      en: 'Can remove only the projects this app created (archives them)',
    },
    scope: 'projects:write',
    category: 'delete',
  },
  {
    // Phase 6 (second wave): what an app adds to the projects it was added to.
    id: 'projects:extend',
    label: { tr: 'Projelere katkı', en: 'Contribute to projects' },
    description: {
      tr: 'Eklendiği projelerde durum ve etiket tanımlayabilir, takvime katman, etkinlik akışına satır ve onay isteği ekleyebilir',
      en: 'Can define statuses and labels, and add a calendar layer, activity lines and approval requests in the projects it was added to',
    },
    scope: 'projects:write',
    category: 'write',
  },
  {
    id: 'users:read',
    label: { tr: 'Kişi dizinini okuma', en: 'Read the people directory' },
    description: {
      tr: 'Kuruluşunuzdaki kişilerin adını, e-postasını ve dizin bilgilerini görebilir',
      en: 'Can see the names, email addresses and directory details of people in your organization',
    },
    scope: 'users:read',
    category: 'read',
  },
  {
    // Phase 5a (G2, D5): the person's own profile in `remote/requests` envelopes, not the directory.
    id: 'profile:read',
    label: { tr: 'Profilinizi görme', en: 'See your profile' },
    description: {
      tr: 'Uygulamanın sunucusu adınızı, e-posta adresinizi ve kurumdaki rolünüzü görür',
      en: "The app's server sees your name, email address and role in your organization",
    },
    // Server-enforced: the fields go into the signed envelope, never into a token.
    scope: null,
    category: 'read',
  },
  {
    id: 'chat:read',
    label: { tr: 'Sohbetleri okuma', en: 'Read chats' },
    description: { tr: 'Sohbetleri okuyabilir', en: 'Can read chats' },
    scope: 'chat',
    category: 'read',
  },
  {
    id: 'chat:write',
    label: { tr: 'Sohbete kart gönderme', en: 'Post cards to chats' },
    description: {
      tr: 'Eklendiği ve sizin bulunduğunuz sohbetlere uygulama adına kart gönderebilir',
      en: 'Can post cards as the app to chats it was added to and that you are in',
    },
    scope: 'chat',
    category: 'write',
  },
  {
    id: 'calendar:read',
    label: { tr: 'Takvim okuma', en: 'Read calendars' },
    description: { tr: 'Takvimlerinizi ve etkinliklerinizi görebilir', en: 'Can see your calendars and events' },
    scope: 'calendar',
    category: 'read',
  },
  {
    id: 'calendar:write',
    label: { tr: 'Etkinlik oluşturma ve değiştirme', en: 'Create and change events' },
    description: {
      tr: 'Takvimlerinizde etkinlik oluşturabilir ve değiştirebilir; davet göndermez',
      en: 'Can create and change events in your calendars; sends no invitations',
    },
    scope: 'calendar',
    category: 'write',
  },
  {
    id: 'calendar:delete',
    label: { tr: 'Etkinlik silme', en: 'Delete events' },
    description: {
      tr: 'Etkinlikleri silebilir; takvimler, varsayılan takvim ve Olan toplantıları silinemez; her silme denetim kaydına yazılır',
      en: 'Can delete events; calendars, the default calendar and Olan meetings cannot be deleted; every deletion is written to the audit log',
    },
    scope: 'calendar',
    category: 'delete',
  },
  {
    id: 'contacts:read',
    label: { tr: 'Kişileri okuma', en: 'Read contacts' },
    description: { tr: 'Adres defterlerinizi ve kişilerinizi görebilir', en: 'Can see your address books and contacts' },
    scope: 'contacts',
    category: 'read',
  },
  {
    id: 'contacts:write',
    label: { tr: 'Kişi oluşturma ve değiştirme', en: 'Create and change contacts' },
    description: { tr: 'Kişi kartı oluşturabilir ve değiştirebilir', en: 'Can create and change contact cards' },
    scope: 'contacts',
    category: 'write',
  },
  {
    id: 'contacts:delete',
    label: { tr: 'Kişi silme', en: 'Delete contacts' },
    description: {
      tr: 'Kendi adres defterlerinizdeki kişileri silebilir; adres defterleri silinemez',
      en: 'Can delete contacts in your own address books; address books cannot be deleted',
    },
    scope: 'contacts',
    category: 'delete',
  },
  {
    id: 'mail:read',
    label: { tr: 'Açtığınız e-postayı okuma', en: 'Read the email you open' },
    description: {
      tr: 'Uygulamayı açtığınız e-postanın içeriğini görebilir; diğer e-postalarınıza erişemez',
      en: 'Can see the content of the email you open the app on; cannot access your other email',
    },
    // Host-enforced: only the message in the invocation context, read with the client's own session.
    scope: null,
    category: 'read',
  },
  {
    id: 'meetings:read',
    label: { tr: 'Toplantı bilgisi', en: 'Meeting details' },
    description: {
      tr: 'Görebildiğiniz toplantıların başlığını, saatini ve katılımcılarını görebilir',
      en: 'Can see the title, time and participants of meetings you can see',
    },
    scope: 'meetings:read',
    category: 'read',
  },
  {
    id: 'storage',
    label: { tr: 'Veri saklama', en: 'Store data' },
    description: {
      tr: 'Kendi verisini saklayabilir (uygulama + kullanıcı başına)',
      en: 'Can store its own data (per app and user)',
    },
    scope: 'apps:storage',
    category: 'data',
  },
  {
    id: 'db',
    label: { tr: 'Uygulama veritabanı', en: 'App database' },
    description: {
      tr: 'Kendi veritabanında kayıt oluşturabilir, okuyabilir, değiştirebilir ve silebilir; veriler bu Olan sunucusunda kalır',
      en: 'Can create, read, change and delete records in its own database; the data stays on this Olan server',
    },
    scope: 'apps:db',
    category: 'data',
  },
  {
    // Phase 5a (G3): the host's picker; uploads go straight to the app's server or an `http:<host>`.
    id: 'files:pick',
    label: { tr: 'Dosya seçtirme', en: 'Let you pick files' },
    description: {
      tr: 'Seçtiğiniz dosyaları okuyabilir ve sizin onayınızla yükleyebilir; başka dosyalarınıza erişemez',
      en: 'Can read the files you pick and upload them; cannot access your other files',
    },
    // Host-enforced.
    scope: null,
    category: 'data',
  },
  {
    id: 'settings:read',
    label: { tr: 'Organizasyon ayarlarını okuma', en: 'Read organization settings' },
    description: { tr: 'Organizasyon ayarlarını okuyabilir', en: 'Can read organization settings' },
    scope: null,
    category: 'settings',
  },
  {
    id: 'remote',
    label: { tr: 'Uygulamanın sunucusu', en: "The app's server" },
    description: {
      tr: `Veriler ${HOST_PLACEHOLDER} adresindeki uygulama sunucusuna gönderilebilir`,
      en: `Data may be sent to the app's server at ${HOST_PLACEHOLDER}`,
    },
    scope: null,
    category: 'network',
    implied: true,
  },
  {
    id: 'ai:tools',
    label: { tr: 'Asistan araçları', en: 'Assistant tools' },
    description: {
      tr: `Olan asistanı bu uygulamanın araçlarını sizin adınıza çağırabilir; araç girdileri ${HOST_PLACEHOLDER} adresine gönderilir`,
      en: `The Olan assistant can call this app's tools on your behalf; tool inputs are sent to ${HOST_PLACEHOLDER}`,
    },
    scope: null,
    category: 'network',
    implied: true,
  },
  {
    id: 'http:*',
    label: { tr: `${HOST_PLACEHOLDER} adresine erişim`, en: `Access ${HOST_PLACEHOLDER}` },
    description: {
      tr: `${HOST_PLACEHOLDER} adresine istek atabilir (Olan üzerinden)`,
      en: `Can send requests to ${HOST_PLACEHOLDER} (through Olan)`,
    },
    scope: null,
    category: 'network',
    pattern: 'http',
  },
];

export const PERMISSIONS: readonly PermissionDefinition[] = Object.freeze(
  PERMISSION_LIST.map((entry) => Object.freeze(entry)),
);

export interface ReservedPermission {
  id: string;
  /** Olan Apps phase that introduces the permission. */
  phase: 'Phase 1b' | 'Phase 3';
  /** What it will allow (English, used in messages). */
  feature: string;
}

/**
 * Permission ids the platform plan has fixed but no server grants yet.
 * `isPermission` is false for them; `validateManifest` reports
 * `manifest.permission_reserved` (with the phase) instead of
 * `manifest.permission_unknown`. Nothing here is granted, mapped to a scope or
 * shown in admin screens. Empty since Phase 3 (calendar and contacts writes
 * arrived); the structure stays for the next reserved permission.
 */
const RESERVED_PERMISSION_LIST: ReservedPermission[] = [];

export const RESERVED_PERMISSIONS: readonly ReservedPermission[] = Object.freeze(
  RESERVED_PERMISSION_LIST.map((entry) => Object.freeze(entry)),
);

const RESERVED_BY_ID = new Map(RESERVED_PERMISSIONS.map((entry) => [entry.id, entry]));

/** The reserved (not yet grantable) permission with this id, if any. */
export function reservedPermission(permission: string): ReservedPermission | undefined {
  return typeof permission === 'string' ? RESERVED_BY_ID.get(permission) : undefined;
}

const STATIC_PERMISSIONS = new Map(PERMISSIONS.filter((p) => !p.pattern).map((p) => [p.id, p]));
const HTTP_PERMISSION = PERMISSIONS.find((p) => p.pattern === 'http')!;

/** Id of the pattern entry; also the `REQUIRED_PERMISSION` value of `http.fetch`. */
export const HTTP_PERMISSION_PATTERN = 'http:*';

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*`;

/**
 * Syntactic pattern for every valid permission string (JSON Schema friendly).
 * `parsePermission` additionally checks the port range and the host length.
 */
export const PERMISSION_PATTERN = new RegExp(
  `^(?:${[...STATIC_PERMISSIONS.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|http:${HOST}(?::[0-9]{1,5})?)$`,
);
const HTTP_RE = new RegExp(`^http:(${HOST})(?::([0-9]{1,5}))?$`);

export type ParsedPermission = { kind: 'static'; id: string } | { kind: 'http'; host: string };

/**
 * Parses a permission string. `http:` hosts are normalised to lowercase and
 * keep an explicit port (`http:API.Example.com:8443` → `api.example.com:8443`).
 * Schemes, paths, wildcards, IPv6 literals and `http:*` itself are rejected.
 */
export function parsePermission(permission: string): ParsedPermission | null {
  if (typeof permission !== 'string') return null;
  if (STATIC_PERMISSIONS.has(permission)) return { kind: 'static', id: permission };
  const match = HTTP_RE.exec(permission);
  if (!match) return null;
  const hostname = match[1]!.toLowerCase();
  if (hostname.length > 253) return null;
  const portText = match[2];
  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portText) return null;
    return { kind: 'http', host: `${hostname}:${port}` };
  }
  return { kind: 'http', host: hostname };
}

export function isPermission(permission: string): boolean {
  return parsePermission(permission) !== null;
}

/** Canonical form of a permission string (`http:` hosts lowercased), or null when invalid. */
export function normalizePermission(permission: string): string | null {
  const parsed = parsePermission(permission);
  if (!parsed) return null;
  return parsed.kind === 'static' ? parsed.id : `http:${parsed.host}`;
}

/**
 * OAuth scope granted for a permission (contract §2 table); null for
 * host-enforced, reserved or unknown permissions. The scope comes from the
 * `PERMISSION_LIST` entry, so a new permission's scope is set there. Several
 * permissions share a scope (`tasks:write`, `tasks:delete`, `projects:delete`
 * → `projects:write`); the app-token guard checks the permission itself.
 */
export function permissionScope(permission: string): string | null {
  const parsed = parsePermission(permission);
  if (!parsed || parsed.kind === 'http') return null;
  return STATIC_PERMISSIONS.get(parsed.id)?.scope ?? null;
}

/** Consent screen category of a valid permission (`http:<host>` → `network`), or null. */
export function permissionCategory(permission: string): PermissionCategory | null {
  const parsed = parsePermission(permission);
  if (!parsed) return null;
  if (parsed.kind === 'http') return HTTP_PERMISSION.category;
  return STATIC_PERMISSIONS.get(parsed.id)?.category ?? null;
}

/** The definition behind a valid permission (`http:<host>` → the `http:*` entry), or null. */
export function permissionDefinition(permission: string): PermissionDefinition | null {
  const parsed = parsePermission(permission);
  if (!parsed) return null;
  return parsed.kind === 'http' ? HTTP_PERMISSION : (STATIC_PERMISSIONS.get(parsed.id) ?? null);
}

/** Texts of implied permissions when the app server's host is not known. */
const IMPLIED_WITHOUT_HOST: Readonly<Record<string, LocalizedText>> = {
  remote: { tr: 'Veriler uygulamanın kendi sunucusuna gönderilebilir', en: "Data may be sent to the app's own server" },
  'ai:tools': {
    tr: 'Olan asistanı bu uygulamanın araçlarını sizin adınıza çağırabilir; araç girdileri uygulamanın sunucusuna gönderilir',
    en: "The Olan assistant can call this app's tools on your behalf; tool inputs are sent to the app's server",
  },
};

/**
 * Consent texts of a permission. `http:<host>` fills in its own host; the implied permissions
 * (`remote`, `ai:tools`) fill in `options.host`, the app server's host (`remoteHost(manifest)`).
 */
export function describePermission(
  permission: string,
  locale: 'tr' | 'en',
  options: { host?: string | null } = {},
): { label: string; description: string } {
  const parsed = parsePermission(permission);
  if (!parsed) {
    return locale === 'tr'
      ? { label: permission, description: 'Bilinmeyen izin' }
      : { label: permission, description: 'Unknown permission' };
  }
  if (parsed.kind === 'http') {
    return {
      label: HTTP_PERMISSION.label[locale].replace(HOST_PLACEHOLDER, parsed.host),
      description: HTTP_PERMISSION.description[locale].replace(HOST_PLACEHOLDER, parsed.host),
    };
  }
  const definition = STATIC_PERMISSIONS.get(parsed.id)!;
  if (definition.implied) {
    const description = options.host
      ? definition.description[locale].replace(HOST_PLACEHOLDER, options.host)
      : (IMPLIED_WITHOUT_HOST[definition.id]?.[locale] ?? definition.description[locale]);
    return { label: definition.label[locale], description };
  }
  return { label: definition.label[locale], description: definition.description[locale] };
}

/** Permissions the manifest implies (Phase 3 §1, `impliedPermissions`); never listed in `permissions`. */
export const IMPLIED_PERMISSIONS: readonly string[] = Object.freeze(PERMISSIONS.filter((p) => p.implied).map((p) => p.id));

export function isImpliedPermission(permission: unknown): boolean {
  return typeof permission === 'string' && IMPLIED_PERMISSIONS.includes(permission);
}

/**
 * Whether `url` may be fetched with the given permissions. A permission
 * without a port matches only the scheme's default port (http 80, https 443);
 * `http:host:port` matches only that explicit port. Only http/https URLs and
 * URLs without credentials qualify. The server still blocks private addresses.
 */
export function isHttpUrlAllowed(url: string, permissions: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  // URL normalises hostnames to lowercase and drops default ports.
  const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  return permissions.some((permission) => {
    const p = parsePermission(permission);
    return p?.kind === 'http' && p.host === host;
  });
}

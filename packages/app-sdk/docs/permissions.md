# Permissions

Declare every permission the app uses in `olan-app.json`:

```json
"permissions": ["projects:read", "tasks:write", "db", "http:api.example.com"]
```

Olan shows them when someone installs the app, grouped as Okuma (read), Yazma (write), **Silme**
(delete — its own heading with a warning and each permission's description), Uygulama verisi
(app data), Ağ (network) and Ayarlar (settings). Delete permissions start unticked: the admin
grants them explicitly. Olan checks every `olan.*` call against the permissions the installation
granted. Declare only what the app calls.

| Permission | Group | Shown to the user | Allows |
|---|---|---|---|
| `projects:read` | read | Projelerinizi ve görevlerinizi okuyabilir | `olan.projects.list`, `get`, `tasks`; SDK 1.7 the `list` calls of `olan.project.statuses`, `labels`, `links`, `calendar`, `approvals`; SDK 1.8 `olan.project.fields.list`, `values`; `project.task.*`, `project.issue.*`, `project.approval.decided` events |
| `users:read` | read | Kuruluşunuzdaki kişilerin adını, e-postasını ve dizin bilgilerini görebilir | `olan.users.get`, `useUsers` (name, email, title, department, team); a permission of its own, no other one needed |
| `chat:read` | read | Sohbetleri okuyabilir | `olan.chat.conversations`, `messages` |
| `tasks:write` | write | Erişebildiğiniz projelerde görev oluşturabilir ve görevleri değiştirebilir | `olan.projects.createTask`, `updateTask` (reading still needs `projects:read`); SDK 1.7 `olan.project.links.upsert`, `remove`, `setStatus`; SDK 1.8 `olan.project.fields.setValues` |
| `projects:write` | write | Proje görevlerini değiştirebilir | `olan.projects.updateTask` only. Older permission: new apps use `tasks:write` |
| `tasks:delete` | delete | Erişebildiğiniz projelerdeki görevleri silebilir; her silme denetim kaydına yazılır | `olan.projects.deleteTask` |
| `projects:delete` | delete | Erişebildiğiniz projelerde boş iş paketlerini kaldırabilir (arşivler). Proje ve varsayılan iş paketi kaldırılamaz | `olan.projects.deleteList` |
| `storage` | data | Kendi verisini saklayabilir | `olan.storage.*`: small key–value data per installation and user (≤ 64 KiB per value, ≤ 1000 keys), for preferences and cache, not records |
| `db` | data | Kendi veritabanında kayıt oluşturabilir, okuyabilir, değiştirebilir ve silebilir; veriler bu Olan sunucusunda kalır | `olan.db.*` on the collections in the manifest's `data` (database.md) |
| `http:<host>` | network | `<host>` adresine istek atabilir | `olan.http.fetch` to that host |
| `settings:read` | settings | Organizasyon ayarlarını okuyabilir | nothing yet (reserved) |
| `chat:write` | write | Eklendiği ve sizin bulunduğunuz sohbetlere uygulama adına kart gönderebilir | `olan.chat.postCard`, `updateCard` (cards.md) |
| `calendar:read` | read | Takvimlerinizi ve etkinliklerinizi görebilir | `olan.calendar.calendars`, `events`; `calendar.event.*` events |
| `calendar:write` | write | Takvimlerinizde etkinlik oluşturabilir ve değiştirebilir; davet göndermez | `olan.calendar.createEvent`, `updateEvent` |
| `calendar:delete` | delete | Etkinlikleri silebilir; takvimler, varsayılan takvim ve Olan toplantıları silinemez; her silme denetim kaydına yazılır | `olan.calendar.deleteEvent` |
| `contacts:read` | read | Adres defterlerinizi ve kişilerinizi görebilir | `olan.contacts.addressBooks`, `search` |
| `contacts:write` | write | Kişi kartı oluşturabilir ve değiştirebilir | `olan.contacts.create`, `update` |
| `contacts:delete` | delete | Kendi adres defterlerinizdeki kişileri silebilir; adres defterleri silinemez | `olan.contacts.delete` |
| `mail:read` | read | Uygulamayı açtığınız e-postanın içeriğini görebilir; diğer e-postalarınıza erişemez | `olan.mail.getMessage` for the open email only |
| `meetings:read` | read | Görebildiğiniz toplantıların başlığını, saatini ve katılımcılarını görebilir | `olan.meetings.get`; `meeting.*` events |
| `projects:create` | write | Proje oluşturabilir; her proje kendi sohbetini, takvimini ve iş paketini açar | `olan.projects.create` |
| `projects:archive` | delete | Yalnız bu uygulamanın oluşturduğu projeleri kaldırabilir (arşivler) | `olan.projects.archive` |
| `projects:extend` | write | Eklendiği projelerde durum ve etiket tanımlayabilir, takvime katman, etkinlik akışına satır ve onay isteği ekleyebilir | SDK 1.7: `olan.project.statuses.define`, `remove`, `labels.define`, `remove`, `calendar.upsert`, `remove`, `activity.post`, `approvals.request`, `cancel`; SDK 1.8 `fields.define`, `remove` (api.md#olanproject-records-statuses-calendar-feed-approvals); only in projects the app was added to |
| `profile:read` | read | Profilinizi görme: uygulamanın sunucusu adınızı, e-posta adresinizi ve kurumdaki rolünüzü görür | SDK 1.5: adds `user.email`, `user.displayName` and `user.role` (`admin` \| `member`) to the `olan.remote.request` envelopes (remote-requests.md). Nothing in the sandbox changes (`useUser()` stays `{ id }`). Needs `remote` in the manifest (`manifest.profile_requires_remote`) |
| `files:pick` | data | Dosya seçtirme: seçtiğiniz dosyaları okuyabilir ve sizin onayınızla yükleyebilir; başka dosyalarınıza erişemez | SDK 1.5: `olan.files.pick`, `upload`, `cancel` (files.md); uploads go only to the `remote.url` origin or an `http:<host>` host |

Two more are **implied** by the manifest and never listed in `permissions` (`manifest.permission_unknown`):
`remote` (network: "Veriler `<host>` adresindeki uygulama sunucusuna gönderilebilir") when it
declares `remote` (it also covers `olan.remote.request` when `remote.requests` is `true`; there is
no separate permission for requests), and `ai:tools` (network: "Olan asistanı bu uygulamanın araçlarını sizin adınıza
çağırabilir; araç girdileri `<host>`'a gönderilir") when it declares `ai.tools`. Consent screens show
them with the server's host; admins can block them like any permission. Surfaces need no
permission; the consent screen lists them under "Görüneceği yerler".

`db` covers the app's own rows only; deleting them does not need a delete permission. Deleting
Olan records always does, and protected records (projects, the default work package, task
statuses and fields, chats, calendars, address books, Olan meetings, members, accounts) cannot be deleted by any app; such
calls fail with `forbidden_record` and are written to the audit log. An admin can also restrict
an app to deleting only the records it created.

No permission is needed for `olan.settings.get` (the app's own settings), `olan.ui.*` (including
`openUrl` and `openExternal`), `Image` and `Avatar` pictures (the host checks their origin instead),
`olan.navigation.*`, `useTheme`, `useLocale`, `usePlatform`, `useSettings`, `useNavigation`, and
`useUser()` (the current user's id; their name needs `users:read`).

## Reserved permissions

Ids fixed for a later phase fail with `manifest.permission_reserved` (the hint names the phase).
None are reserved today. Deleting projects (as opposed to archiving the app's own), creating work
packages, calendars or address books and sending chat messages are not app permissions.
`projects:delete` keeps its meaning (empty work packages); removing projects is `projects:archive`.

Permissions come in families: `<resource>:read`, `<resource>:write` (create and change) and
`<resource>:delete`. Deleting is always its own permission and is shown separately at install.

## `http:<host>`

- Grammar: `http:` + a DNS host name or IPv4 address + an optional `:port` (1–65535). No scheme,
  path, wildcard (`*.example.com`), user info or IPv6. Hosts are lower-cased
  (`http:API.Example.com` → `http:api.example.com`).
- A permission without a port matches only the scheme's default port: `http:api.example.com`
  allows `https://api.example.com/...` (443) and `http://api.example.com/...` (80), not
  `https://api.example.com:8443/`. A permission with a port matches only that port.
- One permission per host: `api.example.com` does not cover `www.example.com`.
- Only `http` and `https` URLs; URLs with credentials (`https://user:pw@…`) are refused.
- Olan's server additionally refuses private and loopback addresses (`localhost`, `10.x`, …).

## What happens when one is missing

- At run time the call rejects with `OlanError` code `permission_denied` (or `http_blocked` for a
  host that is not allowed). Show an `EmptyState` with the message rather than crashing.
- `olan-app validate --strict` renders every surface with the manifest's permissions and reports
  `permission.missing` / `permission.http_missing` with the permission to add.
- In tests, `renderApp({ permissions: [] })` checks how the app behaves without them.

Admins can block permissions for the whole organization (e.g. every `http:` host); a blocked
permission behaves like a missing one.

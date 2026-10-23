# Examples

Complete apps live in the Olan repository under `examples/` (each passes `validate --strict` and
`test`, with fixtures and tests to copy):

| Example | Shows |
|---|---|
| `examples/project-pulse` | `app` surface, three screens on the navigation stack, status `Badge`s, `Menu` → `olan.projects.updateTask` with `revision`, `OlanError` handling, toasts (`projects:read`, `projects:write`) |
| `examples/overdue-widget` | `project.widget` surface with `params.projectId`, manifest `settings` + `useSettings`, date logic tested with a frozen clock (`projects:read`) |
| `examples/exchange-rates` | `olan.http.fetch` with `http:<host>`, `Table`, `Chart`, a `settings` surface with a `Select` saving to `olan.storage`, HTTP fixtures, retry (`http:rates.example.com`, `storage`) |
| `examples/decision-log` | `olan.db` with an `organization` and a `user` collection, `useCollection` with a status filter and `loadMore`, `useRecord`, "Göreve dönüştür" → `olan.projects.createTask`, `deleteTask`, `deleteList` with `forbidden_record` → toast, `fixtures/db.json` (`projects:read`, `db`, `tasks:write`, `tasks:delete`, `projects:delete`) |
| `examples/ops-inbox` | Backend code (`server`, backend.md): `olan.backend.call('summary')` from the UI, a 5-minute `schedules` digest into `olan.db`, a `project.task.created` event handler, a GitHub hook verified with `hmac-sha256`, a `secret: true` setting read only by the backend (`olan.secrets.get`) and used for `olan.http.fetch`; `createBackendHarness` tests (`db`, `projects:read`, `http:ops.example.com`) |
| `examples/media-desk` | SDK 1.5 "Medya Masası": `olan.remote.request` to its own Node server (`handleRequest` routes, `RemoteError` → `Banner`, 422 issues on fields), `olan.files.pick` + `upload` with `ProgressBar` and cancel, `Image`/`Avatar` from the server, `openExternal` sign-in that returns (`appReturnUrl`, `state`, `useSurfaceParams<'app'>().return`), an `/apps/a/…/item?id=` address, `Tabs`, `Switch`, `MultiSelect`, `Stat`, stacked area `Chart`, sortable `Table`, `TextField maxLength`, `refetchIntervalMs`; server tests for signature, stale timestamp, unknown issuer and replay (`profile:read`, `files:pick`) |
| `examples/field-kit` | Every component, `Form`/`TextField`/`Select`/`DatePicker`, every `olan.ui.*` call, `app` + `project.widget`, settings, `olan.db`, task create/delete (the mobile acceptance app) |

These directories are in the Olan source repository, **not** in `node_modules`, so an app
project cannot open them; the table only says what each one shows. Everything you need is inline
in these docs: the snippets below are complete surfaces, and the database pattern (collection,
`useCollection`, insert/update/delete with `revision`, `conflict`/`forbidden_record` handling,
`fixtures/db.json`) is in database.md ("API", "Errors", "Testing").

The `olan-app init` templates (`blank`, `list-detail`, `data-list`, `project-widget`, `project-tab`,
`project-records`, `external-api`) are smaller starting points that land in your project: `npx olan-app init "Notlar"
--template data-list` writes a complete `olan.db` app (list, add with a `Form`, detail, update,
delete) with tests.

To install an example in a local Olan, pack it with your development key
(`npx olan-app pack --dev-sign`, inside the example directory) after adding the key to the local
Platform API (`npx olan-app keygen --dev` prints the `OLAN_APPS_TRUSTED_KEYS` line). A plain
`pack` is unsigned: the catalog lists it, but it does not install (cli.md#signing-and-publishing).

## A widget on the project page

```tsx
import { Card, EmptyState, List, defineApp, olan, useQuery, type SurfaceProps } from '@olan-app/sdk';

function OverdueCard({ params }: SurfaceProps) {
  const projectId = (params as { projectId?: string } | null)?.projectId ?? '';
  const tasks = useQuery(() => olan.projects.tasks(projectId), [projectId]);
  // A sketch: "today" here is the UTC date. A real app should compare in the project's
  // `timeZone` (olan.projects.get) and treat a due time (`2026-10-17T15:00`) as overdue once it passes.
  const today = new Date().toISOString().slice(0, 10);
  const overdue = (tasks.data ?? []).filter(
    (t) => (t.status === 'needs-action' || t.status === 'in-process') && t.due !== null && t.due.slice(0, 10) < today,
  );
  if (tasks.error) return <EmptyState title="Görevler yüklenemedi" description={tasks.error.message} />;
  if (!tasks.loading && overdue.length === 0) return <EmptyState title="Geciken görev yok" icon="check-circle" />;
  return (
    <Card title="Geciken görevler" subtitle={`${overdue.length} görev`}>
      <List loading={tasks.loading} items={overdue.map((t) => ({ key: t.id, title: t.title, meta: t.due ?? undefined, badge: { text: 'Gecikti', tone: 'danger' } }))} />
    </Card>
  );
}

export default defineApp({ 'project.widget': OverdueCard });
```

Manifest: `"surfaces": { "project.widget": { "title": "Gecikenler" } }`, `"permissions": ["projects:read"]`.

## Changing a task from a menu

```tsx
const STATUS_LABEL: Record<ProjectTaskStatus, string> = { 'needs-action': 'Yapılacak', 'in-process': 'Sürüyor', completed: 'Tamamlandı', cancelled: 'İptal' };

function TaskScreen({ projectId, taskId }: { projectId: string; taskId: string }) {
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const task = detail.data?.tasks.find((t) => t.id === taskId);
  if (!task) return <Screen title="Görev" loading={detail.loading} />;
  return (
    <Screen title={task.title}>
      <Stack gap="md" padding="md">
        <Badge text={STATUS_LABEL[task.status]} />
        <Menu
          label="Durumu değiştir"
          items={(Object.keys(STATUS_LABEL) as ProjectTaskStatus[]).map((s) => ({ key: s, label: STATUS_LABEL[s], disabled: s === task.status }))}
          onSelect={async ({ key }) => {
            await olan.projects.updateTask(projectId, task.id, { status: key as ProjectTaskStatus, revision: task.revision });
            await olan.ui.toast({ text: 'Güncellendi', tone: 'success' });
            await detail.refetch();
          }}
        />
      </Stack>
    </Screen>
  );
}
```

Permissions: `projects:read`, `tasks:write` (apps written before SDK 1.1 use `projects:write`, which still allows `updateTask`).

## A form that saves to storage

```tsx
function Notes() {
  const notes = useQuery(async () => (await olan.storage.get<string[]>('notes')) ?? []);
  const add = async (text: string) => {
    if (!text.trim()) return;
    await olan.storage.set('notes', [...(notes.data ?? []), text.trim()]);
    await notes.refetch();
  };
  return (
    <Screen title="Notlar" loading={notes.loading}>
      <Stack gap="md" padding="md">
        <Form submitLabel="Ekle" onSubmit={({ values }) => add(values.text ?? '')}>
          <TextField name="text" label="Not" placeholder="Bir not yazın" />
        </Form>
        <List items={(notes.data ?? []).map((text, index) => ({ key: index, title: text }))} emptyText="Not yok" />
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Notes });
```

Permission: `storage`. Test: `await app.fill('Not', 'Süt al'); await app.press('Ekle'); app.expectText('Süt al');`.

## An external API

```tsx
const URL = 'https://status.example.com/api/services.json';   // permission "http:status.example.com"

function Services() {
  const services = useQuery(async () => {
    const response = await olan.http.fetch(URL, { headers: { accept: 'application/json' } });
    if (response.status !== 200) throw new Error(`API ${response.status}`);
    return response.json<{ services: { id: string; name: string; up: boolean }[] }>().services;
  });
  return (
    <Screen title="Servisler" loading={services.loading} actions={[{ key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: () => services.refetch() }]}>
      {services.error ? (
        <EmptyState title="Durum alınamadı" description={services.error.message} action={{ label: 'Tekrar dene', onPress: () => services.refetch() }} />
      ) : (
        <List items={(services.data ?? []).map((s) => ({ key: s.id, title: s.name, badge: s.up ? { text: 'Çalışıyor', tone: 'success' } : { text: 'Kapalı', tone: 'danger' } }))} />
      )}
    </Screen>
  );
}
```

`fixtures/http.json`: `{ "https://status.example.com/api/services.json": { "status": 200, "json": { "services": [ … ] } } }`.

## Confirm before a destructive action

```tsx
<Button
  label="Hepsini temizle"
  variant="danger"
  onPress={async () => {
    if (!(await olan.ui.confirm({ title: 'Tüm notlar silinsin mi?', confirmLabel: 'Sil', destructive: true }))) return;
    await olan.storage.remove('notes');
    await notes.refetch();
  }}
/>
```

Test the "cancel" path with `renderApp({ ui: { confirm: false } })`. Review guidelines 2.1 (nothing is deleted without asking) and 4.1 (labelled controls) in review-guidelines.md.

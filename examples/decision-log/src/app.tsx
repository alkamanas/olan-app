import { useState } from 'react';

import {
  Button,
  Card,
  DatePicker,
  EmptyState,
  Form,
  List,
  Screen,
  Select,
  Stack,
  Text,
  TextField,
  defineApp,
  isOlanError,
  olan,
  useCollection,
  useNavigation,
  useQuery,
  useRecord,
  type DbWhere,
  type ProjectTaskList,
  type Tone,
} from '@olan-app/sdk';

/** A row of the `decisions` collection (organization scope; only its creator may delete it). */
export interface Decision {
  title: string;
  status?: 'open' | 'done';
  projectId?: string;
  /** The task this decision became ("Göreve dönüştür"). */
  taskId?: string;
  decidedOn?: string;
  score?: number;
}

/** A row of the `pins` collection (user scope: each person sees only their own pins). */
export interface Pin {
  decisionId: string;
}

const decisions = olan.db.collection<Decision>('decisions');
const pins = olan.db.collection<Pin>('pins');
const PAGE = 10;

export const STATUS: Record<'open' | 'done', { label: string; tone: Tone }> = {
  open: { label: 'Açık', tone: 'accent' },
  done: { label: 'Karara bağlandı', tone: 'success' },
};

const FILTERS = [
  { value: 'all', label: 'Tümü' },
  { value: 'open', label: 'Açık' },
  { value: 'done', label: 'Karara bağlandı' },
];

/** A sentence for a failed olan.* call. */
function problem(error: unknown): string {
  if (isOlanError(error, 'forbidden_record')) return 'Bu kayıt korunuyor';
  if (isOlanError(error, 'conflict')) return 'Kayıt bu arada değişti; yeniden yüklendi';
  if (isOlanError(error, 'quota_exceeded')) return 'Uygulamanın veritabanı dolu; yöneticinize başvurun';
  if (isOlanError(error, 'permission_denied')) return 'Bu işlem için izin verilmemiş';
  return error instanceof Error ? error.message : String(error);
}

/** Project names by id (for subtitles and the project picker). */
function useProjects() {
  const projects = useQuery(() => olan.projects.list({ limit: 100 }));
  const items = projects.data?.items ?? [];
  return { projects, items, nameOf: (id: string | undefined) => items.find((project) => project.id === id)?.name };
}

/** First screen ('index'): decisions, newest first, filtered by status, 10 per page. */
function DecisionsScreen() {
  const navigation = useNavigation();
  const [filter, setFilter] = useState('all');
  const where: DbWhere | undefined = filter === 'all' ? undefined : { status: filter };
  const list = useCollection<Decision>('decisions', { ...(where ? { where } : {}), orderBy: { field: 'createdAt', direction: 'desc' }, limit: PAGE });
  const mine = useCollection<Pin>('pins', { limit: 100 });
  const pinned = new Set(mine.rows.map((row) => row.data.decisionId));
  const { nameOf } = useProjects();
  const items = list.rows.map((row) => {
    const status = STATUS[row.data.status ?? 'open'];
    const subtitle = [pinned.has(row.id) ? 'Sabitlendi' : null, nameOf(row.data.projectId) ?? null].filter(Boolean).join(' · ');
    return {
      key: row.id,
      title: row.data.title,
      subtitle: subtitle || undefined,
      meta: row.data.decidedOn,
      badge: { text: status.label, tone: status.tone },
    };
  });
  return (
    <Screen
      title="Karar defteri"
      loading={list.loading}
      actions={[
        { key: 'new', label: 'Yeni karar', icon: 'plus', onPress: () => navigation.push('new') },
        { key: 'projects', label: 'Projeler', onPress: () => navigation.push('projects') },
      ]}
    >
      <Select name="filter" label="Durum" value={filter} options={FILTERS} onChange={({ value }) => setFilter(value)} />
      {list.error ? (
        <EmptyState title="Kararlar yüklenemedi" description={list.error.message} action={{ label: 'Tekrar dene', onPress: () => list.refetch() }} />
      ) : (
        <Stack gap="md">
          <List items={items} emptyText="Henüz karar yok" onSelect={({ key }) => navigation.push('decision', { id: String(key) })} />
          {list.nextCursor ? <Button label="Daha fazla" variant="secondary" onPress={() => list.loadMore()} /> : null}
        </Stack>
      )}
    </Screen>
  );
}

function NewDecisionScreen() {
  const navigation = useNavigation();
  const { items } = useProjects();
  const save = async ({ values }: { values: Record<string, string> }) => {
    const title = (values.title ?? '').trim();
    if (!title) {
      await olan.ui.toast({ text: 'Karar metni gerekli', tone: 'danger' });
      return;
    }
    const data: Decision = { title, status: 'open' };
    if (values.projectId) data.projectId = values.projectId;
    if (values.decidedOn) data.decidedOn = values.decidedOn.slice(0, 10);
    try {
      await decisions.insert(data);
      await olan.ui.toast({ text: 'Karar eklendi', tone: 'success' });
      navigation.pop();
    } catch (error) {
      await olan.ui.toast({ text: problem(error), tone: 'danger' });
    }
  };
  return (
    <Screen title="Yeni karar">
      <Form onSubmit={save} submitLabel="Kaydet" cancelLabel="Vazgeç" onCancel={() => navigation.pop()}>
        <TextField name="title" label="Karar" required placeholder="Ne kararlaştırıldı?" />
        <Select name="projectId" label="Proje" placeholder="Proje seçin" options={items.map((project) => ({ value: project.id, label: project.name }))} />
        <DatePicker name="decidedOn" label="Karar tarihi" />
      </Form>
    </Screen>
  );
}

function DecisionScreen({ id }: { id: string }) {
  const navigation = useNavigation();
  const record = useRecord<Decision>('decisions', id);
  const myPins = useCollection<Pin>('pins', { where: { decisionId: id }, limit: 1 });
  const row = record.data;
  const projectId = row?.data.projectId;
  const project = useQuery(() => (projectId ? olan.projects.get(projectId) : Promise.resolve(null)), [projectId]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!row) {
    return <Screen title="Karar" loading={record.loading}>{record.loading ? null : <EmptyState title="Karar bulunamadı" description="Silinmiş olabilir." />}</Screen>;
  }
  const task = row.data.taskId ? project.data?.tasks.find((candidate) => candidate.id === row.data.taskId) : undefined;
  const pin = myPins.rows[0];
  const status = STATUS[row.data.status ?? 'open'];

  /** Runs one action; failures become a toast and a notice, and the row is reloaded. */
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const done = await action();
      if (done) {
        setNotice(done);
        await olan.ui.toast({ text: done, tone: 'success' });
      }
    } catch (error) {
      const text = problem(error);
      setNotice(text);
      await olan.ui.toast({ text, tone: 'danger' });
      await record.refetch();
    } finally {
      setBusy(false);
    }
  };

  const toTask = () =>
    run(async () => {
      if (!projectId) return null;
      const created = await olan.projects.createTask(projectId, { title: row.data.title, description: 'Karar defterinden' });
      await decisions.update(row.id, { taskId: created.id }, { revision: row.revision });
      await project.refetch();
      return `Görev oluşturuldu: ${created.title}`;
    });

  const deleteTask = () =>
    run(async () => {
      if (!projectId || !row.data.taskId) return null;
      // The task's current revision (it may have changed since the project was loaded).
      const current = (await olan.projects.tasks(projectId)).find((candidate) => candidate.id === row.data.taskId);
      if (current) await olan.projects.deleteTask(projectId, current.id, { revision: current.revision });
      await decisions.update(row.id, { taskId: null }, { revision: row.revision });
      await project.refetch();
      return 'Görev silindi';
    });

  const toggle = () =>
    run(async () => {
      const next = row.data.status === 'done' ? 'open' : 'done';
      await decisions.update(row.id, { status: next }, { revision: row.revision });
      return next === 'done' ? 'Karara bağlandı' : 'Yeniden açıldı';
    });

  const togglePin = () =>
    run(async () => {
      if (pin) await pins.delete(pin.id);
      else await pins.insert({ decisionId: row.id });
      return pin ? 'Sabitleme kaldırıldı' : 'Sabitlendi';
    });

  const remove = async () => {
    const sure = await olan.ui.confirm({ title: 'Karar silinsin mi?', message: row.data.title, confirmLabel: 'Sil', destructive: true });
    if (!sure) return;
    await run(async () => {
      await decisions.delete(row.id, { revision: row.revision });
      if (pin) await pins.delete(pin.id);
      await olan.ui.toast({ text: 'Karar silindi' });
      navigation.pop();
      return null;
    });
  };

  return (
    <Screen title={row.data.title} loading={busy}>
      <Card title="Ayrıntılar">
        <Stack gap="sm">
          <Text text={`Durum: ${status.label}`} />
          <Text text={`Proje: ${project.data?.project.name ?? (projectId ? '…' : 'yok')}`} />
          <Text text={`Karar tarihi: ${row.data.decidedOn ?? 'yok'}`} />
          <Text text={`Görev: ${row.data.taskId ? (task?.title ?? 'silinmiş') : 'yok'}`} />
          {pin ? <Text tone="accent" text="Sabitlendi" /> : null}
          {notice ? <Text tone="muted" text={notice} /> : null}
        </Stack>
      </Card>
      <Stack direction="horizontal" gap="sm" wrap>
        {projectId && !row.data.taskId ? <Button label="Göreve dönüştür" onPress={toTask} disabled={busy} /> : null}
        {row.data.taskId ? <Button label="Görevi sil" variant="secondary" onPress={deleteTask} disabled={busy} /> : null}
        <Button label={row.data.status === 'done' ? 'Yeniden aç' : 'Karara bağla'} variant="secondary" onPress={toggle} disabled={busy} />
        <Button label={pin ? 'Sabitlemeyi kaldır' : 'Sabitle'} variant="ghost" onPress={togglePin} disabled={busy} />
        <Button label="Kararı sil" variant="danger" onPress={remove} disabled={busy} />
      </Stack>
    </Screen>
  );
}

function ProjectsScreen() {
  const navigation = useNavigation();
  const { projects, items } = useProjects();
  return (
    <Screen title="Projeler" loading={projects.loading}>
      {projects.error ? (
        <EmptyState title="Projeler yüklenemedi" description={projects.error.message} action={{ label: 'Tekrar dene', onPress: () => projects.refetch() }} />
      ) : (
        <List
          items={items.map((project) => ({ key: project.id, title: project.name }))}
          emptyText="Henüz proje yok"
          onSelect={({ key }) => navigation.push('project', { projectId: String(key) })}
        />
      )}
    </Screen>
  );
}

/** A work package is empty without tasks and without child work packages. */
function isEmpty(list: ProjectTaskList, lists: ProjectTaskList[], taskListIds: Set<string>): boolean {
  return !taskListIds.has(list.id) && !lists.some((candidate) => candidate.parentId === list.id);
}

function ProjectScreen({ projectId }: { projectId: string }) {
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lists = detail.data?.lists ?? [];
  const counts = new Map<string, number>();
  for (const task of detail.data?.tasks ?? []) counts.set(task.listId, (counts.get(task.listId) ?? 0) + 1);

  /**
   * Removes every empty work package. The default one is attempted too: Olan protects it
   * (`forbidden_record`), and the app says so instead of hiding the rule.
   */
  const cleanUp = async () => {
    setBusy(true);
    const removed: string[] = [];
    const kept: string[] = [];
    try {
      for (const list of lists.filter((candidate) => isEmpty(candidate, lists, new Set(counts.keys())))) {
        try {
          await olan.projects.deleteList(projectId, list.id, { revision: list.revision });
          removed.push(list.name);
        } catch (error) {
          if (!isOlanError(error, 'forbidden_record')) throw error;
          kept.push(list.isDefault ? 'Varsayılan iş paketi korunuyor' : `${list.name} korunuyor`);
        }
      }
      const parts = [removed.length ? `${removed.length} boş iş paketi kaldırıldı` : 'Kaldırılacak boş iş paketi yok', ...kept];
      setNotice(parts.join(' · '));
      for (const text of kept) await olan.ui.toast({ text, tone: 'warning' });
      if (removed.length) await olan.ui.toast({ text: parts[0]!, tone: 'success' });
    } catch (error) {
      const text = problem(error);
      setNotice(text);
      await olan.ui.toast({ text, tone: 'danger' });
    } finally {
      setBusy(false);
      await detail.refetch();
    }
  };

  const items = lists.map((list) => ({
    key: list.id,
    title: list.name,
    subtitle: `${counts.get(list.id) ?? 0} görev`,
    ...(list.isDefault ? { badge: { text: 'Varsayılan', tone: 'muted' as const } } : {}),
  }));
  return (
    <Screen title={detail.data?.project.name ?? 'Proje'} loading={detail.loading || busy}>
      {detail.error ? (
        <EmptyState title="Proje yüklenemedi" description={detail.error.message} action={{ label: 'Tekrar dene', onPress: () => detail.refetch() }} />
      ) : (
        <Card title="İş paketleri">
          <Stack gap="md">
            <List items={items} emptyText="İş paketi yok" />
            <Button label="Boş iş paketlerini temizle" variant="secondary" onPress={cleanUp} disabled={busy || detail.loading} />
            {notice ? <Text tone="muted" text={notice} /> : null}
          </Stack>
        </Card>
      )}
    </Screen>
  );
}

/** The `app` surface switches on the visible screen of the navigation stack. */
function App() {
  const { screen, params } = useNavigation();
  const p = (params ?? {}) as { id?: string; projectId?: string };
  if (screen === 'new') return <NewDecisionScreen />;
  if (screen === 'decision' && p.id) return <DecisionScreen id={p.id} />;
  if (screen === 'projects') return <ProjectsScreen />;
  if (screen === 'project' && p.projectId) return <ProjectScreen projectId={p.projectId} />;
  return <DecisionsScreen />;
}

export default defineApp({ app: App });

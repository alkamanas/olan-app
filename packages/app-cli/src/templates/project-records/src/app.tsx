import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  DatePicker,
  EmptyState,
  List,
  Screen,
  Stack,
  Text,
  TextField,
  defineApp,
  isOlanError,
  olan,
  useQuery,
  useSurfaceParams,
  useUser,
  type AppCard,
  type ProjectApproval,
  type ProjectDetail,
  type RecordLink,
  type RecordTarget,
} from '@olan-app/sdk';

/**
 * The app keeps its own records (purchase requests, `SAT-…`) and links them to project tasks. The
 * task shows the card the app draws; the task moves to the app's "Onay bekliyor" status, the
 * delivery date shows in the project calendar and the project feed tells what happened. All of it
 * only in projects a member added the app to ("Uygulamalar" on the project page).
 */
const AWAITING = { key: 'awaiting-approval', name: 'Onay bekliyor', category: 'started', color: '#E0A526' } as const;

const STATES: Record<ProjectApproval['state'], { text: string; tone: 'warning' | 'success' | 'danger' | 'muted' }> = {
  pending: { text: 'Bekliyor', tone: 'warning' },
  approved: { text: 'Onaylandı', tone: 'success' },
  rejected: { text: 'Reddedildi', tone: 'danger' },
  cancelled: { text: 'İptal edildi', tone: 'muted' },
};

/** The card on the task. Record cards only `open`: the button opens the `record.card` surface. */
function recordCard(recordId: string, title: string, delivered = false): AppCard {
  return {
    version: 1,
    root: 1,
    fallbackText: `${recordId} · ${title}`,
    nodes: [
      { id: 1, type: 'Card', props: { title, subtitle: recordId }, children: [2, 3] },
      { id: 2, type: 'Badge', props: delivered ? { text: 'Teslim alındı', tone: 'success' } : { text: AWAITING.name, tone: 'warning' }, children: [] },
      { id: 3, type: 'Button', props: { label: 'Kaydı aç', action: { kind: 'open', payload: { recordId } } }, children: [] },
    ],
  };
}

/** Who approves: the project's owners and managers other than the person asking (else every member who may write). */
function approversOf(detail: ProjectDetail, me: string): string[] {
  const writers = detail.members.filter((member) => member.role !== 'guest');
  const managers = writers.filter((member) => (member.role === 'owner' || member.role === 'manager') && member.userId !== me);
  return (managers.length ? managers : writers).map((member) => member.userId).slice(0, 10);
}

function NotEnabled({ title }: { title: string }) {
  return (
    <Screen title={title}>
      <EmptyState title="Uygulama bu projeye eklenmemiş" description="Proje sayfasında Uygulamalar'dan ekleyebilirsiniz." icon="link" />
    </Screen>
  );
}

async function failed(error: unknown) {
  if (isOlanError(error, 'permission_denied')) await olan.ui.toast({ text: 'Bu projede değişiklik yapamazsınız', tone: 'danger' });
  else if (isOlanError(error, 'conflict')) await olan.ui.toast({ text: 'Proje bu arada değişmiş; yeniden deneyin', tone: 'warning' });
  else await olan.ui.toast({ text: error instanceof Error ? error.message : 'İşlem tamamlanamadı', tone: 'danger' });
}

/** Asks the project's managers to approve the record (they find it in their approval box). */
function ApprovalButton({ projectId, link, detail }: { projectId: string; link: RecordLink; detail: ProjectDetail | null }) {
  const user = useUser();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label="Onay iste"
      variant="secondary"
      loading={busy}
      disabled={!detail}
      onPress={async () => {
        if (!detail) return;
        setBusy(true);
        try {
          await olan.project.approvals.request(projectId, {
            title: `${link.title} onayı`,
            approverIds: approversOf(detail, user.id),
            mode: 'any',
            externalId: link.externalId,
            linkId: link.id,
            card: link.card,
          });
          await olan.ui.toast({ text: 'Onay istendi', tone: 'success' });
        } catch (error) {
          await failed(error);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** The `task.action` surface: "Kayda bağla" in a task's "…" menu, `params = { projectId, task }`. */
function LinkRecord() {
  const { projectId, task } = useSurfaceParams<'task.action'>();
  const target: RecordTarget = { kind: 'task', id: task.id };
  const links = useQuery(() => olan.project.links.list(projectId, target), [projectId, task.id]);
  const project = useQuery(() => olan.projects.get(projectId), [projectId]);
  const [recordId, setRecordId] = useState('');
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState<string | null>(task.due);
  const [saving, setSaving] = useState(false);
  const [linked, setLinked] = useState<RecordLink | null>(null);

  const error = links.error ?? project.error;
  if (error && isOlanError(error, 'project_not_enabled')) return <NotEnabled title="Kayda bağla" />;
  if (error) {
    return (
      <Screen title="Kayda bağla">
        <EmptyState title="Kayıtlar yüklenemedi" description={error.message} />
      </Screen>
    );
  }
  const current = linked ?? links.data?.[0] ?? null;

  const link = async () => {
    const id = recordId.trim();
    if (!id || !title.trim()) return;
    setSaving(true);
    try {
      // The app's status: defining it again is harmless (same key, same values).
      await olan.project.statuses.define(projectId, [AWAITING]);
      const created = await olan.project.links.upsert(projectId, { target, externalId: id, card: recordCard(id, title.trim()) });
      await olan.project.links.setStatus(projectId, created.id, { statusKey: AWAITING.key });
      if (due) await olan.project.calendar.upsert(projectId, { externalId: id, title: `Teslim: ${title.trim()}`, start: due, allDay: true, linkId: created.id });
      await olan.project.activity.post(projectId, `${id} satın alma kaydı bağlandı, onay bekliyor`, { target });
      setLinked(created);
      await olan.ui.toast({ text: 'Kayıt bağlandı', tone: 'success' });
    } catch (failure) {
      await failed(failure);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title="Kayda bağla" subtitle={task.key ? `${task.key} · ${task.title}` : task.title} loading={links.loading}>
      {current ? (
        <Card title={current.title} subtitle="Bu göreve bağlı kayıt">
          <Stack gap="sm">
            <Text tone="muted">Görev "{AWAITING.name}" durumunda; kaydı görevin kartından açabilirsiniz.</Text>
            <ApprovalButton projectId={projectId} link={current} detail={project.data ?? null} />
          </Stack>
        </Card>
      ) : (
        <Stack gap="md">
          <TextField name="recordId" label="Kayıt numarası" placeholder="SAT-12" value={recordId} maxLength={40} required onChange={({ value }) => setRecordId(value)} />
          <TextField name="title" label="Kayıt adı" value={title} maxLength={120} required onChange={({ value }) => setTitle(value)} />
          <DatePicker name="due" label="Teslim tarihi" value={due} onChange={({ value }) => setDue(value || null)} />
          <Button label="Bağla" loading={saving} disabled={!recordId.trim() || !title.trim()} onPress={link} />
        </Stack>
      )}
    </Screen>
  );
}

/** The `record.card` surface: opened from the card's "Kaydı aç" button, `params = { projectId, linkId, target, externalId, payload }`. */
function RecordScreen() {
  const { projectId, linkId, target, externalId } = useSurfaceParams<'record.card'>();
  const links = useQuery(() => olan.project.links.list(projectId, target), [projectId, target.kind, target.id]);
  const approvals = useQuery(() => olan.project.approvals.list(projectId), [projectId]);
  const calendar = useQuery(() => olan.project.calendar.list(projectId), [projectId]);
  const [done, setDone] = useState(false);
  const error = links.error ?? approvals.error ?? calendar.error;
  if (error && isOlanError(error, 'project_not_enabled')) return <NotEnabled title="Kayıt" />;
  const link = links.data?.find((candidate) => candidate.id === linkId);
  if (error || (!links.loading && !link)) {
    return (
      <Screen title={externalId}>
        <EmptyState title="Kayıt artık bu göreve bağlı değil" description={error?.message} icon="record" />
      </Screen>
    );
  }
  const ownApprovals = (approvals.data ?? []).filter((approval) => approval.linkId === linkId);
  const items = (calendar.data ?? []).filter((item) => item.linkId === linkId);

  return (
    <Screen title={link?.title ?? externalId} subtitle={externalId} loading={links.loading || approvals.loading || calendar.loading}>
      <Card title="Onaylar">
        <List
          emptyText="Onay istenmedi"
          items={ownApprovals.map((approval) => ({ key: approval.id, title: approval.title, badge: STATES[approval.state] }))}
        />
      </Card>
      <Card title="Takvim">
        <List emptyText="Teslim tarihi yok" items={items.map((item) => ({ key: item.id, title: item.title, meta: item.start.slice(0, 10) }))} />
      </Card>
      {done ? (
        <Badge text="Teslim alındı" tone="success" />
      ) : (
        <Button
          label="Teslim alındı"
          onPress={async () => {
            try {
              // Through the link the app moves the task; the feed shows the change under the app.
              await olan.project.links.setStatus(projectId, linkId, { status: 'completed' });
              // The card on the task says so too.
              if (link) await olan.project.links.upsert(projectId, { target, externalId, card: recordCard(externalId, link.title.replace(`${externalId} · `, ''), true) });
              await olan.project.activity.post(projectId, `${externalId} teslim alındı`, { target });
              setDone(true);
              await olan.ui.toast({ text: 'Görev tamamlandı', tone: 'success' });
            } catch (failure) {
              await failed(failure);
            }
          }}
        />
      )}
    </Screen>
  );
}

/** The `project.tab` surface ("Kayıtlar"): every record the app linked in the project. */
function RecordsTab() {
  const { projectId } = useSurfaceParams<'project.tab'>();
  const links = useQuery(() => olan.project.links.list(projectId), [projectId]);
  const approvals = useQuery(() => olan.project.approvals.list(projectId, { state: 'pending' }), [projectId]);
  const error = links.error ?? approvals.error;
  if (error && isOlanError(error, 'project_not_enabled')) return <NotEnabled title="Kayıtlar" />;
  if (error) {
    return (
      <Screen title="Kayıtlar">
        <EmptyState title="Kayıtlar yüklenemedi" description={error.message} />
      </Screen>
    );
  }
  const waiting = new Set((approvals.data ?? []).map((approval) => approval.linkId));
  const rows = links.data ?? [];
  return (
    <Screen title="Kayıtlar" subtitle={`${rows.length} kayıt`} loading={links.loading}>
      {!links.loading && rows.length === 0 ? (
        <EmptyState title="Henüz bağlı kayıt yok" description={'Bir görevin "…" menüsünden "Kayda bağla"yı seçin.'} icon="link" />
      ) : (
        <List
          items={rows.map((link) => ({
            key: link.id,
            title: link.title,
            subtitle: link.target.kind === 'task' ? 'Görev' : 'Sorun',
            badge: waiting.has(link.id) ? { text: 'Onay bekliyor', tone: 'warning' as const } : undefined,
          }))}
        />
      )}
    </Screen>
  );
}

export default defineApp({ 'task.action': LinkRecord, 'record.card': RecordScreen, 'project.tab': RecordsTab });

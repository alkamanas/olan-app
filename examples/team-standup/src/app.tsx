import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  List,
  Screen,
  Select,
  Stack,
  Text,
  TextField,
  defineApp,
  isOlanError,
  olan,
  useQuery,
  useSurfaceParams,
  type MailSurfaceParams,
  type ProjectTask,
} from '@olan-app/sdk';

import { CARD_TITLE, standupCard } from './card.ts';

/*
 * Team Standup: the Olan Apps Phase 3 example (contract §13).
 * - `app`: the person's projects with open and overdue task counts.
 * - `chat.action` ("Standup'a ekle"): turns a chat message into a task of a project (tasks:write).
 * - `chat.command` (`/standup`): posts today's standup card into the chat (chat:write); the card's
 *   "Tamamladım" button is answered by the app server (remote-server/, POST /olan/card-actions).
 * - `calendar.event.action` ("Standup notu"): writes a note on the event (calendar:write), creates
 *   and deletes a follow-up event (calendar:delete) and tries to delete the event itself, which
 *   Olan refuses for Olan meetings and project calendar events (forbidden_record).
 * - `mail.action` ("Standup'a ekle") and `mail.sidebar` ("Standup"): the email (subject, sender,
 *   its text via `olan.mail.getMessage`, mail:read) becomes a task of a project.
 * - `meeting.panel` ("Standup"): the meeting (participants via `olan.meetings.get`, meetings:read),
 *   the open tasks of its project (or a chosen one) and "Görev ekle".
 * Events (`project.task.created`, `chat.message.created`) and the assistant tools `standup_summary`
 * (read-only) and `standup_add_task` (waits for the person's confirmation card) are handled by the
 * app server.
 */

const today = () => new Date().toISOString().slice(0, 10);
const isOpen = (task: ProjectTask) => task.status === 'needs-action' || task.status === 'in-process';

/** "code: message" of a failed call; protected records name their reason. */
function failureText(error: unknown): string {
  if (isOlanError(error, 'forbidden_record')) {
    const reason = /\(([a-z_]+)\)\s*$/.exec(error.message)?.[1];
    return reason ? `Bu kayıt korunuyor: ${reason}` : 'Bu kayıt korunuyor';
  }
  if (isOlanError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function failed(error: unknown, setResult?: (text: string) => void): Promise<void> {
  const text = failureText(error);
  setResult?.(text);
  await olan.ui.toast({ text, tone: 'danger' });
}

// ------------------------------------------------------------------------------------------
// app
// ------------------------------------------------------------------------------------------

function Home() {
  const projects = useQuery(async () => {
    const { items } = await olan.projects.list({ limit: 20 });
    const now = Date.now();
    return Promise.all(items.filter((project) => !project.archived).map(async (project) => {
      const tasks = await olan.projects.tasks(project.id);
      const open = tasks.filter(isOpen);
      const overdue = open.filter((task) => task.due !== null && Date.parse(task.due) < now).length;
      return { project, open: open.length, overdue };
    }));
  });
  return (
    <Screen title="Team Standup" subtitle="Projelerin standup durumu" loading={projects.loading}>
      <Stack gap="md" padding="md">
        {projects.error ? (
          <EmptyState title="Projeler yüklenemedi" description={failureText(projects.error)} action={{ label: 'Tekrar dene', onPress: () => projects.refetch() }} />
        ) : (
          <List
            emptyText="Proje yok"
            items={(projects.data ?? []).map(({ project, open, overdue }) => ({
              key: project.id,
              title: project.name,
              subtitle: `${open} açık görev`,
              ...(overdue > 0 ? { badge: { text: `${overdue} gecikmiş`, tone: 'danger' as const } } : {}),
            }))}
          />
        )}
        <Text variant="caption" tone="muted" text="Sohbette ve e-postada “Standup'a ekle”, oluşturucuda /standup, takvimde “Standup notu”, toplantıda “Standup” paneli." />
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// chat.action: the message becomes a task
// ------------------------------------------------------------------------------------------

function AddToStandup() {
  const { message } = useSurfaceParams<'chat.action'>();
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const options = (projects.data?.items ?? []).filter((project) => !project.archived).map((project) => ({ value: project.id, label: project.name }));
  const selected = projectId ?? options[0]?.value ?? null;
  const body = (message.body ?? '').trim();
  const title = (body.split('\n')[0] ?? '').trim().slice(0, 200) || 'Standup maddesi';

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const task = await olan.projects.createTask(selected, { title, description: body });
      setResult(`Görev oluşturuldu: ${task.title}`);
      await olan.ui.toast({ text: 'Görev oluşturuldu', tone: 'success' });
    } catch (error) {
      await failed(error, setResult);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Standup'a ekle" loading={projects.loading}>
      <Stack gap="md" padding="md">
        <Text variant="label" text="Mesaj" />
        <Text text={body || '(boş mesaj)'} />
        {projects.error ? (
          <EmptyState title="Projeler yüklenemedi" description={failureText(projects.error)} />
        ) : options.length === 0 && !projects.loading ? (
          <EmptyState title="Proje yok" description="Görev eklemek için bir projeye üye olun." />
        ) : (
          <Select name="project" label="Proje" options={options} value={selected} onChange={({ value }) => setProjectId(value)} />
        )}
        <Button label="Göreve çevir" variant="primary" disabled={!selected} loading={busy} onPress={create} />
        {result ? <Text tone="muted" text={result} /> : null}
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// chat.command: /standup posts a card
// ------------------------------------------------------------------------------------------

function StandupCommand() {
  const params = useSurfaceParams<'chat.command'>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const note = params.text.trim();

  const send = async () => {
    setBusy(true);
    try {
      await olan.chat.postCard({
        conversationId: params.conversationId,
        card: standupCard({ day: today(), note }),
        ...(typeof params.threadRootId === 'string' ? { threadRootId: params.threadRootId } : {}),
      });
      setSent(true);
      await olan.ui.toast({ text: 'Kart gönderildi', tone: 'success' });
      // The first screen of a modal: pop() closes it, and the person sees the card in the chat.
      await olan.navigation.pop();
    } catch (error) {
      await failed(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Standup">
      <Stack gap="md" padding="md">
        <Text variant="heading" text={CARD_TITLE} />
        <Text tone="muted" text={note || 'Dün ne yaptın, bugün ne yapacaksın, engel var mı?'} />
        {sent ? <Badge text="Gönderildi" tone="success" /> : null}
        <Button label="Kartı gönder" variant="primary" loading={busy} disabled={sent} onPress={send} />
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// calendar.event.action: a note on the event, a follow-up event, a protected delete
// ------------------------------------------------------------------------------------------

function StandupNote() {
  const event = useSurfaceParams<'calendar.event.action'>();
  const [note, setNote] = useState("Standup'ta konuşuldu");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState('');

  const run = (key: string, action: () => Promise<string>) => async () => {
    setBusy(key);
    try {
      const text = await action();
      setResult(text);
      await olan.ui.toast({ text, tone: 'success' });
    } catch (error) {
      await failed(error, setResult);
    } finally {
      setBusy(null);
    }
  };

  const addNote = run('note', async () => {
    await olan.calendar.updateEvent(event.eventId, { description: `Standup notu (${today()}): ${note.trim() || '-'}` });
    return 'Not eklendi';
  });
  const followUp = run('follow-up', async () => {
    const start = event.isAllDay ? event.start : event.end || event.start;
    const created = await olan.calendar.createEvent({
      title: `Takip: ${event.title || 'Standup'}`,
      start,
      ...(event.isAllDay ? { isAllDay: true } : { duration: 'PT15M' }),
      ...(event.timeZone ? { timeZone: event.timeZone } : {}),
    });
    await olan.calendar.deleteEvent(created.id);
    return 'Takip etkinliği oluşturuldu ve silindi';
  });
  const deleteThis = run('delete', async () => {
    await olan.calendar.deleteEvent(event.eventId);
    return 'Etkinlik silindi';
  });

  return (
    <Screen title="Standup notu">
      <Stack gap="md" padding="md">
        <Text variant="heading" text={event.title || 'Etkinlik'} />
        <Text tone="muted" text={event.isAllDay ? event.start.slice(0, 10) : `${event.start} – ${event.end}`} />
        <TextField name="note" label="Not" value={note} onChange={({ value }) => setNote(value)} />
        <Button label="Not ekle" variant="primary" loading={busy === 'note'} disabled={busy !== null} onPress={addNote} />
        <Button label="Takip etkinliği oluştur ve sil" variant="secondary" loading={busy === 'follow-up'} disabled={busy !== null} onPress={followUp} />
        <Button label="Bu etkinliği sil" variant="danger" loading={busy === 'delete'} disabled={busy !== null} onPress={deleteThis} />
        {result ? <Text tone="muted" text={result} /> : null}
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// mail.action and mail.sidebar: the email becomes a task
// ------------------------------------------------------------------------------------------

const MAX_DESCRIPTION = 4000;

function senderText(mail: MailSurfaceParams): string {
  const { name, email } = mail.from;
  if (name && email) return `${name} <${email}>`;
  return name || email || '-';
}

/** The project picker and "Göreve çevir" for one email; the body is read with `mail:read` when allowed. */
function MailToTask({ mail, textBody }: { mail: MailSurfaceParams; textBody: string | null }) {
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const options = (projects.data?.items ?? []).filter((project) => !project.archived).map((project) => ({ value: project.id, label: project.name }));
  const selected = projectId ?? options[0]?.value ?? null;

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const description = [`Gönderen: ${senderText(mail)}`, textBody?.trim() ?? ''].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
      const task = await olan.projects.createTask(selected, { title: mail.subject.trim().slice(0, 200) || 'E-posta', description });
      setResult(`Görev oluşturuldu: ${task.title}`);
      await olan.ui.toast({ text: 'Görev oluşturuldu', tone: 'success' });
    } catch (error) {
      await failed(error, setResult);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      {projects.error ? (
        <EmptyState title="Projeler yüklenemedi" description={failureText(projects.error)} />
      ) : options.length === 0 && !projects.loading ? (
        <EmptyState title="Proje yok" description="Görev eklemek için bir projeye üye olun." />
      ) : (
        <Select name="project" label="Proje" options={options} value={selected} onChange={({ value }) => setProjectId(value)} />
      )}
      <Button label="Göreve çevir" variant="primary" disabled={!selected} loading={busy} onPress={create} />
      {result ? <Text tone="muted" text={result} /> : null}
    </Stack>
  );
}

/** The email's text (`olan.mail.getMessage`, `mail:read`); null while loading or when not allowed. */
function useMailBody(messageId: string) {
  return useQuery(() => olan.mail.getMessage(messageId), [messageId]);
}

function MailAction() {
  const mail = useSurfaceParams<'mail.action'>();
  const message = useMailBody(mail.messageId);
  return (
    <Screen title="Standup'a ekle">
      <Stack gap="md" padding="md">
        <Text variant="label" text="E-posta" />
        <Text variant="heading" text={mail.subject || '(konu yok)'} />
        <Text tone="muted" text={`Gönderen: ${senderText(mail)}`} />
        <MailToTask key={mail.messageId} mail={mail} textBody={message.data?.textBody ?? null} />
      </Stack>
    </Screen>
  );
}

function MailSidebar() {
  const mail = useSurfaceParams<'mail.sidebar'>();
  const message = useMailBody(mail.messageId);
  const body = (message.data?.textBody ?? '').trim();
  const attachments = message.data?.attachments.length ?? 0;
  return (
    <Screen title="Standup">
      <Stack gap="md" padding="md">
        <Text variant="heading" text={`Konu: ${mail.subject || '(konu yok)'}`} />
        <Text tone="muted" text={`Gönderen: ${senderText(mail)}`} />
        {message.error ? (
          <Text variant="caption" tone="muted" text={`İçerik okunamadı (${failureText(message.error)})`} />
        ) : body ? (
          <Text variant="caption" text={body.length > 280 ? `${body.slice(0, 280)}…` : body} />
        ) : null}
        {attachments > 0 ? <Badge text={`${attachments} ek`} /> : null}
        <MailToTask key={mail.messageId} mail={mail} textBody={message.data?.textBody ?? null} />
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// meeting.panel: the meeting's project (or a chosen one) and its open tasks
// ------------------------------------------------------------------------------------------

function MeetingPanel() {
  const meeting = useSurfaceParams<'meeting.panel'>();
  const details = useQuery(() => olan.meetings.get(meeting.meetingId), [meeting.meetingId]);
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const options = (projects.data?.items ?? []).filter((project) => !project.archived).map((project) => ({ value: project.id, label: project.name }));
  const selected = chosen ?? meeting.projectId ?? options[0]?.value ?? null;
  const tasks = useQuery(async () => (selected ? (await olan.projects.tasks(selected)).filter(isOpen) : []), [selected]);

  const add = async () => {
    if (!selected || !title.trim()) return;
    setBusy(true);
    try {
      await olan.projects.createTask(selected, { title: title.trim().slice(0, 200), description: `Toplantı: ${meeting.title || '-'}` });
      setTitle('');
      await olan.ui.toast({ text: 'Görev eklendi', tone: 'success' });
      await tasks.refetch();
    } catch (error) {
      await failed(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Standup" loading={tasks.loading}>
      <Stack gap="md" padding="md">
        <Text variant="heading" text={`Toplantı: ${meeting.title || '-'}`} />
        {details.data ? (
          <Text tone="muted" text={`${details.data.participants.length} katılımcı`} />
        ) : details.error ? (
          <Text tone="muted" text={meeting.role === 'organizer' ? 'Düzenleyen sizsiniz' : 'Katılımcısınız'} />
        ) : null}
        {projects.error ? (
          <EmptyState title="Projeler yüklenemedi" description={failureText(projects.error)} />
        ) : (
          <Select name="project" label="Proje" options={options} value={selected} onChange={({ value }) => setChosen(value)} />
        )}
        {tasks.error ? (
          <EmptyState title="Görevler yüklenemedi" description={failureText(tasks.error)} />
        ) : (
          <List
            emptyText="Açık görev yok"
            items={(tasks.data ?? []).slice(0, 20).map((task) => ({
              key: task.id,
              title: task.title,
              ...(task.due ? { subtitle: task.due.slice(0, 10) } : {}),
            }))}
          />
        )}
        <TextField name="task" label="Yeni görev" value={title} placeholder="Toplantıdan çıkan iş" onChange={({ value }) => setTitle(value)} />
        <Button label="Görev ekle" variant="secondary" disabled={!selected || !title.trim()} loading={busy} onPress={add} />
      </Stack>
    </Screen>
  );
}

export default defineApp({
  app: Home,
  'chat.action': AddToStandup,
  'chat.command': StandupCommand,
  'calendar.event.action': StandupNote,
  'mail.action': MailAction,
  'mail.sidebar': MailSidebar,
  'meeting.panel': MeetingPanel,
});

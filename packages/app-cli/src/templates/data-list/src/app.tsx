import {
  Button,
  Card,
  EmptyState,
  Form,
  List,
  Screen,
  Stack,
  Text,
  TextField,
  defineApp,
  isOlanError,
  olan,
  useCollection,
  useNavigation,
  useRecord,
} from '@olan-app/sdk';

const TITLE = '{{appName}}';

/** A row of the `notes` collection (olan-app.json `data`). Optional fields are optional here too. */
export interface Note {
  title: string;
  body?: string;
  done?: boolean;
}

const notes = olan.db.collection<Note>('notes');

/** Turns an olan.* failure into a sentence for a toast. */
function problem(error: unknown): string {
  if (isOlanError(error, 'forbidden_record')) return 'Bu kayıt korunuyor: yalnız oluşturan kişi silebilir';
  if (isOlanError(error, 'conflict')) return 'Not bu arada değişti; yeniden yüklendi';
  if (isOlanError(error, 'quota_exceeded')) return 'Uygulamanın veritabanı dolu; yöneticinize başvurun';
  return error instanceof Error ? error.message : String(error);
}

/** First screen ('index'): open notes first, newest first, 20 per page. */
function NotesScreen() {
  const navigation = useNavigation();
  const list = useCollection<Note>('notes', { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 20 });
  const items = list.rows.map((row) => ({
    key: row.id,
    title: row.data.title,
    subtitle: row.data.body || undefined,
    badge: row.data.done ? { text: 'Tamamlandı', tone: 'success' as const } : { text: 'Açık', tone: 'accent' as const },
  }));
  return (
    <Screen title={TITLE} loading={list.loading} actions={[{ key: 'new', label: 'Yeni not', icon: 'add', onPress: () => navigation.push('new') }]}>
      {list.error ? (
        <EmptyState title="Notlar yüklenemedi" description={list.error.message} action={{ label: 'Tekrar dene', onPress: () => list.refetch() }} />
      ) : (
        <Stack gap="md">
          <List items={items} emptyText="Henüz not yok" onSelect={({ key }) => navigation.push('note', { id: String(key) })} />
          {list.nextCursor ? <Button label="Daha fazla" variant="secondary" onPress={() => list.loadMore()} /> : null}
        </Stack>
      )}
    </Screen>
  );
}

function NewNoteScreen() {
  const navigation = useNavigation();
  const save = async ({ values }: { values: Record<string, string> }) => {
    const title = (values.title ?? '').trim();
    if (!title) {
      await olan.ui.toast({ text: 'Başlık gerekli', tone: 'danger' });
      return;
    }
    try {
      const body = (values.body ?? '').trim();
      await notes.insert({ title, ...(body ? { body } : {}), done: false });
      await olan.ui.toast({ text: 'Not eklendi', tone: 'success' });
      navigation.pop();
    } catch (error) {
      await olan.ui.toast({ text: problem(error), tone: 'danger' });
    }
  };
  return (
    <Screen title="Yeni not">
      <Form onSubmit={save} submitLabel="Kaydet" cancelLabel="Vazgeç" onCancel={() => navigation.pop()}>
        <TextField name="title" label="Başlık" required />
        <TextField name="body" label="Not" multiline />
      </Form>
    </Screen>
  );
}

function NoteScreen({ id }: { id: string }) {
  const navigation = useNavigation();
  const note = useRecord<Note>('notes', id);
  const row = note.data;
  if (!row) return <Screen title="Not" loading={note.loading}>{note.loading ? null : <EmptyState title="Not bulunamadı" />}</Screen>;

  const toggle = async () => {
    try {
      await notes.update(row.id, { done: !row.data.done }, { revision: row.revision });
    } catch (error) {
      await olan.ui.toast({ text: problem(error), tone: 'danger' });
      await note.refetch();
    }
  };
  const remove = async () => {
    const sure = await olan.ui.confirm({ title: 'Not silinsin mi?', message: row.data.title, confirmLabel: 'Sil', destructive: true });
    if (!sure) return;
    try {
      await notes.delete(row.id, { revision: row.revision });
      await olan.ui.toast({ text: 'Not silindi' });
      navigation.pop();
    } catch (error) {
      await olan.ui.toast({ text: problem(error), tone: 'danger' });
    }
  };

  return (
    <Screen title={row.data.title}>
      <Card title="Ayrıntılar">
        <Stack gap="sm">
          <Text text={`Durum: ${row.data.done ? 'Tamamlandı' : 'Açık'}`} />
          {row.data.body ? <Text tone="muted" text={row.data.body} /> : null}
          <Text variant="caption" tone="muted" text={`Oluşturan: ${row.createdBy}`} />
        </Stack>
      </Card>
      <Stack direction="horizontal" gap="sm">
        <Button label={row.data.done ? 'Yeniden aç' : 'Tamamlandı'} onPress={toggle} />
        <Button label="Sil" variant="danger" onPress={remove} />
      </Stack>
    </Screen>
  );
}

/** The `app` surface switches on the visible screen of the navigation stack. */
function App() {
  const { screen, params } = useNavigation();
  const p = (params ?? {}) as { id?: string };
  if (screen === 'new') return <NewNoteScreen />;
  if (screen === 'note' && p.id) return <NoteScreen id={p.id} />;
  return <NotesScreen />;
}

export default defineApp({ app: App });

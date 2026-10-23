import {
  Badge,
  Button,
  Card,
  Chart,
  DatePicker,
  EmptyState,
  Form,
  List,
  Menu,
  OlanError,
  Screen,
  Select,
  Stack,
  Table,
  Text,
  TextField,
  defineApp,
  isOlanError,
  olan,
  useCollection,
  useLocale,
  useNavigation,
  usePlatform,
  useQuery,
  useTheme,
  useUser,
  type ProjectTask,
  type ProjectTaskStatus,
  type SurfaceProps,
  type Tone,
} from '@olan-app/sdk';
import { useState } from 'react';

/*
 * Saha Kiti: the Olan Apps mobile acceptance app. Every Phase 1 component and every platform call
 * is reachable from the home screen, so a tester can walk through them on iOS and Android.
 * Phase 1b: the app database (`olan.db`, "Veritabanı") and task/work package writes and deletes
 * ("Veri" → "Kayıtlar").
 */

export const STATUS: Record<ProjectTaskStatus, { label: string; tone: Tone }> = {
  'needs-action': { label: 'Yapılacak', tone: 'default' },
  'in-process': { label: 'Sürüyor', tone: 'accent' },
  completed: { label: 'Tamamlandı', tone: 'success' },
  cancelled: { label: 'İptal', tone: 'muted' },
};
const STATUS_ORDER: ProjectTaskStatus[] = ['needs-action', 'in-process', 'completed', 'cancelled'];
const isOpen = (task: ProjectTask) => task.status === 'needs-action' || task.status === 'in-process';

export const LAST_SUBMISSION_KEY = 'lastSubmission';
export const LONG_LIST_SIZE = 500;
export const WEATHER_URL = 'https://api.example.com/v1/weather?city=istanbul';

const errorText = (error: unknown) => (error instanceof OlanError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));

/** Phase 1b: the error as "code: message" in the screen's result text and as a native danger toast. */
async function reportError(label: string, error: unknown, setResult: (text: string) => void): Promise<void> {
  const code = isOlanError(error) ? error.code : 'error';
  const message = error instanceof Error ? error.message : String(error);
  setResult(`${label}: ${code}: ${message}`);
  await olan.ui.toast({ text: `${code}: ${message}`, tone: 'danger' });
}

/**
 * The project the "Kayıtlar" card writes to: the surface's `params.projectId` when the host opened
 * the app for a project, otherwise the first project the app can see. Project ids are server ids
 * (UUIDs on a real Olan), so the app never hardcodes one.
 */
export async function resolveRecordsProjectId(preferred: string | undefined): Promise<string | null> {
  if (preferred) return preferred;
  const { items } = await olan.projects.list({ limit: 1 });
  return items[0]?.id ?? null;
}

export const CREATED_TASK_KEY = 'createdTask';
type CreatedTask = { projectId: string; taskId: string; title: string };

type Note = { title: string; done?: boolean };
const notes = olan.db.collection<Note>('notes');

/** Theme, locale and platform as the host reports them (changes live when the host theme changes). */
function ContextLine() {
  const theme = useTheme();
  const locale = useLocale();
  const platform = usePlatform();
  return <Text variant="caption" tone="muted" text={`Tema: ${theme === 'dark' ? 'koyu' : 'açık'} · Dil: ${locale} · Platform: ${platform}`} />;
}

/** The signed-in person's central Olan user id (`useUser().id`, contract §10.1; needs no permission). */
function UserLine() {
  const user = useUser();
  return <Text variant="caption" tone="muted" text={`Kullanıcı: ${user?.id ?? '–'}`} />;
}

// ------------------------------------------------------------------------------------------
// Home
// ------------------------------------------------------------------------------------------

const SECTIONS = [
  { key: 'components', title: 'Bileşenler', subtitle: 'Metin, yığın, kart, rozet, tablo, grafik', icon: 'list', badge: { text: '15', tone: 'accent' as Tone } },
  { key: 'form', title: 'Form', subtitle: 'Metin alanı, seçici, tarih seçici', icon: 'edit' },
  { key: 'interactions', title: 'Etkileşimler', subtitle: 'Onay, metin, menü, tarih, paylaşım, bildirim', icon: 'touch' },
  { key: 'long', title: 'Uzun liste', subtitle: `${LONG_LIST_SIZE} satır`, icon: 'list-checks', meta: `${LONG_LIST_SIZE}` },
  { key: 'data', title: 'Veri', subtitle: 'Projeler, sohbetler, ayarlar, kayıtlar', icon: 'projects', badge: { text: 'Sunucu', tone: 'success' as Tone } },
  { key: 'db', title: 'Veritabanı', subtitle: 'olan.db: not ekle, işaretle, sil', icon: 'note', badge: { text: 'olan.db', tone: 'accent' as Tone } },
];

function HomeScreen() {
  const navigation = useNavigation();
  const theme = useTheme();
  const settings = useQuery(() => olan.settings.get());
  const teamName = typeof settings.data?.teamName === 'string' ? settings.data.teamName : 'Saha ekibi';
  return (
    <Screen
      title="Saha Kiti"
      subtitle={`${teamName} · ${theme === 'dark' ? 'Koyu tema' : 'Açık tema'}`}
      actions={[{ key: 'about', label: 'Hakkında', icon: 'info', onPress: () => olan.ui.toast({ text: 'Saha Kiti 1.x · Olan Apps kabul uygulaması' }) }]}
    >
      <Stack gap="md" padding="md">
        <ContextLine />
        <UserLine />
        <List items={SECTIONS} onSelect={({ key }) => navigation.push(String(key))} />
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// Bileşenler
// ------------------------------------------------------------------------------------------

const TONES: Tone[] = ['default', 'muted', 'accent', 'danger', 'success', 'warning'];
const TONE_LABEL: Record<Tone, string> = { default: 'Varsayılan', muted: 'Soluk', accent: 'Vurgu', danger: 'Tehlike', success: 'Başarılı', warning: 'Uyarı' };
const SAMPLE_ITEMS = [
  { key: 'a1', title: 'Kablo kontrolü', subtitle: 'Bina A', meta: '09:30', badge: { text: 'Açık', tone: 'accent' as Tone }, icon: 'check-circle' },
  { key: 'a2', title: 'Pano değişimi', subtitle: 'Bina B', meta: '11:00', badge: { text: 'Gecikti', tone: 'danger' as Tone }, icon: 'warning' },
  { key: 'a3', title: 'Topraklama ölçümü', meta: '14:15', badge: { text: 'Tamam', tone: 'success' as Tone } },
  { key: 'a4', title: 'Devre dışı satır', subtitle: 'Seçilemez', disabled: true },
];

function ComponentsScreen() {
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  const [menuChoice, setMenuChoice] = useState<string | null>(null);
  const [emptyCleared, setEmptyCleared] = useState(false);
  return (
    <Screen
      title="Bileşenler"
      subtitle="Faz 1 bileşenlerinin tamamı"
      scroll
      actions={[
        { key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: () => olan.ui.toast({ text: 'Yenilendi' }) },
        { key: 'share', label: 'Paylaş', icon: 'share', onPress: () => olan.ui.share({ text: 'Saha Kiti bileşenleri' }) },
      ]}
    >
      <Stack gap="lg" padding="md">
        <Card title="Metin" subtitle="Her varyant ve ton">
          <Stack gap="xs">
            <Text variant="title" text="Başlık (title)" />
            <Text variant="heading" text="Ara başlık (heading)" />
            <Text variant="body" text="Gövde metni (body)" />
            <Text variant="caption" text="Açıklama (caption)" />
            <Text variant="label" text="Etiket (label)" />
            {TONES.map((tone) => (
              <Text key={tone} tone={tone} text={`Ton: ${TONE_LABEL[tone]}`} />
            ))}
            <Text weight="regular">Normal</Text>
            <Text weight="medium">Orta</Text>
            <Text weight="semibold">Yarı kalın</Text>
            <Text weight="bold">Kalın</Text>
            <Text truncate text="Bu çok uzun bir satır; tek satıra sığmazsa sonu üç noktayla kesilmelidir, böylece taşma olmaz ve düzen bozulmaz." />
          </Stack>
        </Card>

        <Card title="Yığın" subtitle="Yatay ve dikey, boşluklarla" padding="md">
          <Stack gap="sm">
            {(['none', 'xs', 'sm', 'md', 'lg'] as const).map((gap) => (
              <Stack key={gap} direction="horizontal" gap={gap} align="center">
                <Text variant="label" text={`gap=${gap}`} />
                <Badge text="A" />
                <Badge text="B" />
                <Badge text="C" />
              </Stack>
            ))}
            <Stack direction="horizontal" justify="between" align="center">
              <Text text="Sol" />
              <Text text="Sağ" />
            </Stack>
            <Stack direction="horizontal" gap="xs" wrap>
              {TONES.map((tone) => (
                <Badge key={tone} text={TONE_LABEL[tone]} tone={tone} />
              ))}
            </Stack>
          </Stack>
        </Card>

        <Card
          title="Düğmeler"
          subtitle="Varyantlar ve durumlar"
          actions={[{ key: 'card-action', label: 'Kart eylemi', icon: 'more', onPress: () => olan.ui.toast({ text: 'Kart eylemi' }) }]}
        >
          <Stack gap="sm">
            <Button label="Birincil" variant="primary" icon="check" onPress={() => olan.ui.toast({ text: 'Birincil', tone: 'success' })} />
            <Button label="İkincil" variant="secondary" onPress={() => olan.ui.toast({ text: 'İkincil' })} />
            <Button label="Hayalet" variant="ghost" onPress={() => olan.ui.toast({ text: 'Hayalet' })} />
            <Button label="Tehlikeli" variant="danger" icon="delete" onPress={() => olan.ui.toast({ text: 'Tehlikeli', tone: 'danger' })} />
            <Button label="Devre dışı" disabled onPress={() => undefined} />
            <Button
              label={busy ? 'Yükleniyor' : 'Yükleniyor durumu'}
              loading={busy}
              onPress={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1500);
              }}
            />
          </Stack>
        </Card>

        <Card title="Menü">
          <Stack gap="sm">
            <Menu
              label="İşlemler"
              icon="more"
              items={[
                { key: 'edit', label: 'Düzenle', icon: 'edit' },
                { key: 'copy', label: 'Kopyala', icon: 'copy' },
                { key: 'archive', label: 'Arşivle (kapalı)', icon: 'archive', disabled: true },
                { key: 'delete', label: 'Sil', icon: 'delete', destructive: true },
              ]}
              onSelect={({ key }) => setMenuChoice(String(key))}
            />
            <Menu icon="settings" items={[{ key: 'icon-only', label: 'Yalnız simgeli menü' }]} onSelect={() => setMenuChoice('icon-only')} />
            <Text tone="muted" text={`Menü seçimi: ${menuChoice ?? 'yok'}`} />
          </Stack>
        </Card>

        <Card title="Liste" subtitle="Rozetler ve seçim">
          <List items={SAMPLE_ITEMS} onSelect={({ key }) => navigation.push('detail', { from: 'Bileşenler', key: String(key) })} />
        </Card>

        <Card title="Tablo">
          <Table
            columns={[
              { key: 'site', title: 'Saha', width: 2 },
              { key: 'open', title: 'Açık', align: 'end' },
              { key: 'done', title: 'Biten', align: 'center' },
            ]}
            rows={[
              { key: 'kadikoy', cells: { site: 'Kadıköy', open: 3, done: 7 } },
              { key: 'besiktas', cells: { site: 'Beşiktaş', open: 1, done: 4 } },
              { key: 'uskudar', cells: { site: 'Üsküdar', open: 0, done: null } },
            ]}
            onSelectRow={({ key }) => olan.ui.toast({ text: `Satır: ${String(key)}` })}
            emptyText="Satır yok"
          />
        </Card>

        <Card title="Grafik" subtitle="Çubuk ve çizgi">
          <Stack gap="md">
            <Chart
              kind="bar"
              height={160}
              series={[
                { name: 'Açılan', points: [{ x: 'Pzt', y: 4 }, { x: 'Sal', y: 6 }, { x: 'Çar', y: 3 }, { x: 'Per', y: 8 }, { x: 'Cum', y: 5 }] },
                { name: 'Kapanan', points: [{ x: 'Pzt', y: 2 }, { x: 'Sal', y: 5 }, { x: 'Çar', y: 4 }, { x: 'Per', y: 6 }, { x: 'Cum', y: 7 }] },
              ]}
            />
            <Chart
              kind="line"
              height={160}
              series={[{ name: 'Tamamlanma %', points: [{ x: 'H1', y: 20 }, { x: 'H2', y: 35 }, { x: 'H3', y: 55 }, { x: 'H4', y: 80 }] }]}
            />
          </Stack>
        </Card>

        {emptyCleared ? (
          <Text tone="success" text="Boş durum eylemi çalıştı" />
        ) : (
          <EmptyState title="Burada henüz bir şey yok" description="Boş durum bileşeni, eylem düğmesiyle" icon="inbox" action={{ label: 'Örnek ekle', onPress: () => setEmptyCleared(true) }} />
        )}
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// Form
// ------------------------------------------------------------------------------------------

const PRIORITIES = [
  { value: 'low', label: 'Düşük' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Yüksek' },
];

type Submission = {
  values: Record<string, string>;
  at: string;
};

function FormScreen() {
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [priority, setPriority] = useState<string | null>('normal');
  const [due, setDue] = useState<string | null>(null);
  const [remindAt, setRemindAt] = useState<string | null>(null);
  const last = useQuery(() => olan.storage.get<Submission>(LAST_SUBMISSION_KEY));

  const submit = async (values: Record<string, string>) => {
    if (!(values.title ?? title).trim()) {
      setTitleError('Başlık zorunlu');
      return;
    }
    setTitleError(undefined);
    const submission: Submission = { values: { ...values, pin: values.pin ? '••••' : '' }, at: new Date().toISOString() };
    await olan.storage.set(LAST_SUBMISSION_KEY, submission);
    await olan.ui.toast({ text: 'Form kaydedildi', tone: 'success' });
    await last.refetch();
  };

  const saved = last.data;
  return (
    <Screen title="Form" subtitle="Son gönderim depoda saklanır" loading={last.loading}>
      <Stack gap="lg" padding="md">
        <Form submitLabel="Kaydet" cancelLabel="Vazgeç" onCancel={() => olan.navigation.pop()} onSubmit={({ values }) => submit(values)}>
          <TextField
            name="title"
            label="Başlık"
            placeholder="Örn. Pano kontrolü"
            required
            value={title}
            error={titleError}
            onChange={({ value }) => {
              setTitle(value);
              if (value.trim()) setTitleError(undefined);
            }}
          />
          <TextField name="notes" label="Notlar" placeholder="Ayrıntılar" multiline />
          <TextField name="pin" label="PIN" placeholder="4 hane" secure />
          <Select name="priority" label="Öncelik" placeholder="Seçin" options={PRIORITIES} value={priority} onChange={({ value }) => setPriority(value)} />
          <DatePicker name="due" label="Bitiş tarihi" mode="date" value={due} onChange={({ value }) => setDue(value)} />
          <DatePicker name="remindAt" label="Hatırlatma" mode="datetime" value={remindAt} onChange={({ value }) => setRemindAt(value)} />
        </Form>
        {saved ? (
          <Card title="Son gönderim" subtitle={saved.at}>
            <Stack gap="xs">
              <Text text={`Başlık: ${saved.values.title ?? ''}`} />
              <Text text={`Öncelik: ${PRIORITIES.find((option) => option.value === saved.values.priority)?.label ?? '-'}`} />
              <Text text={`Bitiş: ${saved.values.due || '-'}`} />
              <Text text={`Hatırlatma: ${saved.values.remindAt || '-'}`} />
              <Text tone="muted" text={`Notlar: ${saved.values.notes || '-'}`} />
            </Stack>
          </Card>
        ) : (
          <Text tone="muted" text="Henüz gönderim yok" />
        )}
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// Etkileşimler
// ------------------------------------------------------------------------------------------

function InteractionsScreen() {
  const [result, setResult] = useState('Henüz bir şey denenmedi');
  const run = (label: string, action: () => Promise<unknown>) => async () => {
    try {
      const value = await action();
      setResult(`${label}: ${value === undefined || value === null ? 'boş' : JSON.stringify(value)}`);
    } catch (error) {
      setResult(`${label}: hata ${errorText(error)}`);
    }
  };
  return (
    <Screen title="Etkileşimler" subtitle="Platformun kendi denetimleri">
      <Stack gap="md" padding="md">
        <Card title="Sonuç">
          <Text text={result} />
        </Card>
        <Button
          label="Onay iste"
          variant="danger"
          onPress={run('Onay', () => olan.ui.confirm({ title: 'Kayıt silinsin mi?', message: 'Bu işlem geri alınamaz.', confirmLabel: 'Sil', cancelLabel: 'Vazgeç', destructive: true }))}
        />
        <Button label="Metin iste" onPress={run('Metin', () => olan.ui.prompt({ title: 'Yeni ad', message: 'Saha için bir ad yazın', placeholder: 'Ad', defaultValue: 'Kadıköy' }))} />
        <Button
          label="Menü aç"
          variant="secondary"
          onPress={run('Menü', () =>
            olan.ui.menu({
              items: [
                { key: 'call', label: 'Ara', icon: 'call' },
                { key: 'message', label: 'Mesaj gönder', icon: 'chat' },
                { key: 'locked', label: 'Kilitli', icon: 'lock', disabled: true },
                { key: 'remove', label: 'Kaldır', icon: 'delete', destructive: true },
              ],
            }),
          )}
        />
        <Button label="Tarih seç" variant="secondary" icon="calendar" onPress={run('Tarih', () => olan.ui.datePicker({ value: '2026-10-17', mode: 'date' }))} />
        <Button label="Tarih ve saat seç" variant="secondary" icon="clock" onPress={run('Tarih-saat', () => olan.ui.datePicker({ value: '2026-10-17T09:30:00.000Z', mode: 'datetime' }))} />
        <Button label="Paylaş" variant="ghost" icon="share" onPress={run('Paylaş', () => olan.ui.share({ text: 'Saha Kiti raporu', url: 'https://olan.app' }))} />
        <Stack direction="horizontal" gap="sm" wrap>
          <Button label="Bildirim" variant="ghost" onPress={run('Bildirim', () => olan.ui.toast({ text: 'Varsayılan bildirim' }))} />
          <Button label="Başarı" variant="ghost" onPress={run('Başarı', () => olan.ui.toast({ text: 'Kaydedildi', tone: 'success' }))} />
          <Button label="Uyarı" variant="ghost" onPress={run('Uyarı', () => olan.ui.toast({ text: 'Dikkat', tone: 'warning' }))} />
          <Button label="Hata" variant="ghost" onPress={run('Hata', () => olan.ui.toast({ text: 'Bir şey ters gitti', tone: 'danger' }))} />
        </Stack>
        <Button label="Ayrıntıya git" icon="chevron-right" onPress={run('Gezinme', () => olan.navigation.push('detail', { from: 'Etkileşimler', key: 'nav' }))} />
        <Button
          label="HTTP dene"
          variant="secondary"
          onPress={run('HTTP', async () => {
            const response = await olan.http.fetch(WEATHER_URL, { headers: { accept: 'application/json' } });
            return { status: response.status, body: response.json() };
          })}
        />
      </Stack>
    </Screen>
  );
}

function DetailScreen({ from, itemKey }: { from: string; itemKey: string }) {
  const { depth } = useNavigation();
  return (
    <Screen title="Ayrıntı" subtitle={`${from} · ${itemKey}`}>
      <Stack gap="md" padding="md">
        <Text text={`Seçilen: ${itemKey}`} />
        <Text tone="muted" text={`Yığın derinliği: ${depth}`} />
        <Button label="Bir ayrıntı daha" variant="secondary" onPress={() => olan.navigation.push('detail', { from: 'Ayrıntı', key: `${itemKey}+` })} />
        <Button label="Geri dön" onPress={() => olan.navigation.pop()} />
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// Uzun liste
// ------------------------------------------------------------------------------------------

const LONG_ITEMS = Array.from({ length: LONG_LIST_SIZE }, (_, index) => {
  const n = index + 1;
  const tone: Tone = n % 15 === 0 ? 'danger' : n % 5 === 0 ? 'warning' : n % 3 === 0 ? 'success' : 'default';
  return {
    key: `row-${n}`,
    title: `Satır ${n}`,
    subtitle: `Ölçüm noktası ${((n * 37) % 97) + 1}`,
    meta: `#${n}`,
    ...(tone === 'default' ? {} : { badge: { text: tone === 'danger' ? 'Kritik' : tone === 'warning' ? 'Kontrol' : 'Tamam', tone } }),
  };
});

function LongListScreen() {
  const navigation = useNavigation();
  return (
    <Screen title="Uzun liste" subtitle={`${LONG_LIST_SIZE} satır, sanallaştırılmış`}>
      <List items={LONG_ITEMS} onSelect={({ key }) => navigation.push('detail', { from: 'Uzun liste', key: String(key) })} />
    </Screen>
  );
}


// ------------------------------------------------------------------------------------------
// Veritabanı (olan.db, Phase 1b)
// ------------------------------------------------------------------------------------------

function DatabaseScreen() {
  const list = useCollection<Note>('notes', { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 50 });
  const count = useQuery(() => notes.count());
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState('Henüz işlem yok');

  const after = async (text: string) => {
    setResult(text);
    await count.refetch();
  };
  const add = async (values: Record<string, string>) => {
    const text = (values.title ?? title).trim();
    if (!text) {
      setTitleError('Not başlığı zorunlu');
      return;
    }
    setTitleError(undefined);
    try {
      const row = await notes.insert({ title: text, done: false });
      setTitle('');
      await olan.ui.toast({ text: 'Not eklendi', tone: 'success' });
      await after(`Eklendi: ${row.data.title} (sürüm ${row.revision})`);
    } catch (error) {
      await reportError('Ekleme', error, setResult);
    }
  };
  const act = async (row: { id: string; revision: number; data: Note }, key: string) => {
    try {
      if (key === 'done') {
        const updated = await notes.update(row.id, { done: true }, { revision: row.revision });
        await after(`Tamamlandı: ${updated.data.title} (sürüm ${updated.revision})`);
      } else if (key === 'delete') {
        const sure = await olan.ui.confirm({ title: 'Not silinsin mi?', message: row.data.title, confirmLabel: 'Sil', cancelLabel: 'Vazgeç', destructive: true });
        if (!sure) return;
        await notes.delete(row.id, { revision: row.revision });
        await after(`Silindi: ${row.data.title}`);
      }
    } catch (error) {
      await reportError(key === 'done' ? 'Güncelleme' : 'Silme', error, setResult);
      await list.refetch();
    }
  };

  return (
    <Screen
      title="Veritabanı"
      subtitle="Uygulamanın kendi veritabanı (olan.db)"
      loading={list.loading}
      actions={[{ key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: async () => void (await Promise.all([list.refetch(), count.refetch()])) }]}
    >
      <Stack gap="lg" padding="md">
        <Stack direction="horizontal" gap="sm" align="center">
          <Text variant="heading" text="Notlar" />
          <Badge text={count.error ? 'sayı yok' : `${count.data ?? 0} not`} tone={count.error ? 'danger' : 'accent'} />
        </Stack>
        <Form submitLabel="Not ekle" onSubmit={({ values }) => add(values)}>
          <TextField
            name="title"
            label="Not başlığı"
            placeholder="Örn. Pano etiketlerini yenile"
            required
            value={title}
            error={titleError}
            onChange={({ value }) => {
              setTitle(value);
              if (value.trim()) setTitleError(undefined);
            }}
          />
        </Form>
        <Card title="Sonuç">
          <Text text={result} />
        </Card>
        {list.error ? (
          <EmptyState title="Notlar yüklenemedi" description={errorText(list.error)} icon="warning" action={{ label: 'Tekrar dene', onPress: () => list.refetch() }} />
        ) : list.rows.length === 0 && !list.loading ? (
          <Text tone="muted" text="Henüz not yok" />
        ) : (
          <Stack gap="sm">
            {list.rows.map((row) => (
              <Card key={row.id}>
                <Stack direction="horizontal" gap="sm" align="center" justify="between">
                  <Stack gap="xs">
                    <Text weight="medium" text={row.data.title} />
                    <Stack direction="horizontal" gap="xs" align="center">
                      <Badge text={row.data.done ? 'Tamamlandı' : 'Açık'} tone={row.data.done ? 'success' : 'default'} />
                      <Text variant="caption" tone="muted" text={`Sürüm ${row.revision}`} />
                    </Stack>
                  </Stack>
                  <Menu
                    icon="more"
                    label="Not işlemleri"
                    items={[
                      { key: 'done', label: 'Tamamlandı işaretle', icon: 'check', disabled: row.data.done === true },
                      { key: 'delete', label: 'Sil', icon: 'delete', destructive: true },
                    ]}
                    onSelect={({ key }) => act(row, String(key))}
                  />
                </Stack>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// Veri
// ------------------------------------------------------------------------------------------

/**
 * Phase 1b record writes and deletes in the surface's project (or the first visible one, see
 * `resolveRecordsProjectId`); errors surface as text and a native toast.
 */
function RecordsCard({ projectId: preferredProjectId, onChanged }: { projectId?: string; onChanged: () => Promise<unknown> }) {
  const [result, setResult] = useState('Henüz işlem yok');
  const created = useQuery(() => olan.storage.get<CreatedTask>(CREATED_TASK_KEY));
  const target = useQuery(async () => {
    const id = await resolveRecordsProjectId(preferredProjectId);
    return id ? (await olan.projects.get(id)).project : null;
  }, [preferredProjectId]);
  const withProject = (action: (projectId: string) => Promise<string | null>) => async () => {
    const projectId = await resolveRecordsProjectId(preferredProjectId);
    return projectId ? action(projectId) : 'Proje yok';
  };
  const run = (label: string, action: () => Promise<string | null>) => async () => {
    try {
      const text = await action();
      if (text !== null) setResult(`${label}: ${text}`);
    } catch (error) {
      await reportError(label, error, setResult);
    }
    await Promise.all([created.refetch(), onChanged()]);
  };
  const createTask = run('Görev oluştur', withProject(async (projectId) => {
    const task = await olan.projects.createTask(projectId, { title: `Saha Kiti görevi ${new Date().toISOString().slice(11, 19)}` });
    await olan.storage.set(CREATED_TASK_KEY, { projectId: task.projectId || projectId, taskId: task.id, title: task.title } satisfies CreatedTask);
    await olan.ui.toast({ text: `Görev oluşturuldu: ${task.title}`, tone: 'success' });
    return `${task.title}${task.key ? ` (${task.key})` : ''} · oluşturan uygulama ${task.createdByApp ?? '-'}`;
  }));
  const deleteCreatedTask = run('Oluşturduğum görevi sil', async () => {
    const mine = created.data ?? (await olan.storage.get<CreatedTask>(CREATED_TASK_KEY));
    if (!mine) return 'Önce "Görev oluştur"a dokunun';
    const task = (await olan.projects.tasks(mine.projectId)).find((candidate) => candidate.id === mine.taskId);
    const sure = await olan.ui.confirm({ title: 'Görev silinsin mi?', message: mine.title, confirmLabel: 'Sil', cancelLabel: 'Vazgeç', destructive: true });
    if (!sure) return null;
    await olan.projects.deleteTask(mine.projectId, mine.taskId, { revision: task?.revision ?? 1 });
    await olan.storage.remove(CREATED_TASK_KEY);
    await olan.ui.toast({ text: 'Görev silindi', tone: 'success' });
    return `Silindi: ${mine.title}`;
  });
  const deleteDefaultList = run('Varsayılan iş paketini sil', withProject(async (projectId) => {
    const detail = await olan.projects.get(projectId);
    const list = detail.lists.find((candidate) => candidate.isDefault);
    if (!list) return 'Varsayılan iş paketi bulunamadı';
    const sure = await olan.ui.confirm({ title: 'Varsayılan iş paketi silinsin mi?', message: `${list.name} (korunan kayıt; reddedilmeli)`, confirmLabel: 'Sil', cancelLabel: 'Vazgeç', destructive: true });
    if (!sure) return null;
    await olan.projects.deleteList(projectId, list.id, { revision: list.revision ?? 1 });
    return `Beklenmedik: ${list.name} silindi`;
  }));
  const deleteEmptyList = run('Boş iş paketini sil', withProject(async (projectId) => {
    const detail = await olan.projects.get(projectId);
    const used = new Set(detail.tasks.map((task) => task.listId));
    const list = detail.lists.find((candidate) => !candidate.isDefault && !used.has(candidate.id) && !detail.lists.some((child) => child.parentId === candidate.id));
    if (!list) return 'Boş iş paketi yok';
    const sure = await olan.ui.confirm({ title: 'İş paketi kaldırılsın mı?', message: list.name, confirmLabel: 'Kaldır', cancelLabel: 'Vazgeç', destructive: true });
    if (!sure) return null;
    await olan.projects.deleteList(projectId, list.id, { revision: list.revision ?? 1 });
    await olan.ui.toast({ text: 'İş paketi kaldırıldı', tone: 'success' });
    return `Kaldırıldı: ${list.name}`;
  }));
  const subtitle = target.data ? `${target.data.name} projesinde yazma ve silme` : target.loading ? 'Proje yükleniyor' : 'Proje yok';
  return (
    <Card title="Kayıtlar" subtitle={subtitle}>
      <Stack gap="sm">
        <Text text={result} />
        <Text variant="caption" tone="muted" text={created.data ? `Oluşturduğum görev: ${created.data.title}` : 'Oluşturduğum görev: yok'} />
        <Button label="Görev oluştur" icon="add" onPress={createTask} />
        <Button label="Oluşturduğum görevi sil" variant="danger" icon="delete" onPress={deleteCreatedTask} />
        <Button label="Varsayılan iş paketini sil" variant="danger" icon="delete" onPress={deleteDefaultList} />
        <Button label="Boş iş paketini sil" variant="secondary" icon="archive" onPress={deleteEmptyList} />
      </Stack>
    </Card>
  );
}

function DataScreen({ recordsProjectId }: { recordsProjectId?: string }) {
  const navigation = useNavigation();
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const conversations = useQuery(() => olan.chat.conversations());
  const settings = useQuery(() => olan.settings.get());
  const settingRows = Object.entries(settings.data ?? {}).map(([key, value]) => ({ key, cells: { key, value: typeof value === 'string' ? value : JSON.stringify(value) } }));
  return (
    <Screen
      title="Veri"
      subtitle="Sunucudan, uygulama token'ıyla"
      loading={projects.loading}
      actions={[
        {
          key: 'refresh',
          label: 'Yenile',
          icon: 'refresh',
          onPress: async () => {
            await Promise.all([projects.refetch(), conversations.refetch(), settings.refetch()]);
          },
        },
      ]}
    >
      <Stack gap="lg" padding="md">
        <RecordsCard projectId={recordsProjectId} onChanged={() => projects.refetch()} />
        <Text variant="heading" text="Projeler" />
        {projects.error ? (
          <EmptyState title="Projeler yüklenemedi" description={errorText(projects.error)} icon="warning" action={{ label: 'Tekrar dene', onPress: () => projects.refetch() }} />
        ) : (
          <List
            items={(projects.data?.items ?? []).map((project) => ({ key: project.id, title: project.name, subtitle: project.description || undefined, icon: 'projects' }))}
            emptyText="Proje yok"
            onSelect={({ key }) => navigation.push('project', { projectId: String(key) })}
          />
        )}
        <Text variant="heading" text="Sohbetler" />
        {conversations.error ? (
          <Text tone="danger" text={`Sohbetler yüklenemedi: ${errorText(conversations.error)}`} />
        ) : (
          <List
            items={(conversations.data ?? []).map((conversation) => ({
              key: conversation.id,
              title: conversation.title ?? 'Adsız sohbet',
              subtitle: conversation.kind === 'direct' ? 'Birebir' : 'Grup',
              icon: 'chat',
              ...(conversation.unreadCount ? { badge: { text: String(conversation.unreadCount), tone: 'accent' as Tone } } : {}),
            }))}
            emptyText="Sohbet yok"
          />
        )}
        <Text variant="heading" text="Ayarlar" />
        <Table columns={[{ key: 'key', title: 'Ayar' }, { key: 'value', title: 'Değer', align: 'end' }]} rows={settingRows} emptyText="Ayar yok" />
      </Stack>
    </Screen>
  );
}

function ProjectScreen({ projectId }: { projectId: string }) {
  const navigation = useNavigation();
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const tasks = detail.data?.tasks ?? [];
  return (
    <Screen title={detail.data?.project.name ?? 'Proje'} subtitle={`${tasks.filter(isOpen).length} açık görev`} loading={detail.loading}>
      <Stack gap="md" padding="md">
        {detail.error ? <Text tone="danger" text={errorText(detail.error)} /> : null}
        <List
          items={tasks.map((task) => ({ key: task.id, title: task.title, meta: task.due?.slice(0, 10), badge: { text: STATUS[task.status].label, tone: STATUS[task.status].tone } }))}
          emptyText="Bu projede görev yok"
          onSelect={({ key }) => navigation.push('task', { projectId, taskId: String(key) })}
        />
      </Stack>
    </Screen>
  );
}

function TaskScreen({ projectId, taskId }: { projectId: string; taskId: string }) {
  const tasks = useQuery(() => olan.projects.tasks(projectId), [projectId]);
  const task = tasks.data?.find((candidate) => candidate.id === taskId);
  if (!task) {
    return <Screen title="Görev" loading={tasks.loading}>{tasks.loading ? null : <EmptyState title="Görev bulunamadı" icon="warning" />}</Screen>;
  }
  const change = async (status: ProjectTaskStatus) => {
    if (status === 'cancelled' && !(await olan.ui.confirm({ title: 'Görev iptal edilsin mi?', confirmLabel: 'İptal et', destructive: true }))) return;
    try {
      await olan.projects.updateTask(projectId, task.id, { status, revision: task.revision });
      await olan.ui.toast({ text: `Durum: ${STATUS[status].label}`, tone: 'success' });
    } catch (error) {
      await olan.ui.toast({ text: `Güncellenemedi (${errorText(error)})`, tone: 'danger' });
    }
    await tasks.refetch();
  };
  return (
    <Screen title={task.title}>
      <Stack gap="md" padding="md">
        <Stack direction="horizontal" gap="sm" align="center">
          <Text variant="label" text="Durum" />
          <Badge text={STATUS[task.status].label} tone={STATUS[task.status].tone} />
        </Stack>
        <Text text={`Bitiş: ${task.due ?? 'yok'}`} />
        <Text tone="muted" text={`Sürüm: ${task.revision}`} />
        <Menu
          label="Durumu değiştir"
          icon="edit"
          items={STATUS_ORDER.map((status) => ({ key: status, label: STATUS[status].label, disabled: status === task.status, destructive: status === 'cancelled' }))}
          onSelect={({ key }) => change(key as ProjectTaskStatus)}
        />
      </Stack>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------
// Surfaces
// ------------------------------------------------------------------------------------------

function App({ params: surfaceParams }: SurfaceProps) {
  const { screen, params } = useNavigation();
  const surfaceProjectId = (surfaceParams as { projectId?: unknown } | null)?.projectId;
  const p = (params ?? {}) as { projectId?: string; taskId?: string; from?: string; key?: string };
  switch (screen) {
    case 'components':
      return <ComponentsScreen />;
    case 'form':
      return <FormScreen />;
    case 'interactions':
      return <InteractionsScreen />;
    case 'long':
      return <LongListScreen />;
    case 'data':
      return <DataScreen recordsProjectId={typeof surfaceProjectId === 'string' ? surfaceProjectId : undefined} />;
    case 'db':
      return <DatabaseScreen />;
    case 'detail':
      return <DetailScreen from={p.from ?? ''} itemKey={p.key ?? ''} />;
    case 'project':
      return p.projectId ? <ProjectScreen projectId={p.projectId} /> : <HomeScreen />;
    case 'task':
      return p.projectId && p.taskId ? <TaskScreen projectId={p.projectId} taskId={p.taskId} /> : <HomeScreen />;
    default:
      return <HomeScreen />;
  }
}

/** `project.widget`: the project's open task count, a status chart and a Menu. */
function SahaWidget({ params }: SurfaceProps) {
  const projectId = (params as { projectId?: string } | null)?.projectId ?? '';
  const tasks = useQuery(() => olan.projects.tasks(projectId), [projectId]);
  if (tasks.error) {
    return <EmptyState title="Görevler yüklenemedi" description={errorText(tasks.error)} icon="warning" action={{ label: 'Tekrar dene', onPress: () => tasks.refetch() }} />;
  }
  const list = tasks.data ?? [];
  const open = list.filter(isOpen).length;
  const counts = STATUS_ORDER.map((status) => ({ x: STATUS[status].label, y: list.filter((task) => task.status === status).length }));
  return (
    <Card title="Saha özeti" subtitle={tasks.loading ? undefined : `${open} açık görev`}>
      <Stack gap="sm">
        <Stack direction="horizontal" gap="sm" align="center" justify="between">
          <Text variant="title" text={String(open)} />
          <Menu
            icon="more"
            label="Seçenekler"
            items={[
              { key: 'refresh', label: 'Yenile', icon: 'refresh' },
              { key: 'share', label: 'Özeti paylaş', icon: 'share' },
              { key: 'clear', label: 'Sayacı sıfırla', icon: 'delete', destructive: true, disabled: true },
            ]}
            onSelect={async ({ key }) => {
              if (key === 'refresh') await tasks.refetch();
              if (key === 'share') await olan.ui.share({ text: `${open} açık görev` });
            }}
          />
        </Stack>
        <Chart kind="bar" height={120} series={[{ name: 'Görevler', points: counts }]} />
      </Stack>
    </Card>
  );
}

export default defineApp({ app: App, 'project.widget': SahaWidget });

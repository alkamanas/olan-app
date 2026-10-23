import { useEffect, useRef, useState } from 'react';

import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  Chart,
  defineApp,
  EmptyState,
  Image,
  isOlanError,
  isRemoteError,
  MultiSelect,
  olan,
  PROFILE_REQUIRED,
  ProgressBar,
  Screen,
  Stack,
  Stat,
  Switch,
  Table,
  Tabs,
  Text,
  TextField,
  useNavigation,
  useQuery,
  useSurfaceParams,
  type FileHandle,
  type UploadTask,
} from '@olan-app/sdk';

import {
  CAPTION_MAX,
  CHANNELS,
  MEDIA_ACCEPT,
  MEDIA_MAX_BYTES,
  STATUS_LABEL,
  TITLE_MAX,
  type Channel,
  type ConnectionState,
  type CreatedMediaItem,
  type MediaItem,
  type MediaStats,
  type Profile,
  type ValidationFailure,
} from './model';

/*
 * Medya Masası: everything lives on the app's own server and is reached with `olan.remote.request`
 * (Phase 5a). Tabs: Medya (list, sortable table, live refresh while something is processing), Yükle
 * (pick → POST /items → direct upload with progress and cancel), Analiz (Stat + Chart) and Bağlantı
 * (an external sign-in with `olan.ui.openExternal` and the return address).
 */

type TabKey = 'media' | 'upload' | 'stats' | 'connection';

/** `olan.remote.request` and the body typed (the server's shapes are in `model.ts`). */
async function request<T>(init: Parameters<typeof olan.remote.request>[0]): Promise<T> {
  const response = await olan.remote.request(init);
  return response.body as unknown as T;
}

/** A person-readable line for a failed call (`RemoteError` carries the server's body in `details`). */
function describeError(error: unknown): { tone: 'warning' | 'danger'; text: string } {
  if (isRemoteError(error, 'remote_rejected')) {
    const body = error.details as { error?: unknown; message?: unknown } | null;
    // The server needs the person's email (`profile:read`), which they did not share.
    if (body?.error === PROFILE_REQUIRED) return { tone: 'warning', text: 'Bu işlem için "Profilinizi görme" izni gerekiyor; uygulama izinlerinden açabilirsiniz' };
    return { tone: 'warning', text: typeof body?.message === 'string' ? body.message : `Sunucu isteği reddetti (${error.status})` };
  }
  if (isRemoteError(error, 'remote_unavailable')) {
    return { tone: 'danger', text: error.reason === 'timeout' ? 'Sunucu zamanında yanıt vermedi' : 'Medya sunucusuna şu anda ulaşılamıyor' };
  }
  if (isRemoteError(error, 'consent_required')) return { tone: 'warning', text: 'Uygulamayı kullanmak için izinleri onaylayın' };
  if (isRemoteError(error, 'rate_limited')) return { tone: 'warning', text: `Çok fazla istek; ${error.retryAfterSeconds ?? 60} sn sonra deneyin` };
  return { tone: 'danger', text: error instanceof Error ? error.message : 'Beklenmeyen hata' };
}

const formatBytes = (size: number) => (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);
const channelLabel = (value: string) => CHANNELS.find((channel) => channel.value === value)?.label ?? value;

function App() {
  const { screen, params } = useNavigation();
  // Permanent address `/apps/a/com.olan.examples.media-desk/item?id=…` opens on this screen.
  if (screen === 'item') return <ItemScreen id={String((params as { id?: unknown } | null)?.id ?? '')} />;
  return <Home />;
}

function Home() {
  // A return address reached without a waiting `openExternal` (the app was closed meanwhile).
  const returned = useSurfaceParams<'app'>()?.return ?? null;
  const [tab, setTab] = useState<TabKey>(returned ? 'connection' : 'media');
  const [processing, setProcessing] = useState(0);
  return (
    <Screen title="Medya Masası">
      <Tabs
        items={[
          { key: 'media', label: 'Medya', ...(processing > 0 ? { badge: processing } : {}) },
          { key: 'upload', label: 'Yükle' },
          { key: 'stats', label: 'Analiz' },
          { key: 'connection', label: 'Bağlantı' },
        ]}
        value={tab}
        onChange={({ key }) => setTab(String(key) as TabKey)}
      />
      {tab === 'media' ? <MediaTab onProcessing={setProcessing} /> : null}
      {tab === 'upload' ? <UploadTab onDone={() => setTab('media')} /> : null}
      {tab === 'stats' ? <StatsTab /> : null}
      {tab === 'connection' ? <ConnectionTab returned={returned} /> : null}
    </Screen>
  );
}

function MediaTab({ onProcessing }: { onProcessing: (count: number) => void }) {
  const navigation = useNavigation();
  const [hasProcessing, setHasProcessing] = useState(false);
  // Refreshes quietly every 10 s while something is being processed (the host runs the timer).
  const items = useQuery(() => request<{ items: MediaItem[] }>({ method: 'GET', path: '/items' }), [], {
    refetchIntervalMs: hasProcessing ? 10_000 : undefined,
  });
  const list = items.data?.items ?? [];
  const processingCount = list.filter((item) => item.status !== 'ready').length;
  useEffect(() => {
    setHasProcessing(processingCount > 0);
    onProcessing(processingCount);
  }, [processingCount, onProcessing]);

  if (items.error && !items.data) {
    const problem = describeError(items.error);
    return <Banner tone={problem.tone} title="Medya yüklenemedi" text={problem.text} action={{ label: 'Yeniden dene', onPress: () => items.refetch() }} />;
  }
  if (items.loading) return <Text text="Yükleniyor…" tone="muted" />;
  if (list.length === 0) return <EmptyState title="Henüz medya yok" description="Yükle sekmesinden görsel ya da video ekleyin." icon="photo-library" />;

  const ready = list.filter((item) => item.status === 'ready' && item.mediaUrl);
  return (
    <Stack gap="md">
      {items.error ? <Banner tone="warning" text={describeError(items.error).text} /> : null}
      {processingCount > 0 ? <Text text={`${processingCount} dosya işleniyor; liste kendiliğinden yenilenir.`} tone="muted" variant="caption" /> : null}
      <Table
        columns={[
          { key: 'title', title: 'Başlık', width: 3, sortable: true },
          { key: 'status', title: 'Durum', width: 2 },
          { key: 'views', title: 'Görüntülenme', format: 'number', align: 'end', sortable: true },
          { key: 'spend', title: 'Harcama', format: 'currency', currency: 'TRY', align: 'end', sortable: true },
          { key: 'engagement', title: 'Etkileşim', format: 'percent', align: 'end', sortable: true },
        ]}
        rows={list.map((item) => ({
          key: item.id,
          cells: { title: item.title, status: STATUS_LABEL[item.status], views: item.views, spend: item.spend, engagement: item.engagement },
        }))}
        defaultSort={{ key: 'views', direction: 'desc' }}
        onSelectRow={({ key }) => navigation.push('item', { id: String(key) })}
      />
      {ready.slice(0, 6).map((item) => (
        <Card key={item.id} title={item.title} subtitle={item.channels.map(channelLabel).join(', ')}>
          <Image src={item.mediaUrl!} alt={item.title} aspectRatio={16 / 9} fit="cover" />
          <Stack direction="horizontal" gap="sm" align="center">
            <Avatar name={item.ownerName} size="sm" />
            <Text text={item.ownerName} variant="caption" tone="muted" />
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

function ItemScreen({ id }: { id: string }) {
  const navigation = useNavigation();
  const item = useQuery(() => request<{ item: MediaItem }>({ method: 'GET', path: `/items/${encodeURIComponent(id)}` }), [id]);
  const media = item.data?.item;

  const remove = async () => {
    if (!media) return;
    const ok = await olan.ui.confirm({ title: 'Medya silinsin mi?', message: media.title, confirmLabel: 'Sil', destructive: true });
    if (!ok) return;
    try {
      await olan.remote.request({ method: 'DELETE', path: `/items/${encodeURIComponent(media.id)}` });
      await olan.ui.toast({ text: 'Silindi', tone: 'success' });
      navigation.pop();
    } catch (error) {
      await olan.ui.toast({ text: describeError(error).text, tone: 'danger' });
    }
  };

  if (item.error) {
    const problem = describeError(item.error);
    return (
      <Screen title="Medya">
        <Banner tone={problem.tone} text={problem.text} />
      </Screen>
    );
  }
  if (!media) return <Screen title="Medya" loading />;
  return (
    <Screen title={media.title} subtitle={STATUS_LABEL[media.status]}>
      <Stack gap="md">
        {media.mediaUrl && media.status === 'ready' ? <Image src={media.mediaUrl} alt={media.title} aspectRatio={1} fit="contain" /> : <ProgressBar label={STATUS_LABEL[media.status]} />}
        <Stack direction="horizontal" gap="sm" align="center">
          <Avatar name={media.ownerName} />
          <Text text={media.ownerName} weight="medium" />
        </Stack>
        {media.caption ? <Text text={media.caption} /> : null}
        <Stack direction="horizontal" gap="sm" wrap>
          {media.channels.map((channel) => (
            <Badge key={channel} text={channelLabel(channel)} />
          ))}
        </Stack>
        <Stat label="Görüntülenme" value={media.views} caption={`${media.fileName} · ${formatBytes(media.size)}`} />
        {media.mediaUrl ? <Button label="Sunucuda aç" variant="secondary" onPress={() => olan.ui.openUrl(media.mediaUrl!)} /> : null}
        <Button label="Sil" variant="danger" onPress={remove} />
      </Stack>
    </Screen>
  );
}

interface UploadState {
  fileName: string;
  loaded: number;
  total: number;
}

function UploadTab({ onDone }: { onDone: () => void }) {
  const [files, setFiles] = useState<FileHandle[]>([]);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [channels, setChannels] = useState<Channel[]>(['instagram']);
  const [publishNow, setPublishNow] = useState(false);
  const [issues, setIssues] = useState<ValidationFailure['issues']>({});
  const [progress, setProgress] = useState<UploadState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const task = useRef<UploadTask | null>(null);
  const cancelled = useRef(false);

  const pick = async () => {
    const picked = await olan.files.pick({ accept: MEDIA_ACCEPT, multiple: true, maxFiles: 5, maxBytes: MEDIA_MAX_BYTES });
    if (picked.length > 0) {
      setFiles(picked);
      if (!title) setTitle(picked[0]!.name.replace(/\.[^.]+$/, ''));
    }
  };

  const uploadAll = async () => {
    setProblem(null);
    setIssues({});
    cancelled.current = false;
    let done = 0;
    for (const file of files) {
      let created: CreatedMediaItem;
      try {
        created = await request<CreatedMediaItem>({
          method: 'POST',
          path: '/items',
          body: { title: files.length > 1 ? `${title} (${done + 1})` : title, caption, channels, publishNow, fileName: file.name, type: file.type, size: file.size },
        });
      } catch (error) {
        if (isRemoteError(error, 'remote_rejected') && (error.details as { error?: unknown } | null)?.error === 'validation_failed') {
          setIssues((error.details as unknown as ValidationFailure).issues);
        } else setProblem(describeError(error).text);
        return;
      }
      setProgress({ fileName: file.name, loaded: 0, total: file.size });
      task.current = olan.files.upload(file, {
        url: created.upload.url,
        method: created.upload.method,
        onProgress: ({ loaded, total }) => setProgress({ fileName: file.name, loaded, total }),
      });
      try {
        const result = await task.current;
        if (result.status >= 300) {
          setProblem(`Yükleme başarısız (${result.status})`);
          return;
        }
        done += 1;
      } catch (error) {
        // Cancelled or failed: remove the item that waits for this file.
        await olan.remote.request({ method: 'DELETE', path: `/items/${encodeURIComponent(created.item.id)}` }).catch(() => undefined);
        if (isOlanError(error, 'cancelled') || cancelled.current) await olan.ui.toast({ text: 'Yükleme iptal edildi', tone: 'warning' });
        else setProblem(isOlanError(error, 'upload_failed') ? 'Bağlantı koptu; yükleme tamamlanmadı' : describeError(error).text);
        return;
      } finally {
        task.current = null;
        setProgress(null);
      }
    }
    await olan.ui.toast({ text: done === 1 ? 'Medya yüklendi' : `${done} medya yüklendi`, tone: 'success' });
    setFiles([]);
    setTitle('');
    setCaption('');
    onDone();
  };

  const cancel = async () => {
    cancelled.current = true;
    await task.current?.cancel();
  };

  return (
    <Stack gap="md">
      {problem ? <Banner tone="danger" title="Yüklenemedi" text={problem} onDismiss={() => setProblem(null)} /> : null}
      <Button label={files.length > 0 ? 'Başka dosya seç' : 'Dosya seç'} icon="photo" variant="secondary" onPress={pick} disabled={progress !== null} />
      {files.length > 0 ? <Text text={files.map((file) => `${file.name} (${formatBytes(file.size)})`).join(', ')} variant="caption" /> : null}
      {issues.file ? <Text text={issues.file} tone="danger" variant="caption" /> : null}
      <TextField name="title" label="Başlık" value={title} maxLength={TITLE_MAX} required error={issues.title} onChange={({ value }) => setTitle(value)} />
      <TextField name="caption" label="Açıklama" value={caption} multiline maxLength={CAPTION_MAX} error={issues.caption} onChange={({ value }) => setCaption(value)} />
      <MultiSelect
        label="Kanallar"
        value={channels}
        options={CHANNELS.map((channel) => ({ value: channel.value, label: channel.label }))}
        placeholder="Kanal seçin"
        max={3}
        onChange={({ value }) => setChannels(value as Channel[])}
      />
      {issues.channels ? <Text text={issues.channels} tone="danger" variant="caption" /> : null}
      <Switch label="Hemen yayınla" description="Kapalıysa taslak olarak kaydedilir" value={publishNow} onChange={({ value }) => setPublishNow(value)} />
      {progress ? (
        <Card title="Yükleniyor">
          <ProgressBar value={progress.total > 0 ? progress.loaded / progress.total : undefined} label={`${progress.fileName} · %${progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0}`} />
          <Button label="İptal" variant="ghost" onPress={cancel} />
        </Card>
      ) : (
        <Button label="Yüklemeyi başlat" variant="primary" onPress={uploadAll} disabled={files.length === 0} />
      )}
    </Stack>
  );
}

function StatsTab() {
  const stats = useQuery(() => request<MediaStats>({ method: 'GET', path: '/stats' }), []);
  if (stats.error) {
    const problem = describeError(stats.error);
    return <Banner tone={problem.tone} text={problem.text} action={{ label: 'Yeniden dene', onPress: () => stats.refetch() }} />;
  }
  const data = stats.data;
  if (!data) return <Text text="Yükleniyor…" tone="muted" />;
  return (
    <Stack gap="md">
      <Stack direction="horizontal" gap="md" wrap>
        <Stat label="Görüntülenme" value={data.views} delta={data.delta.views} caption="Son 7 gün" />
        <Stat label="Harcama" value={data.spend} format="currency" currency="TRY" delta={data.delta.spend} deltaGood="down" caption="Son 7 gün" />
        <Stat label="Etkileşim oranı" value={data.engagement} format="percent" delta={data.delta.engagement} />
      </Stack>
      <Card title="Günlük harcama">
        <Chart
          kind="area"
          stacked
          valueFormat="currency"
          currency="TRY"
          series={[
            { name: 'Organik', points: data.days.map((day) => ({ x: day.day.slice(5), y: day.organic })) },
            { name: 'Ücretli', points: data.days.map((day) => ({ x: day.day.slice(5), y: day.paid })) },
          ]}
        />
      </Card>
      <Card title="Etkileşim">
        <Chart kind="line" valueFormat="percent" series={[{ name: 'Etkileşim', points: data.days.map((day) => ({ x: day.day.slice(5), y: day.engagement })) }]} />
      </Card>
    </Stack>
  );
}

function ConnectionTab({ returned }: { returned: Record<string, string> | null }) {
  const connection = useQuery(() => request<ConnectionState>({ method: 'GET', path: '/connections' }), []);
  const profile = useQuery(() => request<Profile>({ method: 'GET', path: '/me' }), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const handledReturn = useRef(false);

  /** Sends the return address's parameters to the server, which checks its `state`. */
  const complete = async (params: Record<string, string>) => {
    try {
      const answer = await request<{ connection: { account: string } }>({ method: 'POST', path: '/connections/complete', body: params });
      setNotice({ tone: 'success', text: `${answer.connection.account} bağlandı` });
      await connection.refetch();
    } catch (error) {
      setNotice({ tone: 'warning', text: describeError(error).text });
    }
  };

  useEffect(() => {
    if (returned?.state && !handledReturn.current) {
      handledReturn.current = true;
      void complete(returned);
    }
    // Runs once for the parameters the surface was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned]);

  const connect = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const start = await request<{ authorizeUrl: string; state: string }>({ method: 'POST', path: '/connections/start' });
      const result = await olan.ui.openExternal(start.authorizeUrl, { expectReturn: true });
      if (result.returned) await complete(result.params);
      else setNotice({ tone: 'warning', text: 'Bağlantı tamamlanmadı' });
    } catch (error) {
      setNotice({ tone: 'danger', text: describeError(error).text });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await olan.remote.request({ method: 'DELETE', path: '/connections' });
    setNotice(null);
    await connection.refetch();
  };

  const me = profile.data;
  const state = connection.data;
  return (
    <Stack gap="md">
      {notice ? <Banner tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} /> : null}
      {connection.error ? <Banner tone={describeError(connection.error).tone} text={describeError(connection.error).text} /> : null}
      {me ? (
        <Card title="Sunucunun gördüğü profil">
          <Stack direction="horizontal" gap="sm" align="center">
            <Avatar name={me.displayName ?? 'Olan kullanıcısı'} size="lg" />
            <Stack gap="xs">
              <Text text={me.displayName ?? 'Ad paylaşılmadı'} weight="semibold" />
              <Text text={me.email ?? 'E-posta paylaşılmadı'} variant="caption" tone="muted" />
            </Stack>
            {me.role ? <Badge text={me.role === 'admin' ? 'Yönetici' : 'Üye'} tone={me.role === 'admin' ? 'accent' : 'default'} /> : null}
          </Stack>
        </Card>
      ) : null}
      <Card title="Sosyal hesap">
        {state?.connection ? (
          <Stack gap="sm">
            <Text text={`Bağlı: ${state.connection.account}`} />
            <Button label="Bağlantıyı kaldır" variant="danger" onPress={disconnect} />
          </Stack>
        ) : (
          <Stack gap="sm">
            <Text text="Hesabınızı bağladığınızda yüklemeler doğrudan yayınlanabilir." tone="muted" />
            <Button label="Hesap bağla" variant="primary" loading={busy} onPress={connect} />
          </Stack>
        )}
      </Card>
      {state ? <Button label="Sunucuda aç" variant="ghost" onPress={() => olan.ui.openUrl(state.webUrl)} /> : null}
    </Stack>
  );
}

export default defineApp({ app: App });

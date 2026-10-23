import { useRef, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  defineApp,
  isOlanError,
  isRemoteError,
  List,
  olan,
  ProgressBar,
  Screen,
  Stack,
  Text,
  TextField,
  useQuery,
  type UploadTask,
} from '@olan-app/sdk';

/*
 * {{appName}}: the data lives on the app's own server (app-server/, manifest `remote`), reached with
 * `olan.remote.request`. "Dosya ekle" picks a file, asks the server for a one-time upload address
 * (POST /items) and uploads straight to it with progress and cancel.
 */

/** The app server's shapes (app-server/routes.ts). */
interface Item {
  id: string;
  title: string;
  status: 'awaiting_upload' | 'ready';
  fileName: string | null;
  size: number | null;
}
interface Created {
  item: Item;
  upload: { url: string; method: 'PUT' };
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

async function request<T>(init: Parameters<typeof olan.remote.request>[0]): Promise<T> {
  return (await olan.remote.request(init)).body as unknown as T;
}

/** A readable line for a failed call: the server's 4xx body is in `RemoteError.details`. */
function describeError(error: unknown): string {
  if (isRemoteError(error, 'remote_rejected')) {
    const body = error.details as { message?: unknown; issues?: { title?: unknown } } | null;
    if (typeof body?.issues?.title === 'string') return body.issues.title;
    return typeof body?.message === 'string' ? body.message : `Sunucu isteği reddetti (${error.status})`;
  }
  if (isRemoteError(error, 'remote_unavailable')) return error.reason === 'timeout' ? 'Sunucu zamanında yanıt vermedi' : 'Uygulama sunucusuna ulaşılamıyor';
  if (isRemoteError(error, 'permission_denied')) return 'Uygulama sunucusuna erişim kapalı';
  return error instanceof Error ? error.message : 'Beklenmeyen hata';
}

const formatBytes = (size: number) => (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);

function Home() {
  const items = useQuery(() => request<{ items: Item[] }>({ method: 'GET', path: '/items' }), []);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ name: string; loaded: number; total: number } | null>(null);
  const task = useRef<UploadTask | null>(null);

  const add = async () => {
    setProblem(null);
    const [file] = await olan.files.pick({ accept: ['image/*', 'application/pdf'], maxBytes: MAX_UPLOAD_BYTES });
    if (!file) return; // the person cancelled
    let created: Created;
    try {
      created = await request<Created>({ method: 'POST', path: '/items', body: { title: title.trim() || file.name, size: file.size } });
    } catch (error) {
      setProblem(describeError(error));
      return;
    }
    setProgress({ name: file.name, loaded: 0, total: file.size });
    task.current = olan.files.upload(file, {
      url: created.upload.url,
      method: created.upload.method,
      onProgress: ({ loaded, total }) => setProgress({ name: file.name, loaded, total }),
    });
    try {
      const result = await task.current;
      if (result.status >= 300) setProblem(`Yükleme reddedildi (${result.status})`);
      else {
        await olan.ui.toast({ text: 'Dosya yüklendi', tone: 'success' });
        setTitle('');
      }
    } catch (error) {
      // Cancelled or failed: remove the item that waited for the file.
      await olan.remote.request({ method: 'DELETE', path: `/items/${encodeURIComponent(created.item.id)}` }).catch(() => undefined);
      if (isOlanError(error, 'cancelled')) await olan.ui.toast({ text: 'Yükleme iptal edildi', tone: 'warning' });
      else setProblem(isOlanError(error, 'upload_failed') ? 'Bağlantı koptu; yükleme tamamlanmadı' : describeError(error));
    } finally {
      task.current = null;
      setProgress(null);
      items.refetch();
    }
  };

  const list = items.data?.items ?? [];
  return (
    <Screen title="{{appName}}">
      <Stack gap="md">
        {items.error && !items.data ? (
          <Banner tone="danger" title="Kayıtlar yüklenemedi" text={describeError(items.error)} action={{ label: 'Yeniden dene', onPress: () => items.refetch() }} />
        ) : null}
        {problem ? <Banner tone="warning" title="Eklenemedi" text={problem} onDismiss={() => setProblem(null)} /> : null}
        <List
          items={list.map((item) => ({
            key: item.id,
            title: item.title,
            ...(item.fileName ? { subtitle: `${item.fileName}${item.size !== null ? ` · ${formatBytes(item.size)}` : ''}` } : {}),
            badge: item.status === 'ready' ? { text: 'Hazır', tone: 'success' as const } : { text: 'Yükleme bekliyor', tone: 'warning' as const },
          }))}
          loading={items.loading && !items.data}
          emptyText="Henüz kayıt yok"
        />
        <TextField name="title" label="Başlık" value={title} maxLength={120} onChange={({ value }) => setTitle(value)} />
        {progress ? (
          <Card title="Yükleniyor">
            <ProgressBar value={progress.total > 0 ? progress.loaded / progress.total : undefined} label={`${progress.name} · %${progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0}`} />
            <Text text="Dosya doğrudan uygulama sunucusuna gidiyor." tone="muted" variant="caption" />
            <Button label="İptal" variant="ghost" onPress={() => void task.current?.cancel()} />
          </Card>
        ) : (
          <Button label="Dosya ekle" variant="primary" icon="add" onPress={add} />
        )}
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Home });

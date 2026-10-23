import { useState } from 'react';

import { Badge, Button, Card, EmptyState, List, Screen, Stack, Text, defineApp, isOlanError, olan, useQuery, type Tone } from '@olan-app/sdk';

// Types only: the backend code itself never enters the UI bundle.
import type { RecordKind, Summary } from '../server/index';

const TITLE = 'Operasyon Kutusu';

const KIND_LABEL: Record<RecordKind, string> = { task: 'Görev', push: 'Push', digest: 'Özet' };
const KIND_TONE: Record<RecordKind, Tone> = { task: 'accent', push: 'warning', digest: 'success' };

/** A readable message for `olan.backend.call` failures (docs/backend.md, error codes). */
function backendMessage(error: unknown): string {
  // Also the Studio preview: it has no installation, so it cannot run the backend.
  if (isOlanError(error, 'backend_unavailable')) {
    return 'Backend burada çalışmıyor. Studio önizlemesinin kurulumu olmadığı için backend çağrıları yapılamaz; backend’i çalıştırmak için uygulamayı kurun ya da olan-app dev kullanın.';
  }
  if (isOlanError(error, 'backend_limit')) return 'Backend zaman ya da bellek sınırına takıldı.';
  if (isOlanError(error, 'backend_busy')) return 'Backend meşgul, birazdan tekrar deneyin.';
  if (isOlanError(error, 'backend_function_not_found')) return 'Backend fonksiyonu bulunamadı.';
  return error instanceof Error ? error.message : String(error);
}

function Inbox() {
  const summary = useQuery(() => olan.backend.call<Summary>('summary'), []);
  const [busy, setBusy] = useState(false);

  const digestNow = async () => {
    setBusy(true);
    try {
      const result = await olan.backend.call<{ tasks: number; pushes: number }>('digestNow');
      await olan.ui.toast({ text: `Özet yazıldı: ${result.tasks} görev, ${result.pushes} push`, tone: 'success' });
      summary.refetch();
    } catch (error) {
      await olan.ui.toast({ text: backendMessage(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (summary.error) {
    return (
      <Screen title={TITLE}>
        <EmptyState title="Backend yanıt vermedi" description={backendMessage(summary.error)} action={{ label: 'Tekrar dene', onPress: () => summary.refetch() }} />
      </Screen>
    );
  }

  const data = summary.data;
  return (
    <Screen title={TITLE} subtitle="Görevler, GitHub push'ları ve 5 dakikalık özetler" loading={summary.loading} actions={[{ key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: () => summary.refetch() }]}>
      <Stack gap="md" padding="md">
        <Card title="Bugünkü kutu">
          <Stack direction="horizontal" gap="sm" wrap>
            <Badge text={`${data?.counts.task ?? 0} görev`} tone="accent" />
            <Badge text={`${data?.counts.push ?? 0} push`} tone="warning" />
            <Badge text={`${data?.counts.digest ?? 0} özet`} tone="success" />
          </Stack>
          <Text text={data?.apiConfigured ? 'Operasyon API anahtarı ayarlı: özetler gönderiliyor.' : 'Operasyon API anahtarı ayarlı değil: özetler yalnız burada.'} tone="muted" variant="caption" />
        </Card>
        <List
          items={(data?.latest ?? []).map((record) => ({
            key: record.id,
            title: record.title,
            meta: record.at.slice(11, 16),
            badge: { text: KIND_LABEL[record.kind], tone: KIND_TONE[record.kind] },
          }))}
          emptyText="Henüz kayıt yok: proje görevleri ve GitHub push'ları burada görünür."
          loading={summary.loading}
        />
        <Button label="Özet oluştur" variant="primary" loading={busy} onPress={digestNow} />
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Inbox });

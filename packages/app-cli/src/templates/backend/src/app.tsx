import { Button, EmptyState, List, Screen, Stack, Text, defineApp, olan, useQuery } from '@olan-app/sdk';

/** What the backend's `summary` function returns (server/index.ts). */
interface Summary {
  count: number;
  latest: { id: string; text: string; source: string }[];
  configured: boolean;
}

const TITLE = '{{appName}}';

function Home() {
  const summary = useQuery(() => olan.backend.call<Summary>('summary'), []);
  const add = async () => {
    await olan.backend.call('addNote', { text: `Not ${new Date().toISOString().slice(11, 19)}` });
    await olan.ui.toast({ text: 'Not eklendi', tone: 'success' });
    summary.refetch();
  };
  if (summary.error) {
    return (
      <Screen title={TITLE}>
        <EmptyState title="Sunucu yanıt vermedi" description={summary.error.message} action={{ label: 'Tekrar dene', onPress: () => summary.refetch() }} />
      </Screen>
    );
  }
  const data = summary.data;
  return (
    <Screen title={TITLE} loading={summary.loading}>
      <Stack gap="md" padding="md">
        <Text text={data ? `${data.count} not` : 'Yükleniyor…'} variant="heading" />
        <Text text={data?.configured ? 'API anahtarı ayarlı' : 'API anahtarı ayarlı değil'} tone="muted" />
        <List items={(data?.latest ?? []).map((note) => ({ key: note.id, title: note.text, meta: note.source }))} emptyText="Henüz not yok" />
        <Button label="Not ekle" variant="primary" onPress={add} />
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Home });

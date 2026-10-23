import { EmptyState, List, Screen, defineApp, olan, useQuery, type Tone } from '@olan-app/sdk';

const TITLE = '{{appName}}';
/** Every host the app calls must be listed as "http:<host>" in olan-app.json permissions. */
export const STATUS_URL = 'https://status.example.com/api/services.json';

interface Service {
  id: string;
  name: string;
  status: 'up' | 'degraded' | 'down';
}

const TONES: Record<Service['status'], { text: string; tone: Tone }> = {
  up: { text: 'Çalışıyor', tone: 'success' },
  degraded: { text: 'Yavaş', tone: 'warning' },
  down: { text: 'Kapalı', tone: 'danger' },
};

/** The sandbox has no fetch(); olan.http.fetch goes through the Olan host (and its proxy). */
async function loadServices(): Promise<Service[]> {
  const response = await olan.http.fetch(STATUS_URL, { headers: { accept: 'application/json' } });
  if (response.status !== 200) throw new Error(`The status API answered ${response.status}`);
  return response.json<{ services: Service[] }>().services;
}

function Services() {
  const services = useQuery(loadServices);
  return (
    <Screen title={TITLE} loading={services.loading} actions={[{ key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: () => services.refetch() }]}>
      {services.error ? (
        <EmptyState title="Durum alınamadı" description={services.error.message} action={{ label: 'Tekrar dene', onPress: () => services.refetch() }} />
      ) : (
        <List
          emptyText="Servis yok"
          items={(services.data ?? []).map((service) => ({ key: service.id, title: service.name, badge: TONES[service.status] }))}
        />
      )}
    </Screen>
  );
}

export default defineApp({ app: Services });

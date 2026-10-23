import { useState } from 'react';
import { Card, Chart, EmptyState, Screen, Select, Stack, Table, Text, defineApp, olan, useQuery } from '@olan-app/sdk';

/**
 * Döviz kurları: latest rates (Table) and the last days of one pair (Chart) from an external API
 * through `olan.http.fetch`. The sandbox has no network; Olan forwards the request only because
 * `http:rates.example.com` is in the manifest permissions. The user's base currency lives in
 * `olan.storage` and is chosen on the `settings` surface.
 */

export const API = 'https://rates.example.com/v1';
export const CURRENCIES = [
  { value: 'USD', label: 'ABD doları (USD)' },
  { value: 'EUR', label: 'Euro (EUR)' },
  { value: 'GBP', label: 'İngiliz sterlini (GBP)' },
  { value: 'TRY', label: 'Türk lirası (TRY)' },
];
const DEFAULT_BASE = 'USD';
const STORAGE_KEY = 'currency';
const HISTORY_DAYS = 5;

interface Latest {
  base: string;
  date: string;
  rates: Record<string, number>;
}

interface History {
  base: string;
  symbol: string;
  points: { date: string; rate: number }[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await olan.http.fetch(url, { headers: { accept: 'application/json' } });
  if (response.status !== 200) throw new Error(`Kur servisi ${response.status} döndü`);
  return response.json<T>();
}

/** The saved base currency, or USD. */
async function loadBase(): Promise<string> {
  const saved = await olan.storage.get<string>(STORAGE_KEY);
  return typeof saved === 'string' && CURRENCIES.some((currency) => currency.value === saved) ? saved : DEFAULT_BASE;
}

const defaultSymbol = (base: string) => (base === 'TRY' ? 'USD' : 'TRY');

/** The `app` surface. */
function Rates() {
  const base = useQuery(loadBase);
  const [chosenSymbol, setChosenSymbol] = useState<string | null>(null);
  const baseCode = base.data;
  const symbol = chosenSymbol && chosenSymbol !== baseCode ? chosenSymbol : defaultSymbol(baseCode ?? DEFAULT_BASE);

  const latest = useQuery(() => (baseCode ? getJson<Latest>(`${API}/latest?base=${baseCode}`) : Promise.resolve(null)), [baseCode]);
  const history = useQuery(
    () => (baseCode ? getJson<History>(`${API}/history?base=${baseCode}&symbol=${symbol}&days=${HISTORY_DAYS}`) : Promise.resolve(null)),
    [baseCode, symbol],
  );

  const error = base.error ?? latest.error;
  if (error) {
    return (
      <Screen title="Döviz kurları">
        <EmptyState
          title="Kurlar alınamadı"
          description={error.message}
          icon="warning"
          action={{ label: 'Tekrar dene', onPress: () => (base.error ? base.refetch() : latest.refetch()) }}
        />
      </Screen>
    );
  }

  const rows = Object.entries(latest.data?.rates ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, rate]) => ({ key: code, cells: { code, rate: rate.toFixed(4) } }));

  return (
    <Screen
      title="Döviz kurları"
      subtitle={latest.data ? `1 ${latest.data.base} · ${latest.data.date}` : undefined}
      loading={base.loading || latest.loading}
      actions={[{ key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: () => Promise.all([latest.refetch(), history.refetch()]) }]}
    >
      <Stack gap="md" padding="md">
        <Table
          columns={[
            { key: 'code', title: 'Para birimi' },
            { key: 'rate', title: 'Kur', align: 'end' },
          ]}
          rows={rows}
          emptyText="Kur yok"
        />
        <Card title={`${baseCode ?? DEFAULT_BASE} → ${symbol}`} subtitle={`Son ${HISTORY_DAYS} gün`}>
          <Stack gap="sm">
            <Select
              name="symbol"
              label="Grafik"
              value={symbol}
              options={CURRENCIES.filter((currency) => currency.value !== baseCode)}
              onChange={({ value }) => setChosenSymbol(value)}
            />
            {history.error ? (
              <Text tone="danger" text={history.error.message} />
            ) : (
              <Chart
                kind="line"
                height={180}
                series={[{ name: `${baseCode ?? DEFAULT_BASE}/${symbol}`, points: (history.data?.points ?? []).map((point) => ({ x: point.date.slice(5), y: point.rate })) }]}
              />
            )}
          </Stack>
        </Card>
      </Stack>
    </Screen>
  );
}

/** The `settings` surface (Olan → Ayarlar → Uygulamalar): the user's base currency. */
function CurrencySettings() {
  const base = useQuery(loadBase);
  const [saving, setSaving] = useState(false);
  const save = async (value: string) => {
    setSaving(true);
    try {
      await olan.storage.set(STORAGE_KEY, value);
      await olan.ui.toast({ text: `Para birimi kaydedildi: ${value}`, tone: 'success' });
      await base.refetch();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Screen title="Para birimi" loading={base.loading || saving}>
      <Stack gap="md" padding="md">
        <Select name="currency" label="Para birimi" value={base.data ?? null} options={CURRENCIES} onChange={({ value }) => save(value)} />
        <Text tone="muted" text="Kurlar bu para birimine göre gösterilir." />
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Rates, settings: CurrencySettings });

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

// Responses come from fixtures/http.json; the mock host never touches the network.
const LATEST_USD = 'https://rates.example.com/v1/latest?base=USD';

test('shows the latest rates in a table and the USD/TRY chart', async () => {
  const app = await renderApp();
  app.expectText('1 USD · 2026-10-16');
  assert.deepEqual(app.find('Table')[0]?.props.rows, [
    { key: 'EUR', cells: { code: 'EUR', rate: '0.9214' } },
    { key: 'GBP', cells: { code: 'GBP', rate: '0.7702' } },
    { key: 'TRY', cells: { code: 'TRY', rate: '34.2875' } },
  ]);
  const chart = app.find('Chart')[0]!;
  assert.equal(chart.props.kind, 'line');
  assert.deepEqual(chart.props.series, [
    {
      name: 'USD/TRY',
      points: [
        { x: '10-12', y: 34.1012 },
        { x: '10-13', y: 34.153 },
        { x: '10-14', y: 34.2104 },
        { x: '10-15', y: 34.2466 },
        { x: '10-16', y: 34.2875 },
      ],
    },
  ]);
  assert.deepEqual(
    app.calls('http.fetch').map((call) => (call.params as { url: string }).url),
    [LATEST_USD, 'https://rates.example.com/v1/history?base=USD&symbol=TRY&days=5'],
  );
  await app.dispose();
});

test('the chart Select switches the pair', async () => {
  const app = await renderApp();
  await app.select('Grafik', 'EUR');
  app.expectText('USD → EUR');
  assert.equal((app.find('Chart')[0]!.props.series as { name: string }[])[0]!.name, 'USD/EUR');
  await app.dispose();
});

test('uses the base currency saved in storage', async () => {
  const app = await renderApp({ fixtures: { storage: { currency: 'EUR' } } });
  app.expectText('1 EUR · 2026-10-16');
  app.expectText('EUR → TRY');
  app.expectText('37.2131');
  await app.dispose();
});

test('the settings surface saves the currency with a Select', async () => {
  const app = await renderApp({ surface: 'settings' });
  app.expectText('ABD doları (USD)');
  await app.select('Para birimi', 'EUR');
  assert.deepEqual(app.host.data.storage, { currency: 'EUR' });
  assert.deepEqual(app.toasts(), [{ text: 'Para birimi kaydedildi: EUR', tone: 'success' }]);
  app.expectText('Euro (EUR)');
  await app.dispose();
});

test('shows an error and retries when the API fails', async () => {
  const app = await renderApp({ fixtures: { http: { [LATEST_USD]: { status: 503, body: 'bakımda' } } } });
  app.expectText('Kurlar alınamadı');
  app.expectText('Kur servisi 503 döndü');
  app.host.data.http[LATEST_USD] = { status: 200, json: { base: 'USD', date: '2026-10-17', rates: { TRY: 34.3 } } };
  await app.press('Tekrar dene');
  app.expectText('1 USD · 2026-10-17');
  await app.dispose();
});

test('without the http: permission the request is blocked', async () => {
  const app = await renderApp({ permissions: ['storage'] });
  assert.equal(app.calls('http.fetch')[0]?.error?.code, 'http_blocked');
  app.expectText('Kurlar alınamadı');
  await app.dispose();
});

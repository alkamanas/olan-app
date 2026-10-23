# Döviz kurları (exchange rates)

Example Olan App (`com.olan.examples.exchange-rates`) that reads an external JSON API through
`olan.http.fetch`: the latest rates in a `Table` and the last five days of one pair in a `Chart`,
with a custom `settings` surface where the user picks the base currency with a `Select`.

- Surfaces: `app` and `settings` (Olan shows the `settings` surface in Ayarlar → Uygulamalar
  instead of a generated form).
- Permissions: `http:rates.example.com` (the only host the app may reach) and `storage` (the
  chosen currency, per user).
- API: `https://rates.example.com/v1/latest?base=USD` and
  `https://rates.example.com/v1/history?base=USD&symbol=TRY&days=5`. `rates.example.com` is a
  placeholder: the responses live in `fixtures/http.json`. Point `API` in `src/app.tsx` and the
  permission at a real service before publishing.
- Tests cover the table and chart, switching the chart pair, the stored base currency, the
  settings surface, an API failure with retry, and the blocked request without the permission.

```sh
npm install                       # installs @olan-app/sdk and @olan-app/cli from npm
npx olan-app validate --strict    # renders app and settings with fixtures/http.json
npx olan-app test
npx olan-app pack --dev-sign      # dist/com.olan.examples.exchange-rates-0.1.0.olanapp, signed with your development key
```


A local Olan installs the package only if its Platform API trusts your development key: run
`npx olan-app keygen --dev` once and add the printed `OLAN_APPS_TRUSTED_KEYS=dev-local=<key>` line
to the API environment (then restart it). A plain `npx olan-app pack` is unsigned: it can be
uploaded and is listed as "İmzasız", but it cannot be installed. Production servers trust only the
Olan Marketplace key.

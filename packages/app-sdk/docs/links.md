# External links, sign-in flows and app addresses

SDK 1.5 (`olan.ui.openUrl`, `olan.ui.openExternal`, permanent app addresses). No permission is
needed.

## `olan.ui.openUrl(url)`

Opens a page in the platform browser and resolves at once: a new tab on the web, the default
browser on desktop, the system browser on iOS and Android.

```ts
await olan.ui.openUrl('https://media.example.com/items/7');
```

## `olan.ui.openExternal(url, { expectReturn? })`

For flows that come back to the app: connecting an account, OAuth of another service, a payment
page. It opens the system browser, never an embedded web view: a new tab on the web, the default
browser on desktop, `ASWebAuthenticationSession` on iOS, Custom Tabs on Android.

```ts
const result = await olan.ui.openExternal(authorizeUrl, { expectReturn: true });
if (result.returned) {
  // result.params: the return address's query, e.g. { state: 'st_91', connection: 'connected' }
  await olan.remote.request({ method: 'POST', path: '/connections/complete', body: result.params });
}
```

- Result: `{ returned: true, params: Record<string, string> }` or `{ returned: false }`.
- `expectReturn` defaults to `false`: the call resolves `{ returned: false }` as soon as the page opens.
- With `expectReturn: true` it resolves when the flow reaches the app's return address, or
  `{ returned: false }` when the person closes it (iOS cancel), another `openExternal` of the same
  installation starts (one pending flow per installation) or 30 minutes pass.
- URL rule (also for `openUrl`): `https:`; `http:` only for loopback and private addresses in
  development installations; no credentials. Other schemes: `invalid_params`.
- When the host cannot tie the call to the person's tap (a pop-up blocker on the web), it asks
  first ("Bağlantı açılsın mı?").

## The return address

```
https://<webOrigin>/apps/return/<installationId>?state=<your state>&<other params>
```

- `webOrigin` is the Olan web app's origin (`https://olan.app` while the API is
  `https://api.olan.app`), published in the issuer's `/.well-known/olan` (below).
- Your **server** builds it and puts it in the flow (e.g. OAuth `redirect_uri` of your own callback,
  which then redirects here):

  ```ts
  // in a handleRequest route (remote-requests.md)
  'POST /connections/start': async (ctx) => {
    const state = await saveState({ installationId: ctx.installationId, userId: ctx.user!.id });
    const returnUrl = await olan.appReturnUrl({ issuer: ctx.issuer, installationId: ctx.installationId });
    return { body: { authorizeUrl: `https://media.example.com/connect?state=${state}&return=${encodeURIComponent(returnUrl)}` } };
  },
  ```

  `olan.appReturnUrl({ issuer, installationId })` (`@olan-app/sdk/server`) reads `webOrigin` from
  the issuer's `/.well-known/olan` (cached; the issuer must be in `issuers`; an Olan server before
  1.5 has none: `web_origin_unknown`). `appReturnUrl(webOrigin, installationId)` of
  `@olan-app/schema` builds it when you already know the origin.
- When something else gives you a return URL (a client, a query parameter), accept it only when
  `await olan.isAppReturnUrl({ issuer, installationId, url })` is true: same origin, exactly
  `/apps/return/<installationId>`, any query, no credentials.
- `state` is yours: create it on your server, check it when the flow comes back. Olan passes it
  through untouched.
- `params`: the query parameters as strings; the last of repeated keys wins; at most 50 keys and
  4 KiB; the fragment (`#…`) is ignored. Never put secrets in them.

### Coming back without a pending call

If no `openExternal` is waiting (the app was closed, the tab reloaded, the phone killed the app),
Olan opens the app's `app` surface with the parameters as `params.return`:

```tsx
function Home() {
  const returned = useSurfaceParams<'app'>()?.return;      // { state, connection, … } or undefined
  useEffect(() => { if (returned?.state) void completeConnection(returned); }, [returned?.state]);
  …
}
```

On the web the return page hands the parameters to the waiting tab (`BroadcastChannel`) and
closes itself; without a waiting tab it opens `/apps/<installationId>` with `return`. On iOS and
Android the return address is a universal link / App Link that brings Olan to the front.

## App addresses: `/apps/a/<appId>`

Every app has a permanent address, the same for every organization and installation:

```
https://<webOrigin>/apps/a/<appId>[/<screen>]?<params>
https://olan.app/apps/a/com.example.media-desk/item?id=item_7
```

- Olan finds the person's installation of `appId` and opens its `app` surface (not installed: a
  link to the store page; plan without the app: "planınızda yok"). On iOS and Android it opens Olan.
- `screen` (`^[A-Za-z0-9_-]{1,64}$`, default `index`) and the query (strings, ≤ 50 keys, ≤ 4 KiB)
  become the start of the navigation stack (`init.navigation`):
  - `index`: the first screen's `useNavigation().params` are the query parameters;
  - another screen: the stack is `[index, <screen>]` with the params on `<screen>`; the back
    control returns to the first screen.

```tsx
function App() {
  const { screen, params } = useNavigation();
  const p = (params ?? {}) as { id?: string };
  if (screen === 'item' && p.id) return <ItemScreen id={p.id} />;    // /apps/a/<appId>/item?id=…
  return <Home />;
}
```

Use it in emails, chat cards (`open` buttons go to the app anyway), notifications and your own
web pages. `appLinkUrl(webOrigin, appId, { screen?, params? })` and `parseAppLink(url)` of
`@olan-app/schema` build and read them. Test with `renderApp({ navigation: { screen: 'item', params: { id: 'item_7' } } })`.

## `/.well-known/olan` (Olan 1.5)

```json
{
  "webOrigin": "https://olan.app",
  "apps": {
    "issuer": "https://api.olan.app",
    "returnUrlTemplate": "https://olan.app/apps/return/{installationId}",
    "appUrlTemplate": "https://olan.app/apps/a/{appId}",
    "features": ["…", "remote-requests", "files", "external-return", "app-links"]
  }
}
```

`features` tells an app server what this Olan server supports; a server without `remote-requests`
answers `olan.remote.request` with `unknown_method`.

## Testing

`renderApp({ ui: { openExternal: { returned: true, params: { state: 'st_1', connection: 'connected' } } } })`
answers `openExternal(…, { expectReturn: true })` (default `{ returned: false }`);
`app.host.opened` lists `{ url, external, expectReturn }` of every opened URL;
`renderApp({ params: { return: { state: 'st_1' } } })` opens the `app` surface as a return without a
pending call (testing.md#remote-requests-files-and-links).

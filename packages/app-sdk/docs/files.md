# Files (`olan.files`)

SDK 1.5: the person picks files with the platform's own picker, and the app uploads them **straight
from the device or browser to its own server**, never through Olan. The sandbox only gets handles;
the bytes stay with the host. Needs the `files:pick` permission ("Dosya seçtirme": the app can read
the files the person picks and upload them; it cannot reach their other files).

```tsx
import { Button, ProgressBar, olan, type FileHandle, type UploadTask } from '@olan-app/sdk';

const picked = await olan.files.pick({ accept: ['image/*', 'video/mp4', '.mov'], multiple: true, maxBytes: 300 * 1024 * 1024 });
if (picked.length === 0) return;                                   // the person cancelled

const { body } = await olan.remote.request({ method: 'POST', path: '/media/uploads', body: { name: picked[0]!.name, size: picked[0]!.size } });
const { uploadUrl } = body as { uploadUrl: string };               // one-time URL on the remote.url origin

const task = olan.files.upload(picked[0]!, {
  url: uploadUrl,                                                  // PUT by default
  onProgress: ({ loaded, total }) => setProgress(total > 0 ? loaded / total : 0),
});
setRunning(task);                                                  // <Button label="İptal" onPress={() => task.cancel()} />
const result = await task;                                         // { status, headers, body }
if (result.status >= 300) throw new Error(`Yükleme reddedildi (${result.status})`);
```

## `olan.files.pick(options?)` → `FileHandle[]`

| Option | Rule |
|---|---|
| `accept` | ≤ 32 entries: MIME types (`image/jpeg`), wildcards (`image/*`, `video/*`) or extensions (`.pdf`). Default: any file |
| `multiple` | Default `false` |
| `maxFiles` | 1–20; default 20 with `multiple`, else 1 |
| `maxBytes` | Per file; default 100 MiB, at most 1 GiB. Larger files are left out of the result (the host tells the person) |
| `source` | `'device'` (the only source in SDK 1.5) |

`FileHandle`: `{ id: 'file_…', name, size, type, lastModified? }`. `type` is
`application/octet-stream` when the platform does not know it; `lastModified` is epoch ms when known.
A handle is valid only while this sandbox runs (not after the app is closed or reloaded); do not
store it. An empty array means the person cancelled.

Pickers: web `<input type="file">`; iOS PHPicker for images and videos and the document picker for
other types; Android the Photo Picker and the system document picker.

## `olan.files.upload(handle, options)` → `UploadTask`

| Option | Rule |
|---|---|
| `url` **required** | The target; see "Where uploads may go" |
| `method` | `'PUT'` (default) or `'POST'` |
| `headers` | ≤ 20, values one line ≤ 4096. Not `host`, `content-length`, `cookie`, `connection`, `transfer-encoding`, `origin`, `referer` or any `x-olan-*` |
| `formField` | POST only: the file's multipart field, default `file` (letters, digits, `_.[]-`) |
| `fields` | POST only: ≤ 50 string fields sent **before** the file |
| `onProgress` | `({ loaded, total }) => void`: at most every 250 ms, and once at the end |

`UploadTask` is a `Promise<FileUploadResult>` with `uploadId` (`upl_…`) and `cancel()`. A handle id
string works in place of the handle. `olan.files.cancel(uploadId)` does the same as `task.cancel()`;
unknown or finished ids are ignored.

- The result is `{ status, headers: { 'content-type'?, etag?, location? }, body }` for **every**
  HTTP status, like `olan.http.fetch`: check `status`. `body` is parsed JSON for a JSON
  `content-type`, else text (≤ 1 MiB).
- Rejections: `cancelled` (after `cancel()`), `upload_failed` (network error, or no progress for
  60 s), `http_blocked` (the target breaks the rule below), `invalid_params` (unknown handle, a
  forbidden header, `formField`/`fields` on a PUT), `permission_denied` (no `files:pick`).
- At most 4 uploads run at once per sandbox; more wait in line. Uploads do not continue after the
  app is closed.

## Where uploads may go

`url` must be `https:` and its origin either:

- the origin of the manifest `remote.url` (with the installation's `remoteUrlOverride`), or
- a host the manifest grants as `http:<host>` (permissions.md; e.g. a separate storage host).

`http:` works only in development installations for loopback and private addresses. URLs with
credentials (`https://user:pw@…`) are refused. Anything else rejects with `http_blocked`.

No cookies are sent (`credentials: 'omit'`): put a one-time token in the URL (or a header) that
your server issued for this upload, e.g. from an `olan.remote.request`.

## What the target receives

Every upload carries `x-olan-file-name: <encodeURIComponent(name)>`. Read the file name from this
header (URL-decoded), never from the multipart `filename`, which browsers change.

**PUT** (default): the body is the file's raw bytes.

```
PUT /olan/uploads/item_7?token=4c1f… HTTP/1.1
content-type: video/mp4                     # handle.type; your headers may replace it
content-length: 5242880
x-olan-file-name: tan%C4%B1t%C4%B1m.mp4
<your headers>

<bytes>
```

**POST**: `multipart/form-data`; the `fields` parts in order, then one file part.

```
POST /olan/uploads HTTP/1.1
content-type: multipart/form-data; boundary=…
x-olan-file-name: kampanya.jpg

--…
Content-Disposition: form-data; name="itemId"

item_7
--…
Content-Disposition: form-data; name="file"; filename="kampanya.jpg"
Content-Type: image/jpeg

<bytes>
--…--
```

**Web (CORS).** In the browser the upload is a cross-origin request from Olan's web origin
(`webOrigin` of the Olan server's `/.well-known/olan`, e.g. `https://olan.app`). The target answers
the preflight and the upload with:

```
Access-Control-Allow-Origin: https://olan.app
Access-Control-Allow-Methods: PUT, POST
Access-Control-Allow-Headers: content-type, x-olan-file-name, <every header you send>
Access-Control-Expose-Headers: etag, location
```

Without `Expose-Headers` the app cannot read `etag` and `location`. iOS and Android do not need CORS.

A Node target is plain HTTP (no Olan signature: the one-time token is the proof): check the token,
read the raw body, answer `201` with JSON (`{ id, url }`), which the app gets as `result.body`.
Show the uploaded media with `Image` from the same origin (components.md#image).

```ts
import { createServer, type IncomingMessage } from 'node:http';

const WEB_ORIGINS = new Set(['https://olan.app']);         // webOrigin of each Olan server you serve
const cors = (req: IncomingMessage): Record<string, string> =>
  WEB_ORIGINS.has(req.headers.origin ?? '')
    ? { 'access-control-allow-origin': req.headers.origin!, 'access-control-allow-methods': 'PUT, POST',
        'access-control-allow-headers': 'content-type, x-olan-file-name', 'access-control-expose-headers': 'etag, location', vary: 'origin' }
    : {};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');   // path + query: /olan/uploads/item_7?token=4c1f…
  const match = /^\/olan\/uploads\/([\w-]+)$/.exec(url.pathname);
  if (!match) return res.writeHead(404).end();
  if (req.method === 'OPTIONS') return res.writeHead(204, cors(req)).end();               // CORS preflight (web)
  if (req.method !== 'PUT') return res.writeHead(405, cors(req)).end();
  if (!takeUploadToken(match[1]!, url.searchParams.get('token'))) return res.writeHead(403, cors(req)).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);                           // the raw file bytes (PUT)
  const bytes = Buffer.concat(chunks);                                                   // stream to storage for big files
  const name = decodeURIComponent(String(req.headers['x-olan-file-name'] ?? 'file'));    // never the multipart filename
  const type = req.headers['content-type'] ?? 'application/octet-stream';
  await saveFile(match[1]!, { name, type, bytes });
  res.writeHead(201, { ...cors(req), 'content-type': 'application/json', etag: `"${bytes.length}"`, location: `/olan/media/${match[1]}` });
  res.end(JSON.stringify({ id: match[1], name, size: bytes.length }));
}).listen(4100);
```

`olan-app init --template remote` has this target (with a size limit) in `app-server/server.ts`
and tests for the preflight and the one-time token. A POST target parses `multipart/form-data`
(e.g. `busboy`); the `fields` come before the file part.

## Limits

| | |
|---|---|
| File size | `maxBytes`, default 100 MiB, at most 1 GiB per file (your server may allow less) |
| Files per pick | 20 |
| Parallel uploads | 4 per sandbox |
| Stall timeout | 60 s without progress → `upload_failed` |
| Response body | 1 MiB |

## Testing

`fixtures/files.json` lists what the picker offers (`[{ "name", "type"?, "size"?, "content"? }]`;
built in: `kampanya.jpg`, `tanitim.mp4`, `brief.pdf`). `renderApp({ ui: { files: ['kampanya.jpg'] } })`
picks those (`null` or `[]` cancels), `renderApp({ upload })` answers uploads, and
`app.host.uploads` records each request with its headers (testing.md#remote-requests-files-and-links).

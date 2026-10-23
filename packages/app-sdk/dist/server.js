/* eslint-disable -- generated bundle */
// @olan-app/sdk/server: generated from src/server/index.ts by scripts/build.mjs; do not edit.

// src/server/crypto.ts
var encoder = new TextEncoder();
function utf8(text) {
  return encoder.encode(text);
}
function toBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}
function fromBase64(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}
function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlJson(value) {
  return toBase64Url(utf8(JSON.stringify(value)));
}
function pemToDer(pem) {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!match) throw new TypeError('privateKeyPem must be a PEM block ("-----BEGIN PRIVATE KEY-----")');
  if (match[1] !== "PRIVATE KEY") {
    throw new TypeError(`privateKeyPem must be PKCS#8 ("BEGIN PRIVATE KEY"), not "${match[1]}"; convert it with \`openssl pkcs8 -topk8 -nocrypt\``);
  }
  return fromBase64(match[2]);
}
function derToPem(der, label = "PRIVATE KEY") {
  const body = toBase64(der).replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----
${body}
-----END ${label}-----
`;
}
var CANDIDATES = [
  { alg: "EdDSA", params: { name: "Ed25519" } },
  { alg: "ES256", params: { name: "ECDSA", namedCurve: "P-256" } },
  { alg: "RS256", params: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } }
];
var PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "key_ops", "ext"];
async function importSigningKey(pem) {
  const der = pemToDer(pem);
  for (const candidate of CANDIDATES) {
    try {
      const key = await crypto.subtle.importKey("pkcs8", der, candidate.params, true, ["sign"]);
      const jwk = await crypto.subtle.exportKey("jwk", key);
      const publicJwk = { ...jwk };
      for (const member of PRIVATE_MEMBERS) delete publicJwk[member];
      return { key, alg: candidate.alg, publicJwk };
    } catch {
    }
  }
  throw new TypeError("privateKeyPem is not an Ed25519, P-256 (ES256) or RSA (RS256) PKCS#8 private key");
}
async function sign(signing, data) {
  const algorithm = signing.alg === "EdDSA" ? { name: "Ed25519" } : signing.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  return new Uint8Array(await crypto.subtle.sign(algorithm, signing.key, data));
}
async function jwkThumbprint(jwk) {
  const members = { OKP: ["crv", "kty", "x"], EC: ["crv", "kty", "x", "y"], RSA: ["e", "kty", "n"] };
  const names = members[jwk.kty ?? ""];
  if (!names) throw new TypeError(`Unsupported key type ${String(jwk.kty)}`);
  const canonical = `{${names.map((name) => `${JSON.stringify(name)}:${JSON.stringify(jwk[name])}`).join(",")}}`;
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonical))));
}
async function importVerifyKey(jwk) {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
}
async function verifyEd25519(key, signature, data) {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
  } catch {
    return false;
  }
}

// src/server/hooks.ts
var HOOK_BODY_MAX_BYTES = 1024 * 1024;
var HOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
function header(headers, name) {
  if (typeof headers.get === "function") return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === void 0) continue;
    return Array.isArray(value) ? value[0] ?? null : value;
  }
  return null;
}
async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}
var toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
function fromHex(text) {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return out;
}
function standardWebhooksKey(secret) {
  return secret.startsWith("whsec_") ? fromBase64(secret.slice("whsec_".length)) : utf8(secret);
}
var bodyBytes = (body) => typeof body === "string" ? utf8(body) : new Uint8Array(body);
async function verifyHookSignature(verify, request, secret, options = {}) {
  const body = bodyBytes(request.body);
  if (body.byteLength > HOOK_BODY_MAX_BYTES) return { ok: false, status: 413, code: "payload_too_large", message: `Hook bodies are limited to ${HOOK_BODY_MAX_BYTES} bytes` };
  const fail = (message) => ({ ok: false, status: 401, code: "hook_verification_failed", message });
  if (verify.kind === "none") return options.development ? { ok: true } : fail('"verify": { "kind": "none" } is only accepted in development installations');
  if (!secret) return { ok: false, status: 503, code: "hook_secret_missing", message: `The secret setting "${verify.secretSetting ?? ""}" is not set for this installation` };
  if (verify.kind === "hmac-sha256") {
    const given = header(request.headers, verify.header ?? "");
    if (!given) return fail(`Missing signature header ${verify.header ?? ""}`);
    const bytes = fromHex(given.trim().replace(/^sha256=/i, ""));
    if (!bytes) return fail("The signature header is not hex");
    return same(bytes, await hmac(utf8(secret), body)) ? { ok: true } : fail("The HMAC-SHA256 signature does not match the body");
  }
  const id = header(request.headers, "webhook-id");
  const timestamp = header(request.headers, "webhook-timestamp");
  const signatures = header(request.headers, "webhook-signature");
  if (!id || !timestamp || !signatures) return fail("Missing webhook-id, webhook-timestamp or webhook-signature");
  const seconds = Number(timestamp);
  const now = Math.floor((options.now ?? Date.now()) / 1e3);
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > HOOK_TIMESTAMP_TOLERANCE_SECONDS) return fail("webhook-timestamp is outside the 5 minute tolerance");
  const signed = new Uint8Array([...utf8(`${id}.${timestamp}.`), ...body]);
  const expected = await hmac(standardWebhooksKey(secret), signed);
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    try {
      if (same(fromBase64(value), expected)) return { ok: true };
    } catch {
    }
  }
  return fail("No webhook-signature entry matches");
}
async function signHookRequest(verify, body, secret, options = {}) {
  const bytes = bodyBytes(body);
  if (verify.kind === "hmac-sha256") return { [(verify.header ?? "x-signature").toLowerCase()]: `sha256=${toHex(await hmac(utf8(secret), bytes))}` };
  if (verify.kind === "standard-webhooks") {
    const id = options.id ?? `msg_${crypto.randomUUID()}`;
    const timestamp = String(Math.floor((options.now ?? Date.now()) / 1e3));
    const signature = await hmac(standardWebhooksKey(secret), new Uint8Array([...utf8(`${id}.${timestamp}.`), ...bytes]));
    return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${toBase64(signature)}` };
  }
  return {};
}

// src/server/index.ts
var WEBHOOK_HEADERS = Object.freeze({
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
  issuer: "olan-issuer",
  keyId: "olan-key-id",
  installationId: "olan-installation-id",
  eventType: "olan-event-type",
  attempt: "olan-delivery-attempt"
});
var WEBHOOK_TOLERANCE_SECONDS = 300;
var WEBHOOK_ID_RETENTION_SECONDS = 24 * 60 * 60;
var DEFAULT_ISSUERS = Object.freeze(["https://api.olan.app"]);
var REQUEST_ID_RETENTION_SECONDS = 600;
var PROFILE_REQUIRED = "profile_required";
var TOKEN_INVALIDATING_EVENTS = Object.freeze(["app.updated", "app.consent.changed", "app.uninstalled"]);
var STALE_TOKEN_ERRORS = Object.freeze(["permission_denied", "insufficient_scope"]);
var APP_RETURN_PATH = "/apps/return/";
var SIGNATURE_VERSION = "v1a";
var CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
var ASSERTION_LIFETIME_SECONDS = 60;
var JWKS_CACHE_SECONDS = 600;
var JWKS_REFRESH_MIN_SECONDS = 60;
var TOOL_RESULT_MAX_BYTES = 64 * 1024;
var TOOL_SUMMARY_MAX = 500;
var PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
var OlanServerError = class extends Error {
  code;
  status;
  /** Token endpoint failures: the OAuth error body (`consent_required` has `missing`). */
  detail;
  constructor(code, message, status = 401, detail) {
    super(message);
    this.name = "OlanServerError";
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
};
function memoryIdempotencyStore(now = Date.now) {
  const seen = /* @__PURE__ */ new Map();
  return {
    has(id) {
      const until = seen.get(id);
      if (until === void 0) return false;
      if (until < now()) {
        seen.delete(id);
        return false;
      }
      return true;
    },
    add(id, ttlSeconds) {
      seen.set(id, now() + ttlSeconds * 1e3);
      if (seen.size > 1e4) {
        for (const [key, until] of seen) if (until < now()) seen.delete(key);
      }
    }
  };
}
var ToolError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
};
var RequestError = class extends Error {
  status;
  body;
  headers;
  constructor(status, body = null, headers) {
    super(`Request failed with status ${status}`);
    this.name = "RequestError";
    this.status = status;
    this.body = body;
    if (headers) this.headers = headers;
  }
};
function isRequestError(error) {
  if (error instanceof RequestError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error;
  return candidate.name === "RequestError" && typeof candidate.status === "number";
}
var compiledRoutes = /* @__PURE__ */ new WeakMap();
function compileRoutes(routes) {
  const cached = compiledRoutes.get(routes);
  if (cached) return cached;
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const match = /^([A-Z]+|\*)\s+(\/\S*)$/.exec(key.trim());
    if (!match) throw new TypeError(`Route "${key}" must look like "GET /brands/:brandId"`);
    const segments = match[2].split("/").slice(1).filter((segment, index, all) => segment !== "" || index < all.length - 1);
    const rest = segments[segments.length - 1] === "*";
    return { method: match[1], segments: rest ? segments.slice(0, -1) : segments, rest, handler };
  });
  compiledRoutes.set(routes, compiled);
  return compiled;
}
function matchRemoteRoute(routes, method, path) {
  const parts = path.split("/").slice(1).filter((segment, index, all) => segment !== "" || index < all.length - 1);
  let pathMatched = false;
  for (const route of compileRoutes(routes)) {
    if (route.rest ? parts.length < route.segments.length : parts.length !== route.segments.length) continue;
    const params = {};
    let ok = true;
    for (let index = 0; index < route.segments.length && ok; index++) {
      const segment = route.segments[index];
      let part;
      try {
        part = decodeURIComponent(parts[index]);
      } catch {
        ok = false;
        break;
      }
      if (segment.startsWith(":")) params[segment.slice(1)] = part;
      else ok = segment === part;
    }
    if (!ok) continue;
    if (route.rest) params["*"] = parts.slice(route.segments.length).join("/");
    pathMatched = true;
    if (route.method === "*" || route.method === method) return { handler: route.handler, params };
  }
  return { status: pathMatched ? 405 : 404 };
}
async function runRemoteRoute(router, context) {
  let handler;
  let params = {};
  if (typeof router === "function") {
    handler = router;
  } else {
    const found = matchRemoteRoute(router, context.method, context.path);
    if ("status" in found) {
      return found.status === 404 ? { status: 404, body: { error: "unknown_route", message: `No route for ${context.method} ${context.path}` } } : { status: 405, body: { error: "method_not_allowed", message: `${context.path} does not accept ${context.method}` } };
    }
    handler = found.handler;
    params = found.params;
  }
  try {
    const result = await handler({ ...context, params }) ?? {};
    const status = result.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new TypeError(`A route answered status ${String(status)} (200\u2013599)`);
    return { status, ...result.headers ? { headers: result.headers } : {}, body: result.body ?? null };
  } catch (error) {
    if (isRequestError(error) && Number.isInteger(error.status) && error.status >= 200 && error.status <= 599) {
      return { status: error.status, ...error.headers ? { headers: error.headers } : {}, body: error.body ?? null };
    }
    return { status: 500, body: { error: "internal_error" } };
  }
}
var normalizeIssuer = (issuer) => issuer.trim().replace(/\/+$/, "");
function headerOf(headers, name) {
  if (typeof headers.get === "function") return headers.get(name);
  const record = headers;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === void 0 ? void 0 : record[key];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
function urlToolName(request) {
  const url = request.url;
  if (typeof url !== "string" || url.length === 0) return null;
  let pathname;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
  const match = /\/ai-tools\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
async function readBody(request) {
  if (typeof Request !== "undefined" && request instanceof Request) return request.text();
  const body = request.body;
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}
var json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function createOlanServer(options) {
  if (!options || typeof options.appId !== "string" || options.appId.length === 0) throw new TypeError("createOlanServer needs { appId }");
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const cacheMs = (options.jwksCacheSeconds ?? JWKS_CACHE_SECONDS) * 1e3;
  const idempotency = options.idempotency === false ? null : options.idempotency ?? memoryIdempotencyStore(now);
  const allowlist = options.issuers ?? DEFAULT_ISSUERS;
  const issuerAllowed = (issuer) => typeof allowlist === "function" ? allowlist(issuer) : allowlist.some((candidate) => normalizeIssuer(candidate) === issuer);
  const issuers = /* @__PURE__ */ new Map();
  const tokens = /* @__PURE__ */ new Map();
  let tokenEpoch = 0;
  let signing = null;
  let nextSigning = null;
  const keyWithKid = (pem, keyId) => importSigningKey(pem).then(async (key) => ({ ...key, kid: keyId ?? await jwkThumbprint(key.publicJwk) }));
  const signingKey = () => {
    if (!options.privateKeyPem) throw new OlanServerError("no_private_key", "createOlanServer needs privateKeyPem for tokens and jwks()", 500);
    signing ??= keyWithKid(options.privateKeyPem, options.keyId);
    return signing;
  };
  const getJson = async (url) => {
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const value = await response.json();
    if (!isObject(value)) throw new Error(`${url} did not answer a JSON object`);
    return value;
  };
  const loadIssuer = async (issuer, previous) => {
    let jwksUri = previous?.jwksUri ?? `${issuer}/api/v2/apps/jwks.json`;
    let tokenEndpoint = previous?.tokenEndpoint ?? `${issuer}/api/v2/apps/oauth/token`;
    let webOrigin = previous?.webOrigin ?? null;
    if (!previous) {
      try {
        const wellKnown = await getJson(`${issuer}/.well-known/olan`);
        const apps = isObject(wellKnown.apps) ? wellKnown.apps : {};
        if (typeof apps.jwksUri === "string") jwksUri = apps.jwksUri;
        if (typeof apps.tokenEndpoint === "string") tokenEndpoint = apps.tokenEndpoint;
        if (typeof wellKnown.webOrigin === "string") {
          try {
            webOrigin = new URL(wellKnown.webOrigin).origin;
          } catch {
          }
        }
      } catch {
      }
    }
    const document = await getJson(jwksUri);
    const keys = /* @__PURE__ */ new Map();
    for (const jwk of Array.isArray(document.keys) ? document.keys : []) {
      if (!isObject(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.kid !== "string" || typeof jwk.x !== "string") continue;
      try {
        keys.set(jwk.kid, await importVerifyKey(jwk));
      } catch {
      }
    }
    return { jwksUri, tokenEndpoint, webOrigin, keys, fetchedAt: now(), refreshedAt: now() };
  };
  const issuerKeys = async (issuer, kid) => {
    let entry = issuers.get(issuer);
    if (!entry) {
      entry = loadIssuer(issuer);
      issuers.set(issuer, entry);
      entry.catch(() => issuers.delete(issuer));
    }
    let current = await entry;
    const stale = now() - current.fetchedAt > cacheMs;
    const unknownKid = kid !== void 0 && !current.keys.has(kid) && now() - current.refreshedAt >= JWKS_REFRESH_MIN_SECONDS * 1e3;
    if (stale || unknownKid) {
      const refreshed = loadIssuer(issuer, stale ? void 0 : current);
      issuers.set(issuer, refreshed);
      try {
        current = await refreshed;
      } catch (error) {
        issuers.set(issuer, Promise.resolve({ ...current, refreshedAt: now() }));
        if (stale) throw error;
      }
    }
    return current;
  };
  const verify = async (request) => {
    const headers = request.headers;
    const need = (name) => {
      const value = headerOf(headers, name);
      if (!value) throw new OlanServerError("missing_header", `The request has no ${name} header`);
      return value;
    };
    const webhookId = need(WEBHOOK_HEADERS.id);
    const timestampText = need(WEBHOOK_HEADERS.timestamp);
    const signatureHeader = need(WEBHOOK_HEADERS.signature);
    const issuer = normalizeIssuer(need(WEBHOOK_HEADERS.issuer));
    const keyId = need(WEBHOOK_HEADERS.keyId);
    const rawBody = await readBody(request);
    if (!issuerAllowed(issuer)) throw new OlanServerError("issuer_not_allowed", `Issuer ${issuer} is not in this app's issuers list`);
    let keys;
    try {
      keys = await issuerKeys(issuer, keyId);
    } catch (error) {
      throw new OlanServerError("jwks_unavailable", `Could not load the signing keys of ${issuer}: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    const key = keys.keys.get(keyId);
    if (!key) throw new OlanServerError("unknown_key", `${issuer} publishes no key "${keyId}"`);
    const signatures = signatureHeader.split(" ").map((part) => part.trim()).filter((part) => part.startsWith(`${SIGNATURE_VERSION},`)).map((part) => part.slice(SIGNATURE_VERSION.length + 1));
    const content = utf8(`${webhookId}.${timestampText}.${rawBody}`);
    let valid = false;
    for (const signature of signatures) {
      let bytes;
      try {
        bytes = fromBase64(signature);
      } catch {
        continue;
      }
      if (await verifyEd25519(key, bytes, content)) {
        valid = true;
        break;
      }
    }
    if (!valid) throw new OlanServerError("invalid_signature", "The webhook-signature does not verify");
    const timestamp = Number(timestampText);
    if (!/^\d+$/.test(timestampText) || Math.abs(now() / 1e3 - timestamp) > tolerance) {
      throw new OlanServerError("timestamp_out_of_range", `webhook-timestamp is more than ${tolerance} s away from this server's clock`);
    }
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new OlanServerError("invalid_body", "The body is not JSON", 400);
    }
    const attempt = headerOf(headers, WEBHOOK_HEADERS.attempt);
    return {
      issuer,
      keyId,
      webhookId,
      timestamp,
      installationId: headerOf(headers, WEBHOOK_HEADERS.installationId),
      eventType: headerOf(headers, WEBHOOK_HEADERS.eventType),
      attempt: attempt && /^\d+$/.test(attempt) ? Number(attempt) : null,
      rawBody,
      body
    };
  };
  const createClientAssertion = async ({ issuer, installationId, userId }) => {
    const key = await signingKey();
    const iat = Math.floor(now() / 1e3);
    const header2 = { alg: key.alg, kid: key.kid, typ: "JWT" };
    const claims = {
      iss: options.appId,
      sub: options.appId,
      aud: `${normalizeIssuer(issuer)}/api/v2/apps/oauth/token`,
      iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
      jti: crypto.randomUUID(),
      olan_installation_id: installationId,
      ...userId ? { olan_user_id: userId } : {}
    };
    const input = `${base64UrlJson(header2)}.${base64UrlJson(claims)}`;
    return `${input}.${toBase64Url(await sign(key, utf8(input)))}`;
  };
  const getInstallationToken = async ({ issuer: rawIssuer, installationId, userId }) => {
    const issuer = normalizeIssuer(rawIssuer);
    if (!issuerAllowed(issuer)) throw new OlanServerError("issuer_not_allowed", `Issuer ${issuer} is not in this app's issuers list`);
    const cacheKey = `${issuer}\0${installationId}\0${userId ?? ""}`;
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - 3e4 > now()) return cached;
    const epoch = tokenEpoch;
    let endpoint = `${issuer}/api/v2/apps/oauth/token`;
    try {
      endpoint = (await issuerKeys(issuer)).tokenEndpoint;
    } catch {
    }
    const assertion = await createClientAssertion({ issuer, installationId, userId });
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }).toString()
    });
    let payload = {};
    try {
      const value = await response.json();
      if (isObject(value)) payload = value;
    } catch {
    }
    if (!response.ok || typeof payload.access_token !== "string") {
      const code = typeof payload.error === "string" ? payload.error : "token_failed";
      const message = typeof payload.error_description === "string" ? payload.error_description : `The token endpoint answered ${response.status}`;
      throw new OlanServerError(code, message, response.status || 502, payload);
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 300;
    const token = {
      accessToken: payload.access_token,
      tokenType: "Bearer",
      expiresIn,
      expiresAt: now() + expiresIn * 1e3,
      scope: typeof payload.scope === "string" ? payload.scope : "",
      permissions: Array.isArray(payload.permissions) ? payload.permissions.filter((item) => typeof item === "string") : []
    };
    if (epoch === tokenEpoch) tokens.set(cacheKey, token);
    return token;
  };
  const invalidateToken = (installationId, { issuer } = {}) => {
    tokenEpoch++;
    const wanted = issuer === void 0 ? null : normalizeIssuer(issuer);
    let dropped = 0;
    for (const key of [...tokens.keys()]) {
      const [keyIssuer, keyInstallation] = key.split("\0");
      if (keyInstallation !== installationId || wanted !== null && keyIssuer !== wanted) continue;
      tokens.delete(key);
      dropped++;
    }
    return dropped;
  };
  const clearTokenCache = () => {
    tokenEpoch++;
    tokens.clear();
  };
  const fetchOlan = async (target, path, init = {}) => {
    const issuer = normalizeIssuer(target.issuer);
    const url = new URL(path, `${issuer}/`);
    if (url.origin !== new URL(issuer).origin) throw new TypeError(`fetchOlan only calls the issuer ${issuer}, not ${url.origin}`);
    const send = async () => {
      const token = await getInstallationToken({ ...target, issuer });
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token.accessToken}`);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      return doFetch(url.toString(), { ...init, headers });
    };
    const response = await send();
    if (response.status !== 403) return response;
    let code;
    try {
      const body = await response.clone().json();
      if (isObject(body)) code = body.error;
    } catch {
    }
    if (typeof code !== "string" || !STALE_TOKEN_ERRORS.includes(code)) return response;
    invalidateToken(target.installationId, { issuer });
    return send();
  };
  const rejected = (error) => {
    if (error instanceof OlanServerError) return json(error.status, { error: error.code, message: error.message });
    return json(500, { error: "internal_error" });
  };
  const handleToolCall = async (request, tools) => {
    let verified;
    try {
      verified = await verify(request);
    } catch (error) {
      return rejected(error);
    }
    const call = verified.body;
    if (!isObject(call) || call.id !== verified.webhookId || typeof call.tool !== "string" || !isObject(call.input)) {
      return json(400, { error: "invalid_body", message: "Not an Olan tool call (id must equal webhook-id)" });
    }
    const urlTool = urlToolName(request);
    if (urlTool !== null && urlTool !== call.tool) {
      return json(400, { error: "tool_mismatch", message: `The URL names the tool "${urlTool}" but the body calls "${call.tool}"` });
    }
    const handler = Object.prototype.hasOwnProperty.call(tools, call.tool) ? tools[call.tool] : void 0;
    if (!handler) return json(200, { ok: false, error: { code: "unknown_tool", message: `This server has no tool "${call.tool}"` } });
    try {
      const output = await handler(call.input, {
        callId: call.id,
        tool: call.tool,
        installationId: call.installationId,
        appId: call.appId,
        issuer: verified.issuer,
        channel: call.channel,
        user: call.user,
        token: call.token
      });
      if (!isObject(output) || !("result" in output)) throw new TypeError(`Tool "${call.tool}" must return { result, summary? }`);
      const body = { ok: true, result: output.result ?? null };
      if (typeof output.summary === "string") body.summary = output.summary.slice(0, TOOL_SUMMARY_MAX);
      const text = JSON.stringify(body);
      if (utf8(text).length > TOOL_RESULT_MAX_BYTES) {
        return json(200, { ok: false, error: { code: "result_too_large", message: `The result is larger than ${TOOL_RESULT_MAX_BYTES} bytes` } });
      }
      return new Response(text, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (error) {
      if (error instanceof ToolError) return json(200, { ok: false, error: { code: error.code, message: error.message } });
      return json(200, { ok: false, error: { code: "tool_failed", message: error instanceof Error ? error.message : "The tool failed" } });
    }
  };
  const handleEvent = async (request, handler) => {
    let verified;
    try {
      verified = await verify(request);
    } catch (error) {
      return rejected(error);
    }
    const event = verified.body;
    if (!isObject(event) || event.id !== verified.webhookId || typeof event.type !== "string") {
      return json(400, { error: "invalid_body", message: "Not an Olan event (id must equal webhook-id)" });
    }
    if (TOKEN_INVALIDATING_EVENTS.includes(event.type)) {
      const installationId = typeof event.installationId === "string" ? event.installationId : verified.installationId;
      if (installationId) invalidateToken(installationId, { issuer: verified.issuer });
    }
    if (idempotency && await idempotency.has(verified.webhookId)) return json(200, { ok: true, duplicate: true });
    const run = typeof handler === "function" ? handler : handler[event.type] ?? handler["*"];
    try {
      if (run) await run(event, { issuer: verified.issuer, installationId: event.installationId, webhookId: verified.webhookId, attempt: verified.attempt });
    } catch (error) {
      return json(500, { ok: false, error: error instanceof Error ? error.message : "The handler failed" });
    }
    if (idempotency) await idempotency.add(verified.webhookId, WEBHOOK_ID_RETENTION_SECONDS);
    return json(200, { ok: true, ...run ? {} : { ignored: true } });
  };
  const handleCardAction = async (request, handler) => {
    let verified;
    try {
      verified = await verify(request);
    } catch (error) {
      return rejected(error);
    }
    const action = verified.body;
    if (!isObject(action) || action.id !== verified.webhookId || typeof action.name !== "string") {
      return json(400, { error: "invalid_body", message: "Not an Olan card action (id must equal webhook-id)" });
    }
    if (idempotency) {
      if (await idempotency.has(verified.webhookId)) return json(409, { error: "duplicate_request", message: "This card action was already handled" });
      await idempotency.add(verified.webhookId, REQUEST_ID_RETENTION_SECONDS);
    }
    try {
      const answer = await handler(action, { issuer: verified.issuer, webhookId: verified.webhookId }) ?? {};
      return json(200, answer);
    } catch (error) {
      return json(500, { error: "card_action_failed", message: error instanceof Error ? error.message : "The handler failed" });
    }
  };
  const handleRequest = async (request, router) => {
    let verified;
    try {
      verified = await verify(request);
    } catch (error) {
      return rejected(error);
    }
    const envelope = verified.body;
    const inner = isObject(envelope) && isObject(envelope.request) ? envelope.request : null;
    if (!isObject(envelope) || envelope.id !== verified.webhookId || typeof envelope.installationId !== "string" || typeof envelope.appId !== "string" || !inner || typeof inner.method !== "string" || typeof inner.path !== "string" || !inner.path.startsWith("/")) {
      return json(400, { error: "invalid_body", message: "Not an Olan request (id must equal webhook-id)" });
    }
    if (typeof envelope.issuer !== "string") return json(400, { error: "invalid_body", message: "Not an Olan request (no issuer)" });
    if (normalizeIssuer(envelope.issuer) !== verified.issuer) {
      return json(401, { error: "issuer_mismatch", message: `The envelope's issuer ${envelope.issuer} is not the olan-issuer ${verified.issuer}` });
    }
    if (idempotency) {
      if (await idempotency.has(verified.webhookId)) return json(409, { error: "duplicate_request", message: "This request id was already handled" });
      await idempotency.add(verified.webhookId, REQUEST_ID_RETENTION_SECONDS);
    }
    const user = isObject(envelope.user) && typeof envelope.user.id === "string" ? envelope.user : null;
    const token = isObject(envelope.token) && typeof envelope.token.accessToken === "string" ? envelope.token : null;
    const answer = await runRemoteRoute(router, {
      id: verified.webhookId,
      issuer: verified.issuer,
      installationId: envelope.installationId,
      appId: envelope.appId,
      user,
      method: inner.method,
      path: inner.path,
      query: isObject(inner.query) ? inner.query : {},
      headers: isObject(inner.headers) ? inner.headers : {},
      body: inner.body ?? null,
      token,
      timeoutMs: typeof inner.timeoutMs === "number" ? inner.timeoutMs : 3e4
    });
    return json(200, answer);
  };
  const webOriginOf = async (rawIssuer) => {
    const issuer = normalizeIssuer(rawIssuer);
    if (!issuerAllowed(issuer)) throw new OlanServerError("issuer_not_allowed", `Issuer ${issuer} is not in this app's issuers list`);
    let keys;
    try {
      keys = await issuerKeys(issuer);
    } catch (error) {
      throw new OlanServerError("jwks_unavailable", `Could not load ${issuer}/.well-known/olan: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    if (!keys.webOrigin) throw new OlanServerError("web_origin_unknown", `${issuer}/.well-known/olan has no webOrigin (Olan before 1.5)`, 503);
    return keys.webOrigin;
  };
  const appReturnUrl = async ({ issuer, installationId }) => `${await webOriginOf(issuer)}${APP_RETURN_PATH}${encodeURIComponent(installationId)}`;
  const isAppReturnUrl = async ({ issuer, installationId, url }) => {
    const expected = new URL(await appReturnUrl({ issuer, installationId }));
    try {
      const candidate = new URL(url);
      return candidate.origin === expected.origin && candidate.pathname === expected.pathname && !candidate.username && !candidate.password;
    } catch {
      return false;
    }
  };
  const jwks = async () => {
    const published = (key) => ({ ...key.publicJwk, kid: key.kid, alg: key.alg, use: "sig" });
    const current = await signingKey();
    const keys = [published(current)];
    if (options.nextPrivateKeyPem) {
      nextSigning ??= keyWithKid(options.nextPrivateKeyPem, options.nextKeyId);
      const next = await nextSigning;
      if (next.kid === current.kid) throw new TypeError("nextPrivateKeyPem needs a kid other than the current key's (nextKeyId)");
      keys.push(published(next));
    }
    for (const extra of options.additionalPublicKeys ?? []) {
      if (typeof extra?.kid !== "string" || extra.kid.length === 0) throw new TypeError("additionalPublicKeys entries need a kid");
      if (keys.some((key) => key.kid === extra.kid)) continue;
      const publicJwk = { ...extra };
      for (const member of PRIVATE_JWK_MEMBERS) delete publicJwk[member];
      keys.push(publicJwk);
    }
    return { keys };
  };
  return { verify, getInstallationToken, invalidateToken, clearTokenCache, fetchOlan, createClientAssertion, handleToolCall, handleEvent, handleCardAction, handleRequest, appReturnUrl, isAppReturnUrl, jwks };
}
async function generateAppKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  const keyId = await jwkThumbprint(publicJwk);
  return { privateKeyPem: derToPem(pkcs8), publicJwk: { ...publicJwk, kid: keyId, alg: "EdDSA", use: "sig" }, keyId };
}
async function fromNodeRequest(request, options = {}) {
  const max = options.maxBytes ?? 1024 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? utf8(chunk) : chunk;
    size += bytes.length;
    if (size > max) throw new OlanServerError("invalid_body", `The body is larger than ${max} bytes`, 413);
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { headers: request.headers, body, ...typeof request.url === "string" ? { url: request.url } : {} };
}
async function sendNodeResponse(target, response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(response.status, headers);
  target.end(new Uint8Array(await response.arrayBuffer()));
}
function cardResponse(card, toast) {
  return { ...card ? { card } : {}, ...toast ? { toast } : {} };
}
export {
  DEFAULT_ISSUERS,
  HOOK_BODY_MAX_BYTES,
  HOOK_TIMESTAMP_TOLERANCE_SECONDS,
  OlanServerError,
  PROFILE_REQUIRED,
  REQUEST_ID_RETENTION_SECONDS,
  RequestError,
  STALE_TOKEN_ERRORS,
  TOKEN_INVALIDATING_EVENTS,
  ToolError,
  WEBHOOK_HEADERS,
  WEBHOOK_ID_RETENTION_SECONDS,
  WEBHOOK_TOLERANCE_SECONDS,
  cardResponse,
  createOlanServer,
  fromNodeRequest,
  generateAppKey,
  matchRemoteRoute,
  memoryIdempotencyStore,
  runRemoteRoute,
  sendNodeResponse,
  signHookRequest,
  verifyHookSignature
};

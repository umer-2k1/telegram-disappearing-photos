# Solution — Programmatic disappearing photos on Telegram Web A

## TL;DR

A disappearing (self-destruct) photo is a native MTProto feature: `messages.sendMedia`
with `media = inputMediaUploadedPhoto` **and a `ttl_seconds` field**. Telegram Web A can build
that field for documents/videos but its *photo* code path drops it, which is exactly why the UI
has no disappearing-photo option.

This extension makes Telegram send `inputMediaUploadedPhoto{ ttl_seconds }` through its **own**
upload + encryption + WebSocket pipeline, by instrumenting the Web Worker that runs its MTProto
stack. No bundled libraries, no external server — everything is in the content script.

## Rules compliance

- **Rule 1 — fully contained in the extension.** No localhost server, no external code. The whole
  solution is the content script (`disappearing.js`), the manifest, and a declarativeNetRequest
  rule (`rules.json`). Nothing runs outside the extension.
- **Rule 2 — no bundled/outside libraries.** The code is plain, dependency-free JavaScript: no
  `import`, no `require`, no `<script src>` to any CDN, and nothing (gramjs, mtproto, mqtt, …) is
  shipped with it. It reuses the GramJS/MTProto stack **that Telegram Web A already loaded in the
  page** by patching Telegram's own worker at runtime — so we carry zero copies of any library.
  Everything used is free and already present. (Reusing the site's own code is the opposite of
  bundling a library.)
- **Rule 3 — Web A only.** The manifest matches `*://web.telegram.org/a*`, and the technique is
  specific to Web A's worker architecture; it does not target `/k` or any other version.

## Why the previous implementation could never work

The old `content.js` / `claudeDom.js` did two things, both wrong:

1. **Hooked `window.apiManager.invokeApi`.** Telegram Web A (the `telegram-tt` codebase) runs its
   entire GramJS/MTProto client — including the WebSocket and all AES-MTProto encryption — inside
   a dedicated `type:"module"` Web Worker (`src/api/gramjs/worker/connector.ts`). Nothing named
   `apiManager` is ever put on `window`. Those hooks match nothing, so the interval times out.
2. **"Deleted the message after N seconds" (or faked it in the DOM).** That is not a disappearing
   photo. A normal photo that you later delete still lived as a normal photo, the recipient may
   have saved it, and the DOM trick doesn't change what was sent over the wire at all. A real
   disappearing photo is enforced server-side via `ttl_seconds`.

## How Telegram Web A actually sends media (ground truth from source)

- Main thread ⇄ worker is a tiny RPC. To send, the app posts to the worker:
  ```js
  worker.postMessage({ payloads: [{ type: 'callMethod', name: 'sendMessage', args: [params] }] })
  ```
  The worker runs `methods.sendMessage(params)` (`src/api/gramjs/methods/messages.ts`).
- `sendMessage` → `uploadMedia()` builds the `InputMedia`. The relevant lines:
  ```js
  // photo branch — NOTE: no ttlSeconds
  return new GramJs.InputMediaUploadedPhoto({ file: inputFile, spoiler: shouldSendAsSpoiler });
  ...
  // document/video branch — has ttlSeconds
  return new GramJs.InputMediaUploadedDocument({ file, mimeType, attributes, thumb, forceFile, spoiler, ttlSeconds });
  ```
  → The photo path never carries `ttlSeconds`. That single omission is the whole challenge.
- The debug helpers `self.invoke = invokeRequest` / `self.GramJs = GramJs` in
  `methods/client.ts` are gated behind `if (DEBUG)`, and `DEBUG = APP_ENV !== 'production'`, so
  they are stripped from the public build.

## The approach

Telegram Web A is built with **Vite/Rollup → ES modules**. The MTProto worker is a single
same-origin ESM chunk. We:

1. **Override `window.Worker`** from the page's MAIN world at `document_start`, before the app
   boots (`disappearing.js`).
2. When the app constructs its module worker, we **synchronously fetch that worker's source**
   (same-origin), and transform it:
   - **Rewrite relative import specifiers → absolute URLs**, and replace `import.meta.url` with
     the original worker URL literal, so the code can run re-hosted from a `blob:` URL (nested
     workers / `new URL(..., import.meta.url)` keep resolving correctly).
   - **Splice `ttlSeconds` into the photo constructor:** every
     `new …InputMediaUploadedPhoto({ … })` becomes
     `new …InputMediaUploadedPhoto({ …, ttlSeconds: self.__dpConsumeTtl() })`.
     `__dpConsumeTtl()` returns a one-shot value we arm from outside — and returns `undefined`
     (identical to omitting the field) for all normal sends, so nothing else is affected.
   - **Expose the GramJS `Api` and connected client** by wrapping known constructions
     (`new Api.InvokeWithLayer({…})` at connect, and the `new TelegramClient(…,{deviceModel:…})`
     assignment). Property/method names survive minification; only the top-level identifiers are
     mangled, so we capture them by wrapping. This powers the fully-programmatic send path.
   - Prepend a small **prelude** that owns `self.__dpConsumeTtl`, listens for control messages,
     and (when armed) sets the one-shot ttl right before the app's own `sendMessage` is processed.
3. Run the transformed source as the worker via a `blob:` URL. The photo now goes out as a real
   `inputMediaUploadedPhoto{ ttl_seconds }` over Telegram's own encrypted WebSocket.

If anything about the transform fails, we fall back to constructing the **original** worker
unmodified, so Telegram keeps working (disappearing mode is simply unavailable that session).

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open **https://web.telegram.org/a/** and log in. Open **Saved Messages**.

## Use

**Armed mode (recommended, most robust — reuses Telegram's own send pipeline):**
1. Bottom-right, click the **🔥 Disappearing: OFF** pill so it reads **ARMED**, set the seconds.
2. Send a photo the normal way (attach → Send). The next photo you send becomes a disappearing
   photo; the toggle auto-disarms after one photo.

**Fully programmatic (no UI interaction), from the page DevTools console:**
```js
// send an image (blob: URL string, Blob, or ArrayBuffer) to Saved Messages, 5s TTL
await window.disappearing.send('blob:https://web.telegram.org/....', 5);

// or fetch something same-origin first (as in the challenge video):
const blob = await (await fetch('/a/img-apple-touch-icon.png')).blob();
await window.disappearing.send(blob, 5);
```
Other helpers: `window.disappearing.arm(ttl)`, `.disarm()`, `.setTtl(n)`, `.status()`.

## How to verify it worked

- **On web:** the sent message renders as an **unsupported / not-viewable** media message —
  Telegram Web A cannot display self-destruct photos. That placeholder is the success signal.
- **On a phone/desktop client:** it appears as a **disappearing photo** with the countdown; after
  you open it and the timer elapses, it shows **expired**.
- **DevTools:** the console logs `[disappearing] worker patched — ttl sites: 1 …` and
  `MTProto worker instrumented ✔`. The WebSocket frame for the send shows the uploaded bytes.

## Assumptions, risks, and how they're handled

- **This was built by reading the `telegram-tt` source and the production build system; it has not
  yet been run against a live logged-in account in this environment.** The source analysis and all
  string-transform logic are unit-tested, but load it once and watch the console (below) to confirm
  the anchors match the exact deployed bundle.
- **CSP / blob workers.** A patched worker runs from a `blob:` URL; if the page CSP forbids blob
  workers the worker won't load. `rules.json` (declarativeNetRequest) strips Telegram's
  `Content-Security-Policy` **response** header on the document to guarantee it can. If Telegram
  ever delivered CSP via a `<meta>` tag instead, that can't be stripped after parse — in that case
  you'd see a CSP violation in the console on the blob worker; tell me and I'll switch to a
  meta-aware strategy.
- **Minifier anchors.** The transform keys off preserved tokens (`.InputMediaUploadedPhoto(`,
  `.InvokeWithLayer(`, `{deviceModel:`). If a future build changes these, `ttl sites: 0` will be
  logged and the extension no-ops safely (original worker). The anchors are easy to update.
- **One photo per arm** to avoid a stray consumer taking the one-shot ttl; re-arm for each.

## Files

- `manifest.json` — MV3; MAIN-world content script at `document_start`; declarativeNetRequest CSP rule.
- `disappearing.js` — the whole solution (Worker override, source transform, prelude, UI, API).
- `rules.json` — removes the document CSP header so the patched blob worker can load.

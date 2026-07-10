/*
 * Telegram Disappearing Photos — for web.telegram.org/a  (Telegram Web "A", the telegram-tt build)
 * ---------------------------------------------------------------------------------------------
 * WHY THE OBVIOUS APPROACHES DON'T WORK
 *
 *   Telegram Web A keeps its ENTIRE MTProto stack (GramJS client + the WebSocket + all
 *   AES-MTProto encryption) inside a dedicated `type:"module"` Web Worker. The page's main
 *   thread never touches `apiManager`/`invokeApi` (those don't exist here) and never sees the
 *   raw socket. The only thing crossing the main<->worker boundary is a tiny RPC:
 *
 *       worker.postMessage({ payloads: [{ type: 'callMethod', name: 'sendMessage', args: [...] }] })
 *
 *   So you cannot inject a request by writing to the WebSocket — the bytes are already
 *   encrypted by the time they get there. And you cannot delete-a-message-after-a-timer
 *   (what the old code did) — that is NOT a disappearing photo, it is just a normal photo that
 *   gets removed, and it leaves the recipient's copy intact.
 *
 *   A real disappearing photo is a native MTProto feature: `messages.sendMedia` where the media
 *   is `inputMediaUploadedPhoto` WITH a `ttl_seconds` field. Telegram Web A can build that field
 *   for documents/videos, but in `uploadMedia()` its PHOTO branch constructs
 *   `new Api.InputMediaUploadedPhoto({ file, spoiler })` and deliberately omits `ttlSeconds`.
 *   That single omission is the reason the UI has no disappearing-photo option.
 *
 * HOW THIS EXTENSION WORKS
 *
 *   1. It installs (in the page's MAIN world, before the app boots) an override of `Worker`.
 *   2. When the app spins up its MTProto worker, we fetch that worker's own bundled source,
 *      rewrite its relative import specifiers to absolute URLs (so it can be re-hosted from a
 *      Blob), and PATCH the `InputMediaUploadedPhoto({...})` construction to inject a
 *      `ttlSeconds` — read from a one-shot value we set from the outside.
 *   3. We run that patched source as the worker. Now the photo you send travels through
 *      Telegram's own real upload + serialization + encryption + WebSocket path, but arrives at
 *      the server as `inputMediaUploadedPhoto{ ttl_seconds: N }` — a genuine disappearing photo.
 *
 *   Two ways to fire it:
 *     • Armed mode (most robust): flip the on-page toggle, then send a photo normally. The next
 *       photo you send becomes disappearing. (We reuse 100% of Telegram's own send pipeline.)
 *     • Programmatic: `window.disappearing.send(blobUrlOrFileOrArrayBuffer, ttlSeconds)` uploads
 *       and sends a self-destruct photo to Saved Messages (InputPeerSelf) with no UI interaction,
 *       using the worker's own GramJS client (which we also expose during the same patch).
 *
 * Everything lives in this one content script (no bundled libraries, no external server),
 * satisfying the challenge rules.
 */

(function () {
  'use strict';

  var TAG = '[disappearing]';
  var CSS = 'color:#fff;background:#8774e1;padding:1px 5px;border-radius:4px';
  function log() {
    var a = ['%c' + TAG, CSS].concat([].slice.call(arguments));
    console.log.apply(console, a);
  }
  function warn() {
    var a = [TAG].concat([].slice.call(arguments));
    console.warn.apply(console, a);
  }

  // Persisted UI settings (page-origin localStorage; MAIN world has no chrome.* APIs).
  var settings = {
    armed: false,
    ttl: parseInt(localStorage.getItem('dp_ttl') || '', 10) || 5,
  };

  var OrigWorker = self.Worker;
  if (!OrigWorker) { warn('No Worker constructor; nothing to do.'); return; }

  // The single instrumented MTProto worker, once we find it.
  var mtprotoWorker = null;

  /* ------------------------------------------------------------------ *
   *  Source patching
   * ------------------------------------------------------------------ */

  function absoluteUrl(spec, base) {
    try { return new URL(spec, base).href; } catch (e) { return spec; }
  }

  // Rewrite the worker chunk so it can be executed from a blob: URL.
  //  - `import.meta.url` is replaced with the ORIGINAL worker URL literal, so any
  //    `new URL('./x', import.meta.url)` (nested workers, wasm, etc.) still resolves correctly.
  //  - relative import specifiers (static, side-effect, and dynamic) are made absolute, because
  //    from a blob: module the base URL would otherwise be the blob itself and fail to resolve.
  function rewriteImportsForBlob(src, baseUrl) {
    var baseLit = JSON.stringify(baseUrl);
    src = src.replace(/import\.meta\.url/g, baseLit);

    // static:  from"./x"  /  from '../x'
    src = src.replace(/from\s*(["'])(\.\.?\/[^"']*)\1/g, function (m, q, spec) {
      return 'from ' + q + absoluteUrl(spec, baseUrl) + q;
    });
    // side-effect:  import"./x"
    src = src.replace(/(^|[^.\w$])import\s*(["'])(\.\.?\/[^"']*)\2/g, function (m, pre, q, spec) {
      return pre + 'import ' + q + absoluteUrl(spec, baseUrl) + q;
    });
    // dynamic:  import("./x")
    src = src.replace(/import\(\s*(["'])(\.\.?\/[^"']*)\1\s*\)/g, function (m, q, spec) {
      return 'import(' + q + absoluteUrl(spec, baseUrl) + q + ')';
    });
    return src;
  }

  // Splice `,ttlSeconds:self.__dpConsumeTtl()` into every `.InputMediaUploadedPhoto({ ... })`
  // constructor's first object-literal argument, by matching balanced braces.
  function injectTtlIntoPhotoMedia(src) {
    var marker = '.InputMediaUploadedPhoto(';
    var count = 0;
    var from = 0;
    while (true) {
      var idx = src.indexOf(marker, from);
      if (idx === -1) break;
      var i = idx + marker.length;
      // find the first object literal that opens the argument list
      while (i < src.length && src[i] !== '{' && src[i] !== ')') i++;
      if (src[i] !== '{') { from = idx + marker.length; continue; }
      var depth = 0, j = i;
      for (; j < src.length; j++) {
        var c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      if (src[j] !== '}') { from = idx + marker.length; continue; }
      var inject = ',ttlSeconds:self.__dpConsumeTtl()';
      src = src.slice(0, j) + inject + src.slice(j);
      count++;
      from = j + inject.length + 1;
    }
    return { src: src, count: count };
  }

  // Best-effort: expose the GramJS `Api` namespace and the connected client on `self`
  // (they are module-private and DEBUG-only in production, so we re-expose them for the
  // fully-programmatic send path). Property/method names survive minification; only the
  // top-level identifiers are mangled, so we capture them by wrapping a known construction.
  function exposeGramInternals(src) {
    var exposed = { api: false, client: false };

    // Api — captured eagerly at connection setup: `new <Api>.InvokeWithLayer({`
    var before = src;
    src = src.replace(/([A-Za-z_$][\w$]*)\.InvokeWithLayer\(/, '(self.__dpApi=$1).InvokeWithLayer(');
    if (src !== before) exposed.api = true;
    else {
      // fallback: capture Api when a photo media object is constructed
      before = src;
      src = src.replace(/([A-Za-z_$][\w$]*)\.InputMediaUploadedPhoto\(/, '(self.__dpApi=$1).InputMediaUploadedPhoto(');
      if (src !== before) exposed.api = true;
    }

    // client — captured at `<client>=new TelegramClient(session,ID,"hash",{deviceModel:...})`
    before = src;
    src = src.replace(/([A-Za-z_$][\w$]*)(=new [A-Za-z_$][\w$]*\([^;]*?\{deviceModel:)/, '$1=self.__dpClient$2');
    if (src !== before) exposed.client = true;

    return { src: src, exposed: exposed };
  }

  /* ------------------------------------------------------------------ *
   *  Prelude injected at the TOP of the worker module.
   *  Serialized from a real function so we avoid string-escaping pain.
   *  It only touches worker globals (self, crypto, File, Blob, fetch, postMessage).
   * ------------------------------------------------------------------ */
  function WORKER_PRELUDE() {
    self.__dpArmed = false;
    self.__dpTtl = 5;
    self.__dpPendingTtl = undefined; // one-shot value consumed by the patched photo constructor

    // Consumed by the patched `new Api.InputMediaUploadedPhoto({..., ttlSeconds: self.__dpConsumeTtl()})`.
    // Returns undefined normally (identical to omitting the field), so ordinary sends are untouched.
    self.__dpConsumeTtl = function () {
      var t = self.__dpPendingTtl;
      self.__dpPendingTtl = undefined;
      if (t) {
        try { self.postMessage({ payloads: [], __dpEvent: { type: 'ttl-applied', ttl: t } }); } catch (e) {}
      }
      return t;
    };

    function randomId() {
      var b = new Uint8Array(8);
      (self.crypto || self.msCrypto).getRandomValues(b);
      var v = 0n;
      for (var i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
      return v;
    }

    // Fully-programmatic send of a self-destruct photo to Saved Messages (InputPeerSelf),
    // using the worker's own GramJS client. Requires the client+Api to have been exposed.
    self.__dpSendSelfDestruct = function (u8, ttl, mime) {
      return (async function () {
        var Api = self.__dpApi;
        var client = self.__dpClient;
        if (!client) throw new Error('GramJS client not ready yet (still connecting / not logged in).');
        if (!Api) throw new Error('GramJS Api not captured yet.');
        var ext = (mime && mime.split('/')[1]) || 'png';
        var file = new File([u8], 'photo.' + ext, { type: mime || 'image/png' });
        var inputFile = await client.uploadFile({ file: file, workers: 1 });
        var media = new Api.InputMediaUploadedPhoto({ file: inputFile, ttlSeconds: ttl });
        var req = new Api.messages.SendMedia({
          peer: new Api.InputPeerSelf(),
          media: media,
          message: '',
          randomId: randomId(),
        });
        await client.invoke(req);
        try { self.postMessage({ payloads: [], __dpEvent: { type: 'sent-programmatic', ttl: ttl } }); } catch (e) {}
        return true;
      })();
    };

    // Listen (in capture phase, and registered BEFORE the app's own onmessage handler because
    // this prelude runs first) for:
    //   • our control messages  -> arm/disarm, set ttl, or fire a programmatic send
    //   • the app's outgoing `sendMessage` RPC -> if armed and it's a photo, arm the one-shot ttl
    self.addEventListener('message', function (e) {
      var d = e.data;
      if (!d) return;

      if (d.__dpControl) {
        var c = d.__dpControl;
        if (c.cmd === 'config') {
          if (typeof c.armed === 'boolean') self.__dpArmed = c.armed;
          if (typeof c.ttl === 'number') self.__dpTtl = c.ttl;
        } else if (c.cmd === 'send') {
          self.__dpSendSelfDestruct(new Uint8Array(c.bytes), c.ttl, c.mime).catch(function (err) {
            try {
              self.postMessage({ payloads: [], __dpEvent: { type: 'error', message: String(err && err.message || err) } });
            } catch (e2) {}
          });
        }
        return;
      }

      // Detect the app's own photo send and arm the one-shot ttl just before it's processed.
      if (self.__dpArmed && d.payloads && d.payloads.length) {
        for (var i = 0; i < d.payloads.length; i++) {
          var p = d.payloads[i];
          if (p && p.type === 'callMethod' && p.name === 'sendMessage' && p.args && p.args[0]) {
            var att = p.args[0].attachment;
            if (att && att.quick && typeof att.mimeType === 'string' &&
                att.mimeType.indexOf('image/') === 0 && att.mimeType !== 'image/gif') {
              self.__dpPendingTtl = self.__dpTtl;
              self.__dpArmed = false; // one photo per arm
              try {
                self.postMessage({ payloads: [], __dpEvent: { type: 'armed-consumed', ttl: self.__dpTtl } });
              } catch (e3) {}
            }
          }
        }
      }
    }, true);

    try { self.postMessage({ payloads: [], __dpEvent: { type: 'worker-instrumented' } }); } catch (e) {}
  }

  var PRELUDE_SRC = '/* disappearing-photos prelude */(' + WORKER_PRELUDE.toString() + ')();\n';

  /* ------------------------------------------------------------------ *
   *  Build the patched worker source (synchronously — Worker ctor is sync).
   * ------------------------------------------------------------------ */

  function syncFetchText(url) {
    var x = new XMLHttpRequest();
    x.open('GET', url, false); // synchronous: runs once at startup
    x.send(null);
    if (x.status >= 200 && x.status < 300) return x.responseText;
    throw new Error('sync fetch ' + url + ' -> HTTP ' + x.status);
  }

  function buildPatchedWorker(originalUrl) {
    var src = syncFetchText(originalUrl);
    if (src.indexOf('.InputMediaUploadedPhoto(') === -1) return null; // not the MTProto worker

    src = rewriteImportsForBlob(src, originalUrl);

    var g = exposeGramInternals(src);
    src = g.src;

    var t = injectTtlIntoPhotoMedia(src);
    src = t.src;
    if (t.count === 0) {
      warn('Found InputMediaUploadedPhoto but could not splice ttlSeconds; aborting instrumentation.');
      return null;
    }

    log('worker patched — ttl sites:', t.count,
        '| Api exposed:', g.exposed.api, '| client exposed:', g.exposed.client);

    var blob = new Blob([PRELUDE_SRC + src], { type: 'text/javascript' });
    return URL.createObjectURL(blob);
  }

  /* ------------------------------------------------------------------ *
   *  Worker override
   * ------------------------------------------------------------------ */

  function isSameOriginScript(urlStr) {
    try {
      var u = new URL(urlStr, location.href);
      return u.origin === location.origin && /^https?:$/.test(u.protocol);
    } catch (e) { return false; }
  }

  function PatchedWorker(scriptURL, options) {
    var finalURL = scriptURL;
    var instrumented = false;

    try {
      var urlStr = (scriptURL instanceof URL) ? scriptURL.href : String(scriptURL);
      var isModule = options && options.type === 'module';
      if (isModule && isSameOriginScript(urlStr)) {
        var blobUrl = buildPatchedWorker(new URL(urlStr, location.href).href);
        if (blobUrl) { finalURL = blobUrl; instrumented = true; }
      }
    } catch (err) {
      warn('instrumentation failed, falling back to original worker:', err);
      finalURL = scriptURL;
      instrumented = false;
    }

    var w = new OrigWorker(finalURL, options);

    if (instrumented) {
      mtprotoWorker = w;
      wireWorker(w);
      pushConfig(); // sync current armed/ttl into the worker
      log('MTProto worker instrumented ✔');
    }
    return w;
  }
  PatchedWorker.prototype = OrigWorker.prototype;

  try {
    self.Worker = PatchedWorker;
  } catch (e) {
    // Some environments make Worker non-writable; fall back to defineProperty.
    try { Object.defineProperty(self, 'Worker', { value: PatchedWorker, writable: true, configurable: true }); }
    catch (e2) { warn('Could not override Worker:', e2); }
  }

  /* ------------------------------------------------------------------ *
   *  Main <-> worker bridge
   * ------------------------------------------------------------------ */

  // NB: our worker->main events are shaped `{ payloads: [], __dpEvent }` so Telegram's own
  // message handler (`data.payloads.forEach(...)`) sees an empty array and does nothing.
  function wireWorker(w) {
    w.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || !d.__dpEvent) return;
      var ev = d.__dpEvent;
      if (ev.type === 'worker-instrumented') {
        toast('Disappearing-photo engine ready');
      } else if (ev.type === 'armed-consumed' || ev.type === 'ttl-applied') {
        settings.armed = false;
        renderUI();
        toast('🔥 Next photo sent as disappearing (' + ev.ttl + 's)');
      } else if (ev.type === 'sent-programmatic') {
        toast('🔥 Disappearing photo sent to Saved Messages (' + ev.ttl + 's)');
      } else if (ev.type === 'error') {
        toast('⚠ ' + ev.message, true);
        warn('worker error:', ev.message);
      }
    });
  }

  function pushConfig() {
    if (!mtprotoWorker) return;
    mtprotoWorker.postMessage({
      payloads: [],
      __dpControl: { cmd: 'config', armed: settings.armed, ttl: settings.ttl },
    });
  }

  /* ------------------------------------------------------------------ *
   *  Public programmatic API
   * ------------------------------------------------------------------ */

  async function programmaticSend(source, ttl) {
    if (!mtprotoWorker) throw new Error('MTProto worker not instrumented yet — reload the page.');
    var seconds = ttl || settings.ttl;
    var bytes, mime = 'image/png';

    if (source instanceof Blob) {
      mime = source.type || mime;
      bytes = await source.arrayBuffer();
    } else if (source instanceof ArrayBuffer) {
      bytes = source;
    } else if (typeof source === 'string') {
      var r = await fetch(source);
      mime = r.headers.get('content-type') || mime;
      bytes = await r.arrayBuffer();
    } else {
      throw new Error('send(source): source must be a blob: URL string, Blob, or ArrayBuffer');
    }

    mtprotoWorker.postMessage(
      { payloads: [], __dpControl: { cmd: 'send', bytes: bytes, ttl: seconds, mime: mime } },
      [bytes]
    );
    log('programmatic self-destruct send dispatched (' + seconds + 's,', mime + ')');
    return true;
  }

  self.disappearing = {
    arm: function (ttl) { if (ttl) setTtl(ttl); settings.armed = true; pushConfig(); renderUI(); return settings; },
    disarm: function () { settings.armed = false; pushConfig(); renderUI(); return settings; },
    setTtl: function (n) { setTtl(n); return settings; },
    status: function () { return { armed: settings.armed, ttl: settings.ttl, ready: !!mtprotoWorker }; },
    send: programmaticSend,
  };

  function setTtl(n) {
    n = Math.max(1, Math.min(60, parseInt(n, 10) || 5));
    settings.ttl = n;
    localStorage.setItem('dp_ttl', String(n));
    pushConfig();
  }

  /* ------------------------------------------------------------------ *
   *  On-page UI (floating control)
   * ------------------------------------------------------------------ */

  var ui = null;

  function toast(msg, isError) {
    try {
      var t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText =
        'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:2147483647;' +
        'background:' + (isError ? '#c0392b' : '#8774e1') + ';color:#fff;padding:9px 14px;' +
        'border-radius:9px;font:13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;' +
        'box-shadow:0 4px 18px rgba(0,0,0,.3);opacity:0;transition:opacity .2s';
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.style.opacity = '1'; });
      setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 250); }, 2600);
    } catch (e) {}
  }

  function buildUI() {
    if (ui || !document.body) return;
    ui = document.createElement('div');
    ui.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;' +
      'background:#212121;color:#fff;padding:8px 10px;border-radius:12px;' +
      'font:13px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);' +
      'user-select:none';

    var toggle = document.createElement('button');
    toggle.id = 'dp-toggle';
    toggle.style.cssText =
      'border:0;cursor:pointer;border-radius:9px;padding:7px 12px;font-weight:600;font-size:13px;color:#fff';
    toggle.onclick = function () { settings.armed = !settings.armed; pushConfig(); renderUI(); };

    var label = document.createElement('span');
    label.textContent = 'burn after';

    var ttlInput = document.createElement('input');
    ttlInput.id = 'dp-ttl';
    ttlInput.type = 'number';
    ttlInput.min = '1';
    ttlInput.max = '60';
    ttlInput.value = String(settings.ttl);
    ttlInput.style.cssText =
      'width:46px;padding:5px 6px;border-radius:7px;border:1px solid #444;background:#111;color:#fff;font-size:13px';
    ttlInput.onchange = function () { setTtl(ttlInput.value); ttlInput.value = String(settings.ttl); };

    var sec = document.createElement('span');
    sec.textContent = 's';

    ui.appendChild(toggle);
    ui.appendChild(label);
    ui.appendChild(ttlInput);
    ui.appendChild(sec);
    document.body.appendChild(ui);
    renderUI();
  }

  function renderUI() {
    if (!ui) return;
    var toggle = ui.querySelector('#dp-toggle');
    var ttlInput = ui.querySelector('#dp-ttl');
    if (ttlInput) ttlInput.value = String(settings.ttl);
    if (toggle) {
      toggle.textContent = settings.armed ? '🔥 Disappearing: ARMED' : '🔥 Disappearing: OFF';
      toggle.style.background = settings.armed ? '#e0483d' : '#8774e1';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }

  log('loaded — Worker override installed. Use the on-page toggle, or window.disappearing.send(...).');
})();

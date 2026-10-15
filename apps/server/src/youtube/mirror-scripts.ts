/**
 * Scripts the YouTube mirror injects into every mirrored HTML page (see mirror.ts). They run in
 * the guest's phone inside the Browse panel's iframe, which is same-origin with the hub.
 *
 * `MIRROR_HEAD_SCRIPT` runs first (start of `<head>`, before any YouTube script):
 *   - shows YouTube its native path (`/yt/results` → `/results`) so its router works, while every
 *     network call that would hit the hub root (`fetch`, XHR, `sendBeacon`, `Worker`, script /
 *     link / img / iframe `src`/`href`) is sent to `/yt/...` instead, and absolute YouTube URLs
 *     too;
 *   - blocks service workers, `window.open` and media playback;
 *   - turns a `pushState`/`replaceState` to `/watch`, `/shorts/` or `/playlist` into a pick;
 *   - fixes plain link navigations (not handled by YouTube's own router) to stay under `/yt/`.
 *
 * `MIRROR_PICK_SCRIPT` (before `</body>`) captures taps on anything that resolves to a video and
 * posts `{ type: 'rj-pick', videoId, title }` to the parent (the guest page), deduped within
 * 500 ms. YouTube's own search box, suggestions, filters and scrolling are untouched.
 *
 * Both are plain ES5-ish JavaScript strings (no build step; they run in YouTube's page).
 */

export const MIRROR_HEAD_SCRIPT = String.raw`(function () {
  if (window.__rjMirror) return;
  window.__rjMirror = true;
  var P = '/yt';
  var O = location.origin;
  var YT = /^(?:https?:)?\/\/(?:www\.|m\.)?youtube\.com(?=[\/?#]|$)/i;
  var GS = /^(?:https?:)?\/\/www\.gstatic\.com\/youtube\/img(?=\/)/i;
  var SQ = /^(?:https?:)?\/\/suggestqueries-clients6\.youtube\.com(?=[\/?#]|$)/i;
  var ID = /^[\w-]{11}$/;
  var last = { id: '', t: 0 };
  function pick(id, title) {
    if (!ID.test(id || '')) return;
    var now = Date.now();
    if (id === last.id && now - last.t < 500) return;
    last = { id: id, t: now };
    try { parent.postMessage({ type: 'rj-pick', videoId: id, title: title || '' }, '*'); } catch (e) {}
  }
  window.__rjPick = pick;
  function videoIdOf(u) {
    if (typeof u !== 'string') return null;
    var m = /[?&]v=([\w-]{11})/.exec(u) || /\/shorts\/([\w-]{11})/.exec(u) || /youtu\.be\/([\w-]{11})/.exec(u);
    return m ? m[1] : null;
  }
  window.__rjVideoIdOf = videoIdOf;
  function isVideoPath(u) {
    try {
      var p = new URL(String(u), location.href).pathname.replace(/^\/yt(?=\/)/, '');
      return /^\/(watch|shorts\/|playlist)/.test(p);
    } catch (e) { return false; }
  }
  /** Any URL this page asks for: hub-root and YouTube URLs go through /yt. */
  function fix(u) {
    if (u == null) return u;
    var s = String(u);
    if (/^(data|blob|javascript|about|mailto):/i.test(s)) return u;
    if (YT.test(s)) return s.replace(YT, O + P);
    if (GS.test(s)) return s.replace(GS, O + P + '/_gstatic/youtube/img');
    if (SQ.test(s)) return s.replace(SQ, O + P + '/_suggest');
    try {
      var url = new URL(s, location.href);
      if (url.origin !== O) return u;
      if (url.pathname === P || url.pathname.indexOf(P + '/') === 0) return u;
      return O + P + url.pathname + url.search + url.hash;
    } catch (e) { return u; }
  }
  window.__rjFix = fix;

  // YouTube's router sees its own path.
  if (location.pathname.indexOf(P + '/') === 0) {
    history.replaceState(history.state, '', location.pathname.slice(P.length) + location.search + location.hash);
  }

  // Chrome only streams request bodies over HTTP/2 (else ERR_ALPN_NEGOTIATION_FAILED) and the hub
  // is plain HTTP/1.1, so YouTube's streamed (gzip) bodies are buffered first.
  var F = window.fetch;
  var RS = window.ReadableStream;
  if (F) {
    window.fetch = function (input, init) {
      var self = this;
      try {
        if (typeof input === 'string' || input instanceof URL) input = fix(String(input));
        if (init && RS && init.body instanceof RS) {
          var i2 = Object.assign({}, init);
          delete i2.duplex;
          return new Response(init.body).arrayBuffer().then(function (buf) {
            i2.body = buf;
            return F.call(self, input, i2);
          });
        }
        if (input && typeof input === 'object' && input.url) {
          var req = input;
          var url = fix(req.url);
          if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
            return req.arrayBuffer().then(function (buf) {
              var opts = {
                method: req.method, headers: req.headers, body: buf, credentials: req.credentials,
                cache: req.cache, redirect: req.redirect, signal: req.signal,
              };
              return F.call(self, new Request(url, opts), init);
            });
          }
          if (url !== req.url) input = new Request(url, req);
        }
      } catch (e) {}
      return F.call(self, input, init);
    };
  }
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var a = Array.prototype.slice.call(arguments);
    a[1] = fix(u);
    return XO.apply(this, a);
  };
  if (navigator.sendBeacon) {
    var SB = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return SB(fix(u), d); };
  }
  if (window.Worker) {
    var W = window.Worker;
    window.Worker = function (u, o) { return new W(fix(u), o); };
    window.Worker.prototype = W.prototype;
  }
  function hookProp(proto, prop) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (v) { d.set.call(this, fix(v)); },
    });
  }
  hookProp(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  hookProp(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href');
  hookProp(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  hookProp(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src');
  hookProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  var SA = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    var t = this.tagName;
    if ((n === 'src' || n === 'href') && (t === 'SCRIPT' || t === 'LINK' || t === 'IMG' || t === 'IFRAME' || t === 'SOURCE')) {
      v = fix(v);
    }
    return SA.call(this, n, v);
  };

  // Navigation to a video becomes a pick and never happens.
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function (s, t, u) {
      if (u != null && isVideoPath(u)) {
        var id = videoIdOf(String(u));
        if (id) pick(id, window.__rjLastTitle && window.__rjLastTitle.id === id ? window.__rjLastTitle.title : '');
        return;
      }
      return orig.apply(this, arguments);
    };
  });

  // No service worker, no popups, no playback.
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled')); };
    }
  } catch (e) {}
  window.open = function () { return null; };
  if (window.HTMLMediaElement) {
    HTMLMediaElement.prototype.play = function () {
      try { this.pause(); } catch (e) {}
      return Promise.reject(new DOMException('Playback is off in the jukebox browser', 'NotAllowedError'));
    };
  }

  // A plain link that YouTube's router didn't take: keep it under /yt.
  window.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var f = fix(a.href);
    if (f !== a.href) a.href = f;
  }, false);
})();`;

export const MIRROR_PICK_SCRIPT = String.raw`(function () {
  if (window.__rjPickInstalled) return;
  window.__rjPickInstalled = true;
  var ID = /^[\w-]{11}$/;
  var RENDERERS = 'ytm-compact-video-renderer, ytm-video-with-context-renderer, ytm-rich-item-renderer, ytm-compact-radio-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-reel-item-renderer, ytm-media-item, ytm-item-section-renderer > *';
  var MENU = 'ytm-menu-renderer, ytm-menu, .media-item-menu, [aria-haspopup], button[aria-label*="menu" i], button[aria-label*="action" i]';
  var HEADLINE = '.compact-media-item-headline, .media-item-headline, .yt-core-attributed-string[role="text"], h3, h4, [role="heading"]';
  function videoIdOf(u) { return window.__rjVideoIdOf ? window.__rjVideoIdOf(u) : null; }
  function idOfNode(n) {
    if (!n || !n.getAttribute) return null;
    if (n.tagName === 'A') {
      var h = videoIdOf(n.getAttribute('href') || '');
      if (h) return h;
    }
    var attrs = ['data-video-id', 'video-id', 'data-videoid', 'data-vid'];
    for (var i = 0; i < attrs.length; i++) {
      var v = n.getAttribute(attrs[i]);
      if (v && ID.test(v)) return v;
    }
    return null;
  }
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function titleOf(box, a) {
    var h = box && box.querySelector ? box.querySelector(HEADLINE) : null;
    var t = clean(h && h.textContent);
    if (t) return t;
    var lab = a && a.getAttribute && a.getAttribute('aria-label');
    if (!lab && box && box.querySelector) {
      var l = box.querySelector('[aria-label]');
      lab = l && l.getAttribute('aria-label');
    }
    lab = clean(lab);
    // "Title - 3 minutes, 2 seconds - Go to channel - ..." → "Title"
    return lab.split(/ [-–] (?:\d|Go to channel|play video)/i)[0] || clean(a && a.textContent);
  }
  function resolve(target) {
    if (!target || !target.closest) return null;
    if (target.closest(MENU)) return null;
    for (var n = target; n && n !== document.body; n = n.parentElement) {
      var id = idOfNode(n);
      if (id) {
        var box = n.closest(RENDERERS) || n;
        return { id: id, title: titleOf(box, n) };
      }
    }
    var r = target.closest(RENDERERS);
    if (r) {
      var a = r.querySelector('a[href*="/watch?"], a[href*="v="], a[href*="/shorts/"], [data-video-id], [video-id]');
      var aid = idOfNode(a);
      if (aid) return { id: aid, title: titleOf(r, a) };
    }
    return null;
  }
  function onTap(e) {
    var hit = resolve(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    window.__rjLastTitle = hit;
    if (e.type === 'click' && window.__rjPick) window.__rjPick(hit.id, hit.title);
  }
  // Capture phase on window: runs before any of YouTube's listeners.
  window.addEventListener('click', onTap, true);
  // Remember the title on touch, so a pushState that slips through still carries it.
  window.addEventListener('touchstart', function (e) {
    var hit = resolve(e.target);
    if (hit) window.__rjLastTitle = hit;
  }, { capture: true, passive: true });
})();`;

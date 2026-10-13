// studio/ml/ml-worker.js
// The model worker. It is started by studio/ml/ml-frame.js inside the isolated frame (studio-ml-frame.html), from a blob, so it runs
// under that frame's Content-Security-Policy: scripts from this site only, WebAssembly, and connect-src limited to this site's own
// static files. It has no DOM. Heavy work (speech to text, background cut-outs) runs here so the editor stays responsive.
(function () {
  'use strict';
  var BASE = '', ortReady = false;
  var whisper = null, matte = null, loading = {};
  var cancelled = Object.create(null);

  function reply(msg, transfer) { try { self.postMessage(msg, transfer || []); } catch (e) { /* frame gone */ } }

  function initOrt() {
    if (ortReady) return;
    if (typeof ort === 'undefined') throw new Error('The speech and image runtime did not load.');
    ort.env.wasm.wasmPaths = BASE; // absolute URL (the worker starts from a blob, which has no usable base) ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'error';
    ortReady = true;
  }

  // Fetches a file with progress. Parts are joined in order (the big decoder is stored in pieces so each file stays small).
  function fetchBytes(urls, onProgress) {
    var sizes = new Array(urls.length), got = new Array(urls.length), i;
    for (i = 0; i < urls.length; i++) { sizes[i] = 0; got[i] = 0; }
    function report() { var l = got.reduce(function (a, b) { return a + b; }, 0), t = sizes.reduce(function (a, b) { return a + b; }, 0); onProgress(l, Math.max(t, l)); }
    return Promise.all(urls.map(function (u, idx) {
      return fetch(u, { credentials: 'omit', cache: 'force-cache' }).then(function (r) {
        if (!r.ok) throw new Error('Could not load ' + u.split('/').pop() + ' (' + r.status + ').');
        sizes[idx] = Number(r.headers.get('content-length')) || 0; report();
        if (!r.body || !r.body.getReader) return r.arrayBuffer().then(function (b) { got[idx] = b.byteLength; sizes[idx] = b.byteLength; report(); return new Uint8Array(b); });
        var rd = r.body.getReader(), chunks = [], n = 0;
        function pump() { return rd.read().then(function (x) { if (x.done) return; chunks.push(x.value); n += x.value.length; got[idx] = n; report(); return pump(); }); }
        return pump().then(function () { var out = new Uint8Array(n), p = 0; chunks.forEach(function (c) { out.set(c, p); p += c.length; }); return out; });
      });
    })).then(function (parts) {
      var total = parts.reduce(function (a, p) { return a + p.length; }, 0), out = new Uint8Array(total), p = 0;
      parts.forEach(function (x) { out.set(x, p); p += x.length; }); return out;
    });
  }

  function loadWhisper(id) {
    if (whisper) return Promise.resolve();
    if (loading.whisper) return loading.whisper;
    initOrt();
    var pe = [0, 0], pd = [0, 0];
    var prog = function () { reply({ type: 'progress', id: id, what: 'Downloading the speech model', loaded: pe[0] + pd[0], total: Math.max(pe[1] + pd[1], pe[0] + pd[0]) }); };
    loading.whisper = Promise.all([
      fetchBytes([BASE + 'models/whisper-tiny-encoder.int8.onnx'], function (l, t) { pe = [l, t]; prog(); }),
      fetchBytes([0, 1, 2].map(function (i) { return BASE + 'models/whisper-tiny-decoder.onnx.part' + i; }), function (l, t) { pd = [l, t]; prog(); }),
      fetch(BASE + 'models/whisper-tiny-tokens.txt', { credentials: 'omit', cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error('Could not load the speech vocabulary.'); return r.text(); }),
    ]).then(function (r) {
      reply({ type: 'progress', id: id, what: 'Starting the speech model', loaded: 1, total: 1, indeterminate: true });
      return CogWhisper.create(ort, r[0], r[1], r[2]);
    }).then(function (w) { whisper = w; }).finally(function () { loading.whisper = null; });
    return loading.whisper;
  }
  function loadMatte(id) {
    if (matte) return Promise.resolve();
    if (loading.matte) return loading.matte;
    initOrt();
    loading.matte = fetchBytes([BASE + 'models/u2netp.onnx'], function (l, t) { reply({ type: 'progress', id: id, what: 'Downloading the cut-out model', loaded: l, total: t }); })
      .then(function (b) { return CogMatte.create(ort, b); }).then(function (m) { matte = m; }).finally(function () { loading.matte = null; });
    return loading.matte;
  }

  // One job at a time: the runtime is single threaded, and requests must not interleave their progress.
  var queue = Promise.resolve();
  function handle(msg) {
    var id = msg.id;
    if (msg.op === 'cancel') { cancelled[msg.target] = true; if (whisper) whisper.cancel(); return Promise.resolve(); }
    if (msg.op === 'load') return (msg.model === 'whisper' ? loadWhisper(id) : loadMatte(id)).then(function () { reply({ type: 'done', id: id, result: { ok: true } }); });
    if (msg.op === 'transcribe') {
      return loadWhisper(id).then(function () {
        if (cancelled[id]) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        var pcm = new Float32Array(msg.pcm);
        return whisper.transcribe(pcm, { lang: msg.lang || 'auto', onProgress: function (f) { reply({ type: 'progress', id: id, what: 'Transcribing', loaded: f, total: 1, work: true }); } });
      }).then(function (r) { reply({ type: 'done', id: id, result: r }); });
    }
    if (msg.op === 'matte') {
      return loadMatte(id).then(function () {
        var count = Math.min(Number(msg.count) || 0, 64), size = CogMatte.SIZE * CogMatte.SIZE * 4, out = [], i = 0;
        if (!(msg.pixels instanceof ArrayBuffer) || msg.pixels.byteLength < count * size) throw new Error('The picture data was not the expected size.');
        function next() {
          if (i >= count) return Promise.resolve();
          if (cancelled[id]) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          var px = new Uint8Array(msg.pixels, i * size, size);
          return CogMatte.segment(matte, px).then(function (a) { out.push(a); i++; reply({ type: 'progress', id: id, what: 'Cutting out', loaded: i, total: count, work: true }); return next(); });
        }
        return next().then(function () {
          var all = new Uint8Array(out.length * CogMatte.SIZE * CogMatte.SIZE); out.forEach(function (a, k) { all.set(a, k * a.length); });
          reply({ type: 'done', id: id, result: { count: out.length, size: CogMatte.SIZE, alpha: all.buffer } }, [all.buffer]);
        });
      });
    }
    return Promise.reject(new Error('Unknown request.'));
  }

  self.onmessage = function (e) {
    var m = e.data; if (!m || typeof m !== 'object') return;
    if (m.op === 'init') {
      BASE = String(m.base || '');
      try { importScripts(BASE + 'ort.wasm.min.js', BASE + 'whisper-core.js', BASE + 'matte-core.js'); reply({ type: 'worker-ready', runtime: typeof ort !== 'undefined' && ort.env && ort.env.versions ? ort.env.versions.web : 'unknown' }); }
      catch (err) { reply({ type: 'worker-failed', message: String(err && err.message || err).slice(0, 200) }); }
      return;
    }
    if (typeof m.id !== 'string') return;
    if (m.op === 'cancel') { handle(m); return; }
    queue = queue.then(function () { return handle(m); }).catch(function (err) {
      reply({ type: 'error', id: m.id, name: err && err.name, message: String(err && err.message || err).slice(0, 300) });
    });
  };
})();

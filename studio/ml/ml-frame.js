// studio/ml/ml-frame.js
// The isolated frame (studio-ml-frame.html). It runs in a sandboxed iframe with an opaque origin: no cookies, no storage, no access to
// the Cognita page, and a Content-Security-Policy that allows scripts from this site only, WebAssembly, and connect-src to this site's
// own static files (the models). Nothing can be sent anywhere else.
// This file only does three things: check that a request comes from the parent window with the session token the parent chose in
// 'hello', start the model worker (from a blob, so it inherits this frame's policy and runs off the main thread), and pass messages
// between the parent and the worker. The model code is in ml-worker.js.
(function () {
  'use strict';
  var parentWin = window.parent, token = null, worker = null, workerReady = false, startErr = '';
  var BASE = new URL('/studio/ml/', document.baseURI).href;

  function toParent(msg, transfer) { try { parentWin.postMessage(msg, '*', transfer || []); } catch (e) { /* parent gone */ } }

  function startWorker() {
    return fetch(BASE + 'ml-worker.js', { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('The model worker could not be loaded (' + r.status + ').');
      return r.text();
    }).then(function (code) {
      var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      worker = new Worker(url);
      return new Promise(function (resolve, reject) {
        worker.onmessage = function (e) {
          var m = e.data || {};
          if (m.type === 'worker-ready') { workerReady = true; worker.onmessage = relayFromWorker; URL.revokeObjectURL(url); resolve(m); }
          else if (m.type === 'worker-failed') reject(new Error(m.message || 'The model worker failed to start.'));
        };
        worker.onerror = function (e) { reject(new Error('The model worker failed to start' + (e && e.message ? ': ' + e.message : '.'))); };
        worker.postMessage({ op: 'init', base: BASE });
      });
    });
  }
  function relayFromWorker(e) {
    var m = e.data; if (!m || typeof m !== 'object') return;
    var transfer = m.type === 'done' && m.result && m.result.alpha instanceof ArrayBuffer ? [m.result.alpha] : [];
    toParent(m, transfer);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data; if (!m || typeof m !== 'object') return;
    if (m.op === 'hello') {
      if (token) return; token = String(m.token || ''); if (!token) { token = null; return; }
      startWorker().then(function (info) { toParent({ type: 'ready', token: token, runtime: info.runtime, wasm: typeof WebAssembly === 'object', worker: true }); })
        .catch(function (err) { startErr = err.message; toParent({ type: 'startup-error', token: token, message: startErr }); });
      return;
    }
    if (!token || m.token !== token || typeof m.id !== 'string' || !worker || !workerReady) return;
    var transfer = []; if (m.pcm instanceof ArrayBuffer) transfer.push(m.pcm); if (m.pixels instanceof ArrayBuffer) transfer.push(m.pixels);
    var out = {}; Object.keys(m).forEach(function (k) { if (k !== 'token') out[k] = m[k]; });
    worker.postMessage(out, transfer);
  });
})();

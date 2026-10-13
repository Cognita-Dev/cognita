// studio/ml/matte-core.js
// Background removal on this device: U2-Net-P ("u2netp", Apache-2.0, 4.5 MB) through onnxruntime-web.
// Classic script, loaded only inside the isolated ML frame. Input: 320x320 RGBA pixels. Output: 320x320 alpha (0 = background, 255 = subject).
(function (root) {
  'use strict';
  var S = 320;
  function create(ort, modelBytes) {
    return ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }).then(function (session) {
      return { session: session, inputName: session.inputNames[0], outputName: session.outputNames[0], ort: ort };
    });
  }
  // rgba: Uint8ClampedArray or Uint8Array of S*S*4
  function segment(m, rgba) {
    var n = S * S, data = new Float32Array(3 * n), i, mx = 1e-6;
    for (i = 0; i < n; i++) { var v = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]); if (v > mx) mx = v; }
    var mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (i = 0; i < n; i++) for (var c = 0; c < 3; c++) data[c * n + i] = (rgba[i * 4 + c] / mx - mean[c]) / std[c];
    var feeds = {}; feeds[m.inputName] = new m.ort.Tensor('float32', data, [1, 3, S, S]);
    return m.session.run(feeds).then(function (out) {
      var pred = out[m.outputName].data, lo = Infinity, hi = -Infinity, k;
      for (k = 0; k < n; k++) { var p = pred[k]; if (p < lo) lo = p; if (p > hi) hi = p; }
      var span = Math.max(hi - lo, 1e-6), alpha = new Uint8Array(n);
      for (k = 0; k < n; k++) alpha[k] = Math.round(((pred[k] - lo) / span) * 255);
      return alpha;
    });
  }
  root.CogMatte = { create: create, segment: segment, SIZE: S };
})(typeof self !== 'undefined' ? self : this);

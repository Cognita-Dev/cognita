// studio/ml/whisper-core.js
// Whisper "tiny" (multilingual) speech to text, running on this device through onnxruntime-web.
// Classic script (no modules, no eval). Loaded only inside the isolated ML frame (studio-ml-frame.html).
// Model: the sherpa-onnx export of openai/whisper-tiny (MIT), int8 encoder and decoder. The decoder's token embedding is stored as
// float16 (lossless for these weights, checked) so the download is 50 MB instead of 90 MB.
// Pipeline: 16 kHz mono sound -> log-mel spectrogram (same maths as OpenAI's) -> encoder -> greedy decoding with the standard
// timestamp rules, a no-speech check, a repetition guard and a seek loop for chunks the model stops early on.
(function (root) {
  'use strict';
  var SR = 16000, N_FFT = 400, HOP = 160, N_MELS = 80, N_SAMPLES = 30 * SR, N_FRAMES = 3000;
  var TOK = { eot: 50257, sot: 50258, langBase: 50259, translate: 50358, transcribe: 50359, nospeech: 50362, notimestamps: 50363, tsBegin: 50364 };
  var LANGS = 'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su'.split(' ');
  var MAX_TOKENS = 224, VOCAB = 51865, MAX_SEEK_ROUNDS = 5;

  // ───────── log-mel spectrogram ─────────
  var cache = null;
  function hz2mel(f) { return f >= 1000 ? 15 + Math.log(f / 1000) / (Math.log(6.4) / 27) : f / (200 / 3); }
  function mel2hz(m) { return m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 / 3) * m; }
  function tables() {
    if (cache) return cache;
    var nb = N_FFT / 2 + 1, i, k, n;
    var cosT = new Float64Array(nb * N_FFT), sinT = new Float64Array(nb * N_FFT);
    for (k = 0; k < nb; k++) for (n = 0; n < N_FFT; n++) { var a = 2 * Math.PI * ((k * n) % N_FFT) / N_FFT; cosT[k * N_FFT + n] = Math.cos(a); sinT[k * N_FFT + n] = Math.sin(a); }
    var win = new Float64Array(N_FFT); for (n = 0; n < N_FFT; n++) win[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT);
    var pts = new Float64Array(N_MELS + 2), m0 = hz2mel(0), m1 = hz2mel(SR / 2);
    for (i = 0; i < N_MELS + 2; i++) pts[i] = mel2hz(m0 + (m1 - m0) * i / (N_MELS + 1));
    var fb = new Float32Array(N_MELS * nb);
    for (i = 0; i < N_MELS; i++) {
      var fd0 = pts[i + 1] - pts[i], fd1 = pts[i + 2] - pts[i + 1], enorm = 2 / (pts[i + 2] - pts[i]);
      for (k = 0; k < nb; k++) { var f = k * (SR / 2) / (nb - 1); var lower = -(pts[i] - f) / fd0, upper = (pts[i + 2] - f) / fd1; fb[i * nb + k] = Math.max(0, Math.min(lower, upper)) * enorm; }
    }
    cache = { nb: nb, cosT: cosT, sinT: sinT, win: win, fb: fb };
    return cache;
  }
  // pcm: Float32Array of 16 kHz mono sound, at most 30 s. Returns Float32Array [80 * 3000], row-major (mel bin, frame).
  function logMel(pcm) {
    var T = tables(), nb = T.nb, x = new Float32Array(N_SAMPLES), n = Math.min(pcm.length, N_SAMPLES), i, k, f;
    x.set(pcm.subarray(0, n));
    var padded = new Float32Array(N_SAMPLES + N_FFT);
    for (i = 0; i < N_SAMPLES; i++) padded[i + N_FFT / 2] = x[i];
    for (i = 0; i < N_FFT / 2; i++) { padded[N_FFT / 2 - 1 - i] = x[i + 1]; padded[N_SAMPLES + N_FFT / 2 + i] = x[N_SAMPLES - 2 - i]; }
    var power = new Float32Array(nb * N_FRAMES), frame = new Float64Array(N_FFT);
    for (f = 0; f < N_FRAMES; f++) {
      var off = f * HOP, any = false;
      for (i = 0; i < N_FFT; i++) { var v = padded[off + i]; if (v !== 0) any = true; frame[i] = v * T.win[i]; }
      if (!any) continue;
      for (k = 0; k < nb; k++) {
        var re = 0, im = 0, base = k * N_FFT;
        for (i = 0; i < N_FFT; i++) { var s = frame[i]; re += s * T.cosT[base + i]; im += s * T.sinT[base + i]; }
        power[k * N_FRAMES + f] = re * re + im * im;
      }
    }
    var mel = new Float32Array(N_MELS * N_FRAMES), mx = -1e30, m;
    for (m = 0; m < N_MELS; m++) {
      for (k = 0; k < nb; k++) {
        var w = T.fb[m * nb + k]; if (w === 0) continue;
        var pr = k * N_FRAMES, mr = m * N_FRAMES;
        for (f = 0; f < N_FRAMES; f++) mel[mr + f] += w * power[pr + f];
      }
    }
    for (i = 0; i < mel.length; i++) { var l = Math.log10(Math.max(mel[i], 1e-10)); mel[i] = l; if (l > mx) mx = l; }
    var floor = mx - 8;
    for (i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], floor) + 4) / 4;
    return mel;
  }

  // ───────── tokens ─────────
  function parseTokens(text) {
    var table = new Array(VOCAB), lines = text.split('\n'), i;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i]; if (!ln) continue; var sp = ln.lastIndexOf(' '); if (sp < 0) continue;
      var id = parseInt(ln.slice(sp + 1), 10); if (!(id >= 0 && id < VOCAB)) continue;
      // special tokens (ids above the text vocabulary) may carry malformed base64; they are never printed, so an empty entry is correct
      var b64 = ln.slice(0, sp), bin = '', b, j;
      try { bin = atob(b64 + '==='.slice((b64.length + 3) % 4)); } catch (e) { bin = ''; }
      b = new Uint8Array(bin.length); for (j = 0; j < bin.length; j++) b[j] = bin.charCodeAt(j);
      table[id] = b;
    }
    return table;
  }
  function detok(table, ids) {
    var total = 0, i; for (i = 0; i < ids.length; i++) { var b = table[ids[i]]; if (b) total += b.length; }
    var out = new Uint8Array(total), p = 0; for (i = 0; i < ids.length; i++) { var c = table[ids[i]]; if (c) { out.set(c, p); p += c.length; } }
    return new TextDecoder('utf-8').decode(out).replace(/\s+/g, ' ').trim();
  }

  // ───────── decoding ─────────
  function logSoftmax(row) {
    var mx = -Infinity, i; for (i = 0; i < row.length; i++) if (row[i] > mx) mx = row[i];
    var s = 0; for (i = 0; i < row.length; i++) s += Math.exp(row[i] - mx);
    var lse = mx + Math.log(s), out = new Float32Array(row.length); for (i = 0; i < row.length; i++) out[i] = row[i] - lse;
    return out;
  }
  // The sequence repeats itself in a loop (a known failure of small Whisper models on noise or music).
  function looping(seq) {
    var n = seq.length; if (n < 12) return false;
    for (var p = 1; p <= 8; p++) { var reps = 1; while (reps < 8) { var ok = true; for (var j = 0; j < p; j++) if (seq[n - 1 - j - reps * p] !== seq[n - 1 - j]) { ok = false; break; } if (!ok) break; reps++; if (n - reps * p < 0) break; } if (reps >= 6 && p * reps <= n) return true; }
    return false;
  }

  function create(ort, encoderBytes, decoderBytes, tokensText) {
    var table = parseTokens(tokensText);
    var opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    return Promise.all([ort.InferenceSession.create(encoderBytes, opts), ort.InferenceSession.create(decoderBytes, opts)]).then(function (s) {
      return new Whisper(ort, s[0], s[1], table);
    });
  }
  function Whisper(ort, enc, dec, table) { this.ort = ort; this.enc = enc; this.dec = dec; this.table = table; this.cancelled = false; }

  Whisper.prototype.cancel = function () { this.cancelled = true; };

  Whisper.prototype._encode = function (pcm) {
    var mel = logMel(pcm);
    return this.enc.run({ mel: new this.ort.Tensor('float32', mel, [1, N_MELS, N_FRAMES]) });
  };

  // One decoder step. cache: { k, v, offset }. Returns the logits of the requested row.
  Whisper.prototype._step = function (tokens, cache, enc, row) {
    var self = this, ort = this.ort;
    var feeds = {
      tokens: new ort.Tensor('int64', BigInt64Array.from(tokens.map(function (t) { return BigInt(t); })), [1, tokens.length]),
      in_n_layer_self_k_cache: cache.k, in_n_layer_self_v_cache: cache.v,
      n_layer_cross_k: enc.n_layer_cross_k, n_layer_cross_v: enc.n_layer_cross_v,
      offset: new ort.Tensor('int64', BigInt64Array.from([BigInt(cache.offset)]), [1]),
    };
    return this.dec.run(feeds).then(function (out) {
      cache.k = out.out_n_layer_self_k_cache; cache.v = out.out_n_layer_self_v_cache; cache.offset += tokens.length;
      var l = out.logits.data, r = row < 0 ? tokens.length - 1 : row; void self;
      return l.subarray(r * VOCAB, (r + 1) * VOCAB);
    });
  };
  Whisper.prototype._newCache = function () { var z = function () { return new Float32Array(4 * 448 * 384); }; return { k: new this.ort.Tensor('float32', z(), [4, 1, 448, 384]), v: new this.ort.Tensor('float32', z(), [4, 1, 448, 384]), offset: 0 }; };

  Whisper.prototype.detectLanguage = function (pcm) {
    var self = this;
    return this._encode(pcm).then(function (enc) {
      return self._step([TOK.sot], self._newCache(), enc, 0).then(function (logits) {
        var best = 0, bv = -Infinity; for (var i = 0; i < LANGS.length; i++) { var v = logits[TOK.langBase + i]; if (v > bv) { bv = v; best = i; } }
        return LANGS[best];
      });
    });
  };

  // Decodes one 30 s window. Returns { segments:[{start,end,text}], lastEnd, noSpeech, avgLogprob, reason }.
  Whisper.prototype._decodeWindow = function (pcm, lang, translate) {
    var self = this, langId = TOK.langBase + Math.max(0, LANGS.indexOf(lang));
    var prompt = [TOK.sot, langId, translate ? TOK.translate : TOK.transcribe];
    return this._encode(pcm).then(function (enc) {
      var cache = self._newCache(), seq = [], sumLp = 0, noSpeech = 0, reason = 'eot';
      var next = prompt;
      function loop(step) {
        if (self.cancelled) { reason = 'cancelled'; return Promise.resolve(); }
        return self._step(next, cache, enc, -1).then(function (raw) {
          var logits = Float32Array.from(raw), i;
          if (step === 0) { var lp0 = logSoftmax(logits); noSpeech = Math.exp(lp0[TOK.nospeech]); }
          // never emit these specials; the blank/eot at the very start is not allowed either
          for (i = TOK.sot; i < TOK.tsBegin; i++) logits[i] = -Infinity;
          if (seq.length === 0) { logits[TOK.eot] = -Infinity; logits[220] = -Infinity; }
          var lastTs = seq.length >= 1 && seq[seq.length - 1] >= TOK.tsBegin, penTs = seq.length < 2 || seq[seq.length - 2] >= TOK.tsBegin;
          if (lastTs) { if (penTs) for (i = TOK.tsBegin; i < VOCAB; i++) logits[i] = -Infinity; else for (i = 0; i < TOK.eot; i++) logits[i] = -Infinity; }
          var tsList = seq.filter(function (t) { return t >= TOK.tsBegin; });
          if (tsList.length) { var lt = tsList[tsList.length - 1], from = lastTs && !penTs ? lt : lt + 1; for (i = TOK.tsBegin; i < from && i < VOCAB; i++) logits[i] = -Infinity; }
          if (seq.length === 0) { for (i = 0; i < TOK.tsBegin; i++) logits[i] = -Infinity; for (i = TOK.tsBegin + 51; i < VOCAB; i++) logits[i] = -Infinity; }
          var lp = logSoftmax(logits), tsMass = -Infinity, textMax = -Infinity;
          var mxTs = -Infinity, sTs = 0; for (i = TOK.tsBegin; i < VOCAB; i++) if (lp[i] > mxTs) mxTs = lp[i];
          if (mxTs > -Infinity) { for (i = TOK.tsBegin; i < VOCAB; i++) sTs += Math.exp(lp[i] - mxTs); tsMass = mxTs + Math.log(sTs); }
          for (i = 0; i < TOK.tsBegin; i++) if (lp[i] > textMax) textMax = lp[i];
          if (tsMass > textMax) for (i = 0; i < TOK.tsBegin; i++) lp[i] = -Infinity;
          var best = 0, bv = -Infinity; for (i = 0; i < VOCAB; i++) if (lp[i] > bv) { bv = lp[i]; best = i; }
          if (best === TOK.eot) { reason = 'eot'; return; }
          seq.push(best); sumLp += bv;
          if (seq.length >= MAX_TOKENS) { reason = 'length'; return; }
          if (looping(seq)) { reason = 'loop'; return; }
          next = [best];
          return loop(step + 1);
        });
      }
      return loop(0).then(function () {
        // tokens -> segments
        var segs = [], buf = [], start = null, lastEnd = 0, i;
        for (i = 0; i < seq.length; i++) {
          var t = seq[i];
          if (t >= TOK.tsBegin) {
            var tm = (t - TOK.tsBegin) * 0.02;
            if (start === null) start = tm;
            else if (buf.length) { segs.push({ start: start, end: Math.max(tm, start + 0.1), text: detok(self.table, buf) }); lastEnd = tm; buf = []; start = null; }
            else start = tm;
          } else if (t < TOK.eot) buf.push(t);
        }
        if (buf.length) { var s0 = start === null ? lastEnd : start; var e0 = Math.min(pcm.length / SR, s0 + Math.max(1, buf.length * 0.25)); segs.push({ start: s0, end: Math.max(e0, s0 + 0.1), text: detok(self.table, buf), open: true }); lastEnd = e0; }
        // drop empty text, music notes, and sound tags such as [Music] or (applause): they are not speech
        segs = segs.filter(function (s) { return s.text && !/^[\s.\u2026\-\u266a\u266b]*$/.test(s.text) && !/^[\[(][^\])]{0,40}[\])]\.?$/.test(s.text); });
        return { segments: segs, lastEnd: lastEnd, noSpeech: noSpeech, avgLogprob: seq.length ? sumLp / seq.length : 0, reason: reason };
      });
    });
  };

  // pcm: Float32Array 16 kHz mono. Any length up to 30 s per call is fine; longer sound is walked in windows.
  // opts: { lang: 'auto' | 'en' | ..., translate, onProgress(frac) }. Returns { language, segments:[{start,end,text}], dropped }.
  Whisper.prototype.transcribe = function (pcm, opts) {
    opts = opts || {}; var self = this; this.cancelled = false;
    var total = pcm.length / SR, segments = [], dropped = 0, pos = 0, rounds = 0, language = opts.lang && opts.lang !== 'auto' && LANGS.indexOf(opts.lang) >= 0 ? opts.lang : null;
    function peak(a, b) { var m = 0; for (var i = a; i < b; i += 4) { var v = Math.abs(pcm[i]); if (v > m) m = v; } return m; }
    function round() {
      if (self.cancelled) return Promise.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      var a = Math.round(pos * SR), b = Math.min(pcm.length, a + N_SAMPLES);
      if (b - a < SR * 0.3 || rounds >= MAX_SEEK_ROUNDS * Math.ceil(total / 30 + 1)) return Promise.resolve();
      rounds++;
      var win = pcm.subarray(a, b);
      var detect = language ? Promise.resolve(language) : self.detectLanguage(win);
      return detect.then(function (lang) {
        language = language || lang;
        return self._decodeWindow(win, language, !!opts.translate);
      }).then(function (r) {
        if (opts.onProgress) opts.onProgress(Math.min(1, (b / SR) / total));
        // A window the model thinks is not speech: drop it (stops "Thank you." style inventions on silence and music).
        var quiet = peak(a, b) < 0.01;
        if (r.reason === 'cancelled') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        if ((r.noSpeech > 0.6 && r.avgLogprob < -1) || r.avgLogprob < -1.6 || quiet) { dropped += r.segments.length; r.segments = []; }
        for (var i = 0; i < r.segments.length; i++) { var sg = r.segments[i]; segments.push({ start: pos + sg.start, end: pos + sg.end, text: sg.text }); }
        // The model often stops early inside a long window. Continue from where it stopped when there is still sound left.
        var win_len = (b - a) / SR, advance = r.lastEnd > 0.5 && r.reason !== 'loop' ? r.lastEnd : win_len;
        if (r.reason === 'loop' || !r.segments.length) advance = win_len;
        if (win_len - advance < 1.5) advance = win_len;
        pos += advance;
        return round();
      });
    }
    return round().then(function () { return { language: language || 'en', segments: segments, dropped: dropped }; });
  };

  root.CogWhisper = { create: create, logMel: logMel, LANGS: LANGS, SR: SR, parseTokens: parseTokens, detok: detok, looping: looping };
})(typeof self !== 'undefined' ? self : this);

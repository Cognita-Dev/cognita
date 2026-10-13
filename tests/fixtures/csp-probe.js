// Runs inside <iframe sandbox="allow-scripts"> with the same headers as studio-ml-frame. Reports what the policy allows.
(async function () {
  var r = {};
  try { r.eval = String(eval('1+1')); } catch (e) { r.eval = 'blocked'; }
  try { r.fn = String(new Function('return 2')()); } catch (e) { r.fn = 'blocked'; }
  try { await fetch('https://example.com/', { mode: 'no-cors' }); r.external = 'reached'; } catch (e) { r.external = 'blocked'; }
  try { r.ownFile = (await fetch('/studio/ml/models/whisper-tiny-tokens.txt', { method: 'HEAD' })).status; } catch (e) { r.ownFile = 'blocked'; }
  try { r.storage = String(localStorage.length); } catch (e) { r.storage = 'blocked'; }
  try { r.parent = String(window.parent.document.title); } catch (e) { r.parent = 'blocked'; }
  try { r.cookie = document.cookie === '' ? 'empty' : 'has'; } catch (e) { r.cookie = 'blocked'; }
  try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); r.wasm = 'allowed'; } catch (e) { r.wasm = 'blocked'; }
  try { var w = new Worker(URL.createObjectURL(new Blob(['postMessage(typeof eval)'], { type: 'text/javascript' }))); r.worker = await new Promise(function (res) { w.onmessage = function (e) { res('started'); }; w.onerror = function () { res('error'); }; setTimeout(function () { res('timeout'); }, 3000); }); } catch (e) { r.worker = 'blocked'; }
  try { var w2 = new Worker(URL.createObjectURL(new Blob(['try{postMessage("eval:"+eval("1+1"))}catch(e){postMessage("worker-eval-blocked")}'], { type: 'text/javascript' }))); r.workerEval = await new Promise(function (res) { w2.onmessage = function (e) { res(e.data); }; w2.onerror = function () { res('error'); }; setTimeout(function () { res('timeout'); }, 3000); }); } catch (e) { r.workerEval = 'blocked'; }
  try { var w3 = new Worker(URL.createObjectURL(new Blob(['fetch("https://example.com/",{mode:"no-cors"}).then(function(){postMessage("reached")}).catch(function(){postMessage("worker-fetch-blocked")})'], { type: 'text/javascript' }))); r.workerFetch = await new Promise(function (res) { w3.onmessage = function (e) { res(e.data); }; w3.onerror = function () { res('error'); }; setTimeout(function () { res('timeout'); }, 3000); }); } catch (e) { r.workerFetch = 'blocked'; }
  window.parent.postMessage({ probe: r }, '*');
})();

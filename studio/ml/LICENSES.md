# Third-party files in studio/ml

These files run only inside the isolated model frame (`studio-ml-frame.html`). Nothing here is loaded by the main app.

| File | What it is | Source | Licence |
|---|---|---|---|
| `ort.wasm.min.js`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` | ONNX Runtime Web 1.30.0 (CPU/WebAssembly build, single thread) | npm `onnxruntime-web@1.30.0` | MIT, Copyright (c) Microsoft Corporation |
| `models/whisper-tiny-encoder.int8.onnx`, `models/whisper-tiny-decoder.onnx.part0-2`, `models/whisper-tiny-tokens.txt` | OpenAI Whisper "tiny" (multilingual), int8, exported for ONNX by sherpa-onnx. The decoder's token embedding was converted from float32 to float16 (the stored values were already exactly representable, so output is identical) and the file is split in 16 MiB parts so each stays under GitHub's 25 MB web-upload limit | `k2-fsa/sherpa-onnx` release `asr-models`, file `sherpa-onnx-whisper-tiny.tar.bz2` | Whisper: MIT, Copyright (c) 2022 OpenAI |
| `models/u2netp.onnx` | U²-Net-P ("u2netp"), the small salient-object segmentation network | `danielgatis/rembg` release `v0.0.0` | U²-Net: Apache-2.0 (Xuebin Qin et al.) |

`models/SHA256SUMS` lists the checksum of every model file as shipped. To use a different or newer model, replace the file under the same name or change the URL in `ml-worker.js`, and rename it if you want browsers to fetch it again (model files are cached for 30 days, see `vercel.json`).

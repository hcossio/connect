// Runs Whisper on this device with Transformers.js (ONNX Runtime on WebGPU,
// or WebAssembly where WebGPU isn't available). The model downloads from
// Hugging Face the first time and the browser keeps it cached after that.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

const MODEL = 'onnx-community/whisper-base';
let loading = null, ready = false;

async function load() {
  const gpu = await navigator.gpu?.requestAdapter().catch(() => null);
  const files = {};
  const asr = await pipeline('automatic-speech-recognition', MODEL, {
    device: gpu ? 'webgpu' : 'wasm',
    dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const [done, total] = Object.values(files).reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
      postMessage({ type: 'progress', pct: Math.floor((100 * done) / total) });
    },
  });
  ready = true;
  postMessage({ type: 'ready', device: gpu ? 'webgpu' : 'wasm' });
  return asr;
}

onmessage = async ({ data }) => {
  try {
    loading ||= load();
    const asr = await loading;
    const opts = { task: 'transcribe' };
    if (data.language) opts.language = data.language;
    const out = await asr(data.audio, opts);
    postMessage({ type: 'text', id: data.id, text: out.text || '' });
  } catch (err) {
    if (!ready) loading = null; // try loading again on the next clip
    postMessage({ type: 'error', id: data.id, message: String(err?.message || err) });
  }
};

// Microphone recorder for voice messages: captures mono PCM with Web Audio and
// encodes 16 kHz WAV (supported by every browser incl. iOS Safari, and natively
// by Gemini). Reports a live input level for the recording UI.

const TARGET_RATE = 16000;
let sharedStream = null;

/** Asks for the microphone once and reuses the stream (avoids repeated prompts). */
async function getStream() {
  if (sharedStream && sharedStream.getAudioTracks().some((t) => t.readyState === "live")) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return sharedStream;
}

export function voiceSupported() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));
}

/** Releases the microphone (the OS mic indicator turns off). */
export function releaseMicrophone() {
  if (sharedStream) for (const t of sharedStream.getTracks()) t.stop();
  sharedStream = null;
}

function downsample(buffer, fromRate) {
  if (fromRate === TARGET_RATE) return buffer;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(buffer.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += buffer[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TARGET_RATE, true); v.setUint32(28, TARGET_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Starts recording. Returns { stop(): Promise<{blob, duration}>, cancel() , startedAt }.
 * `onLevel(0..1)` is called ~20x/second for the level meter.
 */
export async function startRecording({ onLevel } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === "suspended") await ctx.resume();
  const stream = await getStream();
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let lastLevel = 0;
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / (data.length / 8));
    lastLevel = Math.min(1, rms * 6);
    if (onLevel) onLevel(lastLevel);
  };
  source.connect(proc);
  proc.connect(ctx.destination);
  const startedAt = performance.now();
  let done = false;

  const teardown = () => {
    if (done) return;
    done = true;
    try { source.disconnect(); proc.disconnect(); } catch { /* ignore */ }
    ctx.close().catch(() => {});
  };

  return {
    startedAt,
    cancel: teardown,
    async stop() {
      const duration = (performance.now() - startedAt) / 1000;
      const rate = ctx.sampleRate;
      teardown();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { pcm.set(c, off); off += c.length; }
      return { blob: encodeWav(downsample(pcm, rate)), duration };
    },
  };
}

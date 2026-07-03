// Playback + waveform peaks from the backend's raw PCM
// (u32 rate | u32 channels | u32 frames | i16 interleaved, little-endian).
//
// Two playback backends behind one API:
// - native: the Rust PulseAudio engine (Linux) — its own 200 ms stream buffer
//   sidesteps WebKitGTK's underrun-prone GStreamer path entirely. Position is
//   polled and extrapolated between polls; ticks are mixed in-stream.
// - web: WebAudio, used when the native engine is unavailable (Windows/macOS).

import * as api from "../api.js";

const PEAKS_PER_SEC = 200;
const TICK_LOOKAHEAD = 0.3;
const TICK_INTERVAL_MS = 100;
const NATIVE_POLL_MS = 150;

export class Player {
  peaks: Float32Array | null = null;
  readonly peaksPerSec = PEAKS_PER_SEC;
  playing = false;
  rate = 1;
  ticksEnabled = true;
  onstate: () => void = () => {};

  private native = false;
  private durationSec = 0;
  private startPos = 0; // paused position (both backends)
  private noteTimes: number[] = [];

  // --- web backend ---
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private tickGain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private tickIdx = 0;
  private tickTimer: number | null = null;
  private playGen = 0;

  // --- native backend ---
  private anchorPos = 0;
  private anchorAt = 0;
  private nativeLatency = 0;
  private pollTimer: number | null = null;

  /** Detect the native engine; call once before use. */
  async init(): Promise<void> {
    try {
      this.native = await api.nativeAvailable();
    } catch {
      this.native = false;
    }
  }

  get loaded(): boolean {
    return this.durationSec > 0;
  }

  get duration(): number {
    return this.durationSec;
  }

  loadPcm(raw: ArrayBuffer): void {
    this.hardStop();
    const view = new DataView(raw);
    const rate = view.getUint32(0, true);
    const channels = view.getUint32(4, true);
    const frames = view.getUint32(8, true);
    const samples = new Int16Array(raw, 12, frames * channels);
    this.durationSec = frames / rate;
    this.computePeaks(samples, channels, rate);
    if (!this.native) {
      const ctx = this.ensureCtx();
      const buffer = ctx.createBuffer(channels, frames, rate);
      for (let ch = 0; ch < channels; ch++) {
        const dest = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          dest[i] = samples[i * channels + ch] / 32768;
        }
      }
      this.buffer = buffer;
    }
    this.startPos = 0;
    this.anchorPos = 0;
    this.onstate();
  }

  private computePeaks(samples: Int16Array, channels: number, rate: number): void {
    const frames = samples.length / channels;
    const bucketLen = rate / PEAKS_PER_SEC;
    const count = Math.ceil(frames / bucketLen);
    const peaks = new Float32Array(count);
    for (let f = 0; f < frames; f++) {
      const b = Math.floor(f / bucketLen);
      for (let ch = 0; ch < channels; ch++) {
        const v = Math.abs(samples[f * channels + ch]) / 32768;
        if (v > peaks[b]) peaks[b] = v;
      }
    }
    this.peaks = peaks;
  }

  get time(): number {
    if (!this.playing) return this.startPos;
    if (this.native) {
      return Math.min(
        this.durationSec,
        this.anchorPos + ((performance.now() - this.anchorAt) / 1000) * this.rate,
      );
    }
    if (!this.src || !this.ctx) return this.startPos;
    return Math.min(
      this.durationSec,
      this.startPos + (this.ctx.currentTime - this.startCtxTime) * this.rate,
    );
  }

  /** What the listener is hearing right now — `time` minus output latency.
   *  Use for the playhead/time display; use `time` for editing. */
  get displayTime(): number {
    if (!this.playing) return this.startPos;
    if (this.native) return Math.max(0, this.time - this.nativeLatency);
    const ctx = this.ctx;
    const latency = ctx ? (ctx.outputLatency || ctx.baseLatency || 0) * this.rate : 0;
    return Math.max(0, this.time - latency);
  }

  setNoteTimes(times: number[]): void {
    this.noteTimes = times;
    if (this.native) {
      void api.nativeSetTicks(times, this.ticksEnabled).catch(() => {});
    } else if (this.playing) {
      this.tickIdx = lowerBound(times, this.time + 1e-6);
    }
  }

  setTicksEnabled(enabled: boolean): void {
    this.ticksEnabled = enabled;
    if (this.native) {
      void api.nativeSetTicks(this.noteTimes, enabled).catch(() => {});
    }
  }

  play(): void {
    if (!this.loaded || this.playing) return;
    if (this.startPos >= this.durationSec - 0.005) this.startPos = 0;
    if (this.native) {
      this.playing = true;
      this.anchorPos = this.startPos;
      this.anchorAt = performance.now();
      void api.nativePlay(this.startPos, this.rate).catch((e) => {
        this.playing = false;
        this.stopPoll();
        this.onstate();
        console.error("native play failed:", e);
      });
      this.startPoll();
      this.onstate();
      return;
    }
    void this.playWeb();
  }

  private async playWeb(): Promise<void> {
    const ctx = this.ensureCtx();
    // claim playback before the async resume so a double-toggle can't double-start
    this.playing = true;
    const gen = ++this.playGen;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        /* try to start anyway */
      }
    }
    if (gen !== this.playGen || !this.buffer) return; // paused/seeked while resuming
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gain!);
    src.onended = () => {
      if (this.src === src) {
        this.startPos = this.time;
        this.stopWebInternals();
        this.onstate();
      }
    };
    this.startCtxTime = ctx.currentTime + 0.02;
    src.start(this.startCtxTime, this.startPos);
    this.src = src;
    this.tickIdx = lowerBound(this.noteTimes, this.startPos + 1e-6);
    this.tickTimer = window.setInterval(() => this.scheduleTicks(), TICK_INTERVAL_MS);
    this.scheduleTicks();
    this.onstate();
  }

  pause(): void {
    if (!this.playing) return;
    if (this.native) {
      this.playing = false;
      this.stopPoll();
      this.startPos = Math.max(0, this.time - this.nativeLatency);
      void api
        .nativePause()
        .then((pos) => {
          this.startPos = pos;
          this.onstate();
        })
        .catch(() => {});
      this.onstate();
      return;
    }
    this.startPos = this.time;
    this.stopWebInternals();
    this.onstate();
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  stop(): void {
    this.hardStop();
    this.startPos = 0;
    this.onstate();
  }

  seek(t: number): void {
    const target = Math.max(0, Math.min(this.durationSec, t));
    if (this.native) {
      this.startPos = target;
      this.anchorPos = target;
      this.anchorAt = performance.now();
      if (this.playing) {
        void api.nativePlay(target, this.rate).catch(() => {});
      }
      this.onstate();
      return;
    }
    const wasPlaying = this.playing;
    this.stopWebInternals();
    this.startPos = target;
    if (wasPlaying) void this.playWeb();
    else this.onstate();
  }

  setRate(rate: number): void {
    if (this.native) {
      const cur = this.time;
      this.rate = rate;
      if (this.playing) {
        this.anchorPos = cur;
        this.anchorAt = performance.now();
        void api.nativePlay(cur, rate).catch(() => {});
      }
      return;
    }
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.rate = rate;
    if (wasPlaying) void this.playWeb();
  }

  dispose(): void {
    this.hardStop();
    if (this.ctx) void this.ctx.close();
  }

  /** Stop playback on whichever backend, without touching startPos. */
  private hardStop(): void {
    if (this.native) {
      this.stopPoll();
      if (this.playing) void api.nativePause().catch(() => {});
      this.playing = false;
      return;
    }
    this.stopWebInternals();
  }

  // --- native helpers ---

  private startPoll(): void {
    this.stopPoll();
    this.pollTimer = window.setInterval(() => void this.poll(), NATIVE_POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    let p: { raw: number; display: number; playing: boolean };
    try {
      p = await api.nativePosition();
    } catch {
      return;
    }
    if (!this.playing || !this.native) return;
    this.anchorPos = p.raw;
    this.anchorAt = performance.now();
    this.nativeLatency = Math.max(0, p.raw - p.display);
    if (!p.playing) {
      // reached the end (or the stream died)
      this.playing = false;
      this.stopPoll();
      this.startPos = p.display;
      this.onstate();
    }
  }

  // --- web helpers ---

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      // "playback" = larger buffers; the default "interactive" crackles on
      // high-latency outputs
      this.ctx = new AudioContext({ latencyHint: "playback" });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.tickGain = this.ctx.createGain();
      this.tickGain.gain.value = 0.35;
      this.tickGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private stopWebInternals(): void {
    this.playGen++;
    if (this.src) {
      this.src.onended = null;
      try {
        this.src.stop();
      } catch {
        /* not started */
      }
      this.src = null;
    }
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.playing = false;
  }

  private scheduleTicks(): void {
    if (!this.playing || !this.ticksEnabled || !this.ctx) return;
    const horizon = this.time + TICK_LOOKAHEAD * this.rate;
    while (this.tickIdx < this.noteTimes.length && this.noteTimes[this.tickIdx] <= horizon) {
      const t = this.noteTimes[this.tickIdx++];
      const when = this.startCtxTime + (t - this.startPos) / this.rate;
      if (when >= this.ctx.currentTime - 0.005) this.tick(when);
    }
  }

  private tick(when: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = 1660;
    env.gain.setValueAtTime(1, when);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
    osc.connect(env);
    env.connect(this.tickGain!);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

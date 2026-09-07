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
/** Relative to index.html — copied into ui/dist/assets by the build script. */
const TICK_SE_URL = "assets/SE_Perfect.mp3";

export type TickSound = "beep" | "se";

export class Player {
  peaks: Float32Array | null = null;
  readonly peaksPerSec = PEAKS_PER_SEC;
  playing = false;
  rate = 1;
  volume = 1;
  ticksEnabled = true;
  /** Which tick sound to play. "se" only takes effect on the web backend (see
   *  setTickSound) — the native mixer only knows how to synthesize the beep. */
  tickSound: TickSound = "beep";
  onstate: () => void = () => {};

  private native = false;
  private seBuffer: AudioBuffer | null = null;
  private seLoadPromise: Promise<void> | null = null;
  private durationSec = 0;
  private startPos = 0; // paused position (both backends)
  /** Bumped whenever startPos is set on purpose — lets late async replies
   *  (nativePause's heard-position correction) detect they've been superseded
   *  by a newer seek/play instead of clobbering it. */
  private posEpoch = 0;
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
  private lastTickTime = -Infinity;
  private playGen = 0;

  // --- native backend ---
  private anchorPos = 0;
  private anchorAt = 0;
  private nativeLatency = 0;
  private pollTimer: number | null = null;
  /** Native invokes run on a backend thread pool with NO ordering guarantee —
   *  a fire-and-forget pause could execute after the play it should precede.
   *  All native-engine calls are serialized through this chain. */
  private chain: Promise<unknown> = Promise.resolve();

  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Detect the native engine; call once before use. */
  async init(): Promise<void> {
    try {
      this.native = await api.nativeAvailable();
    } catch {
      this.native = false;
    }
    if (this.native) {
      // The mixer's volume lives in backend state that outlives this Player, so
      // without this a level set in a previous project would carry over while
      // the (fresh) slider claims 100%.
      void this.queued(() => api.nativeSetVolume(this.volume)).catch(() => {});
    } else {
      // The native mixer synthesizes its own beep and has no MP3 decode/resample path;
      // only bother preloading the sample when the web backend will actually use it.
      void this.loadSe();
    }
  }

  get loaded(): boolean {
    return this.durationSec > 0;
  }

  /** False on the native backend, which can only play the synthesized beep tick. */
  get supportsTickSe(): boolean {
    return !this.native;
  }

  setTickSound(sound: TickSound): void {
    this.tickSound = sound;
    if (sound === "se" && !this.native) void this.loadSe();
  }

  private async loadSe(): Promise<void> {
    if (this.seBuffer) return;
    if (!this.seLoadPromise) {
      const ctx = this.ensureCtx();
      this.seLoadPromise = fetch(TICK_SE_URL)
        .then((res) => res.arrayBuffer())
        .then((bytes) => ctx.decodeAudioData(bytes))
        .then((buf) => {
          this.seBuffer = buf;
        })
        .catch((e) => console.error("failed to load tick SE sound:", e));
    }
    return this.seLoadPromise;
  }

  get duration(): number {
    return this.durationSec;
  }

  loadPcm(raw: ArrayBuffer): void {
    this.hardStop();
    if (raw.byteLength < 12) throw "Corrupt PCM payload";
    const view = new DataView(raw);
    const rate = view.getUint32(0, true);
    const channels = view.getUint32(4, true);
    const frames = view.getUint32(8, true);
    if (!rate || !channels || channels > 8 || 12 + frames * channels * 2 > raw.byteLength) {
      throw "Corrupt PCM payload (bad header)";
    }
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
    this.posEpoch++;
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
      void this.queued(() => api.nativeSetTicks(times, this.ticksEnabled)).catch(() => {});
    } else if (this.playing) {
      // don't re-schedule notes already inside the lookahead window (double tick)
      this.tickIdx = lowerBound(times, Math.max(this.time, this.lastTickTime) + 1e-6);
    }
  }

  setTicksEnabled(enabled: boolean): void {
    this.ticksEnabled = enabled;
    if (this.native) {
      void this.queued(() => api.nativeSetTicks(this.noteTimes, enabled)).catch(() => {});
    }
  }

  /** Volume of the decoded audio, 0–1. Ticks have their own fixed level and are unaffected. */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.native) {
      void this.queued(() => api.nativeSetVolume(this.volume)).catch(() => {});
    } else if (this.gain) {
      this.gain.gain.value = this.volume;
    }
  }

  play(): void {
    if (!this.loaded || this.playing) return;
    this.posEpoch++;
    if (this.startPos >= this.durationSec - 0.005) this.startPos = 0;
    if (this.native) {
      this.playing = true;
      this.anchorPos = this.startPos;
      this.anchorAt = performance.now();
      const from = this.startPos;
      const epoch = this.posEpoch;
      void this.queued(() => api.nativePlay(from, this.rate)).catch((e) => {
        // only kill playback state if no newer play/seek superseded this one
        if (epoch === this.posEpoch) {
          this.playing = false;
          this.stopPoll();
          this.onstate();
        }
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
    this.lastTickTime = -Infinity;
    this.tickIdx = lowerBound(this.noteTimes, this.startPos + 1e-6);
    this.tickTimer = window.setInterval(() => this.scheduleTicks(), TICK_INTERVAL_MS);
    this.scheduleTicks();
    this.onstate();
  }

  pause(): void {
    if (!this.playing) return;
    if (this.native) {
      // read the heard position while `time` still extrapolates (playing=true)
      const heardNow = Math.max(0, this.time - this.nativeLatency);
      this.playing = false;
      this.stopPoll();
      this.startPos = heardNow;
      const epoch = ++this.posEpoch;
      void this.queued(() => api.nativePause())
        .then((pos) => {
          // apply the backend's exact heard-position only if nothing
          // (a click-to-seek, a new play) has moved the position since
          if (epoch === this.posEpoch && !this.playing) {
            this.startPos = pos;
            this.onstate();
          }
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
    this.posEpoch++;
    this.startPos = 0;
    this.onstate();
  }

  seek(t: number): void {
    const target = Math.max(0, Math.min(this.durationSec, t));
    this.posEpoch++;
    if (this.native) {
      this.startPos = target;
      this.anchorPos = target;
      this.anchorAt = performance.now();
      if (this.playing) {
        void this.queued(() => api.nativePlay(target, this.rate)).catch(() => {});
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
        void this.queued(() => api.nativePlay(cur, rate)).catch(() => {});
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
      if (this.playing) void this.queued(() => api.nativePause()).catch(() => {});
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
    const epoch = this.posEpoch;
    let p: { raw: number; display: number; playing: boolean };
    try {
      // queued so a poll can never observe state from before a pending play
      p = await this.queued(() => api.nativePosition());
    } catch {
      return;
    }
    // a seek/play/pause since this poll started makes its data stale
    if (!this.playing || !this.native || epoch !== this.posEpoch) return;
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
      this.gain.gain.value = this.volume;
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
      this.lastTickTime = t;
      const when = this.startCtxTime + (t - this.startPos) / this.rate;
      if (when >= this.ctx.currentTime - 0.005) this.tick(when);
    }
  }

  private tick(when: number): void {
    const ctx = this.ctx!;
    if (this.tickSound === "se" && this.seBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.seBuffer;
      src.connect(this.tickGain!);
      src.start(when);
      return;
    }
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

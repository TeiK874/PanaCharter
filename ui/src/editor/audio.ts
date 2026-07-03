// Playback + waveform peaks from the backend's raw PCM
// (u32 rate | u32 channels | u32 frames | i16 interleaved, little-endian).

const PEAKS_PER_SEC = 200;
const TICK_LOOKAHEAD = 0.3;
const TICK_INTERVAL_MS = 100;

export class Player {
  // "playback" = larger audio buffers; the default "interactive" crackles on
  // high-latency outputs (WSLg's PulseAudio bridge, bluetooth, …)
  readonly ctx = new AudioContext({ latencyHint: "playback" });
  buffer: AudioBuffer | null = null;
  peaks: Float32Array | null = null;
  readonly peaksPerSec = PEAKS_PER_SEC;
  playing = false;
  rate = 1;
  ticksEnabled = true;
  onstate: () => void = () => {};

  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode;
  private tickGain: GainNode;
  private startCtxTime = 0;
  private startPos = 0;
  private noteTimes: number[] = [];
  private tickIdx = 0;
  private tickTimer: number | null = null;
  private playGen = 0;

  constructor() {
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.tickGain = this.ctx.createGain();
    this.tickGain.gain.value = 0.35;
    this.tickGain.connect(this.ctx.destination);
  }

  loadPcm(raw: ArrayBuffer): void {
    const view = new DataView(raw);
    const rate = view.getUint32(0, true);
    const channels = view.getUint32(4, true);
    const frames = view.getUint32(8, true);
    const samples = new Int16Array(raw, 12, frames * channels);
    const buffer = this.ctx.createBuffer(channels, frames, rate);
    for (let ch = 0; ch < channels; ch++) {
      const dest = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        dest[i] = samples[i * channels + ch] / 32768;
      }
    }
    this.stop();
    this.buffer = buffer;
    this.computePeaks(buffer);
    this.startPos = 0;
    this.onstate();
  }

  private computePeaks(buffer: AudioBuffer): void {
    const bucketLen = buffer.sampleRate / PEAKS_PER_SEC;
    const count = Math.ceil(buffer.length / bucketLen);
    const peaks = new Float32Array(count);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let b = 0; b < count; b++) {
        let max = 0;
        const end = Math.min(data.length, Math.floor((b + 1) * bucketLen));
        for (let i = Math.floor(b * bucketLen); i < end; i++) {
          const v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        if (max > peaks[b]) peaks[b] = max;
      }
    }
    this.peaks = peaks;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get time(): number {
    // this.src is null while play() is still awaiting ctx.resume()
    if (!this.playing || !this.src) return this.startPos;
    return Math.min(
      this.duration,
      this.startPos + (this.ctx.currentTime - this.startCtxTime) * this.rate,
    );
  }

  /** What the listener is hearing right now — `time` minus the output pipeline
   *  latency. Use for the playhead/time display; use `time` for editing. */
  get displayTime(): number {
    if (!this.playing || !this.src) return this.startPos;
    const latency = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * this.rate;
    return Math.max(0, this.time - latency);
  }

  setNoteTimes(times: number[]): void {
    this.noteTimes = times;
    if (this.playing) this.tickIdx = lowerBound(times, this.time + 1e-6);
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    // claim playback before the async resume so a double-toggle can't double-start
    this.playing = true;
    const gen = ++this.playGen;
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        /* try to start anyway */
      }
    }
    if (gen !== this.playGen || !this.buffer) return; // paused/seeked while resuming
    if (this.startPos >= this.duration - 0.005) this.startPos = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);
    src.onended = () => {
      if (this.src === src) {
        this.startPos = this.time;
        this.stopInternals();
        this.onstate();
      }
    };
    this.startCtxTime = this.ctx.currentTime + 0.02;
    src.start(this.startCtxTime, this.startPos);
    this.src = src;
    this.tickIdx = lowerBound(this.noteTimes, this.startPos + 1e-6);
    this.tickTimer = window.setInterval(() => this.scheduleTicks(), TICK_INTERVAL_MS);
    this.scheduleTicks();
    this.onstate();
  }

  pause(): void {
    if (!this.playing) return;
    this.startPos = this.time; // safe: time falls back to startPos pre-start
    this.stopInternals();
    this.onstate();
  }

  toggle(): void {
    this.playing ? this.pause() : void this.play();
  }

  stop(): void {
    this.stopInternals();
    this.startPos = 0;
    this.onstate();
  }

  seek(t: number): void {
    const target = Math.max(0, Math.min(this.duration, t));
    const wasPlaying = this.playing;
    this.stopInternals();
    this.startPos = target;
    if (wasPlaying) void this.play();
    else this.onstate();
  }

  setRate(rate: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.rate = rate;
    if (wasPlaying) void this.play();
  }

  private stopInternals(): void {
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
    if (!this.playing || !this.ticksEnabled) return;
    const horizon = this.time + TICK_LOOKAHEAD * this.rate;
    while (this.tickIdx < this.noteTimes.length && this.noteTimes[this.tickIdx] <= horizon) {
      const t = this.noteTimes[this.tickIdx++];
      const when = this.startCtxTime + (t - this.startPos) / this.rate;
      if (when >= this.ctx.currentTime - 0.005) this.tick(when);
    }
  }

  private tick(when: number): void {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.frequency.value = 1660;
    env.gain.setValueAtTime(1, when);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
    osc.connect(env);
    env.connect(this.tickGain);
    osc.start(when);
    osc.stop(when + 0.06);
  }

  dispose(): void {
    this.stopInternals();
    void this.ctx.close();
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

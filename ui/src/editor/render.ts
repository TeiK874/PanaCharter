import type { Note, NoteKind } from "./chart.js";
import { gridStepSec } from "./tempo.js";

export type Orientation = "vertical" | "horizontal";

export interface ViewState {
  orientation: Orientation;
  /** Time at the start edge of the time axis, seconds. */
  scroll: number;
  /** Pixels per second along the time axis. */
  zoom: number;
  bpm: number;
  offset: number;
  /** Tempo segments covering the whole song (always at least one entry) — the grid follows
   *  these instead of the flat bpm/offset above whenever there's more than one. */
  tempoSegments: { startSec: number; startBeat: number; bpm: number }[];
  /** Time-signature segments covering the whole song (always at least one entry) — measure
   *  lines/numbering follow these instead of a flat 4 beats/measure whenever there's more
   *  than one. */
  timeSigSegments: { startSec: number; startBeat: number; startMeasure: number; beats: number }[];
  /** Subdivisions per beat for the snap grid. */
  snap: number;
  duration: number;
}

export interface DrawState extends ViewState {
  notes: Note[];
  selection: Set<number>;
  cursor: number;
  peaks: Float32Array | null;
  peaksPerSec: number;
  ghost: { t: number; lane: number; kind: NoteKind } | null;
  pendingHold: { t: number; lane: number; dur: number } | null;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Tail of the slide chain being extended, if any — previewed as a dashed line to the ghost. */
  activeSlideFrom: { t: number; lane: number } | null;
  /** id of the note currently in slide-edit mode (open for extending/hold-ending), if any —
   *  drawn with a distinct ring color so slide-edit mode reads differently from plain selection. */
  activeSlideEditId: number | null;
}

export interface NoteHit {
  note: Note;
  part: "head" | "tail" | "body";
}

const GUTTER = 86;

const COLORS = {
  bg: "#14141f",
  laneA: "#181826",
  laneB: "#1b1b2b",
  laneLine: "#232338",
  sub: "#222236",
  beat: "#31314c",
  measure: "#4a4a72",
  gutterBg: "#10101a",
  wave: "#3d5a80",
  waveLoud: "#62b1ff",
  label: "#77748f",
  playhead: "#ff6f9c",
  tap: "#ff8fb0",
  tapRim: "#c25476",
  hold: "#6fd98b",
  holdRim: "#2c7a45",
  holdBody: "rgba(111, 217, 139, 0.30)",
  star: "#ffcf5e",
  starRim: "#c69a2e",
  sim: "rgba(236, 234, 244, 0.35)",
  slide: "#b48cff",
  slideRim: "#7c56c9",
  slideBody: "rgba(180, 140, 255, 0.30)",
  slideChain: "rgba(180, 140, 255, 0.55)",
  slidePreview: "rgba(180, 140, 255, 0.35)",
  flick: "#4ea8ff",
  flickRim: "#2b6fb8",
  /** Selection ring for the note currently open in slide-edit mode — a hue nothing else on
   *  the canvas uses, and drawn much thicker than the plain selection ring (see
   *  ACTIVE_SLIDE_RING_WIDTH) so the two states read as clearly different at a glance. */
  slideEditRing: "#2be8ff",
  selectRing: "#ffffff",
  /** Tempo-change marker line + BPM label chip — orange, unused by any note/selection
   *  color, drawn over the grid AND the waveform so a BPM change is visible either way. */
  tempoMarker: "#ffab49",
  tempoMarkerText: "#14141f",
  /** Time-signature-change marker line + label chip — a distinct hue from the tempo
   *  marker so the two kinds of change read apart at a glance. */
  timeSigMarker: "#5ee0a8",
  timeSigMarkerText: "#14141f",
};

const SELECT_RING_WIDTH = 1.6;
const ACTIVE_SLIDE_RING_WIDTH = 4;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Canvas position where the time axis begins. */
  private tOffset(o: Orientation): number {
    return o === "vertical" ? 0 : GUTTER;
  }

  /** Length of the visible time axis in px. */
  timeSpanPx(o: Orientation): number {
    return o === "vertical" ? this.h : this.w - GUTTER;
  }

  /** Visible seconds. */
  timeSpan(s: ViewState): number {
    return this.timeSpanPx(s.orientation) / s.zoom;
  }

  private laneExtent(o: Orientation): number {
    return o === "vertical" ? this.w - GUTTER : this.h - GUTTER;
  }

  private laneBand(o: Orientation): number {
    return this.laneExtent(o) / 9;
  }

  noteRadius(o: Orientation): number {
    return Math.min(15, Math.max(7, this.laneBand(o) * 0.32));
  }

  /** Time → canvas position along the time axis. */
  private tpx(t: number, s: ViewState): number {
    return this.tOffset(s.orientation) + (t - s.scroll) * s.zoom;
  }

  /** Lane center along the cross axis, offset from the gutter edge.
   *  Vertical: lane 9 leftmost … lane 1 rightmost (the game is right-to-left).
   *  Horizontal: lane 1 top … lane 9 bottom. */
  private laneCross(lane: number, o: Orientation): number {
    const idx = o === "vertical" ? 9 - lane : lane - 1;
    return GUTTER + (idx + 0.5) * this.laneBand(o);
  }

  notePoint(t: number, lane: number, s: ViewState): { x: number; y: number } {
    const tp = this.tpx(t, s);
    const cross = this.laneCross(lane, s.orientation);
    return s.orientation === "vertical" ? { x: cross, y: tp } : { x: tp, y: cross };
  }

  /** Classify a canvas point: over lanes (time+lane), over the gutter (time), or out. */
  pointInfo(
    x: number,
    y: number,
    s: ViewState,
  ): { kind: "lanes"; t: number; lane: number } | { kind: "gutter"; t: number } | null {
    const o = s.orientation;
    const timePos = o === "vertical" ? y : x;
    if (timePos < this.tOffset(o)) return null; // lane-label strip (horizontal mode)
    const t = s.scroll + (timePos - this.tOffset(o)) / s.zoom;
    const crossPos = (o === "vertical" ? x : y) - GUTTER;
    if (crossPos < 0) return { kind: "gutter", t };
    if (crossPos >= this.laneExtent(o)) return null;
    const idx = Math.min(8, Math.max(0, Math.floor(crossPos / this.laneBand(o))));
    const lane = o === "vertical" ? 9 - idx : idx + 1;
    return { kind: "lanes", t, lane };
  }

  noteHit(x: number, y: number, s: ViewState, notes: Note[]): NoteHit | null {
    const r = this.noteRadius(s.orientation) + 3;
    // scan back-to-front so visually-on-top (later) notes win
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const head = this.notePoint(n.t, n.lane, s);
      if (n.kind === "hold" || (n.kind === "slide" && n.dur > 0)) {
        const tail = this.notePoint(n.t + n.dur, n.lane, s);
        if (dist(x, y, tail.x, tail.y) <= r) return { note: n, part: "tail" };
        if (dist(x, y, head.x, head.y) <= r) return { note: n, part: "head" };
        const o = s.orientation;
        const cross = o === "vertical" ? head.x : head.y;
        const c = o === "vertical" ? x : y;
        const p = o === "vertical" ? y : x;
        const p0 = o === "vertical" ? head.y : head.x;
        const p1 = o === "vertical" ? tail.y : tail.x;
        if (Math.abs(c - cross) <= r && p >= Math.min(p0, p1) && p <= Math.max(p0, p1)) {
          return { note: n, part: "body" };
        }
      } else if (dist(x, y, head.x, head.y) <= r) {
        return { note: n, part: "head" };
      }
    }
    return null;
  }

  notesInBox(
    box: { x0: number; y0: number; x1: number; y1: number },
    s: ViewState,
    notes: Note[],
  ): Note[] {
    const xMin = Math.min(box.x0, box.x1);
    const xMax = Math.max(box.x0, box.x1);
    const yMin = Math.min(box.y0, box.y1);
    const yMax = Math.max(box.y0, box.y1);
    return notes.filter((n) => {
      const p = this.notePoint(n.t, n.lane, s);
      return p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax;
    });
  }

  draw(s: DrawState): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawLanes(s);
    this.drawGrid(s);
    this.drawGutter(s);
    this.drawTempoMarkers(s);
    this.drawTimeSigMarkers(s);
    this.drawSimLines(s);
    this.drawSlideChains(s);

    const t0 = s.scroll - 2;
    const t1 = s.scroll + this.timeSpan(s) + 2;
    for (const n of s.notes) {
      if (n.t + n.dur < t0 || n.t > t1) continue;
      this.drawNote(n, s, s.selection.has(n.id), 1);
    }

    if (s.pendingHold) {
      this.drawNote(
        { id: -1, t: s.pendingHold.t, lane: s.pendingHold.lane, kind: "hold", dur: s.pendingHold.dur },
        s,
        false,
        0.55,
      );
    } else if (s.ghost) {
      this.drawNote(
        { id: -1, t: s.ghost.t, lane: s.ghost.lane, kind: s.ghost.kind, dur: 0 },
        s,
        false,
        0.4,
      );
    }

    if (s.activeSlideFrom && s.ghost) {
      const from = this.notePoint(s.activeSlideFrom.t, s.activeSlideFrom.lane, s);
      const to = this.notePoint(s.ghost.t, s.ghost.lane, s);
      ctx.strokeStyle = COLORS.slidePreview;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.drawPlayhead(s);

    if (s.box) {
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.min(s.box.x0, s.box.x1),
        Math.min(s.box.y0, s.box.y1),
        Math.abs(s.box.x1 - s.box.x0),
        Math.abs(s.box.y1 - s.box.y0),
      );
      ctx.setLineDash([]);
    }

    this.drawLaneHeaders(s.orientation);
  }

  private drawLanes(s: DrawState): void {
    const { ctx } = this;
    const o = s.orientation;
    const band = this.laneBand(o);
    for (let idx = 0; idx < 9; idx++) {
      ctx.fillStyle = idx % 2 === 0 ? COLORS.laneA : COLORS.laneB;
      if (o === "vertical") ctx.fillRect(GUTTER + idx * band, 0, band, this.h);
      else ctx.fillRect(GUTTER, GUTTER + idx * band, this.w - GUTTER, band);
    }
    ctx.strokeStyle = COLORS.laneLine;
    ctx.lineWidth = 1;
    for (let idx = 0; idx <= 9; idx++) {
      const c = Math.round(GUTTER + idx * band) + 0.5;
      ctx.beginPath();
      if (o === "vertical") {
        ctx.moveTo(c, 0);
        ctx.lineTo(c, this.h);
      } else {
        ctx.moveTo(GUTTER, c);
        ctx.lineTo(this.w, c);
      }
      ctx.stroke();
    }
  }

  private timeLine(t: number, s: DrawState, color: string, width: number): void {
    const { ctx } = this;
    const o = s.orientation;
    const p = Math.round(this.tpx(t, s)) + 0.5;
    const lo = this.tOffset(o);
    if (p < lo - 2 || p > lo + this.timeSpanPx(o) + 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    if (o === "vertical") {
      ctx.moveTo(GUTTER, p);
      ctx.lineTo(this.w, p);
    } else {
      ctx.moveTo(p, GUTTER);
      ctx.lineTo(p, this.h);
    }
    ctx.stroke();
  }

  /** The time-signature segment covering `beat` (continuous beat count from song start). */
  private timeSigSegAt(s: DrawState, beat: number): { startBeat: number; startMeasure: number; beats: number } {
    const segs = s.timeSigSegments.length ? s.timeSigSegments : [{ startBeat: 0, startMeasure: 0, beats: 4 }];
    let seg = segs[0];
    for (const cand of segs) {
      if (cand.startBeat > beat + 1e-6) break;
      seg = cand;
    }
    return seg;
  }

  private drawGrid(s: DrawState): void {
    const segments = s.tempoSegments.length
      ? s.tempoSegments
      : [{ startSec: s.offset, startBeat: 0, bpm: s.bpm }];
    const t0 = s.scroll;
    const t1 = s.scroll + this.timeSpan(s);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.bpm <= 0) continue;
      const segEnd = i + 1 < segments.length ? segments[i + 1].startSec : Infinity;
      if (segEnd < t0 || seg.startSec > t1) continue; // outside the visible window
      const lo = Math.max(t0, seg.startSec);
      const hi = Math.min(t1, segEnd);
      // Lines are anchored at this segment's own start, `startSec + k * gridStepSec(...)` —
      // the exact slots tempo.ts's slotTime describes and the editor snaps to, so a drawn
      // line and a snapped click agree bit for bit.
      const div = Math.max(1, s.snap);
      const beat = gridStepSec(seg.bpm, 1);
      const sub = gridStepSec(seg.bpm, div);

      if (sub * s.zoom >= 5 && s.snap > 1) {
        let k = Math.ceil((lo - seg.startSec) / sub - 1e-6);
        for (; seg.startSec + k * sub <= hi; k++) {
          if (((k % s.snap) + s.snap) % s.snap === 0) continue; // beat line, drawn below
          this.timeLine(seg.startSec + k * sub, s, COLORS.sub, 1);
        }
      }
      if (beat * s.zoom >= 4) {
        // Beat numbering restarts with the grid at each change: a segment's first line takes
        // the next whole beat number after the previous segment's last line (ceil of its
        // continuous beat position), so numbers stay unique and increasing across a change.
        // Measure numbering counts continuously across BOTH tempo and time-signature changes.
        const firstBeat = Math.max(0, Math.ceil(seg.startBeat - 1e-9));
        for (let k = Math.ceil((lo - seg.startSec) / beat - 1e-6); ; k++) {
          // beat k is this segment's slot k*div — spelled with the slot formula, not
          // `k * beat`, which can differ by an ulp for snaps that aren't a power of two
          const t = seg.startSec + k * div * sub;
          if (t > hi) break;
          const globalBeat = firstBeat + k;
          const tsSeg = this.timeSigSegAt(s, globalBeat);
          const beatsPerMeasure = Math.max(1, tsSeg.beats);
          const beatInSeg = Math.round(globalBeat - tsSeg.startBeat);
          const measure = ((beatInSeg % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure === 0;
          this.timeLine(t, s, measure ? COLORS.measure : COLORS.beat, measure ? 1.5 : 1);
          if (measure && beat * s.zoom * beatsPerMeasure > 40) {
            const { ctx } = this;
            ctx.fillStyle = COLORS.label;
            ctx.font = "10px ui-monospace, monospace";
            const p = this.tpx(t, s);
            const label = `${Math.round(tsSeg.startMeasure) + Math.floor(beatInSeg / beatsPerMeasure) + 1}`;
            if (s.orientation === "vertical") ctx.fillText(label, GUTTER + 4, p - 3);
            else ctx.fillText(label, p + 3, GUTTER + 11);
          }
        }
      }
    }
  }

  private drawGutter(s: DrawState): void {
    const { ctx } = this;
    const o = s.orientation;
    ctx.fillStyle = COLORS.gutterBg;
    if (o === "vertical") ctx.fillRect(0, 0, GUTTER, this.h);
    else ctx.fillRect(0, 0, this.w, GUTTER);

    // waveform: one max-abs bar per pixel along the time axis
    if (s.peaks) {
      const span = this.timeSpanPx(o);
      const off = this.tOffset(o);
      const mid = GUTTER * 0.55;
      const halfMax = GUTTER * 0.4;
      for (let p = 0; p < span; p++) {
        const tA = s.scroll + p / s.zoom;
        const tB = s.scroll + (p + 1) / s.zoom;
        if (tB < 0 || tA > s.duration) continue;
        let amp = 0;
        const bA = Math.max(0, Math.floor(tA * s.peaksPerSec));
        const bB = Math.min(s.peaks.length - 1, Math.floor(tB * s.peaksPerSec));
        for (let b = bA; b <= bB; b++) amp = Math.max(amp, s.peaks[b]);
        const half = Math.max(0.6, amp * halfMax);
        ctx.fillStyle = amp > 0.9 ? COLORS.waveLoud : COLORS.wave;
        if (o === "vertical") ctx.fillRect(mid - half, off + p, half * 2, 1);
        else ctx.fillRect(off + p, mid - half, 1, half * 2);
      }
    }

    // time labels
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((v) => v * s.zoom >= 48) ?? 120;
    ctx.fillStyle = COLORS.label;
    ctx.font = "10px ui-monospace, monospace";
    const t0 = Math.max(0, s.scroll);
    const t1 = s.scroll + this.timeSpan(s);
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const p = Math.round(this.tpx(t, s));
      const m = Math.floor(t / 60);
      const sec = t - m * 60;
      const label = `${m}:${sec < 9.95 ? "0" : ""}${step < 1 ? sec.toFixed(1) : Math.round(sec)}`;
      if (o === "vertical") {
        ctx.fillRect(0, p, 6, 1);
        ctx.fillText(label, 2, p + 11);
      } else {
        ctx.fillRect(p, 0, 1, 6);
        ctx.fillText(label, p + 3, 14);
      }
    }

    // gutter/lanes divider
    ctx.strokeStyle = COLORS.measure;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (o === "vertical") {
      ctx.moveTo(GUTTER + 0.5, 0);
      ctx.lineTo(GUTTER + 0.5, this.h);
    } else {
      ctx.moveTo(0, GUTTER + 0.5);
      ctx.lineTo(this.w, GUTTER + 0.5);
    }
    ctx.stroke();
  }

  /** A dashed line + BPM label chip at each tempo change, drawn over the grid AND the
   *  gutter/waveform (called right after drawGutter) so the change is visible either way. */
  private drawTempoMarkers(s: DrawState): void {
    if (s.tempoSegments.length < 2) return;
    const { ctx } = this;
    const o = s.orientation;
    const t0 = s.scroll - 1;
    const t1 = s.scroll + this.timeSpan(s) + 1;

    for (let i = 1; i < s.tempoSegments.length; i++) {
      const seg = s.tempoSegments[i];
      if (seg.startSec < t0 || seg.startSec > t1) continue;
      const p = Math.round(this.tpx(seg.startSec, s)) + 0.5;

      ctx.strokeStyle = COLORS.tempoMarker;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      if (o === "vertical") {
        ctx.moveTo(0, p);
        ctx.lineTo(this.w, p);
      } else {
        ctx.moveTo(p, 0);
        ctx.lineTo(p, this.h);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const label = `♩${Math.round(seg.bpm * 100) / 100}`;
      ctx.font = "700 10px ui-monospace, monospace";
      const textW = ctx.measureText(label).width;
      const padX = 4;
      const boxW = textW + padX * 2;
      const boxH = 14;
      const bx = o === "vertical" ? 2 : Math.min(p + 3, this.w - boxW - 2);
      const by = o === "vertical" ? Math.min(Math.max(p - boxH - 1, GUTTER + 1), this.h - boxH - 1) : GUTTER + 2;

      ctx.beginPath();
      roundRect(ctx, bx, by, boxW, boxH, 3);
      ctx.fillStyle = COLORS.tempoMarker;
      ctx.fill();
      ctx.fillStyle = COLORS.tempoMarkerText;
      ctx.fillText(label, bx + padX, by + boxH - 4);
    }
  }

  /** Same idea as drawTempoMarkers, for time-signature changes — offset below the tempo
   *  chip (or to the side, in horizontal layout) so the two don't overlap when they land
   *  at the same time. */
  private drawTimeSigMarkers(s: DrawState): void {
    if (s.timeSigSegments.length < 2) return;
    const { ctx } = this;
    const o = s.orientation;
    const t0 = s.scroll - 1;
    const t1 = s.scroll + this.timeSpan(s) + 1;

    for (let i = 1; i < s.timeSigSegments.length; i++) {
      const seg = s.timeSigSegments[i];
      if (seg.startSec < t0 || seg.startSec > t1) continue;
      const p = Math.round(this.tpx(seg.startSec, s)) + 0.5;

      ctx.strokeStyle = COLORS.timeSigMarker;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      if (o === "vertical") {
        ctx.moveTo(0, p);
        ctx.lineTo(this.w, p);
      } else {
        ctx.moveTo(p, 0);
        ctx.lineTo(p, this.h);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const label = `${seg.beats}/4`;
      ctx.font = "700 10px ui-monospace, monospace";
      const textW = ctx.measureText(label).width;
      const padX = 4;
      const boxW = textW + padX * 2;
      const boxH = 14;
      const bx = o === "vertical" ? 2 : Math.min(p + 3, this.w - boxW - 2);
      // Offset from drawTempoMarkers' spot (above the line / first row) so a change that
      // lands at the same time as a tempo change doesn't overlap it: below the line in
      // vertical layout, a second row below GUTTER in horizontal layout.
      const by =
        o === "vertical"
          ? Math.min(Math.max(p + 2, GUTTER + 1), this.h - boxH - 1)
          : GUTTER + 2 + boxH + 2;

      ctx.beginPath();
      roundRect(ctx, bx, by, boxW, boxH, 3);
      ctx.fillStyle = COLORS.timeSigMarker;
      ctx.fill();
      ctx.fillStyle = COLORS.timeSigMarkerText;
      ctx.fillText(label, bx + padX, by + boxH - 4);
    }
  }

  private drawSimLines(s: DrawState): void {
    const { ctx } = this;
    const t0 = s.scroll - 1;
    const t1 = s.scroll + this.timeSpan(s) + 1;
    // Two notes are simultaneous to within this — matching ew's own SIMULTANEOUS_EPSILON_SEC
    // (chart.rs), which is what actually decides it once the chart is uploaded. Grouping by
    // exact equality here would show two notes as NOT simultaneous whenever their raw values
    // had drifted a few float ulps apart (different computation paths for "the same" instant
    // — e.g. a hold's computed tail vs. an independently-placed tap), then flip to
    // simultaneous as soon as the project is saved and reloaded, since round6 collapses that
    // drift into identical decimal literals on the way out. Same intent, same eventual
    // upload result — it shouldn't look different depending on whether you've saved yet.
    const SIM_EPS = 1e-6;
    const visible = s.notes.filter((n) => n.t >= t0 && n.t <= t1).sort((a, b) => a.t - b.t);
    const groups: Note[][] = [];
    for (const n of visible) {
      const last = groups[groups.length - 1];
      // Anchored to the group's FIRST member (same anchor ew's own clustering uses), not
      // the previous note, so a long near-drifting run can't chain past the epsilon.
      if (last && n.t - last[0].t <= SIM_EPS) last.push(n);
      else groups.push([n]);
    }
    ctx.strokeStyle = COLORS.sim;
    ctx.lineWidth = 2;
    for (const group of groups) {
      if (group.length < 2) continue;
      const pts = group.map((n) => this.notePoint(n.t, n.lane, s));
      ctx.beginPath();
      if (s.orientation === "vertical") {
        ctx.moveTo(Math.min(...pts.map((p) => p.x)), pts[0].y);
        ctx.lineTo(Math.max(...pts.map((p) => p.x)), pts[0].y);
      } else {
        ctx.moveTo(pts[0].x, Math.min(...pts.map((p) => p.y)));
        ctx.lineTo(pts[0].x, Math.max(...pts.map((p) => p.y)));
      }
      ctx.stroke();
    }
  }

  private drawSlideChains(s: DrawState): void {
    const { ctx } = this;
    const t0 = s.scroll - 2;
    const t1 = s.scroll + this.timeSpan(s) + 2;
    const groups = new Map<number, Note[]>();
    for (const n of s.notes) {
      if (n.kind !== "slide" || n.slideId === undefined) continue;
      if (n.t < t0 || n.t > t1) continue;
      const g = groups.get(n.slideId);
      if (g) g.push(n);
      else groups.set(n.slideId, [n]);
    }
    ctx.strokeStyle = COLORS.slideChain;
    ctx.lineWidth = 3;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((a, b) => a.t - b.t);
      ctx.beginPath();
      ordered.forEach((n, i) => {
        const p = this.notePoint(n.t, n.lane, s);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
  }

  private drawNote(n: Note, s: DrawState, selected: boolean, alpha: number): void {
    const { ctx } = this;
    const o = s.orientation;
    const r = this.noteRadius(o);
    const head = this.notePoint(n.t, n.lane, s);
    ctx.globalAlpha = alpha;
    const editing = n.id === s.activeSlideEditId;
    const ring = editing ? COLORS.slideEditRing : selected ? COLORS.selectRing : null;
    const ringWidth = editing ? ACTIVE_SLIDE_RING_WIDTH : SELECT_RING_WIDTH;

    if (n.kind === "hold") {
      const tail = this.notePoint(n.t + n.dur, n.lane, s);
      ctx.fillStyle = COLORS.holdBody;
      ctx.beginPath();
      const bw = r * 1.1;
      if (o === "vertical") {
        roundRect(ctx, head.x - bw / 2, Math.min(head.y, tail.y), bw, Math.abs(tail.y - head.y), bw / 2);
      } else {
        roundRect(ctx, Math.min(head.x, tail.x), head.y - bw / 2, Math.abs(tail.x - head.x), bw, bw / 2);
      }
      ctx.fill();
      // A flick-ended hold's tail is colored like a flick note, so its release reads
      // differently from a normal one at a glance without needing a whole new shape.
      const [tailFill, tailRim] = n.flickEnd ? [COLORS.flick, COLORS.flickRim] : [COLORS.hold, COLORS.holdRim];
      circle(ctx, tail.x, tail.y, r * 0.72, tailFill, tailRim, ring, ringWidth);
      circle(ctx, head.x, head.y, r, COLORS.hold, COLORS.holdRim, ring, ringWidth);
    } else if (n.kind === "star") {
      star(ctx, head.x, head.y, r * 1.15, COLORS.star, COLORS.starRim, ring, ringWidth);
    } else if (n.kind === "flick") {
      chevron(ctx, head.x, head.y, r, o, COLORS.flick, COLORS.flickRim, ring, ringWidth);
    } else if (n.kind === "slide") {
      if (n.dur > 0) {
        const tail = this.notePoint(n.t + n.dur, n.lane, s);
        ctx.fillStyle = COLORS.slideBody;
        ctx.beginPath();
        const bw = r * 1.1;
        if (o === "vertical") {
          roundRect(ctx, head.x - bw / 2, Math.min(head.y, tail.y), bw, Math.abs(tail.y - head.y), bw / 2);
        } else {
          roundRect(ctx, Math.min(head.x, tail.x), head.y - bw / 2, Math.abs(tail.x - head.x), bw, bw / 2);
        }
        ctx.fill();
        circle(ctx, tail.x, tail.y, r * 0.72, COLORS.slide, COLORS.slideRim, ring, ringWidth);
      }
      // A flick-ended chain's last point is drawn as a chevron instead of the usual
      // diamond, same shape a standalone flick uses, so the ending reads at a glance.
      if (n.flickEnd) {
        chevron(ctx, head.x, head.y, r, o, COLORS.flick, COLORS.flickRim, ring, ringWidth);
      } else {
        diamond(ctx, head.x, head.y, r, COLORS.slide, COLORS.slideRim, ring, ringWidth);
      }
    } else {
      circle(ctx, head.x, head.y, r, COLORS.tap, COLORS.tapRim, ring, ringWidth);
    }
    ctx.globalAlpha = 1;
  }

  private drawPlayhead(s: DrawState): void {
    const { ctx } = this;
    const o = s.orientation;
    const p = this.tpx(s.cursor, s);
    const lo = this.tOffset(o);
    if (p < lo - 2 || p > lo + this.timeSpanPx(o) + 2) return;
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (o === "vertical") {
      ctx.moveTo(0, p);
      ctx.lineTo(this.w, p);
    } else {
      ctx.moveTo(p, 0);
      ctx.lineTo(p, this.h);
    }
    ctx.stroke();
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    if (o === "vertical") {
      ctx.moveTo(0, p - 5);
      ctx.lineTo(8, p);
      ctx.lineTo(0, p + 5);
    } else {
      ctx.moveTo(p - 5, 0);
      ctx.lineTo(p, 8);
      ctx.lineTo(p + 5, 0);
    }
    ctx.fill();
  }

  private drawLaneHeaders(o: Orientation): void {
    const { ctx } = this;
    const band = this.laneBand(o);
    ctx.font = "700 11px ui-monospace, monospace";
    ctx.fillStyle = COLORS.label;
    for (let idx = 0; idx < 9; idx++) {
      const lane = o === "vertical" ? 9 - idx : idx + 1;
      if (o === "vertical") {
        ctx.fillText(String(lane), GUTTER + (idx + 0.5) * band - 3, 14);
      } else {
        ctx.fillText(String(lane), GUTTER - 16, GUTTER + (idx + 0.5) * band + 4);
      }
    }
  }
}

function dist(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

function circle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  rim: string,
  ring: string | null,
  ringWidth: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = rim;
  ctx.stroke();
  if (ring) selectRing(ctx, x, y, r, ring, ringWidth);
}

function star(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  rim: string,
  ring: string | null,
  ringWidth: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = rim;
  ctx.stroke();
  if (ring) selectRing(ctx, x, y, r, ring, ringWidth);
}

function diamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  rim: string,
  ring: string | null,
  ringWidth: number,
): void {
  const d = r * 1.15;
  ctx.beginPath();
  ctx.moveTo(x, y - d);
  ctx.lineTo(x + d, y);
  ctx.lineTo(x, y + d);
  ctx.lineTo(x - d, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = rim;
  ctx.stroke();
  if (ring) selectRing(ctx, x, y, r, ring, ringWidth);
}

/** A flick's glyph: a chevron pointing along the time axis, distinct from every other
 *  note shape so a flick — standalone, or a hold/slide ending in one — reads at a glance. */
function chevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  o: Orientation,
  fill: string,
  rim: string,
  ring: string | null,
  ringWidth: number,
): void {
  const d = r * 1.2;
  ctx.beginPath();
  if (o === "vertical") {
    ctx.moveTo(x - d, y - d * 0.8);
    ctx.lineTo(x + d * 0.7, y);
    ctx.lineTo(x - d, y + d * 0.8);
  } else {
    ctx.moveTo(x - d * 0.8, y - d);
    ctx.lineTo(x, y + d * 0.7);
    ctx.lineTo(x + d * 0.8, y - d);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = rim;
  ctx.stroke();
  if (ring) selectRing(ctx, x, y, r, ring, ringWidth);
}

function selectRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r + 2 + width / 2, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

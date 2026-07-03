import type { Note, NoteKind } from "./chart.js";

export type Orientation = "vertical" | "horizontal";

export interface ViewState {
  orientation: Orientation;
  /** Time at the start edge of the time axis, seconds. */
  scroll: number;
  /** Pixels per second along the time axis. */
  zoom: number;
  bpm: number;
  offset: number;
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
};

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
      if (n.kind === "hold") {
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
    this.drawSimLines(s);

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

  private drawGrid(s: DrawState): void {
    if (s.bpm <= 0) return;
    const beat = 60 / s.bpm;
    const sub = beat / Math.max(1, s.snap);
    const t0 = s.scroll;
    const t1 = s.scroll + this.timeSpan(s);

    if (sub * s.zoom >= 5 && s.snap > 1) {
      let k = Math.ceil((t0 - s.offset) / sub - 1e-6);
      for (; s.offset + k * sub <= t1; k++) {
        if (((k % s.snap) + s.snap) % s.snap === 0) continue; // beat line, drawn below
        this.timeLine(s.offset + k * sub, s, COLORS.sub, 1);
      }
    }
    if (beat * s.zoom >= 4) {
      let k = Math.ceil((t0 - s.offset) / beat - 1e-6);
      for (; s.offset + k * beat <= t1; k++) {
        const measure = ((k % 4) + 4) % 4 === 0;
        this.timeLine(
          s.offset + k * beat,
          s,
          measure ? COLORS.measure : COLORS.beat,
          measure ? 1.5 : 1,
        );
        if (measure && beat * s.zoom * 4 > 40) {
          const { ctx } = this;
          ctx.fillStyle = COLORS.label;
          ctx.font = "10px ui-monospace, monospace";
          const p = this.tpx(s.offset + k * beat, s);
          const label = `${Math.floor(k / 4) + 1}`;
          if (s.orientation === "vertical") ctx.fillText(label, GUTTER + 4, p - 3);
          else ctx.fillText(label, p + 3, GUTTER + 11);
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

  private drawSimLines(s: DrawState): void {
    const { ctx } = this;
    const t0 = s.scroll - 1;
    const t1 = s.scroll + this.timeSpan(s) + 1;
    const groups = new Map<number, Note[]>();
    for (const n of s.notes) {
      if (n.t < t0 || n.t > t1) continue;
      const g = groups.get(n.t);
      if (g) g.push(n);
      else groups.set(n.t, [n]);
    }
    ctx.strokeStyle = COLORS.sim;
    ctx.lineWidth = 2;
    for (const group of groups.values()) {
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

  private drawNote(n: Note, s: DrawState, selected: boolean, alpha: number): void {
    const { ctx } = this;
    const o = s.orientation;
    const r = this.noteRadius(o);
    const head = this.notePoint(n.t, n.lane, s);
    ctx.globalAlpha = alpha;

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
      circle(ctx, tail.x, tail.y, r * 0.72, COLORS.hold, COLORS.holdRim, selected);
      circle(ctx, head.x, head.y, r, COLORS.hold, COLORS.holdRim, selected);
    } else if (n.kind === "star") {
      star(ctx, head.x, head.y, r * 1.15, COLORS.star, COLORS.starRim, selected);
    } else {
      circle(ctx, head.x, head.y, r, COLORS.tap, COLORS.tapRim, selected);
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
  selected: boolean,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = rim;
  ctx.stroke();
  if (selected) selectRing(ctx, x, y, r);
}

function star(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  rim: string,
  selected: boolean,
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
  if (selected) selectRing(ctx, x, y, r);
}

function selectRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r + 3, 0, Math.PI * 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
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

// Renders the in-game-style note preview: a SIF-like fan of 9 judgment positions, all the
// same distance from a top-center spawn point (lane 1/9 sitting level with it, either
// side), with notes flying out from the spawn point and growing to full size as they
// arrive.
import type { Note, NoteKind } from "./chart.js";

export interface PreviewState {
  /** Current playhead time, seconds. */
  now: number;
  /** Seconds from a note's spawn to its arrival at the judgment position. */
  approachSec: number;
  notes: Note[];
  /** Judgment-position display size multiplier, 0.5-2.0 (1.0 = 100%). */
  sizeScale: number;
  /** e.g. "Measure 12 · Beat 3", already formatted (tempo/time-signature math lives in
   *  editor.ts, which has the song's tempo map — this renderer just displays it). */
  measureLabel: string;
  /** Notes/sec for the current measure and the 3 after it (index 0 = current). */
  measureNps: number[];
  /** Notes/sec for every measure across the whole song — the whole-song density strip. */
  songMeasureNps: number[];
  /** Index into songMeasureNps that's current — highlighted as the strip's playhead. */
  currentMeasureIndex: number;
  /** How far through currentMeasureIndex playback is, 0-1 — positions the exact playhead
   *  line within that measure's bar (currentMeasureIndex alone only picks the bar). */
  currentMeasureFrac: number;
  /** Song-strip position (measure index + fraction, matching songPositionAtPoint) under
   *  the pointer — while hovering OR dragging — for the seek tooltip; null when neither. */
  songHoverPos: number | null;
  /** Formatted "m:ss · Measure N" text for songHoverPos (tempo math lives in editor.ts,
   *  same reason measureLabel is pre-formatted there). */
  songHoverLabel: string | null;
  /** Lane (1-9) the pointer is currently over the lane-stats chart for, if any — see
   *  laneAtPoint(). */
  hoverLane: number | null;
}

const LANES = 9;
/** Scale at spawn (grows to 1 at arrival). */
const MIN_SCALE = 0.14;
/** Judgment-position radius as a fraction of the fan radius (spawn-to-judgment distance)
 *  at sizeScale 1 — ties the drawn size to the actual layout distance, so it only changes
 *  when that distance does, not whenever the panel's raw width does. */
const JUDGE_RADIUS_RATIO = 0.15;
/** Display size goes up to 125% (see editor.ts's size-scale control) — geometry reserves
 *  room for that worst case up front so judgment positions never clip regardless of the
 *  CURRENT size, and so their centers don't shift as the size changes. */
const JUDGE_RADIUS_MAX_SCALE = 1.25;

const COLORS = {
  bg: "#101018",
  guide: "#26263a",
  judge: "#20202f",
  judgeRim: "#4a4a6e",
  tap: "#ff8fb0",
  tapRim: "#c25476",
  hold: "#6fd98b",
  holdRim: "#2c7a45",
  holdBody: "rgba(111, 217, 139, 0.35)",
  star: "#ffcf5e",
  starRim: "#c69a2e",
  slide: "#b48cff",
  slideRim: "#7c56c9",
  slideBody: "rgba(180, 140, 255, 0.35)",
  flick: "#4ea8ff",
  flickRim: "#2b6fb8",
  label: "#77748f",
  labelStrong: "#eceaf4",
  density: "#62b1ff",
  densityNow: "#ffab49",
  tooltipBg: "#2e2e45",
  tooltipBorder: "#4a4a6e",
};

function colorFor(kind: NoteKind): readonly [string, string, string] {
  switch (kind) {
    case "hold":
      return [COLORS.hold, COLORS.holdRim, COLORS.holdBody] as const;
    case "star":
      return [COLORS.star, COLORS.starRim, COLORS.starRim] as const;
    case "slide":
      return [COLORS.slide, COLORS.slideRim, COLORS.slideBody] as const;
    case "flick":
      return [COLORS.flick, COLORS.flickRim, COLORS.flickRim] as const;
    default:
      return [COLORS.tap, COLORS.tapRim, COLORS.tapRim] as const;
  }
}

/** 0 (spawn) -> 1 (arrival); eased so growth accelerates near arrival, like perspective. */
function noteScale(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return MIN_SCALE + (1 - MIN_SCALE) * p * p;
}

interface LaneCounts {
  tap: number;
  hold: number;
  star: number;
  slide: number;
  flick: number;
}

/** Note counts per lane (index 0 = lane 1), broken down by kind. */
function laneCounts(notes: Note[]): LaneCounts[] {
  const counts: LaneCounts[] = Array.from({ length: LANES }, () => ({ tap: 0, hold: 0, star: 0, slide: 0, flick: 0 }));
  for (const n of notes) {
    const c = counts[n.lane - 1];
    if (c) c[n.kind]++;
  }
  return counts;
}

interface Point {
  x: number;
  y: number;
}

export class NotePreviewRenderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  // How many measures the last draw() laid the song-density strip out over — hit-testing
  // (songPositionAtPoint) needs this to invert a click's x back into a measure position,
  // and it isn't otherwise a function of the panel's own fixed geometry (unlike lanes,
  // always 9), so draw() has to remember it for whenever a pointer event asks.
  private songMeasureCount = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Spawn point, and the radius (distance from spawn) every judgment position sits at —
   *  purely a function of the panel's own dimensions, independent of the display-size
   *  scale, so judgment positions keep a fixed center as that scale changes. The margin
   *  around the fan is sized for the LARGEST a judgment position can ever draw (see
   *  JUDGE_RADIUS_MAX_SCALE) so it never gets clipped at the top or sides, no matter the
   *  current size setting. The fan is kept in the upper part of the panel — the rest
   *  (statsTop downward) is used for the lane-stats bar chart below. */
  private geometry(): { spawn: Point; fanRadius: number; statsTop: number; comboY: number } {
    const edgeMargin = 3;
    // Room for the "N Combo" readout, drawn just above the spawn point.
    const topReserve = 16;
    // Reserves room for the measure/beat readout, the density chart and the lane-stats
    // chart below the fan (see statsLayout()).
    const bottomReserveFrac = 0.45;
    // judgeRadius = fanRadius * k at the largest size setting — lane 1/9 (level with
    // spawn, either side) need fanRadius + fanRadius*k to clear the sides, and their top
    // edge (spawn.y - fanRadius*k) needs to clear the combo readout above. The +10% covers
    // the judgment ring's own stroke, which is drawn centered on that radius and so extends
    // a bit further out still.
    const k = JUDGE_RADIUS_RATIO * JUDGE_RADIUS_MAX_SCALE * 1.1;
    const widthLimit = Math.max(10, (this.w / 2 - edgeMargin) / (1 + k));
    const topRegionBottom = this.h * (1 - bottomReserveFrac);
    // Lane 5 (straight down) needs spawn.y + fanRadius + fanRadius*k to clear the
    // reserved bottom area, and spawn.y itself is topReserve + fanRadius*k + edgeMargin.
    const heightLimit = Math.max(10, (topRegionBottom - edgeMargin - topReserve) / (1 + 2 * k));
    const fanRadius = Math.max(16, Math.min(widthLimit, heightLimit));
    const spawn = { x: this.w / 2, y: topReserve + fanRadius * k + edgeMargin };
    // Start the stats block right after the fan's own actual bottom edge (which is often
    // well short of topRegionBottom — e.g. whenever the fan is width- rather than
    // height-limited) rather than always at the reserved boundary, so there's no dead gap
    // between them.
    const statsTop = Math.min(topRegionBottom, spawn.y + fanRadius * (1 + k));
    // Sits just above the spawn point — where notes actually emerge from — rather than
    // at a fixed distance from the panel's edge, so it tracks the fan as its size changes.
    return { spawn, fanRadius, statsTop, comboY: spawn.y - 8 };
  }

  /** How the area below the fan (from statsTop down) splits into rows — the measure/beat
   *  label, the density mini-chart, and the lane-stats chart — degrading gracefully (later
   *  rows dropped first) if the panel is too short to fit all of them. Shared by draw()
   *  and laneAtPoint() so hit-testing always matches what's actually drawn. */
  private statsLayout(statsTop: number): {
    measureY: number | null;
    npsTop: number | null;
    npsBottom: number | null;
    songTop: number | null;
    songBottom: number | null;
    laneTop: number;
    laneBottom: number;
  } {
    const top = statsTop + 4;
    // Leaves clear space below the lane-stats chart rather than running it to the edge.
    const bottom = this.h - 16;
    let cursor = top;
    let measureY: number | null = null;
    let npsTop: number | null = null;
    let npsBottom: number | null = null;
    let songTop: number | null = null;
    let songBottom: number | null = null;

    const measureRowH = 11;
    if (bottom - cursor >= measureRowH + 10) {
      measureY = cursor + 8;
      cursor += measureRowH;
    }
    const npsRowH = 34;
    if (bottom - cursor >= npsRowH + 10) {
      npsTop = cursor + 3;
      npsBottom = npsTop + npsRowH - 12;
      cursor = npsTop + npsRowH;
    }
    const songRowH = 22;
    if (bottom - cursor >= songRowH + 10) {
      songTop = cursor + 3;
      songBottom = songTop + songRowH - 6;
      cursor = songTop + songRowH;
    }
    return { measureY, npsTop, npsBottom, songTop, songBottom, laneTop: cursor, laneBottom: bottom };
  }

  /** Judgment-position display radius — proportional to the fan radius (the actual
   *  spawn-to-judgment distance), so it only grows when that distance does. */
  private judgeRadius(fanRadius: number, sizeScale: number): number {
    const scale = Math.min(2, Math.max(0.5, sizeScale));
    return fanRadius * JUDGE_RADIUS_RATIO * scale;
  }

  /** Lane 1 (rightmost) sits at angle 0, lane 9 (leftmost) at angle PI — both level with
   *  spawn, either side of it — sweeping through straight down (lane 5) in between. */
  private judgePos(spawn: Point, fanRadius: number, lane: number): Point {
    const angle = ((lane - 1) / (LANES - 1)) * Math.PI;
    return { x: spawn.x + fanRadius * Math.cos(angle), y: spawn.y + fanRadius * Math.sin(angle) };
  }

  private lerp(a: Point, b: Point, t: number): Point {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  draw(s: PreviewState): void {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const { spawn, fanRadius, statsTop, comboY } = this.geometry();
    this.drawCombo(s.notes, s.now, comboY);
    const judgeRadius = this.judgeRadius(fanRadius, s.sizeScale);
    const judgePositions: Point[] = [];
    for (let lane = 1; lane <= LANES; lane++) judgePositions.push(this.judgePos(spawn, fanRadius, lane));

    ctx.strokeStyle = COLORS.guide;
    ctx.lineWidth = 1;
    for (const p of judgePositions) {
      ctx.beginPath();
      ctx.moveTo(spawn.x, spawn.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    for (const p of judgePositions) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, judgeRadius, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.judge;
      ctx.fill();
      ctx.strokeStyle = COLORS.judgeRim;
      ctx.lineWidth = Math.max(1, judgeRadius * 0.16);
      ctx.stroke();
    }

    ctx.fillStyle = COLORS.judgeRim;
    ctx.fillRect(spawn.x - 0.5, spawn.y - 0.5, 1, 1);

    // Slide chains: the direction each note's arrow points — toward the next member, or
    // for a chain's last member (no next), the same direction as the one before it, so
    // the end point continues showing where the slide was heading.
    const slideDirection = new Map<number, number>();
    const bySlide = new Map<number, Note[]>();
    for (const n of s.notes) {
      if (n.kind !== "slide" || n.slideId === undefined) continue;
      let arr = bySlide.get(n.slideId);
      if (!arr) bySlide.set(n.slideId, (arr = []));
      arr.push(n);
    }
    for (const arr of bySlide.values()) {
      arr.sort((a, b) => a.t - b.t);
      for (let i = 0; i < arr.length; i++) {
        const from = i < arr.length - 1 ? arr[i] : arr[i - 1];
        const to = i < arr.length - 1 ? arr[i + 1] : arr[i];
        if (!from) continue; // single-member chain — no direction to show
        const a = judgePositions[from.lane - 1];
        const b = judgePositions[to.lane - 1];
        if (!a || !b) continue;
        slideDirection.set(arr[i].id, Math.atan2(b.y - a.y, b.x - a.x));
      }
    }

    // Notes judged at the same instant — each gets a horizontal tick over its own circle
    // (see below), rather than a line spanning between them.
    const timeCounts = new Map<number, number>();
    for (const n of s.notes) timeCounts.set(n.t, (timeCounts.get(n.t) ?? 0) + 1);

    for (const n of s.notes) {
      const untilHit = n.t - s.now;
      if (untilHit > s.approachSec) continue; // not spawned yet
      if (n.dur > 0) {
        if (s.now > n.t + n.dur) continue; // hold finished
      } else if (untilHit < 0) {
        continue; // already hit
      }
      const judge = judgePositions[n.lane - 1];
      if (!judge) continue;
      const headProgress = Math.min(1, Math.max(0, 1 - untilHit / s.approachSec));
      const headPos = this.lerp(spawn, judge, headProgress);
      const headRadius = judgeRadius * noteScale(headProgress);
      const [fill, rim, body] = colorFor(n.kind);
      // flickEnd marks the RELEASE as a flick — a hold's head (dur > 0) stays hold-colored
      // and only its tail marker below turns flick-blue; a flick-ended slide chain has no
      // duration of its own, so its tail IS this note's head circle and that's what has to
      // turn flick-blue instead.
      const [tailFill, tailRim] = n.flickEnd ? [COLORS.flick, COLORS.flickRim] : [fill, rim];
      const [headFill, headRim] = n.dur === 0 && n.flickEnd ? [COLORS.flick, COLORS.flickRim] : [fill, rim];

      if (n.dur > 0) {
        const tailUntil = n.t + n.dur - s.now;
        const tailProgress = Math.min(1, Math.max(0, 1 - tailUntil / s.approachSec));
        const tailPos = this.lerp(spawn, judge, tailProgress);
        const tailRadius = judgeRadius * noteScale(tailProgress);

        // Tapered translucent ribbon connecting head and tail.
        const dirX = fanRadius > 0 ? (judge.x - spawn.x) / fanRadius : 0;
        const dirY = fanRadius > 0 ? (judge.y - spawn.y) / fanRadius : 1;
        const perpX = -dirY;
        const perpY = dirX;
        // Full width of the ribbon at each end matches the note circle's own diameter.
        const headHalf = headRadius;
        const tailHalf = tailRadius;
        ctx.beginPath();
        ctx.moveTo(headPos.x + perpX * headHalf, headPos.y + perpY * headHalf);
        ctx.lineTo(tailPos.x + perpX * tailHalf, tailPos.y + perpY * tailHalf);
        ctx.lineTo(tailPos.x - perpX * tailHalf, tailPos.y - perpY * tailHalf);
        ctx.lineTo(headPos.x - perpX * headHalf, headPos.y - perpY * headHalf);
        ctx.closePath();
        ctx.fillStyle = body;
        ctx.fill();

        // Tail marker (the release point).
        ctx.beginPath();
        ctx.arc(tailPos.x, tailPos.y, tailRadius, 0, Math.PI * 2);
        ctx.fillStyle = tailFill;
        ctx.fill();
        ctx.lineWidth = Math.max(1, tailRadius * 0.18);
        ctx.strokeStyle = tailRim;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(headPos.x, headPos.y, headRadius, 0, Math.PI * 2);
      ctx.fillStyle = headFill;
      ctx.fill();
      ctx.lineWidth = Math.max(1, headRadius * 0.18);
      ctx.strokeStyle = headRim;
      ctx.stroke();

      // Slide direction arrow, overlaid on top of the note's circle.
      const angle = n.kind === "slide" ? slideDirection.get(n.id) : undefined;
      if (angle !== undefined) {
        ctx.save();
        ctx.translate(headPos.x, headPos.y);
        ctx.rotate(angle);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(-headRadius * 0.4, -headRadius * 0.55);
        ctx.lineTo(headRadius * 0.35, 0);
        ctx.lineTo(-headRadius * 0.4, headRadius * 0.55);
        ctx.strokeStyle = rim;
        ctx.lineWidth = Math.max(1.5, headRadius * 0.4);
        ctx.stroke();
        ctx.restore();
      }

      // Simultaneous-note mark, overlaid on top of the circle like the slide arrow above.
      if ((timeCounts.get(n.t) ?? 0) >= 2) {
        ctx.beginPath();
        ctx.moveTo(headPos.x - headRadius * 0.6, headPos.y);
        ctx.lineTo(headPos.x + headRadius * 0.6, headPos.y);
        ctx.strokeStyle = rim;
        ctx.lineWidth = Math.max(1.5, headRadius * 0.4);
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }

    const layout = this.statsLayout(statsTop);
    if (layout.measureY !== null) this.drawMeasureRow(s.measureLabel, layout.measureY);
    if (layout.npsTop !== null && layout.npsBottom !== null) {
      this.drawDensityChart(s.measureNps, layout.npsTop, layout.npsBottom);
    }
    if (layout.songTop !== null && layout.songBottom !== null) {
      this.drawSongDensityChart(
        s.songMeasureNps,
        s.currentMeasureIndex,
        s.currentMeasureFrac,
        layout.songTop,
        layout.songBottom,
      );
      if (s.songHoverPos !== null && s.songHoverLabel !== null) {
        this.drawSongTooltip(s.songHoverPos, s.songHoverLabel, layout.songTop);
      }
    }
    this.drawLaneStats(s.notes, layout.laneTop, layout.laneBottom);
    if (s.hoverLane !== null) this.drawLaneTooltip(s.notes, s.hoverLane, layout.laneTop);
  }

  /** Running combo — notes whose hit is already resolved as of `now`. A hold/slide-into-hold
   *  resolves at its release (t + dur), matching the same "the tail counts, not the head"
   *  rule ChartDoc.comboCount uses for the full-chart total; dur is 0 for everything else,
   *  so t + dur already reduces to a plain hit-time check for those. */
  private drawCombo(notes: Note[], now: number, y: number): void {
    let combo = 0;
    for (const n of notes) if (n.t + n.dur <= now) combo++;
    const { ctx, w } = this;
    ctx.font = "700 12px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.labelStrong;
    ctx.fillText(`${combo} Combo`, w / 2, y);
  }

  private drawMeasureRow(label: string, y: number): void {
    const { ctx, w } = this;
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.labelStrong;
    ctx.fillText(label, w / 2, y);
  }

  /** Notes/sec for the current measure (highlighted) and the 3 after it. */
  private drawDensityChart(nps: number[], top: number, bottom: number): void {
    const { ctx, w } = this;
    if (nps.length === 0 || bottom - top < 6) return;
    const margin = 8;
    const gap = 6;
    const barAreaH = bottom - top;
    const barW = Math.max(4, (w - margin * 2 - gap * (nps.length - 1)) / nps.length);
    const maxNps = Math.max(1e-6, ...nps);

    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < nps.length; i++) {
      const x = margin + i * (barW + gap);
      const cx = x + barW / 2;
      const segH = (nps[i] / maxNps) * barAreaH;
      ctx.fillStyle = i === 0 ? COLORS.densityNow : COLORS.density;
      ctx.fillRect(x, bottom - segH, barW, segH);
      ctx.fillStyle = COLORS.label;
      ctx.fillText(nps[i].toFixed(1), cx, bottom + 9);
    }
  }

  /** Notes/sec per MEASURE across the whole song (one bar per measure, same unit as the
   *  4-measure close-up above), with the current measure highlighted and an exact playhead
   *  line within it — an at-a-glance map of where the chart gets dense, and where you
   *  currently are in it. Doubles as a seek bar; see songPositionAtPoint(). */
  private drawSongDensityChart(
    nps: number[],
    currentMeasureIndex: number,
    currentMeasureFrac: number,
    top: number,
    bottom: number,
  ): void {
    const { ctx, w } = this;
    this.songMeasureCount = nps.length;
    if (nps.length === 0 || bottom - top < 4) return;
    const barAreaH = bottom - top;
    const barW = w / nps.length;
    const maxNps = Math.max(1e-6, ...nps);
    for (let i = 0; i < nps.length; i++) {
      const segH = (nps[i] / maxNps) * barAreaH;
      if (segH <= 0) continue;
      ctx.fillStyle = i === currentMeasureIndex ? COLORS.densityNow : COLORS.density;
      ctx.fillRect(i * barW, bottom - segH, Math.max(1, barW - 0.5), segH);
    }
    const px = Math.min(w, Math.max(0, (currentMeasureIndex + currentMeasureFrac) * barW));
    ctx.strokeStyle = COLORS.densityNow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.stroke();
  }

  /** Single-line "m:ss · Measure N" bubble above the song strip, following the pointer
   *  while hovering or dragging it (see songPositionAtPoint/songHoverPos). */
  private drawSongTooltip(pos: number, label: string, songTop: number): void {
    const { ctx, w } = this;
    if (this.songMeasureCount <= 0) return;
    const cx = (pos / this.songMeasureCount) * w;

    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    const padX = 6;
    const padY = 5;
    const textW = ctx.measureText(label).width;
    const boxW = textW + padX * 2;
    const boxH = 11 + padY * 2 - 2;
    const bx = Math.min(Math.max(cx - boxW / 2, 2), w - boxW - 2);
    const by = Math.max(2, songTop - boxH - 4);

    roundRect(ctx, bx, by, boxW, boxH, 4);
    ctx.fillStyle = COLORS.tooltipBg;
    ctx.fill();
    ctx.strokeStyle = COLORS.tooltipBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COLORS.labelStrong;
    ctx.fillText(label, bx + padX, by + padY + 11 - 3);
  }

  /** The song-strip position (measure index + fraction within it, matching
   *  currentMeasureIndex/currentMeasureFrac) a canvas-space point maps to, for the caller
   *  to convert into an actual seek time or tooltip text (this renderer doesn't know the
   *  tempo map) — or null outside the strip's row. Lets the strip double as a seek bar.
   *  `ignoreYBounds` skips the row's vertical extent — pass true while a drag begun on the
   *  strip is already in progress, so it keeps tracking the pointer past the row's edges
   *  (standard seek-bar behavior) instead of losing the drag the moment y strays off. */
  songPositionAtPoint(x: number, y: number, ignoreYBounds = false): number | null {
    const { statsTop } = this.geometry();
    const { songTop, songBottom } = this.statsLayout(statsTop);
    if (songTop === null || songBottom === null) return null;
    if (!ignoreYBounds && (y < songTop || y > songBottom)) return null;
    if (this.songMeasureCount <= 0) return null;
    return Math.min(this.songMeasureCount, Math.max(0, (x / this.w) * this.songMeasureCount));
  }

  /** x, width of the lane-stats bar for the i-th displayed column (0 = leftmost, lane 9). */
  private laneBarX(i: number): { x: number; barW: number } {
    const margin = 8;
    const gap = 3;
    const barW = Math.max(2, (this.w - margin * 2 - gap * (LANES - 1)) / LANES);
    return { x: margin + i * (barW + gap), barW };
  }

  /** Per-lane note counts, stacked by kind, in the area the fan leaves free below it. */
  private drawLaneStats(notes: Note[], top: number, bottom: number): void {
    const { ctx } = this;
    const countH = 12;
    const labelH = 11;
    const barTop = top + countH;
    const barBottom = bottom - labelH;
    if (barBottom - barTop < 8) return; // panel too short — skip rather than overlap

    const counts = laneCounts(notes);
    const totals = counts.map((c) => c.tap + c.hold + c.star + c.slide + c.flick);
    const maxTotal = Math.max(1, ...totals);
    const barAreaH = barBottom - barTop;
    const kinds: (keyof LaneCounts)[] = ["tap", "hold", "star", "slide", "flick"];

    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < LANES; i++) {
      // Displayed left-to-right as lane 9 (leftmost) .. lane 1 (rightmost), matching the
      // fan above and the game's own lane numbering.
      const lane = LANES - i;
      const c = counts[lane - 1];
      const total = totals[lane - 1];
      const { x, barW } = this.laneBarX(i);
      const cx = x + barW / 2;

      let y = barBottom;
      for (const kind of kinds) {
        const n = c[kind];
        if (n <= 0) continue;
        const segH = (n / maxTotal) * barAreaH;
        ctx.fillStyle = COLORS[kind];
        ctx.fillRect(x, y - segH, barW, segH);
        y -= segH;
      }

      ctx.fillStyle = COLORS.label;
      ctx.fillText(String(total), cx, barTop - 2);
      ctx.fillText(String(lane), cx, bottom - 1);
    }
  }

  /** Which lane (1-9) a canvas-space point falls over in the lane-stats chart, if any —
   *  for editor.ts to drive hover-tooltip state from pointer events. */
  laneAtPoint(x: number, y: number): number | null {
    const { statsTop } = this.geometry();
    const { laneTop, laneBottom } = this.statsLayout(statsTop);
    if (y < laneTop || y > laneBottom) return null;
    for (let i = 0; i < LANES; i++) {
      const { x: bx, barW } = this.laneBarX(i);
      if (x >= bx && x <= bx + barW) return LANES - i;
    }
    return null;
  }

  /** Breakdown for the hovered lane: its share of the whole chart, and each kind's count
   *  and share within that lane. */
  private drawLaneTooltip(notes: Note[], lane: number, laneTop: number): void {
    const counts = laneCounts(notes)[lane - 1];
    if (!counts) return;
    const total = counts.tap + counts.hold + counts.star + counts.slide + counts.flick;
    const grandTotal = notes.length;
    const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

    const kinds: { key: keyof LaneCounts; label: string }[] = [
      { key: "tap", label: "Tap" },
      { key: "hold", label: "Hold" },
      { key: "star", label: "Star" },
      { key: "slide", label: "Slide" },
      { key: "flick", label: "Flick" },
    ];
    const lines = [`Lane ${lane}: ${total} (${pct(total, grandTotal)}%)`];
    for (const { key, label } of kinds) {
      const n = counts[key];
      if (n > 0) lines.push(`${label}: ${n} (${pct(n, total)}%)`);
    }

    const { ctx, w } = this;
    const i = LANES - lane;
    const { x, barW } = this.laneBarX(i);
    const cx = Math.min(Math.max(x + barW / 2, 4), w - 4);

    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    const padX = 6;
    const padY = 5;
    const lineH = 11;
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = textW + padX * 2;
    const boxH = lines.length * lineH + padY * 2 - 2;
    const bx = Math.min(Math.max(cx - boxW / 2, 2), w - boxW - 2);
    const by = Math.max(2, laneTop - boxH - 4);

    roundRect(ctx, bx, by, boxW, boxH, 4);
    ctx.fillStyle = COLORS.tooltipBg;
    ctx.fill();
    ctx.strokeStyle = COLORS.tooltipBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COLORS.labelStrong;
    lines.forEach((line, idx) => {
      ctx.fillText(line, bx + padX, by + padY + lineH * (idx + 1) - 3);
    });
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

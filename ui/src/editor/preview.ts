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
  /** Size, as a fraction of full size (0-1), a normal note or a hold's head spawns at —
   *  growing to 1 as it arrives. */
  spawnScaleHead: number;
  /** The same for a hold's tail (its release marker), set separately from the head. */
  spawnScaleTail: number;
  /** Landing-ripple size multiplier (1 = the default size, 0 = no ripple). */
  rippleScale: number;
  /** Fill notes with their bright color (true), or draw them as outlines in it (false). */
  fillNotes: boolean;
}

const LANES = 9;
/** Hold ribbon width at the judgment position, as a fraction of a judgment circle's diameter. */
const RIBBON_WIDTH_RATIO = 0.95;
/** How long, in seconds, the ripple after a note reaches its judgment position lasts. */
const RIPPLE_SEC = 0.45;
/** Judgment-position radius as a fraction of the fan radius (spawn-to-judgment distance)
 *  at sizeScale 1 — ties the drawn size to the actual layout distance, so it only changes
 *  when that distance does, not whenever the panel's raw width does. */
const JUDGE_RADIUS_RATIO = 98.75 / 644;

// Full-screen layout, measured off a 1920x1080 in-game reference screenshot: the spawn
// icon's center, the spawn-to-lane-5 distance (the fan radius every other lane is placed
// around at the same fixed angles, rather than each circle being pinned to its own pixel),
// and the header bar's vertical extent. Judgment circles there are 98.75px in radius, which
// is where JUDGE_RADIUS_RATIO above comes from. Any other window size scales this whole
// 16:9 stage uniformly to fit, centered.
const FS_REF_W = 1920;
const FS_REF_H = 1080;
const FS_SPAWN = { x: 960, y: 267.5 };
const FS_FAN_RADIUS = 644;
const FS_SPAWN_RING_R = 58;
const FS_HEADER_TOP = 33;
const FS_HEADER_BOTTOM = 92;

/** A rectangle in canvas CSS pixels. */
export interface PreviewRect {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}
/** Display size goes up to 125% (see editor.ts's size-scale control) — geometry reserves
 *  room for that worst case up front so judgment positions never clip regardless of the
 *  CURRENT size, and so their centers don't shift as the size changes. */
const JUDGE_RADIUS_MAX_SCALE = 1.25;

const COLORS = {
  judge: "#20202f",
  judgeRim: "#4a4a6e",
  tap: "#ff8fb0",
  tapRim: "#c25476",
  hold: "#6fd98b",
  holdRim: "#2c7a45",
  holdBody: "rgba(111, 217, 139, 0.35)",
  star: "#ffcf5e",
  starRim: "#c69a2e",
  slide: "#4ea8ff",
  slideRim: "#2b6fb8",
  slideBody: "rgba(78, 168, 255, 0.35)",
  flick: "#b48cff",
  flickRim: "#7c56c9",
  label: "#77748f",
  labelStrong: "#eceaf4",
  density: "#62b1ff",
  densityNow: "#ffab49",
  judgeFs: "rgba(32, 32, 47, 0.6)",
  spawnFs: "rgba(255, 95, 168, 0.16)",
  spawnFsRim: "#ff5fa8",
  headerFs: "rgba(14, 14, 22, 0.72)",
  headerFsRim: "rgba(150, 150, 190, 0.4)",
  stripFs: "rgba(0, 0, 0, 0.55)",
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

/** 0 (spawn) -> 1 (arrival), starting from `spawnScale` and growing in proportion to
 *  progress — measured off the real game, where a marker's size tracks how far along the path
 *  it is (about 0.08 of full size a tenth of the way out, about 0.63 at 65%). */
function noteScale(progress: number, spawnScale: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return spawnScale + (1 - spawnScale) * p;
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
  // Where the last draw() put the song-density strip horizontally — it spans the whole
  // panel normally, but only the header's middle section in full screen.
  private songStripX0 = 0;
  private songStripW = 0;
  private fullscreen = false;
  // Full screen only: the header's middle section (a DOM element laid out by editor.ts,
  // between its playback controls and its exit button) the density strip is drawn into.
  private fsStrip: PreviewRect | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  setFullscreen(on: boolean): void {
    this.fullscreen = on;
    if (!on) this.fsStrip = null;
  }

  setFullscreenStrip(rect: PreviewRect | null): void {
    this.fsStrip = rect;
  }

  /** Uniform scale and origin of the 1920x1080 reference stage fitted into the canvas. */
  private stage(): { s: number; ox: number; oy: number } {
    const s = Math.max(0.01, Math.min(this.w / FS_REF_W, this.h / FS_REF_H));
    return { s, ox: (this.w - FS_REF_W * s) / 2, oy: (this.h - FS_REF_H * s) / 2 };
  }

  /** The full-screen header bar — as wide as the row of judgment circles (at 100% size, so
   *  it doesn't breathe with the size setting), not the whole screen — in canvas pixels. */
  fullscreenHeaderRect(): { x: number; y: number; w: number; h: number } {
    const { s, ox, oy } = this.stage();
    const half = FS_FAN_RADIUS * (1 + JUDGE_RADIUS_RATIO);
    return {
      x: ox + (FS_SPAWN.x - half) * s,
      y: oy + FS_HEADER_TOP * s,
      w: 2 * half * s,
      h: (FS_HEADER_BOTTOM - FS_HEADER_TOP) * s,
    };
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
    if (this.fullscreen) {
      const { s, ox, oy } = this.stage();
      const spawn = { x: ox + FS_SPAWN.x * s, y: oy + FS_SPAWN.y * s };
      // Above the spawn icon, in the clear space between it and the header.
      return { spawn, fanRadius: FS_FAN_RADIUS * s, statsTop: this.h, comboY: spawn.y - (FS_SPAWN_RING_R + 16) * s };
    }
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
    return { spawn, fanRadius, statsTop, comboY: spawn.y - (FS_SPAWN_RING_R * fanRadius) / FS_FAN_RADIUS - 5 };
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
    // Never painted over: the canvas stays transparent so the jacket (and, behind it, the
    // panel's base color) — both CSS, on the wrapper — shows through.
    ctx.clearRect(0, 0, w, h);

    const { spawn, fanRadius, statsTop, comboY } = this.geometry();
    const stageScale = this.fullscreen ? this.stage().s : 1;
    this.drawCombo(s.notes, s.now, comboY, this.fullscreen ? 28 * stageScale : 12);
    const judgeRadius = this.judgeRadius(fanRadius, s.sizeScale);
    const judgePositions: Point[] = [];
    for (let lane = 1; lane <= LANES; lane++) judgePositions.push(this.judgePos(spawn, fanRadius, lane));

    for (const p of judgePositions) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, judgeRadius, 0, Math.PI * 2);
      ctx.fillStyle = this.fullscreen ? COLORS.judgeFs : COLORS.judge;
      ctx.fill();
      ctx.strokeStyle = COLORS.judgeRim;
      ctx.lineWidth = Math.max(1, judgeRadius * 0.16);
      ctx.stroke();
    }

    // The pink ring around the spawn point, sized off the fan radius (same proportion the
    // reference screenshot has) so it reads the same in the small panel as full screen.
    const ringScale = fanRadius / FS_FAN_RADIUS;
    ctx.beginPath();
    ctx.arc(spawn.x, spawn.y, FS_SPAWN_RING_R * ringScale, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.spawnFs;
    ctx.fill();
    ctx.strokeStyle = COLORS.spawnFsRim;
    ctx.lineWidth = Math.max(1.5, 4 * ringScale);
    ctx.stroke();

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
    // (see below), rather than a line spanning between them. Grouped the same way as
    // render.ts's drawSimLines (same SIM_EPS, same "anchor to the group's first member"
    // rule) — keying this by exact n.t instead would miss notes whose times differ by a few
    // float ulps (e.g. a hold's computed tail vs. an independently-placed tap) even though
    // the editor's own sim-line already shows them as simultaneous.
    const SIM_EPS = 1e-6;
    // Instants include a hold's release as well as every head, same as the editor's own
    // lines: a tap landing on a hold's release is simultaneous with it. Heads and releases
    // are tracked apart because each is marked on its own circle.
    const simHeads = new Set<number>(); // ids of notes whose head is in a group of 2+
    const simTails = new Set<number>(); // ids of holds whose release is in a group of 2+
    {
      interface Instant {
        t: number;
        id: number;
        tail: boolean;
      }
      const instants: Instant[] = [];
      for (const n of s.notes) {
        instants.push({ t: n.t, id: n.id, tail: false });
        if (n.dur > 0) instants.push({ t: n.t + n.dur, id: n.id, tail: true });
      }
      instants.sort((a, b) => a.t - b.t);
      let group: Instant[] = [];
      const flush = () => {
        if (group.length >= 2) for (const i of group) (i.tail ? simTails : simHeads).add(i.id);
      };
      for (const i of instants) {
        if (group.length && i.t - group[0].t > SIM_EPS) {
          flush();
          group = [];
        }
        group.push(i);
      }
      flush();
    }

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
      const headRadius = judgeRadius * noteScale(headProgress, s.spawnScaleHead);
      const [fill, rim, body] = colorFor(n.kind);
      // flickEnd marks the RELEASE as a flick — a hold's head (dur > 0) stays hold-colored
      // and only its tail marker below turns flick-blue; a flick-ended slide chain has no
      // duration of its own, so its tail IS this note's head circle and that's what has to
      // turn flick-blue instead.
      const [tailFill, tailRim] = n.flickEnd ? [COLORS.flick, COLORS.flickRim] : [fill, rim];
      const [headFill, headRim] = n.dur === 0 && n.flickEnd ? [COLORS.flick, COLORS.flickRim] : [fill, rim];
      // Filled notes are the bright color with a darker rim, marks drawn in the rim color;
      // unfilled ones are just a ring in the bright color, marks in it too.
      const headInk = s.fillNotes ? headRim : headFill;
      const tailInk = s.fillNotes ? tailRim : tailFill;

      if (n.dur > 0) {
        const tailUntil = n.t + n.dur - s.now;
        const tailProgress = Math.min(1, Math.max(0, 1 - tailUntil / s.approachSec));
        const tailPos = this.lerp(spawn, judge, tailProgress);
        const tailRadius = judgeRadius * noteScale(tailProgress, s.spawnScaleTail);

        // Tapered translucent ribbon connecting head and tail.
        const dirX = fanRadius > 0 ? (judge.x - spawn.x) / fanRadius : 0;
        const dirY = fanRadius > 0 ? (judge.y - spawn.y) / fanRadius : 1;
        const perpX = -dirY;
        const perpY = dirX;
        // The ribbon's width is its own thing, not the end markers' size: measured off the real
        // game, it's linear in distance from the spawn point — a cone from nothing at the
        // spawn to about the circle's diameter at the judgment position — so it stays thin
        // near the spawn however big the markers there start out.
        // Never wider than the marker at that end, though: with the markers' own size curve
        // (spawn size + growth) a marker can be smaller than the linear ribbon at the same
        // distance, and a ribbon fatter than the note it belongs to looks wrong.
        const headHalf = Math.min(judgeRadius * RIBBON_WIDTH_RATIO * headProgress, headRadius);
        const tailHalf = Math.min(judgeRadius * RIBBON_WIDTH_RATIO * tailProgress, tailRadius);
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
        if (s.fillNotes) {
          ctx.fillStyle = tailFill;
          ctx.fill();
        }
        ctx.lineWidth = Math.max(1, tailRadius * (s.fillNotes ? 0.18 : 0.2));
        ctx.strokeStyle = tailInk;
        ctx.stroke();

        if (simTails.has(n.id)) {
          ctx.beginPath();
          ctx.moveTo(tailPos.x - tailRadius * 0.6, tailPos.y);
          ctx.lineTo(tailPos.x + tailRadius * 0.6, tailPos.y);
          ctx.strokeStyle = tailInk;
          ctx.lineWidth = Math.max(1.5, tailRadius * 0.4);
          ctx.lineCap = "round";
          ctx.stroke();
        }
      }

      ctx.beginPath();
      ctx.arc(headPos.x, headPos.y, headRadius, 0, Math.PI * 2);
      if (s.fillNotes) {
        ctx.fillStyle = headFill;
        ctx.fill();
      }
      ctx.lineWidth = Math.max(1, headRadius * (s.fillNotes ? 0.18 : 0.2));
      ctx.strokeStyle = headInk;
      ctx.stroke();

      // A star note carries a star outline in its middle.
      if (n.kind === "star") {
        const outer = headRadius * 0.56;
        const inner = outer * 0.42;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const r = i % 2 === 0 ? outer : inner;
          const x = headPos.x + r * Math.cos(a);
          const y = headPos.y + r * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = headInk;
        ctx.lineWidth = Math.max(1.2, headRadius * 0.12);
        ctx.lineJoin = "round";
        ctx.stroke();
      }

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
        ctx.strokeStyle = headInk;
        ctx.lineWidth = Math.max(1.5, headRadius * 0.4);
        ctx.stroke();
        ctx.restore();
      }

      // Simultaneous-note mark, overlaid on top of the circle like the slide arrow above.
      if (simHeads.has(n.id)) {
        ctx.beginPath();
        ctx.moveTo(headPos.x - headRadius * 0.6, headPos.y);
        ctx.lineTo(headPos.x + headRadius * 0.6, headPos.y);
        ctx.strokeStyle = headInk;
        ctx.lineWidth = Math.max(1.5, headRadius * 0.4);
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }

    this.drawRipples(s.notes, s.now, judgePositions, judgeRadius, s.rippleScale);

    if (this.fullscreen) {
      this.drawFullscreenHud(s);
      return;
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

  /** A ripple at a judgment position for a moment after a note lands on it: two rings
   *  spreading out from the circle's rim and fading. A hold lands twice — its head, and its
   *  release. Stateless like everything else here: it's a function of `now` against each
   *  note's own hit time, so scrubbing and replaying look the same as playing through. */
  private drawRipples(notes: Note[], now: number, judgePositions: Point[], judgeRadius: number, rippleScale: number): void {
    const { ctx } = this;
    if (rippleScale <= 0) return;
    const size = judgeRadius * rippleScale;
    const ring = (n: Note, at: number, tailOfHold: boolean): void => {
      const age = now - at;
      if (age < 0 || age >= RIPPLE_SEC) return;
      const judge = judgePositions[n.lane - 1];
      if (!judge) return;
      const [fill, , ] = colorFor(n.kind);
      const color = n.flickEnd && (tailOfHold || n.dur === 0) ? COLORS.flick : fill;
      const p = age / RIPPLE_SEC;
      for (let i = 0; i < 2; i++) {
        const q = p - i * 0.18; // the second ring trails the first
        if (q <= 0) continue;
        const eased = 1 - (1 - q) * (1 - q);
        ctx.beginPath();
        ctx.arc(judge.x, judge.y, size * (1 + 0.75 * eased), 0, Math.PI * 2);
        ctx.globalAlpha = Math.max(0, 0.85 * (1 - q) * (1 - q));
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, size * 0.14 * (1 - q) + 1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    for (const n of notes) {
      if (n.t > now) continue; // not yet landed (cheap reject; notes are time-sorted anyway)
      ring(n, n.t, false);
      if (n.dur > 0) ring(n, n.t + n.dur, true);
    }
  }

  /** Full screen's header bar: its background, and the song-density strip (which doubles as
   *  the seek bar) in the middle of it. The playback controls on its left and the exit
   *  button on its right are DOM elements laid over this canvas by editor.ts, so only the
   *  parts the canvas owns are drawn here. */
  private drawFullscreenHud(s: PreviewState): void {
    const { ctx } = this;
    const { s: scale } = this.stage();
    const bar = this.fullscreenHeaderRect();
    roundRect(ctx, bar.x, bar.y, bar.w, bar.h, 8 * scale);
    ctx.fillStyle = COLORS.headerFs;
    ctx.fill();
    ctx.strokeStyle = COLORS.headerFsRim;
    ctx.lineWidth = Math.max(1, 1.5 * scale);
    ctx.stroke();

    const r = this.fsStrip;
    if (!r || r.x1 - r.x0 < 20) return;
    roundRect(ctx, r.x0, r.top, r.x1 - r.x0, r.bottom - r.top, 4 * scale);
    ctx.fillStyle = COLORS.stripFs;
    ctx.fill();
    ctx.save();
    ctx.clip();
    this.drawSongDensityChart(s.songMeasureNps, s.currentMeasureIndex, s.currentMeasureFrac, r.top, r.bottom, r.x0, r.x1 - r.x0);
    ctx.restore();
    if (s.songHoverPos !== null && s.songHoverLabel !== null) {
      this.drawSongTooltip(s.songHoverPos, s.songHoverLabel, r.top, r.bottom);
    }
  }

  /** Running combo — notes whose hit is already resolved as of `now`. A hold/slide-into-hold
   *  resolves at its release (t + dur), matching the same "the tail counts, not the head"
   *  rule ChartDoc.comboCount uses for the full-chart total; dur is 0 for everything else,
   *  so t + dur already reduces to a plain hit-time check for those. */
  private drawCombo(notes: Note[], now: number, y: number, fontPx = 12): void {
    let combo = 0;
    for (const n of notes) if (n.t + n.dur <= now) combo++;
    const { ctx } = this;
    const cx = this.geometry().spawn.x;
    ctx.font = `700 ${fontPx}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.labelStrong;
    ctx.fillText(`${combo} Combo`, cx, y);
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
    x0 = 0,
    width = this.w,
  ): void {
    const { ctx } = this;
    this.songMeasureCount = nps.length;
    this.songStripX0 = x0;
    this.songStripW = width;
    if (nps.length === 0 || bottom - top < 4) return;
    const barAreaH = bottom - top;
    const barW = width / nps.length;
    const maxNps = Math.max(1e-6, ...nps);
    for (let i = 0; i < nps.length; i++) {
      const segH = (nps[i] / maxNps) * barAreaH;
      if (segH <= 0) continue;
      ctx.fillStyle = i === currentMeasureIndex ? COLORS.densityNow : COLORS.density;
      ctx.fillRect(x0 + i * barW, bottom - segH, Math.max(1, barW - 0.5), segH);
    }
    const px = x0 + Math.min(width, Math.max(0, (currentMeasureIndex + currentMeasureFrac) * barW));
    ctx.strokeStyle = COLORS.densityNow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.stroke();
  }

  /** Single-line "m:ss · Measure N" bubble above the song strip, following the pointer
   *  while hovering or dragging it (see songPositionAtPoint/songHoverPos). */
  private drawSongTooltip(pos: number, label: string, songTop: number, belowY: number | null = null): void {
    const { ctx, w } = this;
    if (this.songMeasureCount <= 0) return;
    const cx = this.songStripX0 + (pos / this.songMeasureCount) * this.songStripW;

    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    const padX = 6;
    const padY = 5;
    const textW = ctx.measureText(label).width;
    const boxW = textW + padX * 2;
    const boxH = 11 + padY * 2 - 2;
    const bx = Math.min(Math.max(cx - boxW / 2, 2), w - boxW - 2);
    // Full screen's strip sits at the very top of the screen, so its bubble goes below it.
    const by = belowY !== null ? belowY + 6 : Math.max(2, songTop - boxH - 4);

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
    if (this.fullscreen) {
      const r = this.fsStrip;
      if (!r || this.songMeasureCount <= 0 || r.x1 <= r.x0) return null;
      if (!ignoreYBounds && (y < r.top - 6 || y > r.bottom + 6 || x < r.x0 - 6 || x > r.x1 + 6)) return null;
      return Math.min(this.songMeasureCount, Math.max(0, ((x - r.x0) / (r.x1 - r.x0)) * this.songMeasureCount));
    }
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
    if (this.fullscreen) return null; // no lane-stats chart in full screen
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

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
}

const LANES = 9;
/** Scale at spawn (grows to 1 at arrival). */
const MIN_SCALE = 0.14;
/** Judgment-position radius as a fraction of the fan radius (spawn-to-judgment distance)
 *  at sizeScale 1 — ties the drawn size to the actual layout distance, so it only changes
 *  when that distance does, not whenever the panel's raw width does. */
const JUDGE_RADIUS_RATIO = 0.15;
/** Display size goes up to 200% (see editor.ts's size-scale control) — geometry reserves
 *  room for that worst case up front so judgment positions never clip regardless of the
 *  CURRENT size, and so their centers don't shift as the size changes. */
const JUDGE_RADIUS_MAX_SCALE = 2;

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
};

function colorFor(kind: NoteKind): readonly [string, string, string] {
  switch (kind) {
    case "hold":
      return [COLORS.hold, COLORS.holdRim, COLORS.holdBody] as const;
    case "star":
      return [COLORS.star, COLORS.starRim, COLORS.starRim] as const;
    case "slide":
      return [COLORS.slide, COLORS.slideRim, COLORS.slideBody] as const;
    default:
      return [COLORS.tap, COLORS.tapRim, COLORS.tapRim] as const;
  }
}

/** 0 (spawn) -> 1 (arrival); eased so growth accelerates near arrival, like perspective. */
function noteScale(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return MIN_SCALE + (1 - MIN_SCALE) * p * p;
}

interface Point {
  x: number;
  y: number;
}

export class NotePreviewRenderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

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
   *  current size setting. The fan is kept in the upper part of the panel — the rest is
   *  left blank for future stats display. */
  private geometry(): { spawn: Point; fanRadius: number } {
    const edgeMargin = 3;
    const bottomReserveFrac = 0.35;
    // judgeRadius = fanRadius * k at the largest size setting — lane 1/9 (level with
    // spawn, either side) need fanRadius + fanRadius*k to clear the sides, and their top
    // edge (spawn.y - fanRadius*k) needs to clear the panel's top. The +10% covers the
    // judgment ring's own stroke, which is drawn centered on that radius and so extends
    // a bit further out still.
    const k = JUDGE_RADIUS_RATIO * JUDGE_RADIUS_MAX_SCALE * 1.1;
    const widthLimit = Math.max(10, (this.w / 2 - edgeMargin) / (1 + k));
    const topRegionBottom = this.h * (1 - bottomReserveFrac);
    // Lane 5 (straight down) needs spawn.y + fanRadius + fanRadius*k to clear the
    // reserved bottom area, and spawn.y itself is fanRadius*k + edgeMargin (below).
    const heightLimit = Math.max(10, (topRegionBottom - edgeMargin) / (1 + 2 * k));
    const fanRadius = Math.max(16, Math.min(widthLimit, heightLimit));
    const spawn = { x: this.w / 2, y: fanRadius * k + edgeMargin };
    return { spawn, fanRadius };
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

    const { spawn, fanRadius } = this.geometry();
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
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = Math.max(1, tailRadius * 0.18);
        ctx.strokeStyle = rim;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(headPos.x, headPos.y, headRadius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = Math.max(1, headRadius * 0.18);
      ctx.strokeStyle = rim;
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
  }
}

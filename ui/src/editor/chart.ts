import type { SifNote } from "../types.js";

export type NoteKind = "tap" | "hold" | "star" | "slide" | "flick";

export interface Note {
  id: number;
  /** Hit time, seconds. The server (ew's chart.rs) groups notes into one spawn cluster
   *  when their times agree within SIMULTANEOUS_EPSILON_SEC (1e-6) — not exact equality —
   *  and the slot grid (tempo.ts) already keeps snapped placements within float noise
   *  (~1e-13) of each other, comfortably inside that tolerance without any rounding.
   *  Kept at full precision in memory; toSif() rounds on the way out (see round6) for an
   *  unrelated reason — a serde_json parsing bug on the Rust side. */
  t: number;
  /** Lane 1–9, right-to-left (1 = rightmost, matching the game). */
  lane: number;
  kind: NoteKind;
  /** Hold duration, seconds (0 for tap/star/flick). For a slide note, only meaningful on
   *  the chronologically LAST member of its chain: > 0 means the slide settles into a hold
   *  there (effect 13) instead of ending as a plain point (effect 11/12). */
  dur: number;
  /** Marks the RELEASE as a flick instead of a normal one. Meaningful only for kind ===
   *  "hold" (effect 10 instead of 3) and for the chronologically LAST member of a slide
   *  chain (effect 14 instead of 11/13) — mutually exclusive with that member's dur, since
   *  a flick carries no duration of its own. Ignored everywhere else. */
  flickEnd?: boolean;
  /** Slide chain id (kind === "slide" only). Notes sharing a slideId link together in
   *  time order, each link crossing lanes — see allocateSlideId(). */
  slideId?: number;
}

export interface ChartIssue {
  message: string;
  severity: "error" | "warning";
  noteId?: number;
}

let nextId = 1;
// 1 is SIF1's "not chained" default, so chain ids must start above it.
let nextSlideId = 2;

/** Allocates a fresh slide chain id, always > 1 so it never reads as "unchained". */
export function allocateSlideId(): number {
  return nextSlideId++;
}

const EPS = 1e-9;

/** Rounds to microsecond precision — far coarser than anything this app's own math
 *  needs (the slot grid already keeps intentionally-simultaneous notes within ~1e-13
 *  of each other, and the server's own chord grouping tolerates 1e-6 anyway). This
 *  exists for a completely different reason: the project file is written by a Rust
 *  backend over Tauri's IPC, and serde_json 1.0.150's float parser has a confirmed bug
 *  where a handful of full-precision (17-significant-digit) decimal strings parse back
 *  as the ADJACENT f64 instead of the one they actually name (see the regression test
 *  in src-tauri/src/projects.rs). A note round-tripped through such a case reads as
 *  having drifted a couple of ULPs every time the project reopens — not a real edit,
 *  but enough to make "Snap to grid" (or anything else comparing exact values) think
 *  it needs fixing again on every load. Rounding here keeps the JSON text short enough
 *  that it never reaches the digit count where that parser bug can trigger. */
export function round6(t: number): number {
  return Math.round(t * 1e6) / 1e6;
}

export class ChartDoc {
  notes: Note[] = [];
  selection = new Set<number>();
  onchange: () => void = () => {};

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  static fromSif(sif: SifNote[]): ChartDoc {
    const doc = new ChartDoc();
    // Slide chain grouping: notes_level > 1 groups effect 11/12/13/14 notes together, same
    // rule the server's transcoder uses (chart.rs: notes_level <= 1 is SIF1's own
    // "not chained" default and must not be treated as a group).
    const chains = new Map<number, SifNote[]>();
    // An unchained note: a hold for effect 3 (or 10, ending in a flick instead of a normal
    // release) — and for 13, because the server's transcoder keeps a hold tail on effect 13
    // whether or not the note has chain partners — a star for 4, a flick for 8 (a lone
    // effect 14 plays the same way once it has no chain partner), a plain tap otherwise.
    const unchained = (n: SifNote): Note => {
      const hold = (n.effect === 3 || n.effect === 10 || n.effect === 13) && n.effect_value > 0;
      const kind: NoteKind = hold ? "hold" : n.effect === 4 ? "star" : n.effect === 8 || n.effect === 14 ? "flick" : "tap";
      return {
        id: nextId++,
        t: n.timing_sec,
        lane: n.position,
        kind,
        dur: hold ? n.effect_value : 0,
        flickEnd: hold && n.effect === 10 ? true : undefined,
      };
    };
    for (const n of sif) {
      if (n.position < 1 || n.position > 9 || n.timing_sec < 0) continue;
      if (n.effect === 11 || n.effect === 12 || n.effect === 13 || n.effect === 14) {
        const level = n.notes_level ?? 1;
        if (level > 1) {
          let group = chains.get(level);
          if (!group) chains.set(level, (group = []));
          group.push(n);
          continue;
        }
      }
      doc.notes.push(unchained(n));
    }
    for (const group of chains.values()) {
      if (group.length < 2) {
        // A lone slide can't be a slider — it plays unchained, same as the server.
        for (const n of group) doc.notes.push(unchained(n));
        continue;
      }
      const ordered = [...group].sort((a, b) => a.timing_sec - b.timing_sec);
      const slideId = allocateSlideId();
      ordered.forEach((n, i) => {
        const isLast = i === ordered.length - 1;
        const dur = isLast && n.effect === 13 && n.effect_value > 0 ? n.effect_value : 0;
        const flickEnd = isLast && n.effect === 14 ? true : undefined;
        doc.notes.push({ id: nextId++, t: n.timing_sec, lane: n.position, kind: "slide", dur, flickEnd, slideId });
      });
    }
    doc.sort();
    return doc;
  }

  toSif(): SifNote[] {
    this.sort();
    // Only the chronologically last member of a chain may end in a hold (effect 13);
    // every other member is a plain slide point (effect 11).
    const chainTailIds = new Set<number>();
    const chains = new Map<number, Note[]>();
    for (const n of this.notes) {
      if (n.kind !== "slide" || n.slideId === undefined) continue;
      let group = chains.get(n.slideId);
      if (!group) chains.set(n.slideId, (group = []));
      group.push(n);
    }
    for (const group of chains.values()) {
      const ordered = [...group].sort((a, b) => a.t - b.t);
      chainTailIds.add(ordered[ordered.length - 1].id);
    }
    // A hold/slide-hold's effect_value is derived as the GAP between the already-rounded
    // head and tail, not round6(dur) on its own — rounding the duration independently can
    // round the head and tail of "the same instant" (shared with some other, separately
    // placed note) into different 6-decimal buckets, each up to 0.5µs off, so the
    // reconstructed tail (timing_sec + effect_value) would land more than the server's
    // SIMULTANEOUS_EPSILON_SEC from that other note even though they were exactly
    // coincident (within the slot grid's ~1e-13) beforehand.
    //
    // round6(tail) - round6(head) is mathematically a clean multiple of 1e-6 (both operands
    // are), but the SUBTRACTION itself lands a few ULPs off that — e.g. 17.176154 - 16.714615
    // comes out 0.4615390000000019, not 0.461539 — which is exactly the kind of
    // long-decimal value serde_json 1.0.150 mis-parses on the way back in (see round6's own
    // comment). Rounding that gap a second time snaps it back onto the clean value, short
    // enough to serialize safely, while 0.4615390000000019 and 0.461539 both reconstruct
    // (head + effect_value) within a few ULPs of the same tail either way.
    const holdEffectValue = (t: number, dur: number): number => round6(round6(t + dur) - t);
    return this.notes.map((n) => {
      const t = round6(n.t);
      if (n.kind === "slide") {
        const isTail = chainTailIds.has(n.id);
        const isFlickEnd = isTail && n.flickEnd === true;
        const isHoldEnd = isTail && !isFlickEnd && n.dur > 0;
        return {
          timing_sec: t,
          position: n.lane,
          effect: isFlickEnd ? 14 : isHoldEnd ? 13 : 11,
          effect_value: isHoldEnd ? holdEffectValue(n.t, n.dur) : 0,
          notes_level: n.slideId,
        };
      }
      return {
        timing_sec: t,
        position: n.lane,
        effect: n.kind === "hold" ? (n.flickEnd ? 10 : 3) : n.kind === "star" ? 4 : n.kind === "flick" ? 8 : 1,
        effect_value: n.kind === "hold" ? holdEffectValue(n.t, n.dur) : 0,
      };
    });
  }

  private sort(notes: Note[] = this.notes): void {
    notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  }

  private serialize(): string {
    return JSON.stringify(this.notes);
  }

  private restore(json: string): void {
    this.notes = JSON.parse(json) as Note[];
    this.selection.clear();
  }

  /** Capture pre-state for a gesture; call commit(pre) when it ends. */
  begin(): string {
    return this.serialize();
  }

  commit(pre: string): void {
    this.sort();
    const now = this.serialize();
    if (now === pre) return;
    this.undoStack.push(pre);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onchange();
  }

  /** One-shot edit with undo. */
  edit(fn: () => void): void {
    const pre = this.begin();
    fn();
    this.commit(pre);
  }

  undo(): void {
    const pre = this.undoStack.pop();
    if (pre === undefined) return;
    this.redoStack.push(this.serialize());
    this.restore(pre);
    this.onchange();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.serialize());
    this.restore(next);
    this.onchange();
  }

  /** Rewrite every note's time through `map` — the live notes AND every undo/redo
   *  snapshot — without adding an undo step. For the grid offset moving: that re-anchors
   *  the whole chart at once, and the offset field itself (like BPM) isn't part of the undo
   *  model, so rather than a per-difficulty step that can't restore the offset, the history
   *  is carried along — undoing an older edit afterwards restores times on the NEW grid. */
  remapTimes(map: (t: number) => number): void {
    const apply = (notes: Note[]): Note[] => {
      for (const n of notes) n.t = map(n.t);
      this.sort(notes);
      return notes;
    };
    apply(this.notes);
    const applyJson = (json: string) => JSON.stringify(apply(JSON.parse(json) as Note[]));
    this.undoStack = this.undoStack.map(applyJson);
    this.redoStack = this.redoStack.map(applyJson);
    this.onchange();
  }

  byId(id: number): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  noteAt(t: number, lane: number, ignore?: Set<number>): Note | undefined {
    return this.notes.find(
      (n) => n.lane === lane && Math.abs(n.t - t) < EPS && !ignore?.has(n.id),
    );
  }

  /** Place a note; anything already on that exact time+lane is replaced. */
  place(t: number, lane: number, kind: NoteKind, dur = 0, slideId?: number): Note {
    const clash = this.noteAt(t, lane);
    if (clash) this.notes.splice(this.notes.indexOf(clash), 1);
    const note: Note = { id: nextId++, t, lane, kind, dur, slideId };
    this.notes.push(note);
    return note;
  }

  /** True if `note` is the chronologically last member of its slide chain — the only
   *  point that may end the chain in a hold, or be reopened to add another link. */
  isSlideChainTail(note: Note): boolean {
    if (note.kind !== "slide" || note.slideId === undefined) return false;
    return !this.notes.some((n) => n.slideId === note.slideId && n.id !== note.id && n.t > note.t);
  }

  remove(ids: Iterable<number>): void {
    const gone = new Set(ids);
    this.notes = this.notes.filter((n) => !gone.has(n.id));
    for (const id of gone) this.selection.delete(id);
  }

  /** After moving notes, drop any note now exactly under a moved one —
   *  unmoved notes under the selection, and later-moved over earlier-moved
   *  (two selected notes can land on the same slot when snapping compresses). */
  resolveCollisions(movedIds: Set<number>): void {
    const doomed = new Set<number>();
    const taken = new Map<string, number>(); // "t/lane" -> moved note id
    for (const moved of this.notes) {
      if (!movedIds.has(moved.id)) continue;
      const clash = this.noteAt(moved.t, moved.lane, movedIds);
      if (clash) doomed.add(clash.id);
      const key = `${moved.t}/${moved.lane}`;
      const prev = taken.get(key);
      if (prev !== undefined) doomed.add(moved.id);
      else taken.set(key, moved.id);
    }
    if (doomed.size) this.remove(doomed);
  }

  selectedNotes(): Note[] {
    return this.notes.filter((n) => this.selection.has(n.id));
  }

  /** In-game combo: each note counts once (a same-lane hold is one combo — the tail). */
  get comboCount(): number {
    return this.notes.length;
  }

  /** `sameLaneSlides`: when true, slide points that share a lane back to back aren't flagged —
   *  charts that use flicks have those on purpose. */
  issues(audioDuration: number, opts: { sameLaneSlides?: boolean } = {}): ChartIssue[] {
    const out: ChartIssue[] = [];
    const sorted = [...this.notes].sort((a, b) => a.t - b.t);
    const byLane = new Map<number, Note[]>();
    for (const n of sorted) {
      if (n.lane < 1 || n.lane > 9) {
        out.push({ message: `Note at ${n.t.toFixed(3)}s: lane ${n.lane} is outside 1–9`, severity: "error", noteId: n.id });
      }
      if (n.t < 0) {
        out.push({ message: `Note at ${n.t.toFixed(3)}s is before the track start`, severity: "error", noteId: n.id });
      }
      if (n.kind === "hold" && n.dur <= 0) {
        out.push({ message: `Hold at ${n.t.toFixed(3)}s has no duration`, severity: "error", noteId: n.id });
      }
      let laneList = byLane.get(n.lane);
      if (!laneList) byLane.set(n.lane, (laneList = []));
      laneList.push(n);
    }
    // overlaps within a lane: inside a hold's body is unplayable, and a note
    // stacked exactly on a hold's tail crashes the SIF2 runtime (NRE).
    // Scan every later note under each hold, not just the immediate neighbor.
    for (const [lane, list] of byLane) {
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        if (cur.kind !== "hold" && !(cur.kind === "slide" && cur.dur > 0)) continue;
        const end = cur.t + cur.dur;
        for (let j = i + 1; j < list.length && list[j].t < end + EPS; j++) {
          const next = list[j];
          if (next.t < end - EPS) {
            out.push({
              message: `Lane ${lane}: note at ${next.t.toFixed(3)}s lands inside the hold starting at ${cur.t.toFixed(3)}s`,
              severity: "warning",
              noteId: next.id,
            });
          } else {
            out.push({
              message: `Lane ${lane}: note at ${next.t.toFixed(3)}s sits exactly on a hold's tail — this crashes the game; leave a gap`,
              severity: "error",
              noteId: next.id,
            });
          }
        }
      }
      // duplicates on the exact same time+lane: different kinds are rejected
      // by the server, same kinds become two stacked in-game notes
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (Math.abs(a.t - b.t) < EPS) {
          out.push({
            message: `Lane ${lane}: two notes share the exact time ${a.t.toFixed(3)}s${
              a.kind !== b.kind ? " with different kinds — the server rejects this" : " (stacked notes)"
            }`,
            severity: a.kind !== b.kind ? "error" : "warning",
            noteId: b.id,
          });
        }
      }
    }
    // slide chains: a lone point can't slide, and adjacent points sharing a lane
    // silently fail to link (the server skips the link rather than lying about it)
    const slideGroups = new Map<number, Note[]>();
    for (const n of sorted) {
      if (n.kind !== "slide" || n.slideId === undefined) continue;
      let group = slideGroups.get(n.slideId);
      if (!group) slideGroups.set(n.slideId, (group = []));
      group.push(n);
    }
    for (const group of slideGroups.values()) {
      if (group.length < 2) {
        const n = group[0];
        out.push({
          message: `Slide at ${n.t.toFixed(3)}s has no chain partner and will play as a plain ${n.dur > 0 ? "hold" : "tap"}`,
          severity: "warning",
          noteId: n.id,
        });
        continue;
      }
      const ordered = [...group].sort((a, b) => a.t - b.t);
      for (let i = 0; i < ordered.length - 1; i++) {
        if (!opts.sameLaneSlides && ordered[i].lane === ordered[i + 1].lane) {
          out.push({
            message: `Slide chain: points at ${ordered[i].t.toFixed(3)}s and ${ordered[i + 1].t.toFixed(3)}s share lane ${ordered[i].lane} and won't connect`,
            severity: "warning",
            noteId: ordered[i + 1].id,
          });
        }
        if (ordered[i].dur > 0) {
          out.push({
            message: `Slide chain: point at ${ordered[i].t.toFixed(3)}s ends in a hold but isn't the last point — only the final point can`,
            severity: "warning",
            noteId: ordered[i].id,
          });
        }
      }
    }
    if (audioDuration > 0) {
      for (const n of sorted) {
        if (n.t + n.dur > audioDuration) {
          out.push({
            message: `Note at ${n.t.toFixed(3)}s extends past the end of the audio (${audioDuration.toFixed(1)}s)`,
            severity: "warning",
            noteId: n.id,
          });
        }
      }
    }
    return out;
  }
}

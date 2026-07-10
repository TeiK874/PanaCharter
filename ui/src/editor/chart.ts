import type { SifNote } from "../types.js";

export type NoteKind = "tap" | "hold" | "star";

export interface Note {
  id: number;
  /** Hit time, seconds. Snapped placements share bit-identical values, which is
   *  what makes the server group them as simultaneous (exact f64 equality). */
  t: number;
  /** Lane 1–9, right-to-left (1 = rightmost, matching the game). */
  lane: number;
  kind: NoteKind;
  /** Hold duration, seconds (0 for tap/star). */
  dur: number;
}

export interface ChartIssue {
  message: string;
  severity: "error" | "warning";
  noteId?: number;
}

let nextId = 1;

const EPS = 1e-9;

export class ChartDoc {
  notes: Note[] = [];
  selection = new Set<number>();
  onchange: () => void = () => {};

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  static fromSif(sif: SifNote[]): ChartDoc {
    const doc = new ChartDoc();
    for (const n of sif) {
      if (n.position < 1 || n.position > 9 || n.timing_sec < 0) continue;
      let kind: NoteKind = "tap";
      let dur = 0;
      if (n.effect === 3 && n.effect_value > 0) {
        kind = "hold";
        dur = n.effect_value;
      } else if (n.effect === 4) {
        kind = "star";
      }
      doc.notes.push({ id: nextId++, t: n.timing_sec, lane: n.position, kind, dur });
    }
    doc.sort();
    return doc;
  }

  toSif(): SifNote[] {
    this.sort();
    return this.notes.map((n) => ({
      timing_sec: n.t,
      position: n.lane,
      effect: n.kind === "hold" ? 3 : n.kind === "star" ? 4 : 1,
      effect_value: n.kind === "hold" ? n.dur : 0,
    }));
  }

  private sort(): void {
    this.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
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

  byId(id: number): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  noteAt(t: number, lane: number, ignore?: Set<number>): Note | undefined {
    return this.notes.find(
      (n) => n.lane === lane && Math.abs(n.t - t) < EPS && !ignore?.has(n.id),
    );
  }

  /** Place a note; anything already on that exact time+lane is replaced. */
  place(t: number, lane: number, kind: NoteKind, dur = 0): Note {
    const clash = this.noteAt(t, lane);
    if (clash) this.notes.splice(this.notes.indexOf(clash), 1);
    const note: Note = { id: nextId++, t, lane, kind, dur };
    this.notes.push(note);
    return note;
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

  issues(audioDuration: number): ChartIssue[] {
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
        if (cur.kind !== "hold") continue;
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

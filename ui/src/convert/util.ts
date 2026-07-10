// Leaf helpers shared by all converters. Kept out of index.ts so that
// converter modules don't import their own registry back (circular imports
// evaluate in load order and would throw a TDZ ReferenceError if a converter
// module were ever evaluated first).

import type { SifNote } from "../types.js";

/** Clamp/validate a converted note; returns null if unusable. */
export function makeNote(
  timing_sec: number,
  position: number,
  kind: "tap" | "hold" | "star",
  dur = 0,
): SifNote | null {
  if (!Number.isFinite(timing_sec) || timing_sec < 0) return null;
  if (!Number.isFinite(position) || position < 1 || position > 9) return null;
  if (kind === "hold" && !(dur > 0)) kind = "tap";
  return {
    timing_sec,
    position: Math.round(position),
    effect: kind === "hold" ? 3 : kind === "star" ? 4 : 1,
    effect_value: kind === "hold" ? dur : 0,
  };
}

/** Seconds-at-beat clock from a list of BPM changes (non-positive BPMs ignored). */
export function makeBeatClock(
  changes: { beat: number; bpm: number }[],
  fallbackBpm = 120,
): (beat: number) => number {
  const bpms = changes.filter((c) => c.bpm > 0).sort((a, b) => a.beat - b.beat);
  if (!bpms.length || bpms[0].beat > 0) bpms.unshift({ beat: 0, bpm: bpms[0]?.bpm ?? fallbackBpm });
  const at: number[] = [0];
  for (let i = 1; i < bpms.length; i++) {
    at.push(at[i - 1] + ((bpms[i].beat - bpms[i - 1].beat) * 60) / bpms[i - 1].bpm);
  }
  return (beat: number) => {
    let i = bpms.length - 1;
    while (i > 0 && bpms[i].beat > beat) i--;
    return at[i] + ((beat - bpms[i].beat) * 60) / bpms[i].bpm;
  };
}

/** Remove taps sitting exactly on a same-lane hold tail — that configuration
 *  NREs the SIF2 runtime. Returns how many notes were dropped. */
export function dropTailStacks(notes: SifNote[]): number {
  const EPS = 1e-9;
  const doomed = new Set<number>();
  for (const hold of notes) {
    if (hold.effect !== 3) continue;
    const end = hold.timing_sec + hold.effect_value;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n === hold || n.position !== hold.position || n.effect === 3) continue;
      if (Math.abs(n.timing_sec - end) < EPS) doomed.add(i);
    }
  }
  if (doomed.size) {
    let i = 0;
    for (let r = 0; r < notes.length; r++) {
      if (!doomed.has(r)) notes[i++] = notes[r];
    }
    notes.length = i;
  }
  return doomed.size;
}

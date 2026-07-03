// Chart-format converters. Each converter turns a foreign chart file into the
// app's native note list (the SIF1 upload schema — what projects store and the
// server accepts). To support a new game/format: write a module exporting a
// ChartConverter and add it to CONVERTERS.

import type { SifNote } from "../types.js";
import { sif1Converter } from "./sif1.js";
import { sif2Converter } from "./sif2.js";
import { bandoriNoteConverter } from "./bandori.js";
import { bestdoriConverter } from "./bestdori.js";

export interface ImportedChart {
  notes: SifNote[];
  /** BPM carried by the source format, if any (first/dominant on changes). */
  bpm?: number;
  /** Lossy-conversion notes for the user (dropped flicks, flattened slides…). */
  warnings: string[];
}

export interface ChartConverter {
  id: string;
  label: string;
  /** Cheap content sniff — no exceptions, just yes/no. */
  detect(text: string): boolean;
  /** May throw a string/Error with a user-readable message. */
  convert(text: string): ImportedChart;
}

export const CONVERTERS: ChartConverter[] = [
  sif1Converter,
  sif2Converter,
  bandoriNoteConverter,
  bestdoriConverter,
];

export function importChart(text: string): ImportedChart & { format: string } {
  for (const c of CONVERTERS) {
    if (c.detect(text)) {
      const result = c.convert(text);
      if (!result.notes.length) throw `Detected ${c.label}, but no usable notes came out`;
      result.notes.sort((a, b) => a.timing_sec - b.timing_sec || a.position - b.position);
      return { ...result, format: c.label };
    }
  }
  throw `Unrecognized chart format. Supported: ${CONVERTERS.map((c) => c.label).join(", ")}`;
}

/** Shared helper: seconds-at-beat clock from a sorted-or-not list of BPM changes. */
export function makeBeatClock(
  changes: { beat: number; bpm: number }[],
  fallbackBpm = 120,
): (beat: number) => number {
  const bpms = [...changes].sort((a, b) => a.beat - b.beat);
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

/** Shared helper: clamp/validate a converted note; returns null if unusable. */
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

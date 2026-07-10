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

export { makeBeatClock, makeNote } from "./util.js";

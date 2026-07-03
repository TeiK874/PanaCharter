// SIF1 / NPPS4 upload schema — the app's native format. "Conversion" is
// validation + normalization, so stray fields and legacy effects are cleaned up.

import type { ChartConverter, ImportedChart } from "./index.js";
import { makeNote } from "./index.js";

export const sif1Converter: ChartConverter = {
  id: "sif1",
  label: "SIF1 / NPPS4 JSON",

  detect(text: string): boolean {
    try {
      const v = JSON.parse(text);
      return (
        Array.isArray(v) &&
        v.length > 0 &&
        typeof v[0] === "object" &&
        v[0] !== null &&
        "timing_sec" in v[0] &&
        "position" in v[0] &&
        "effect" in v[0]
      );
    } catch {
      return false;
    }
  },

  convert(text: string): ImportedChart {
    const raw = JSON.parse(text) as Record<string, number>[];
    const warnings: string[] = [];
    const notes = [];
    let dropped = 0;
    let swings = 0;
    for (const n of raw) {
      const effect = Number(n.effect);
      const kind =
        effect === 3 && Number(n.effect_value) > 0 ? "hold" : effect === 4 ? "star" : "tap";
      if (effect === 11 || effect === 12 || effect === 13) swings++;
      const note = makeNote(Number(n.timing_sec), Number(n.position), kind, Number(n.effect_value) || 0);
      if (note) notes.push(note);
      else dropped++;
    }
    if (swings) warnings.push(`${swings} swing notes (effect 11/12/13) became plain taps — SIF2 has no swings.`);
    if (dropped) warnings.push(`${dropped} notes had invalid time/lane and were dropped.`);
    return { notes, warnings };
  },
};

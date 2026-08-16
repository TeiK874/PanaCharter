// SIF1 / NPPS4 upload schema — the app's native format. "Conversion" is
// validation + normalization, so stray fields and legacy effects are cleaned up.

import type { ChartConverter, ImportedChart } from "./index.js";
import type { SifNote } from "../types.js";
import { makeNote } from "./util.js";

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
    const notes: SifNote[] = [];
    let dropped = 0;
    let orphanSwings = 0;
    let chains = 0;
    // Slide chain grouping, matching the server's transcoder (chart.rs): notes sharing a
    // notes_level > 1 chain together in time order; 1/absent is SIF1's "not chained" default.
    const groups = new Map<number, Record<string, number>[]>();
    for (const n of raw) {
      const effect = Number(n.effect);
      if (effect === 11 || effect === 12 || effect === 13) {
        const level = Number(n.notes_level) || 1;
        if (level > 1) {
          let g = groups.get(level);
          if (!g) groups.set(level, (g = []));
          g.push(n);
          continue;
        }
      }
      const kind =
        effect === 3 && Number(n.effect_value) > 0 ? "hold" : effect === 4 ? "star" : "tap";
      if (effect === 11 || effect === 12 || effect === 13) orphanSwings++;
      const note = makeNote(Number(n.timing_sec), Number(n.position), kind, Number(n.effect_value) || 0);
      if (note) notes.push(note);
      else dropped++;
    }
    for (const [level, g] of groups) {
      if (g.length < 2) {
        // no chain partner -> plays as a plain tap, same fallback the server uses
        orphanSwings++;
        const note = makeNote(Number(g[0].timing_sec), Number(g[0].position), "tap", 0);
        if (note) notes.push(note);
        else dropped++;
        continue;
      }
      chains++;
      const ordered = [...g].sort((a, b) => Number(a.timing_sec) - Number(b.timing_sec));
      ordered.forEach((n, i) => {
        const isLast = i === ordered.length - 1;
        const isHoldEnd = isLast && Number(n.effect) === 13 && Number(n.effect_value) > 0;
        const timing_sec = Number(n.timing_sec);
        const position = Number(n.position);
        if (!Number.isFinite(timing_sec) || timing_sec < 0 || !Number.isFinite(position) || position < 1 || position > 9) {
          dropped++;
          return;
        }
        notes.push({
          timing_sec,
          position: Math.round(position),
          effect: isHoldEnd ? 13 : 11,
          effect_value: isHoldEnd ? Number(n.effect_value) : 0,
          notes_level: level,
        });
      });
    }
    if (orphanSwings) warnings.push(`${orphanSwings} swing notes (effect 11/12/13) had no chain partner and became plain taps.`);
    if (chains) warnings.push(`${chains} slide chain${chains > 1 ? "s" : ""} imported.`);
    if (dropped) warnings.push(`${dropped} notes had invalid time/lane and were dropped.`);
    return { notes, warnings };
  },
};

// SIF1 / NPPS4 upload schema — the app's native format. "Conversion" is
// validation + normalization, so stray fields and legacy effects are cleaned up.

import type { ChartConverter, ImportedChart } from "./index.js";
import type { SifNote } from "../types.js";

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
    // An unchained note. Effect 13/10 (ending in a hold, normal or flick-released) keep
    // their hold tail even with no chain partner — the server's transcoder treats effect
    // 3/10/13 alike there. A lone effect 14 plays as a plain flick, same as effect 8. Built
    // directly (not through the lossy generic makeNote helper) so effect 8/10/14 survive
    // the round trip instead of collapsing into 1/3.
    const unchained = (n: Record<string, number>): SifNote | null => {
      const timing_sec = Number(n.timing_sec);
      const position = Number(n.position);
      if (!Number.isFinite(timing_sec) || timing_sec < 0 || !Number.isFinite(position) || position < 1 || position > 9) {
        return null;
      }
      const effect = Number(n.effect);
      const value = Number(n.effect_value) || 0;
      const isHold = (effect === 3 || effect === 10) && value > 0;
      return {
        timing_sec,
        position: Math.round(position),
        effect: isHold ? effect : effect === 4 ? 4 : effect === 8 || effect === 14 ? 8 : 1,
        effect_value: isHold ? value : 0,
      };
    };
    for (const n of raw) {
      const effect = Number(n.effect);
      if (effect === 11 || effect === 12 || effect === 13 || effect === 14) {
        const level = Number(n.notes_level) || 1;
        if (level > 1) {
          let g = groups.get(level);
          if (!g) groups.set(level, (g = []));
          g.push(n);
          continue;
        }
        orphanSwings++;
      }
      const note = unchained(n);
      if (note) notes.push(note);
      else dropped++;
    }
    for (const [level, g] of groups) {
      if (g.length < 2) {
        // no chain partner -> plays unchained, same fallback the server uses
        orphanSwings++;
        const note = unchained(g[0]);
        if (note) notes.push(note);
        else dropped++;
        continue;
      }
      chains++;
      const ordered = [...g].sort((a, b) => Number(a.timing_sec) - Number(b.timing_sec));
      ordered.forEach((n, i) => {
        const isLast = i === ordered.length - 1;
        const isFlickEnd = isLast && Number(n.effect) === 14;
        const isHoldEnd = isLast && !isFlickEnd && Number(n.effect) === 13 && Number(n.effect_value) > 0;
        const timing_sec = Number(n.timing_sec);
        const position = Number(n.position);
        if (!Number.isFinite(timing_sec) || timing_sec < 0 || !Number.isFinite(position) || position < 1 || position > 9) {
          dropped++;
          return;
        }
        notes.push({
          timing_sec,
          position: Math.round(position),
          effect: isFlickEnd ? 14 : isHoldEnd ? 13 : 11,
          effect_value: isHoldEnd ? Number(n.effect_value) : 0,
          notes_level: level,
        });
      });
    }
    if (orphanSwings) warnings.push(`${orphanSwings} swing notes (effect 11/12/13) had no chain partner and were imported unchained — as plain taps, or as holds where they ended in one (effect 13).`);
    if (chains) warnings.push(`${chains} slide chain${chains > 1 ? "s" : ""} imported.`);
    if (dropped) warnings.push(`${dropped} notes had invalid time/lane and were dropped.`);
    return { notes, warnings };
  },
};

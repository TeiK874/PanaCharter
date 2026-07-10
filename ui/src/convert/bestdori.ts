// Bestdori-style JSON charts (the community format for Bandori / GARUPA) —
// event list. Timing is in beats (BPM-change events interleaved); lanes 0–6
// left-to-right map onto the center 7 of SIF2's 9 lanes.
//
// Lossy by nature: SIF2 holds can't change lanes, and has no flicks — slides
// flatten to a hold on their starting lane, flicks become taps. Every loss is
// counted and reported as an import warning.

import type { ChartConverter, ImportedChart } from "./index.js";
import { dropTailStacks, makeBeatClock, makeNote } from "./util.js";

interface BandoriEvent {
  type: string;
  beat?: number;
  bpm?: number;
  lane?: number;
  flick?: boolean;
  connections?: { beat: number; lane: number; hidden?: boolean; flick?: boolean }[];
}

/** Bandori lane 0 (leftmost) → SIF position 8; lane 6 → position 2. */
function lanePos(lane: number): number {
  return 8 - lane;
}



export const bestdoriConverter: ChartConverter = {
  id: "bestdori",
  label: "Bestdori JSON",

  detect(text: string): boolean {
    try {
      const v = JSON.parse(text);
      return (
        Array.isArray(v) &&
        v.length > 0 &&
        v.some(
          (e) =>
            e &&
            typeof e.type === "string" &&
            ["BPM", "Single", "Slide", "Long", "Directional"].includes(e.type),
        )
      );
    } catch {
      return false;
    }
  },

  convert(text: string): ImportedChart {
    const events = JSON.parse(text) as BandoriEvent[];
    const toSec = makeBeatClock(
      events
        .filter((e) => e.type === "BPM" && typeof e.bpm === "number")
        .map((e) => ({ beat: e.beat ?? 0, bpm: e.bpm! })),
    );
    const warnings: string[] = [];
    const notes = [];

    let flicks = 0;
    let laneChangingSlides = 0;
    let slideTicks = 0;
    let skipped = 0;

    for (const e of events) {
      switch (e.type) {
        case "BPM":
          break;
        case "Single":
        case "Skill": {
          if (e.lane === undefined || e.beat === undefined) {
            skipped++;
            break;
          }
          if (e.flick) flicks++;
          const n = makeNote(toSec(e.beat), lanePos(e.lane), "tap");
          if (n) notes.push(n);
          else skipped++;
          break;
        }
        case "Directional": {
          if (e.lane === undefined || e.beat === undefined) {
            skipped++;
            break;
          }
          flicks++;
          const n = makeNote(toSec(e.beat), lanePos(e.lane), "tap");
          if (n) notes.push(n);
          else skipped++;
          break;
        }
        case "Slide":
        case "Long": {
          const conns = (e.connections ?? [])
            .filter((c) => !c.hidden && Number.isFinite(c.beat))
            .sort((a, b) => a.beat - b.beat);
          if (conns.length < 2) {
            skipped++;
            break;
          }
          const head = conns[0];
          const tail = conns[conns.length - 1];
          if (conns.some((c) => c.lane !== head.lane)) laneChangingSlides++;
          slideTicks += Math.max(0, conns.length - 2);
          if (tail.flick) flicks++;
          const t0 = toSec(head.beat);
          const dur = toSec(tail.beat) - t0;
          const n = makeNote(t0, lanePos(head.lane), "hold", dur);
          if (n) notes.push(n);
          else skipped++;
          break;
        }
        default:
          skipped++;
      }
    }

    const tailStacks = dropTailStacks(notes);
    if (tailStacks)
      warnings.push(
        `${tailStacks} notes sat exactly on a same-lane hold tail (crashes the game) and were dropped.`,
      );
    if (laneChangingSlides)
      warnings.push(
        `${laneChangingSlides} slides change lanes — flattened to a straight hold on their starting lane.`,
      );
    if (slideTicks) warnings.push(`${slideTicks} mid-slide waypoints were dropped.`);
    if (flicks) warnings.push(`${flicks} flick notes became plain taps/hold-ends — SIF2 has no flicks.`);
    if (skipped) warnings.push(`${skipped} events were unrecognized or invalid and were skipped.`);

    const bpmEvents = events
      .filter((e) => e.type === "BPM" && typeof e.bpm === "number" && e.bpm! > 0)
      .sort((a, b) => (a.beat ?? 0) - (b.beat ?? 0));
    if (!bpmEvents.length && notes.length) throw "Chart has no positive BPM event";
    const bpm = bpmEvents[0]?.bpm;
    if (bpmEvents.length > 1)
      warnings.push(
        `The song changes BPM ${bpmEvents.length - 1} times — note times are correct, but the snap grid only follows the first BPM (${bpm}).`,
      );

    return { notes, warnings, bpm };
  },
};

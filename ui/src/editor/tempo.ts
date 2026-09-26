// Piecewise-linear tempo map: converts between absolute seconds and a continuous "beat"
// coordinate across mid-song BPM changes. Same shape of math as convert/util.ts's
// makeBeatClock, but keyed by seconds (not beat) and bidirectional — the editor needs to
// go both ways, for grid drawing (beat -> time) and snapping clicks/drags (time -> beat).
// Kept independent of convert/ (which is import-only and shouldn't depend on editor/).
//
// It is also the ONE definition of the snap grid (slotAt/slotTime below): render.ts draws
// exactly the lines those describe, and editor.ts snaps/moves/pastes onto them.

export interface TempoSegment {
  /** Absolute seconds where this segment starts. */
  startSec: number;
  /** Continuous beat number at startSec (the first segment always starts at beat 0). */
  startBeat: number;
  bpm: number;
}

export interface BpmChangeLike {
  time_sec: number;
  bpm: number;
}

export interface TempoMap {
  /** Sorted ascending by startSec/startBeat; always has at least one entry. */
  segments: TempoSegment[];
  /** The input changes that had no effect — non-positive bpm, or a time not strictly
   *  after the previous segment's start (which includes two changes at the same time).
   *  The very objects that were passed in, so callers can flag them by identity. */
  dropped: BpmChangeLike[];
  /** Continuous beat position at an absolute time — monotonic across segment boundaries,
   *  extrapolated (possibly negative) before the first segment or past the last. */
  beatAt(sec: number): number;
  /** Inverse of beatAt. */
  timeAt(beat: number): number;
  /** The BPM in effect at an absolute time. */
  bpmAt(sec: number): number;
  /** Nearest grid slot to `sec` on the segment-local grid with `div` divisions per beat.
   *  Slots are integers counted consecutively through the whole song: slot 0 is the first
   *  segment's start (negative slots extend before it), and each later segment's slot 0 is
   *  its own start time. A time nearer to the next segment's start than to any line of its
   *  own segment lands on that start. */
  slotAt(sec: number, div: number): number;
  /** Absolute seconds of a grid slot from slotAt — `startSec + k * gridStepSec(bpm, div)`
   *  of the segment that owns it. Stepping the slot number crosses segment boundaries onto
   *  the next segment's lines. */
  slotTime(slot: number, div: number): number;
}

/** Seconds per grid division at `bpm` with `div` divisions per beat. The operation order
 *  is load-bearing: projects saved before tempo changes existed placed notes at
 *  `offset + k * (60 / bpm / snap)`, and snapping must keep reproducing those exact f64
 *  values so they still read as on-grid (the editor tests that by exact equality). */
export function gridStepSec(bpm: number, div: number): number {
  return 60 / bpm / div;
}

/** `baseBpm` applies from `offsetSec` onward; `changes` are additional tempo changes
 *  layered on top. A change is ignored if its bpm isn't positive or its time doesn't fall
 *  strictly after the segment before it — the same tolerant filtering makeBeatClock uses.
 *  Ignored changes are reported in `dropped`. */
export function buildTempoMap(
  baseBpm: number,
  offsetSec: number,
  changes: BpmChangeLike[],
): TempoMap {
  const segments: TempoSegment[] = [
    { startSec: offsetSec, startBeat: 0, bpm: baseBpm > 0 ? baseBpm : 120 },
  ];
  const dropped: BpmChangeLike[] = changes.filter((c) => !(c.bpm > 0));
  const sorted = [...changes].filter((c) => c.bpm > 0).sort((a, b) => a.time_sec - b.time_sec);
  for (const c of sorted) {
    const prev = segments[segments.length - 1];
    if (c.time_sec <= prev.startSec) {
      dropped.push(c);
      continue;
    }
    const startBeat = prev.startBeat + ((c.time_sec - prev.startSec) * prev.bpm) / 60;
    segments.push({ startSec: c.time_sec, startBeat, bpm: c.bpm });
  }

  function segmentIndexAtSec(sec: number): number {
    let i = 0;
    for (let j = 1; j < segments.length && segments[j].startSec <= sec; j++) i = j;
    return i;
  }

  function segmentAtBeat(beat: number): TempoSegment {
    let seg = segments[0];
    for (const s of segments) {
      if (s.startBeat > beat) break;
      seg = s;
    }
    return seg;
  }

  // The grid is SEGMENT-LOCAL: each segment anchors its own lines at
  // startSec + k * gridStepSec(bpm, div), k = 0, 1, 2, …, up to (not including) the next
  // segment's start, which is that segment's own k = 0. A change that doesn't land on a
  // division of the previous grid therefore restarts the grid at its own time instead of
  // continuing the continuous beat count — that's what's drawn, so it's what's snapped to.

  /** How many slots segment `i` owns (k = 0 .. count-1 land strictly before the next
   *  segment's start); Infinity for the last segment. */
  function slotCount(i: number, div: number): number {
    if (i + 1 >= segments.length) return Infinity;
    const seg = segments[i];
    const step = gridStepSec(seg.bpm, div);
    const end = segments[i + 1].startSec;
    let count = Math.max(1, Math.ceil((end - seg.startSec) / step));
    // settle the estimate against the exact same arithmetic slotTime uses
    while (count > 1 && seg.startSec + (count - 1) * step >= end) count--;
    while (seg.startSec + count * step < end) count++;
    return count;
  }

  return {
    segments,
    dropped,
    beatAt(sec) {
      const seg = segments[segmentIndexAtSec(sec)];
      return seg.startBeat + ((sec - seg.startSec) * seg.bpm) / 60;
    },
    timeAt(beat) {
      const seg = segmentAtBeat(beat);
      return seg.startSec + ((beat - seg.startBeat) * 60) / seg.bpm;
    },
    bpmAt(sec) {
      return segments[segmentIndexAtSec(sec)].bpm;
    },
    slotAt(sec, div) {
      const i = segmentIndexAtSec(sec);
      let base = 0;
      for (let j = 0; j < i; j++) base += slotCount(j, div);
      const seg = segments[i];
      const step = gridStepSec(seg.bpm, div);
      let k = Math.round((sec - seg.startSec) / step);
      if (i + 1 < segments.length) {
        const count = slotCount(i, div);
        const nextStart = segments[i + 1].startSec;
        // rounding must not cross into the next segment on this segment's grid; and the
        // next segment's start is itself a line, taken when it's the nearer one
        if (k >= count || nextStart - sec < sec - (seg.startSec + k * step)) k = count;
      }
      return base + k;
    },
    slotTime(slot, div) {
      let i = 0;
      let k = slot;
      while (i + 1 < segments.length) {
        const count = slotCount(i, div);
        if (k < count) break;
        k -= count;
        i++;
      }
      const seg = segments[i];
      return seg.startSec + k * gridStepSec(seg.bpm, div);
    },
  };
}

export interface TimeSigSegment {
  /** Continuous beat number (from the song's TempoMap) where this segment starts. */
  startBeat: number;
  /** Continuous measure number at startBeat (the first segment always starts at measure 0). */
  startMeasure: number;
  /** Beats per measure. */
  beats: number;
}

export interface TimeSigMap {
  /** Sorted ascending by startBeat; always has at least one entry. */
  segments: TimeSigSegment[];
  /** Continuous (possibly fractional) measure position at a continuous beat — monotonic
   *  across segment boundaries. */
  measureAt(beat: number): number;
  /** Inverse of measureAt. */
  beatAtMeasure(measure: number): number;
  /** Beats per measure in effect at a continuous beat. */
  beatsAt(beat: number): number;
}

/** `baseBeats` applies from beat 0 onward; `changes` are additional time-signature changes,
 *  each anchored to an absolute time and converted to a beat position via `tempo`. A change
 *  is ignored if its beat count isn't positive or it doesn't fall strictly after the segment
 *  before it (same tolerant filtering as buildTempoMap). */
export function buildTimeSigMap(
  baseBeats: number,
  tempo: TempoMap,
  changes: { time_sec: number; beats: number }[],
): TimeSigMap {
  const segments: TimeSigSegment[] = [
    { startBeat: 0, startMeasure: 0, beats: baseBeats > 0 ? baseBeats : 4 },
  ];
  const sorted = [...changes].filter((c) => c.beats > 0).sort((a, b) => a.time_sec - b.time_sec);
  for (const c of sorted) {
    const prev = segments[segments.length - 1];
    const startBeat = tempo.beatAt(c.time_sec);
    if (startBeat <= prev.startBeat) continue;
    const startMeasure = prev.startMeasure + (startBeat - prev.startBeat) / prev.beats;
    segments.push({ startBeat, startMeasure, beats: c.beats });
  }

  function segmentAtBeat(beat: number): TimeSigSegment {
    let seg = segments[0];
    for (const s of segments) {
      if (s.startBeat > beat) break;
      seg = s;
    }
    return seg;
  }

  function segmentAtMeasure(measure: number): TimeSigSegment {
    let seg = segments[0];
    for (const s of segments) {
      if (s.startMeasure > measure) break;
      seg = s;
    }
    return seg;
  }

  return {
    segments,
    measureAt(beat) {
      const seg = segmentAtBeat(beat);
      return seg.startMeasure + (beat - seg.startBeat) / seg.beats;
    },
    beatAtMeasure(measure) {
      const seg = segmentAtMeasure(measure);
      return seg.startBeat + (measure - seg.startMeasure) * seg.beats;
    },
    beatsAt(beat) {
      return segmentAtBeat(beat).beats;
    },
  };
}

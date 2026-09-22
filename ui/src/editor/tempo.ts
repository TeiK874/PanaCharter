// Piecewise-linear tempo map: converts between absolute seconds and a continuous "beat"
// coordinate across mid-song BPM changes. Same shape of math as convert/util.ts's
// makeBeatClock, but keyed by seconds (not beat) and bidirectional — the editor needs to
// go both ways, for grid drawing (beat -> time) and snapping clicks/drags (time -> beat).
// Kept independent of convert/ (which is import-only and shouldn't depend on editor/).

export interface TempoSegment {
  /** Absolute seconds where this segment starts. */
  startSec: number;
  /** Continuous beat number at startSec (the first segment always starts at beat 0). */
  startBeat: number;
  bpm: number;
}

export interface TempoMap {
  /** Sorted ascending by startSec/startBeat; always has at least one entry. */
  segments: TempoSegment[];
  /** Continuous beat position at an absolute time — monotonic across segment boundaries,
   *  extrapolated (possibly negative) before the first segment or past the last. */
  beatAt(sec: number): number;
  /** Inverse of beatAt. */
  timeAt(beat: number): number;
  /** The BPM in effect at an absolute time. */
  bpmAt(sec: number): number;
}

/** `baseBpm` applies from `offsetSec` onward; `changes` are additional tempo changes
 *  layered on top. A change is ignored if its bpm isn't positive or its time doesn't fall
 *  strictly after the segment before it — the same tolerant filtering makeBeatClock uses. */
export function buildTempoMap(
  baseBpm: number,
  offsetSec: number,
  changes: { time_sec: number; bpm: number }[],
): TempoMap {
  const segments: TempoSegment[] = [
    { startSec: offsetSec, startBeat: 0, bpm: baseBpm > 0 ? baseBpm : 120 },
  ];
  const sorted = [...changes].filter((c) => c.bpm > 0).sort((a, b) => a.time_sec - b.time_sec);
  for (const c of sorted) {
    const prev = segments[segments.length - 1];
    if (c.time_sec <= prev.startSec) continue;
    const startBeat = prev.startBeat + ((c.time_sec - prev.startSec) * prev.bpm) / 60;
    segments.push({ startSec: c.time_sec, startBeat, bpm: c.bpm });
  }

  function segmentAtSec(sec: number): TempoSegment {
    let seg = segments[0];
    for (const s of segments) {
      if (s.startSec > sec) break;
      seg = s;
    }
    return seg;
  }

  function segmentAtBeat(beat: number): TempoSegment {
    let seg = segments[0];
    for (const s of segments) {
      if (s.startBeat > beat) break;
      seg = s;
    }
    return seg;
  }

  return {
    segments,
    beatAt(sec) {
      const seg = segmentAtSec(sec);
      return seg.startBeat + ((sec - seg.startSec) * seg.bpm) / 60;
    },
    timeAt(beat) {
      const seg = segmentAtBeat(beat);
      return seg.startSec + ((beat - seg.startBeat) * 60) / seg.bpm;
    },
    bpmAt(sec) {
      return segmentAtSec(sec).bpm;
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

  return {
    segments,
    measureAt(beat) {
      const seg = segmentAtBeat(beat);
      return seg.startMeasure + (beat - seg.startBeat) / seg.beats;
    },
    beatsAt(beat) {
      return segmentAtBeat(beat).beats;
    },
  };
}

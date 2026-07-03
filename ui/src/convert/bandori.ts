// Bandori / GARUPA game-asset charts — the BMS-derived `.note` text format
// found in musicscore bundles. Rules match ethanaobrien/bandori-sif2-tools'
// frozen, in-game-verified converter (bandori_to_sif2.py):
//
// - A slot's meaning comes from the chart's own #WAVxx keysound table:
//   bd/skill/fever_note → tap, flick* → tap (SIF2 has no flick gesture),
//   slide_a/b (+ends) → slide chains, bgm/cmd_/se_ → skipped.
// - Channels 11–16,18 are the 7 lanes; BMS quirk: channel 16 is the LEFTMOST
//   display lane. Channels 51–56,58 are the LNTYPE-1 hold layer (paired
//   open/close markers per lane). Channel 02 = measure length, 03 = hex BPM.
// - Slide chains (streams a/b, 0.55 s stale gap) flatten to a hold on the
//   head's lane. LN chains with shared boundaries (mid-slide clicks) merge to
//   ONE hold: the ew upload schema can only express 2-node chains, and
//   boundary-stacked notes NRE the SIF2 runtime.

import type { ChartConverter, ImportedChart } from "./index.js";
import { makeBeatClock, makeNote } from "./index.js";

// channel%10 (BMS lane 1–6,8) → SIF position 1–9 (1 = rightmost).
// Display left→right is ch 16,11,12,13,14,15,18 → positions 8..2 — bandori's
// 7 lanes centered on SIF2's 9, matching bandori-sif2-tools' verified map.
const LANE_POS: Record<number, number> = { 1: 7, 2: 6, 3: 5, 4: 4, 5: 3, 6: 8, 8: 2 };

const SLIDE_GAP_SEC = 0.55;

type Action = "tap" | "flick" | "slide" | "slide_end" | "slide_end_flick" | "skip";

function classifyWav(name: string): Action {
  const n = name.toLowerCase();
  if (!n || n.startsWith("bgm") || n.startsWith("cmd_") || n.startsWith("se_") || n.startsWith("無音")) {
    return "skip";
  }
  if (n.includes("slide_end_flick")) return "slide_end_flick";
  if (n.includes("slide_end")) return "slide_end";
  if (n.includes("slide")) return "slide";
  if (n.includes("flick")) return "flick";
  return "tap"; // bd.wav, skill.wav, fever_note.wav — and unknowns, kept rather than dropped
}

interface Ev {
  t: number;
  lane: number; // BMS lane id (1-6, 8)
  action: Action;
  wav: string;
}

export const bandoriNoteConverter: ChartConverter = {
  id: "bandori-note",
  label: "Bandori .note (BMS)",

  detect(text: string): boolean {
    return /^#WAV[0-9A-Z]{2}\s/m.test(text) && /^#\d{5}:/m.test(text);
  },

  convert(text: string): ImportedChart {
    const warnings: string[] = [];
    const wavMap = new Map<string, string>();
    let headerBpm = 120;
    const channels: { measure: number; channel: string; data: string }[] = [];

    for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
      const line = rawLine.trim();
      let m = line.match(/^#BPM\s+([\d.]+)/i);
      if (m) {
        headerBpm = Number(m[1]) || 120;
        continue;
      }
      m = line.match(/^#WAV([0-9A-Z]{2})\s+(.+)$/);
      if (m) {
        wavMap.set(m[1].toUpperCase(), m[2].trim());
        continue;
      }
      m = line.match(/^#(\d{3})([0-9A-Z]{2}):([0-9A-Z.]+)$/i);
      if (m) {
        channels.push({ measure: Number(m[1]), channel: m[2].toUpperCase(), data: m[3] });
      }
    }
    if (!channels.length) throw "No data lines found in the .note file";

    // measure lengths (channel 02 = length multiplier; 4 beats by default)
    const maxMeasure = Math.max(...channels.map((c) => c.measure));
    const beatsIn: number[] = new Array(maxMeasure + 1).fill(4);
    for (const c of channels) {
      if (c.channel === "02") {
        const mult = Number(c.data);
        if (mult > 0) beatsIn[c.measure] = 4 * mult;
      }
    }
    const startBeat: number[] = [0];
    for (let m = 0; m <= maxMeasure; m++) startBeat.push(startBeat[m] + beatsIn[m]);

    const slots = (data: string) => {
      const out: { idx: number; n: number; slot: string }[] = [];
      const n = Math.floor(data.length / 2);
      for (let i = 0; i < n; i++) {
        const slot = data.slice(i * 2, i * 2 + 2).toUpperCase();
        if (slot !== "00") out.push({ idx: i, n, slot });
      }
      return out;
    };
    const beatAt = (measure: number, idx: number, n: number) =>
      startBeat[measure] + (idx / n) * beatsIn[measure];

    // BPM changes (channel 03, hex value = BPM) and the bgm anchor (channel 01)
    const bpmChanges: { beat: number; bpm: number }[] = [{ beat: 0, bpm: headerBpm }];
    let bgmBeat: number | null = null;
    for (const c of channels) {
      if (c.channel === "03") {
        for (const s of slots(c.data)) {
          const bpm = parseInt(s.slot, 16);
          if (bpm > 0) bpmChanges.push({ beat: beatAt(c.measure, s.idx, s.n), bpm });
        }
      } else if (c.channel === "01") {
        for (const s of slots(c.data)) {
          if ((wavMap.get(s.slot) ?? "").toLowerCase().startsWith("bgm")) {
            const b = beatAt(c.measure, s.idx, s.n);
            bgmBeat = bgmBeat === null ? Math.min(bgmBeat ?? b, b) : Math.min(bgmBeat, b);
          }
        }
      }
    }
    const clock = makeBeatClock(bpmChanges, headerBpm);
    const anchor = bgmBeat !== null ? clock(bgmBeat) : 0;
    if (anchor > 0.0005) {
      warnings.push(`Audio starts ${anchor.toFixed(3)}s into the score — note times were shifted to match the track.`);
    }

    // main + LN layers
    const events: Ev[] = [];
    const lnByLane = new Map<number, number[]>(); // lane -> sorted times
    for (const c of channels) {
      const layer = Number(c.channel[0]);
      const laneRaw = Number(c.channel[1]);
      if ((layer !== 1 && layer !== 5) || !(laneRaw in LANE_POS)) continue;
      for (const s of slots(c.data)) {
        const t = clock(beatAt(c.measure, s.idx, s.n)) - anchor;
        if (layer === 5) {
          let list = lnByLane.get(laneRaw);
          if (!list) lnByLane.set(laneRaw, (list = []));
          list.push(t);
        } else {
          const wav = wavMap.get(s.slot) ?? "";
          const action = classifyWav(wav);
          if (action !== "skip") events.push({ t, lane: laneRaw, action, wav });
        }
      }
    }

    const notes = [];
    let flicks = 0;
    let zigzags = 0;
    let midClicks = 0;
    let orphans = 0;
    let skipped = 0;

    // taps + flicks
    for (const e of events) {
      if (e.action === "tap" || e.action === "flick") {
        if (e.action === "flick") flicks++;
        const n = makeNote(e.t, LANE_POS[e.lane], "tap");
        if (n) notes.push(n);
        else skipped++;
      }
    }

    // slide chains: streams a/b, closed by *_end, broken by stale gaps
    const slideEvents = events
      .filter((e) => e.action === "slide" || e.action === "slide_end" || e.action === "slide_end_flick")
      .sort((a, b) => a.t - b.t || a.lane - b.lane);
    const open = new Map<string, Ev[]>();
    const chains: Ev[][] = [];
    const streamOf = (e: Ev) => {
      const n = e.wav.toLowerCase();
      return n.includes("slide_a") || n.includes("slide_end_a") ? "a"
        : n.includes("slide_b") || n.includes("slide_end_b") ? "b" : "x";
    };
    for (const e of slideEvents) {
      const k = streamOf(e);
      let cur = open.get(k);
      if (cur && e.t - cur[cur.length - 1].t > SLIDE_GAP_SEC) {
        chains.push(cur);
        cur = undefined;
      }
      if (!cur) open.set(k, (cur = []));
      cur.push(e);
      if (e.action !== "slide") {
        chains.push(cur);
        open.delete(k);
      }
    }
    for (const cur of open.values()) if (cur.length) chains.push(cur);

    for (const chain of chains) {
      if (chain.length < 2) {
        // isolated slide sound = tap-with-slide-skin
        const n = makeNote(chain[0].t, LANE_POS[chain[0].lane], "tap");
        if (n) notes.push(n);
        else skipped++;
        continue;
      }
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (chain.some((e) => e.lane !== head.lane)) zigzags++;
      if (tail.action === "slide_end_flick") flicks++;
      const n = makeNote(head.t, LANE_POS[head.lane], "hold", tail.t - head.t);
      if (n) notes.push(n);
      else skipped++;
    }

    // LN layer: pair open/close markers per lane; boundary-sharing pairs
    // (mid-slide clicks) merge into one long hold — 2-node chains only.
    for (const [lane, times] of lnByLane) {
      times.sort((a, b) => a - b);
      if (times.length % 2 === 1) {
        orphans++;
        times.pop();
      }
      let start = -1;
      let end = -1;
      for (let i = 0; i < times.length; i += 2) {
        const s = times[i];
        const e = times[i + 1];
        if (start >= 0 && Math.abs(s - end) < 1e-4) {
          end = e; // mid-slide click: extend the open hold
          midClicks++;
          continue;
        }
        if (start >= 0) {
          const n = makeNote(start, LANE_POS[lane], "hold", end - start);
          if (n) notes.push(n);
          else skipped++;
        }
        start = s;
        end = e;
      }
      if (start >= 0) {
        const n = makeNote(start, LANE_POS[lane], "hold", end - start);
        if (n) notes.push(n);
        else skipped++;
      }
    }

    if (flicks) warnings.push(`${flicks} flicks became plain taps/hold-ends — SIF2 has no flick gesture.`);
    if (zigzags) warnings.push(`${zigzags} lane-changing slides were flattened to a hold on their starting lane.`);
    if (midClicks) warnings.push(`${midClicks} mid-slide clicks were merged into their hold (the upload format only supports simple holds).`);
    if (orphans) warnings.push(`${orphans} lanes had an unpaired hold marker — the trailing marker was dropped.`);
    if (skipped) warnings.push(`${skipped} events were invalid and were skipped.`);
    const laterBpms = bpmChanges.filter((b) => b.beat > 0 && b.bpm !== headerBpm);
    if (laterBpms.length) {
      warnings.push(`The song changes BPM mid-chart (${laterBpms.length}×) — note times are correct, but the snap grid only follows the initial BPM (${headerBpm}).`);
    }

    return { notes, warnings, bpm: headerBpm };
  },
};

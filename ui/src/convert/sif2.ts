// Official SIF2 NoteData — both the served JSON shape (chart_N.json, §4b of the
// server spec) and Unity .asset YAML (Aoharu.NoteData ScriptableObject dumps).
// Reverse of the server's transcoder: dummy header dropped, hold tails folded
// back into their head's duration, line 0–8 → position 1–9.

import type { ChartConverter, ImportedChart } from "./index.js";
import { makeNote } from "./util.js";

interface RawNote {
  id: number;
  line: number;
  time: number;
  type: number;
  parent_id: number;
  child_id: number;
}

function fromRawNotes(raw: RawNote[]): ImportedChart {
  const warnings: string[] = [];
  const byId = new Map<number, RawNote>();
  for (const n of raw) byId.set(n.id, n);

  const notes = [];
  let flicks = 0;
  let unknownTypes = 0;
  let brokenHolds = 0;
  let chainWaypoints = 0;

  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    // The first m_NoteList entry is ALWAYS a skipped header — the game iterates
    // from index 1. Old-style charts mark it type 0, but newer official charts
    // (m_LPB: 60 era) use a type-1 entry at t=0, so skip positionally.
    if (i === 0) continue;
    if (n.type === 0) continue;
    if (n.parent_id !== 0) continue; // hold tail — folded into its head
    let kind: "tap" | "hold" | "star" = "tap";
    let dur = 0;
    if (n.child_id !== 0) {
      // follow the chain to its final tail — official-style charts use 2-node
      // chains, but converter-made ones may thread mid-click waypoints
      let last: RawNote = n;
      const seen = new Set<number>([n.id]);
      let cur = byId.get(n.child_id);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        last = cur;
        if (seen.size > 2) chainWaypoints++; // nodes beyond head+tail
        cur = cur.child_id !== 0 ? byId.get(cur.child_id) : undefined;
      }
      if (last.time > n.time) {
        kind = "hold";
        dur = last.time - n.time;
      } else {
        brokenHolds++;
      }
    } else if (n.type === 3) {
      kind = "star";
    } else if (n.type === 2) {
      flicks++; // engine supports flicks but the game never uses them
    } else if (n.type !== 1) {
      unknownTypes++;
    }
    const note = makeNote(n.time, n.line + 1, kind, dur);
    if (note) notes.push(note);
  }

  if (flicks) warnings.push(`${flicks} flick notes (type 2) became taps.`);
  if (unknownTypes) warnings.push(`${unknownTypes} notes had unknown types and became taps.`);
  if (brokenHolds) warnings.push(`${brokenHolds} holds had missing/invalid tails and became taps.`);
  if (chainWaypoints)
    warnings.push(`${chainWaypoints} mid-chain waypoints were folded into their hold (simple holds only).`);
  return { notes, warnings };
}

function parseServedJson(text: string): RawNote[] | null {
  try {
    const v = JSON.parse(text) as { notes?: Record<string, number>[] };
    if (!v || !Array.isArray(v.notes) || !v.notes.length) return null;
    const first = v.notes[0];
    if (!("num" in first && "line" in first && "time" in first && "type" in first)) return null;
    return v.notes.map((n) => ({
      id: Number(n.id),
      line: Number(n.line),
      time: Number(n.time),
      type: Number(n.type),
      parent_id: Number(n.parent_id) || 0,
      child_id: Number(n.child_id) || 0,
    }));
  } catch {
    return null;
  }
}

/** Minimal parser for Unity YAML NoteData dumps: scans m_NoteList entries. */
function parseAssetYaml(text: string): RawNote[] | null {
  if (!text.includes("m_NoteList")) return null;
  const notes: RawNote[] = [];
  let cur: Partial<Record<string, number>> | null = null;
  const flush = () => {
    if (cur && cur.m_Id !== undefined) {
      notes.push({
        id: cur.m_Id ?? 0,
        line: cur.m_Line ?? 0,
        time: cur.m_Time ?? 0,
        type: cur.m_Type ?? 1,
        parent_id: cur.m_ParentId ?? 0,
        child_id: cur.m_ChildId ?? 0,
      });
    }
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^\s*-\s*m_Id:\s*(-?[\d.]+)/);
    if (start) {
      flush();
      cur = { m_Id: Number(start[1]) };
      continue;
    }
    if (cur) {
      const kv = line.match(/^\s*m_(\w+):\s*([-+\d.eE]+)\s*$/);
      if (kv) cur[`m_${kv[1]}`] = Number(kv[2]);
      else if (!/^\s/.test(line)) flush(); // left the list block
    }
  }
  flush();
  return notes.length ? notes : null;
}

export const sif2Converter: ChartConverter = {
  id: "sif2",
  label: "SIF2 NoteData (JSON / Unity .asset)",

  detect(text: string): boolean {
    if (text.includes("m_NoteList") && text.includes("m_Time")) return true;
    return parseServedJson(text) !== null;
  },

  convert(text: string): ImportedChart {
    const raw = parseServedJson(text) ?? parseAssetYaml(text);
    if (!raw) throw "Could not parse SIF2 NoteData from this file";
    return fromRawNotes(raw);
  },
};

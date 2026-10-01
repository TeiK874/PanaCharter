import * as api from "../api.js";
import { attempt, confirmDialog, el, fmtTime, openDialog, pickFile, toast } from "../dom.js";
import type { ProjectData, SifNote } from "../types.js";
import { DIFFICULTIES } from "../types.js";
import { Player } from "./audio.js";
import type { TickSound } from "./audio.js";
import { ChartDoc, allocateSlideId, round6 } from "./chart.js";
import type { Note, NoteKind } from "./chart.js";
import { buildTempoMap, buildTimeSigMap, gridStepSec } from "./tempo.js";
import type { TempoMap } from "./tempo.js";
import { Renderer } from "./render.js";
import type { DrawState, Orientation } from "./render.js";
import { NotePreviewRenderer } from "./preview.js";
import { openMetadataDialog } from "../views/metadata.js";
import { openUploadDialog } from "../views/upload.js";
import { CONVERTERS, importChart } from "../convert/index.js";

export interface EditorView {
  root: HTMLElement;
  dispose(): Promise<void>;
}

type Tool = "select" | NoteKind;

type Gesture =
  | { type: "none" }
  | { type: "place-hold"; pre: string; note: Note }
  | {
      type: "place-slide";
      pre: string;
      note: Note;
      slideId: number;
      /** True if this note was already the open chain tail when the click started — a
       *  plain click (no drag) then toggles it back to select mode instead of reopening it. */
      wasActive: boolean;
    }
  | {
      type: "move";
      pre: string;
      startT: number;
      startLane: number;
      orig: Map<number, { t: number; lane: number }>;
      minLane: number;
      maxLane: number;
      part: "head" | "tail";
      resizeNote: Note | null;
      /** True if this is a lone, already-selected, not-yet-open slide chain tail — a
       *  plain click (no net movement) then opens it for editing instead of no-op'ing. */
      slideTogglePending: boolean;
      /** True if the clicked note is an already-selected tap/star note — a plain click (no
       *  net movement) then flips it, and every other selected tap/star note, to the other
       *  kind instead of no-op'ing. */
      kindTogglePending: boolean;
      /** Set once the drag actually displaces a note, even briefly — so dragging away and
       *  back to the exact start still counts as a real drag, not a plain click, and
       *  doesn't trigger slideTogglePending/kindTogglePending. */
      moved: boolean;
    }
  | { type: "box"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { type: "pan"; startScroll: number; startPos: number }
  | { type: "scrub"; resume: boolean };

const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16];
const RATES = [0.5, 0.75, 1];

// In-game note speed (1-10) <-> seconds from spawn to judgment, for the note preview.
// Speed 1 = 1.8s (slowest), speed 10 = 0.45s (fastest), linear in between.
const PREVIEW_SEC_MIN = 0.45;
const PREVIEW_SEC_MAX = 1.8;
const PREVIEW_SPEED_KEY = "charter.previewApproachSec";

function speedToApproachSec(speed: number): number {
  const s = Math.min(10, Math.max(1, speed));
  return PREVIEW_SEC_MAX + ((s - 1) * (PREVIEW_SEC_MIN - PREVIEW_SEC_MAX)) / 9;
}
function approachSecToSpeed(sec: number): number {
  const clamped = Math.min(PREVIEW_SEC_MAX, Math.max(PREVIEW_SEC_MIN, sec));
  return 1 + ((clamped - PREVIEW_SEC_MAX) * 9) / (PREVIEW_SEC_MIN - PREVIEW_SEC_MAX);
}
function loadPreviewApproachSec(): number {
  const raw = Number(localStorage.getItem(PREVIEW_SPEED_KEY));
  if (Number.isFinite(raw) && raw >= PREVIEW_SEC_MIN && raw <= PREVIEW_SEC_MAX) return raw;
  return speedToApproachSec(6);
}

// Judgment-position display size, as a percentage (50-125, 100 = the reference size).
const PREVIEW_SCALE_MIN = 50;
const PREVIEW_SCALE_MAX = 125;
const PREVIEW_SCALE_KEY = "charter.previewSizeScalePct";

function loadPreviewSizeScale(): number {
  const raw = Number(localStorage.getItem(PREVIEW_SCALE_KEY));
  if (Number.isFinite(raw) && raw >= PREVIEW_SCALE_MIN && raw <= PREVIEW_SCALE_MAX) return raw / 100;
  return 1;
}

// Playback sound settings (note ticks, tick sound, volume) — app-wide preferences, not
// per-project state, so they live in localStorage like the preview settings above rather
// than in editorMeta.
const TICK_ENABLED_KEY = "charter.tickEnabled";
const TICK_SOUND_KEY = "charter.tickSound";
const VOLUME_KEY = "charter.volumePct";

function loadTickEnabled(): boolean {
  const raw = localStorage.getItem(TICK_ENABLED_KEY);
  return raw === null ? true : raw === "1";
}
function loadTickSound(): TickSound {
  return localStorage.getItem(TICK_SOUND_KEY) === "se" ? "se" : "beep";
}
function loadVolumePct(): number {
  const stored = localStorage.getItem(VOLUME_KEY);
  // Number(null) is 0, not NaN — without this check, "never saved before" was
  // indistinguishable from "saved as 0" and silently opened every project muted.
  if (stored === null) return 100;
  const raw = Number(stored);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 100;
}

// Preview panel width, px — an app-wide layout preference like the sound settings above,
// not per-project state. Null (never saved, or a stored value too small to be real) means
// "use the CSS default" rather than forcing a specific width on a first-ever launch.
const PREVIEW_WIDTH_KEY = "charter.previewWidthPx";

function loadPreviewWidthPx(): number | null {
  const raw = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= 140 ? raw : null;
}

export async function createEditor(
  projectId: string,
  goBack: () => void,
  setTitle: (text: string, onClick?: () => void, tooltip?: string) => void,
): Promise<EditorView> {
  const data: ProjectData = await api.projectLoad(projectId);
  const manifest = data.manifest;
  const editorMeta = data.editor;
  // Absent on projects saved before mid-song tempo changes existed.
  editorMeta.bpm_changes ??= [];
  // Absent on projects saved before mid-song time-signature changes existed.
  editorMeta.beats_per_measure ??= 4;
  editorMeta.time_sig_changes ??= [];

  // --- chart documents ------------------------------------------------------
  const docs = new Map<number, ChartDoc>();
  for (const [levelStr, notes] of Object.entries(data.charts)) {
    docs.set(Number(levelStr), ChartDoc.fromSif(notes));
  }
  let level = docs.size ? Math.min(...docs.keys()) : 1;
  if (!docs.has(level)) docs.set(level, new ChartDoc());

  const doc = () => docs.get(level)!;

  // --- view / playback state ------------------------------------------------
  let tool: Tool = "tap";
  let scroll = -0.5;
  let zoom = editorMeta.zoom || 200;
  let orientation: Orientation = editorMeta.orientation === "horizontal" ? "horizontal" : "vertical";
  let snap = SNAPS.includes(editorMeta.snap) ? editorMeta.snap : 4;
  let gesture: Gesture = { type: "none" };
  let ghost: DrawState["ghost"] = null;
  let needsDraw = true;
  let disposed = false;
  // Note-preview speed and judgment-position size — app-wide settings (not per-project),
  // so they carry over between songs like a player's own in-game settings would.
  let previewApproachSec = loadPreviewApproachSec();
  let previewSizeScale = loadPreviewSizeScale();
  let previewHoverLane: number | null = null;
  // Drag state for the whole-song density strip doubling as a seek bar.
  let previewSeeking = false;
  let previewSeekResume = false;
  // Song-strip position under the pointer, while hovering OR dragging — drives its tooltip.
  let previewSongHoverPos: number | null = null;
  // Offsets from the earliest copied note and hold lengths are kept in BEATS (via the tempo
  // map), not seconds, so a phrase copied at one tempo pastes with the same rhythm at another.
  let clipboard: { dBeat: number; lane: number; kind: NoteKind; durBeat: number; slideId?: number; flickEnd?: boolean }[] = [];
  // Slide chain currently being extended by sequential clicks of the slide tool. Its tail
  // note is looked up by id on every read (openSlideTail) rather than cached, so a tail
  // deleted or moved by any path can't leave a phantom origin behind.
  let activeSlide: { slideId: number; lastId: number } | null = null;
  function endActiveSlide(): void {
    activeSlide = null;
  }
  /** The open chain's tail note, or null — ending the chain if that note is gone or no
   *  longer an open (dur === 0) slide point of the chain. */
  function openSlideTail(): Note | null {
    if (!activeSlide) return null;
    const tail = doc().byId(activeSlide.lastId);
    if (tail && tail.kind === "slide" && tail.slideId === activeSlide.slideId && tail.dur === 0) return tail;
    activeSlide = null;
    return null;
  }

  const player = new Player();
  // Seed from the persisted app-wide preferences before init() — it resends whatever
  // volume is currently set to the native mixer (and always preloads the tick SE sound
  // on the web backend), so these need to already hold the saved values by then, not
  // the class's own hardcoded defaults.
  player.ticksEnabled = loadTickEnabled();
  player.tickSound = loadTickSound();
  player.volume = loadVolumePct() / 100;
  await player.init();

  const bpm = () => manifest.bpm ?? 120;
  // Rebuilt on demand — the change list is tiny, no need to cache/invalidate.
  const tempo = () => buildTempoMap(bpm(), editorMeta.offset_sec, editorMeta.bpm_changes!);
  const timeSig = () => buildTimeSigMap(editorMeta.beats_per_measure!, tempo(), editorMeta.time_sig_changes!);

  /** Current measure/beat label, plus note density (notes/sec) for the current measure and
   *  the 3 after it — for the note preview's density readout. */
  function currentMeasureInfo(): { measureLabel: string; measureNps: number[] } {
    const tm = tempo();
    const ts = timeSig();
    const curBeat = tm.beatAt(player.displayTime);
    const measureFloat = ts.measureAt(curBeat);
    const measureIndex = Math.floor(measureFloat);
    const beatsPerMeasure = ts.beatsAt(curBeat);
    const beatInMeasure = Math.floor((measureFloat - measureIndex) * beatsPerMeasure) + 1;
    const measureLabel = `Measure ${measureIndex + 1} · Beat ${beatInMeasure}`;

    const notes = doc().notes;
    const measureNps: number[] = [];
    // A note placed exactly on a measure boundary went through the slot-based snap grid
    // (tm.slotTime/slotAt), a different arithmetic path than this boundary's beatAt/timeAt
    // — the two can disagree by a float ULP even for "the same" instant. Shifting the
    // whole [secStart, secEnd) window earlier by a hair keeps such a note in the measure
    // it visually starts, instead of leaking into the one before it.
    const BOUNDARY_EPS = 1e-6;
    for (let i = 0; i < 4; i++) {
      const secStart = tm.timeAt(ts.beatAtMeasure(measureIndex + i)) - BOUNDARY_EPS;
      const secEnd = tm.timeAt(ts.beatAtMeasure(measureIndex + i + 1)) - BOUNDARY_EPS;
      const dur = Math.max(1e-6, secEnd - secStart);
      let count = 0;
      for (const n of notes) if (n.t >= secStart && n.t < secEnd) count++;
      measureNps.push(count / dur);
    }
    return { measureLabel, measureNps };
  }

  /** Notes/sec for every measure across the whole song, plus which one is current — for
   *  the preview panel's whole-song density strip. Same boundary self-heal as
   *  currentMeasureInfo() above (see its comment): shifting each [secStart, secEnd)
   *  window a hair earlier keeps a note placed exactly on a measure line in the measure
   *  it visually starts. */
  function songMeasureInfo(): { songMeasureNps: number[]; currentMeasureIndex: number; currentMeasureFrac: number } {
    const tm = tempo();
    const ts = timeSig();
    const notes = doc().notes;
    const BOUNDARY_EPS = 1e-6;

    const currentMeasureIndex = Math.floor(ts.measureAt(tm.beatAt(player.displayTime)));
    const endBeat = tm.beatAt(duration());
    const measureCount = Math.max(1, Math.ceil(ts.measureAt(endBeat)) + 1);

    const songMeasureNps: number[] = [];
    for (let i = 0; i < measureCount; i++) {
      const secStart = tm.timeAt(ts.beatAtMeasure(i)) - BOUNDARY_EPS;
      const secEnd = tm.timeAt(ts.beatAtMeasure(i + 1)) - BOUNDARY_EPS;
      const dur = Math.max(1e-6, secEnd - secStart);
      let count = 0;
      for (const n of notes) if (n.t >= secStart && n.t < secEnd) count++;
      songMeasureNps.push(count / dur);
    }
    // Undoes the note-counting epsilon above — the visual playhead line wants the measure's
    // real boundary, not one nudged a hair earlier to keep a boundary-exact note in the
    // right bucket.
    const curStart = tm.timeAt(ts.beatAtMeasure(currentMeasureIndex));
    const curEnd = tm.timeAt(ts.beatAtMeasure(currentMeasureIndex + 1));
    const currentMeasureFrac = Math.min(1, Math.max(0, (player.displayTime - curStart) / Math.max(1e-6, curEnd - curStart)));
    return { songMeasureNps, currentMeasureIndex, currentMeasureFrac };
  }

  /** Converts a song-density-strip position (measure index + fraction within it, from
   *  NotePreviewRenderer.songPositionAtPoint) into an actual seek time and jumps there —
   *  the strip doubles as a seek bar. */
  function seekToSongPosition(measurePos: number): void {
    const tm = tempo();
    const ts = timeSig();
    const measureIndex = Math.max(0, Math.floor(measurePos));
    const frac = measurePos - measureIndex;
    const beatStart = ts.beatAtMeasure(measureIndex);
    const beatEnd = ts.beatAtMeasure(measureIndex + 1);
    const t = tm.timeAt(beatStart + frac * (beatEnd - beatStart));
    player.seek(Math.max(0, Math.min(duration(), t)));
    scrollToPlayhead(player.time);
    requestDraw();
  }

  /** "m:ss · Measure N" for the song-strip hover/drag tooltip. */
  function formatSongPosition(measurePos: number): string {
    const tm = tempo();
    const ts = timeSig();
    const measureIndex = Math.max(0, Math.floor(measurePos));
    const frac = measurePos - measureIndex;
    const beatStart = ts.beatAtMeasure(measureIndex);
    const beatEnd = ts.beatAtMeasure(measureIndex + 1);
    const t = Math.max(0, Math.min(duration(), tm.timeAt(beatStart + frac * (beatEnd - beatStart))));
    const m = Math.floor(t / 60);
    const sec = Math.floor(t - m * 60);
    return `${m}:${String(sec).padStart(2, "0")} · Measure ${measureIndex + 1}`;
  }

  const fallbackDuration = () => {
    let last = 60;
    for (const d of docs.values()) for (const n of d.notes) last = Math.max(last, n.t + n.dur + 10);
    return last;
  };
  const duration = () => (player.loaded ? player.duration : fallbackDuration());

  /** Nearest grid line to `t` under tempo map `tm`, on division `div` (defaults to the
   *  currently-selected snap) — the same segment-local lines render.ts draws (see tempo.ts
   *  slotAt/slotTime). With no tempo changes this is bit for bit the original `offset +
   *  round((t - offset) / step) * step`, which is what keeps notes from older projects
   *  reading as on-grid (`snapTime(n.t) === n.t`). */
  function snapWith(tm: TempoMap, t: number, div: number = snap): number {
    // slotTime is a pure function of an integer slot number, so two notes landing on the
    // same slot come out bit-identical without needing to round — no float noise to chase.
    const clamped = Math.max(0, t);
    return Math.max(0, tm.slotTime(tm.slotAt(clamped, div), div));
  }

  /** The grid line — on ANY standard division, not just the currently-selected snap — that
   *  `t` is closest to, if that's within float noise of it; null if `t` isn't close to any
   *  of them. Different divisions' lines are generically tens of milliseconds apart at any
   *  real-world BPM, four orders of magnitude above the tolerance here, so at most one
   *  division can plausibly match for a given drifted note — there's no need to know which
   *  division a note was originally placed on to recognize it's merely drifted off that
   *  line. */
  function nearestGridTime(tm: TempoMap, t: number): number | null {
    let best: number | null = null;
    let bestDiff = 1e-4;
    for (const div of SNAPS) {
      const candidate = snapWith(tm, t, div);
      const diff = Math.abs(candidate - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }
    return best;
  }

  function snapTime(t: number): number {
    // No tempo at all means no slot grid to land on.
    if (bpm() <= 0) return Math.max(0, t);
    return snapWith(tempo(), t);
  }

  /** A sensible "one grid division" length in seconds at time `t` — always positive
   *  (self-heals an unset/invalid BPM to a 120 fallback), for defaults like a click-placed
   *  hold/slide's length or the arrow-key playhead step. Not used to gate whether snapping
   *  happens at all — that's still the explicit `bpm() > 0` checks below. */
  function localStepSec(t: number): number {
    return gridStepSec(tempo().bpmAt(t), snap);
  }

  /** Snaps every note in the current difficulty onto the tempo grid, for charts that predate
   *  the slot-grid rework or were edited by a different build/tool: a note (or hold/slide
   *  duration) that's merely within float noise of a grid line — not one deliberately placed
   *  off-grid, which this leaves alone — gets pulled exactly onto it, the same self-heal the
   *  move gesture already does for a note you actually drag, just applied to everything at
   *  once without requiring a drag. Checks every standard division (nearestGridTime), not
   *  just the currently-selected snap — a chart can mix plain notes with triplets, and
   *  there's no single division that's a superset of both (SNAPS' binary and 3-multiple
   *  entries only share 1, 2, 4, 6, 12 aren't multiples of 16 or vice versa), so picking one
   *  division would silently miss the other family instead of just doing the right thing
   *  automatically. */
  function snapAllToGrid(): void {
    if (bpm() <= 0) {
      toast("No BPM set — nothing to snap to", "error");
      return;
    }
    const d = doc();
    const tm = tempo();
    const pre = d.begin();
    let changed = 0;
    for (const n of d.notes) {
      const beforeT = n.t;
      const beforeDur = n.dur;
      const snappedT = nearestGridTime(tm, beforeT);
      const newT = snappedT !== null ? snappedT : beforeT;
      let newDur = beforeDur;
      if (n.kind === "hold" || (n.kind === "slide" && n.dur > 0)) {
        const origEnd = beforeT + beforeDur;
        const snappedEnd = nearestGridTime(tm, origEnd);
        if (snappedEnd !== null) newDur = Math.max(0, snappedEnd - newT);
      }
      // Compare at round6 (export) precision, not raw bits: toSif() rounds on the way
      // out, so a note reloaded from a save is already round6(preciseValue) — a few
      // ulps off the freshly-recomputed precise value even when it's already correct.
      // Comparing raw would flag (and rewrite) it as "changed" every single time this
      // runs after a reload, forever, for a difference that was never real.
      if (round6(newT) !== round6(beforeT) || round6(newDur) !== round6(beforeDur)) {
        n.t = newT;
        n.dur = newDur;
        changed++;
      }
    }
    d.commit(pre);
    toast(
      changed ? `Snapped ${changed} note${changed > 1 ? "s" : ""} onto the grid` : "Already on the grid",
      changed ? "ok" : "info",
    );
  }

  function syncTicks(): void {
    const times: number[] = [];
    for (const n of doc().notes) {
      times.push(n.t);
      if (n.kind === "hold" || (n.kind === "slide" && n.dur > 0)) times.push(n.t + n.dur);
    }
    times.sort((a, b) => a - b);
    player.setNoteTimes(times);
  }

  // --- persistence ----------------------------------------------------------
  let saveTimer: number | null = null;
  let saveState: "saved" | "dirty" | "saving" = "saved";
  let saveGen = 0;
  // Serializes actual project_save calls — see doSave()'s doc comment for why.
  let saveInFlight: Promise<boolean> | null = null;
  let saveQueued = false;

  function chartsRecord(): Record<string, SifNote[]> {
    const out: Record<string, SifNote[]> = {};
    for (const [lvl, d] of docs) {
      if (d.notes.length) out[String(lvl)] = d.toSif();
    }
    return out;
  }

  function syncManifestLevels(): void {
    manifest.levels = [...docs.entries()]
      .filter(([, d]) => d.notes.length > 0)
      .map(([lvl]) => ({
        level: lvl,
        level_number:
          manifest.levels.find((x) => x.level === lvl)?.level_number ?? 3 * lvl,
      }))
      .sort((a, b) => a.level - b.level);
  }

  async function saveOnce(): Promise<boolean> {
    const gen = ++saveGen;
    syncManifestLevels();
    editorMeta.snap = snap;
    editorMeta.zoom = zoom;
    editorMeta.orientation = orientation;
    saveState = "saving";
    updateStatus();
    let ok = true;
    try {
      await api.projectSave(data.id, manifest, editorMeta, chartsRecord());
      // edits made while the save was in flight keep the doc dirty
      if (gen === saveGen && saveTimer === null && !saveQueued) saveState = "saved";
      else if (saveState === "saving") saveState = "dirty";
    } catch (e) {
      saveState = "dirty";
      ok = false;
      toast(`Save failed: ${e}`, "error");
    }
    updateStatus();
    return ok;
  }

  /** Runs project_save calls one at a time — never two in flight together. A call that
   *  arrives while one is already running doesn't start its own; it just marks a
   *  follow-up pass to run immediately after, which captures whatever's dirty AT THAT
   *  POINT rather than the stale snapshot from when it was requested. Without this, two
   *  overlapping saves — e.g. the debounced autosave firing right as dispose() also
   *  forces one on navigating away — could finish their IPC round trips out of order,
   *  letting the now-stale earlier call's write land on disk AFTER the newer one and
   *  silently erase the latest edit. (The two calls used to share one fixed temp
   *  filename on the Rust side too, compounding this — see write_atomic in
   *  projects.rs — so both ends needed the fix.) */
  async function doSave(): Promise<boolean> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saveInFlight) {
      saveQueued = true;
      return saveInFlight;
    }
    saveInFlight = (async () => {
      let result = await saveOnce();
      while (saveQueued) {
        saveQueued = false;
        result = await saveOnce();
      }
      return result;
    })();
    try {
      return await saveInFlight;
    } finally {
      saveInFlight = null;
    }
  }

  function markDirty(): void {
    saveGen++;
    saveState = "dirty";
    updateStatus();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void doSave(), 1200);
  }

  // --- toolbar --------------------------------------------------------------
  setTitle(manifest.name || "(untitled)", () => openSettings(), "Song settings");

  const tabsHost = el("div", { class: "row" });
  const starInput = el("input", {
    type: "number",
    min: "1",
    max: "20",
    title: "Star difficulty shown in-game (1–20)",
    oninput: () => {
      const v = Math.max(1, Math.min(20, Number(starInput.value) || 1));
      const entry = manifest.levels.find((x) => x.level === level);
      if (entry) entry.level_number = v;
      else manifest.levels.push({ level, level_number: v });
      markDirty();
    },
  });

  function renderTabs(): void {
    tabsHost.replaceChildren();
    for (let lvl = 1; lvl <= 4; lvl++) {
      const exists = docs.has(lvl);
      const d = DIFFICULTIES[lvl];
      const btn = el("button", {
        class: `difficulty-tab ${exists ? `exists-${lvl}` : "missing"} ${lvl === level ? "active" : ""}`,
        text: exists ? d.short : `+${d.short}`,
        title: exists
          ? `${d.name} — right-click to delete this difficulty`
          : `Create ${d.name} chart`,
        onclick: () => {
          endActiveSlide();
          if (!docs.has(lvl)) {
            docs.set(lvl, new ChartDoc());
            hookDoc(docs.get(lvl)!);
          }
          level = lvl;
          renderTabs();
          syncTicks();
          requestDraw();
          updateStatus();
        },
        oncontextmenu: async (e: Event) => {
          e.preventDefault();
          if (!docs.has(lvl)) return;
          if (!(await confirmDialog(`Delete the ${d.name} chart? This cannot be undone.`))) return;
          endActiveSlide();
          docs.delete(lvl);
          manifest.levels = manifest.levels.filter((x) => x.level !== lvl);
          if (level === lvl) level = docs.size ? Math.min(...docs.keys()) : (docs.set(1, hookDoc(new ChartDoc())), 1);
          renderTabs();
          markDirty();
          syncTicks();
          requestDraw();
          updateStatus();
        },
      });
      tabsHost.append(btn);
    }
    const entry = manifest.levels.find((x) => x.level === level);
    starInput.value = String(entry?.level_number ?? 3 * level);
  }

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  function toolBtn(t: Tool, icon: string, label: string, key: string): HTMLButtonElement {
    const btn = el("button", {
      class: "btn tool-btn",
      text: icon,
      title: `${label} (${key})`,
      onclick: () => setTool(t),
    });
    toolButtons.set(t, btn);
    return btn;
  }
  function setTool(t: Tool): void {
    tool = t;
    if (t !== "slide") endActiveSlide();
    for (const [k, b] of toolButtons) b.classList.toggle("active", k === t);
    ghost = null;
    requestDraw();
  }

  const snapSelect = el(
    "select",
    {
      title: "Snap grid (subdivisions per beat)",
      onchange: () => {
        snap = Number(snapSelect.value);
        markDirty();
        requestDraw();
      },
    },
    ...SNAPS.map((s) => el("option", { value: String(s), text: `1/${s}` })),
  );
  snapSelect.value = String(snap);

  const bpmInput = el("input", {
    type: "number",
    min: "1",
    step: "0.01",
    value: String(bpm()),
    title: "BPM (drives the snap grid and is shown in-game)",
    oninput: () => {
      const v = Number(bpmInput.value);
      if (v >= 1) {
        manifest.bpm = v;
        markDirty();
        requestDraw();
      }
    },
  });

  // Tracks the last value the offset was committed at, so `change` can shift every
  // difficulty's notes by exactly the net delta once editing settles (not per keystroke).
  let committedOffset = editorMeta.offset_sec;
  const offsetInput = el("input", {
    type: "number",
    step: "0.001",
    value: String(editorMeta.offset_sec),
    title: "Grid offset: time of beat 1 in seconds. Moving it shifts every difficulty's notes with it.",
    oninput: () => {
      const v = Number(offsetInput.value);
      if (Number.isFinite(v)) {
        editorMeta.offset_sec = v;
        markDirty();
        requestDraw();
      }
    },
    onchange: () => {
      let v = editorMeta.offset_sec;
      // The shift may not push the earliest note (of any difficulty) before the track
      // start — clamping notes at 0 would stack them, which the server rejects when their
      // kinds differ — so the offset itself is limited instead.
      let first = Infinity;
      for (const d of docs.values()) for (const n of d.notes) first = Math.min(first, n.t);
      if (first + (v - committedOffset) < 0) {
        v = committedOffset - first;
        editorMeta.offset_sec = v;
        offsetInput.value = String(v);
        toast(`Offset limited to ${v.toFixed(3)}s — any lower would move the earliest note before the track start`, "error");
      }
      const delta = v - committedOffset;
      if (delta !== 0) {
        // Tempo changes are absolute times too, so they ride along with the notes; the map
        // before/after lets notes that sat on the old grid be re-derived from the new grid
        // formula (`t + delta` alone can land an ulp off it and read as off-grid).
        const before = tempo();
        committedOffset = v;
        for (const c of editorMeta.bpm_changes!) c.time_sec += delta;
        // Time-signature changes are anchored to absolute time too — shift them with
        // everything else so a change's position relative to the beat grid doesn't move.
        for (const c of editorMeta.time_sig_changes!) c.time_sec += delta;
        const after = tempo();
        const hasGrid = bpm() > 0;
        const shift = (t: number): number => {
          const moved = Math.max(0, t + delta);
          return hasGrid && snapWith(before, t) === t ? snapWith(after, moved) : moved;
        };
        endActiveSlide();
        // Not an undo step (see ChartDoc.remapTimes): each difficulty's history is carried
        // along instead, so nothing is left half-undoable.
        for (const d of docs.values()) d.remapTimes(shift);
        markDirty();
      }
      requestDraw();
    },
  });

  const playBtn = el("button", {
    class: "btn tool-btn",
    text: "⏵",
    title: "Play/pause (Space)",
    onclick: () => player.toggle(),
  });
  const timeDisplay = el("span", { class: "time-display", text: "0:00.000 / 0:00.000" });

  const rateSelect = el(
    "select",
    {
      title: "Playback speed",
      onchange: () => player.setRate(Number(rateSelect.value)),
    },
    ...RATES.map((r) => el("option", { value: String(r), text: `${r}×` })),
  );
  rateSelect.value = "1";

  const tickBtn = el("button", {
    class: `btn tool-btn${player.ticksEnabled ? " active" : ""}`,
    text: "🔔",
    title: "Note ticks during playback",
    onclick: () => {
      player.setTicksEnabled(!player.ticksEnabled);
      tickBtn.classList.toggle("active", player.ticksEnabled);
      localStorage.setItem(TICK_ENABLED_KEY, player.ticksEnabled ? "1" : "0");
    },
  });

  const tickSoundSelect = el(
    "select",
    {
      title: player.supportsTickSe
        ? "Tick sound"
        : "Tick sound (the native audio engine can only play the synthesized beep)",
      disabled: !player.supportsTickSe,
      onchange: () => {
        const sound = tickSoundSelect.value === "se" ? "se" : "beep";
        player.setTickSound(sound);
        localStorage.setItem(TICK_SOUND_KEY, sound);
      },
    },
    el("option", { value: "beep", text: "Beep" }),
    el("option", { value: "se", text: "Perfect SE" }),
  );
  tickSoundSelect.value = player.tickSound;

  const volumeInput = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: String(Math.round(player.volume * 100)),
    title: "Audio volume",
    oninput: () => {
      player.setVolume(Number(volumeInput.value) / 100);
      localStorage.setItem(VOLUME_KEY, volumeInput.value);
    },
  });

  const orientBtn = el("button", {
    class: "btn",
    text: orientation === "vertical" ? "⇆ Horizontal" : "⇅ Vertical",
    title: "Toggle editor orientation",
    onclick: () => {
      orientation = orientation === "vertical" ? "horizontal" : "vertical";
      orientBtn.textContent = orientation === "vertical" ? "⇆ Horizontal" : "⇅ Vertical";
      markDirty();
      requestDraw();
    },
  });

  const toolbar = el(
    "div",
    { class: "editor-toolbar" },
    el(
      "div",
      { class: "group" },
      el("button", { class: "btn", text: "← Library", onclick: () => goBack() }),
    ),
    el(
      "div",
      { class: "group" },
      tabsHost,
      el("span", { class: "mini-label", text: "★" }),
      starInput,
      el("button", {
        class: "btn",
        text: "⤓ Import",
        title: "Import a chart into this difficulty — SIF1/SIF2/Bandori/Bestdori files or Unity asset bundles (.unity3d)",
        onclick: () => void importChartFlow(),
      }),
    ),
    el(
      "div",
      { class: "group" },
      toolBtn("select", "⬚", "Select", "1"),
      toolBtn("tap", "●", "Tap", "2"),
      toolBtn("hold", "▮", "Hold — drag to set length", "3"),
      toolBtn("star", "★", "Star", "4"),
      toolBtn("slide", "◆", "Slide — click points across lanes, Esc ends the chain", "5"),
      toolBtn("flick", "↗", "Flick — click a selected hold or a selected slide's tail to toggle its release into a flick", "6"),
    ),
    el(
      "div",
      { class: "group" },
      el("span", { class: "mini-label", text: "snap" }),
      snapSelect,
      el("span", { class: "mini-label", text: "bpm" }),
      bpmInput,
      el("span", { class: "mini-label", text: "offset" }),
      offsetInput,
      el("button", {
        class: "btn",
        text: "Tempo…",
        title: "Add or edit mid-song tempo and time-signature changes",
        onclick: () => openTempoDialog(),
      }),
      el("button", {
        class: "btn",
        text: "Snap to grid",
        title:
          "Pull every note (and hold/slide length) that's merely within float noise of a grid line exactly onto it — checks every standard division (plain and triplet), not just the one currently selected — fixes charts from before the grid-precision fixes, or edited by another tool, where simultaneous notes drifted apart by a hair",
        onclick: () => snapAllToGrid(),
      }),
    ),
    el("div", { class: "row-break" }),
    el(
      "div",
      { class: "group" },
      playBtn,
      rateSelect,
      tickBtn,
      tickSoundSelect,
      el("span", { class: "mini-label", text: "🔊" }),
      volumeInput,
      timeDisplay,
      el("button", { class: "btn", text: "Jump…", title: "Jump to measure (Ctrl+G)", onclick: () => openJumpDialog() }),
    ),
    el(
      "div",
      { class: "group" },
      el("button", { class: "btn tool-btn", text: "−", title: "Zoom out (Ctrl+wheel)", onclick: () => zoomBy(1 / 1.3) }),
      el("button", { class: "btn tool-btn", text: "+", title: "Zoom in (Ctrl+wheel)", onclick: () => zoomBy(1.3) }),
      orientBtn,
    ),
    el(
      "div",
      { class: "group" },
      el("button", { class: "btn", text: "⚙ Preview…", title: "Note-preview settings", onclick: () => openPreviewSettingsDialog() }),
    ),
    el("div", { class: "group" }, el("button", { class: "btn", text: "？", title: "Shortcuts", onclick: showHelp })),
    el("div", { class: "spacer", style: "flex:1" }),
    el(
      "div",
      { class: "group" },
      el("button", { class: "btn", text: "Song settings", onclick: () => openSettings() }),
      el("button", { class: "btn btn-primary", text: "Upload", onclick: () => void upload() }),
    ),
  );
  setTool("tap");

  // --- canvas ---------------------------------------------------------------
  const canvas = el("canvas");
  const noAudioOverlay = el(
    "div",
    { class: "no-audio" },
    el("p", { text: "No audio track yet — add one to chart against the waveform." }),
    el("button", {
      class: "btn btn-primary",
      text: "Add audio (ogg / mp3 / wav)",
      onclick: () => void pickAudio(),
    }),
    el("p", { class: "mini-label", text: "You can still place notes without audio." }),
    el("button", { class: "btn btn-ghost", text: "Dismiss", onclick: () => noAudioOverlay.remove() }),
  );
  const canvasWrap = el("div", { class: "editor-canvas-wrap" }, canvas);
  const renderer = new Renderer(canvas);

  // --- note preview -----------------------------------------------------------
  const previewCanvas = el("canvas");
  const previewWrap = el("div", { class: "preview-canvas-wrap" }, previewCanvas);
  const previewRenderer = new NotePreviewRenderer(previewCanvas);

  previewCanvas.addEventListener("pointerdown", (e) => {
    const rect = previewCanvas.getBoundingClientRect();
    const pos = previewRenderer.songPositionAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (pos === null) return;
    previewSeeking = true;
    previewSongHoverPos = pos;
    // Pause while seeking — same reason the main waveform's scrub gesture does (see
    // its pointerdown handler): re-seeking a live source every pointermove otherwise
    // sounds like a glitch storm.
    previewSeekResume = player.playing;
    if (previewSeekResume) player.pause();
    seekToSongPosition(pos);
    previewCanvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  previewCanvas.addEventListener("pointermove", (e) => {
    const rect = previewCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    previewHoverLane = previewRenderer.laneAtPoint(x, y);
    // While dragging, ignore the row's vertical bounds (see songPositionAtPoint) so the
    // tooltip and the seek both keep tracking even if the pointer strays off the strip.
    previewSongHoverPos = previewRenderer.songPositionAtPoint(x, y, previewSeeking);
    if (previewSeeking && previewSongHoverPos !== null) seekToSongPosition(previewSongHoverPos);
  });
  previewCanvas.addEventListener("pointerleave", () => {
    previewHoverLane = null;
    if (!previewSeeking) previewSongHoverPos = null;
  });
  const endPreviewSeek = () => {
    if (!previewSeeking) return;
    previewSeeking = false;
    previewSongHoverPos = null;
    if (previewSeekResume && !player.playing) player.play();
  };
  previewCanvas.addEventListener("pointerup", endPreviewSeek);
  previewCanvas.addEventListener("pointercancel", endPreviewSeek);

  function setPreviewApproachSec(sec: number): void {
    previewApproachSec = Math.min(PREVIEW_SEC_MAX, Math.max(PREVIEW_SEC_MIN, sec));
    localStorage.setItem(PREVIEW_SPEED_KEY, String(previewApproachSec));
    updatePreviewSpeedInputs();
    requestDraw();
  }

  const previewSpeedInput = el("input", {
    type: "number",
    min: "1",
    max: "10",
    step: "0.1",
    title: "Note speed (game speed value 1-10)",
    oninput: () => setPreviewApproachSec(speedToApproachSec(Number(previewSpeedInput.value))),
  });
  const previewSpeedSlider = el("input", {
    type: "range",
    min: "1",
    max: "10",
    step: "0.1",
    title: "Note speed (game speed value 1-10)",
    oninput: () => setPreviewApproachSec(speedToApproachSec(Number(previewSpeedSlider.value))),
  });
  const previewSecInput = el("input", {
    type: "number",
    min: String(PREVIEW_SEC_MIN),
    max: String(PREVIEW_SEC_MAX),
    step: "0.01",
    title: "Time from spawn to judgment, in seconds",
    oninput: () => setPreviewApproachSec(Number(previewSecInput.value)),
  });
  function bumpPreviewSpeed(delta: number): void {
    const speed = Math.round((approachSecToSpeed(previewApproachSec) + delta) * 10) / 10;
    setPreviewApproachSec(speedToApproachSec(speed));
  }
  function updatePreviewSpeedInputs(): void {
    const speed = Math.round(approachSecToSpeed(previewApproachSec) * 10) / 10;
    previewSpeedInput.value = String(speed);
    previewSpeedSlider.value = String(speed);
    previewSecInput.value = String(Math.round(previewApproachSec * 100) / 100);
  }
  updatePreviewSpeedInputs();

  function setPreviewSizeScale(pct: number): void {
    const clamped = Math.min(PREVIEW_SCALE_MAX, Math.max(PREVIEW_SCALE_MIN, Math.round(pct)));
    previewSizeScale = clamped / 100;
    localStorage.setItem(PREVIEW_SCALE_KEY, String(clamped));
    previewSizeInput.value = String(clamped);
    previewSizeSlider.value = String(clamped);
    requestDraw();
  }
  const previewSizeSlider = el("input", {
    type: "range",
    min: String(PREVIEW_SCALE_MIN),
    max: String(PREVIEW_SCALE_MAX),
    step: "1",
    value: String(Math.round(previewSizeScale * 100)),
    title: "Judgment-position display size",
    oninput: () => setPreviewSizeScale(Number(previewSizeSlider.value)),
  });
  const previewSizeInput = el("input", {
    type: "number",
    min: String(PREVIEW_SCALE_MIN),
    max: String(PREVIEW_SCALE_MAX),
    step: "1",
    value: String(Math.round(previewSizeScale * 100)),
    title: "Judgment-position display size, %",
    oninput: () => setPreviewSizeScale(Number(previewSizeInput.value)),
  });

  function openPreviewSettingsDialog(): void {
    openDialog(
      "Note preview settings",
      el("p", {
        class: "dialog-body",
        text: "Game speed 1-10, or seconds directly — how long a note takes from spawn to the judgment line.",
      }),
      el(
        "div",
        { class: "row preview-speed-row" },
        el("span", { class: "mini-label", text: "Speed" }),
        el("button", { class: "btn btn-ghost tool-btn", text: "−", title: "Slower", onclick: () => bumpPreviewSpeed(-0.1) }),
        previewSpeedSlider,
        el("button", { class: "btn btn-ghost tool-btn", text: "+", title: "Faster", onclick: () => bumpPreviewSpeed(0.1) }),
        previewSpeedInput,
        el("span", { class: "mini-label", text: "sec" }),
        previewSecInput,
      ),
      el(
        "div",
        { class: "row preview-speed-row" },
        el("span", { class: "mini-label", text: "Size" }),
        previewSizeSlider,
        previewSizeInput,
        el("span", { class: "mini-label", text: "%" }),
      ),
    );
  }

  const previewPanel = el("div", { class: "preview-panel" }, previewWrap);
  const previewResizer = el("div", { class: "preview-resizer", title: "Drag to resize the preview" });

  previewResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = previewPanel.getBoundingClientRect().width;
    let finalWidth = startWidth;
    const onMove = (ev: PointerEvent) => {
      const bodyWidth = editorBody.getBoundingClientRect().width;
      const w = Math.min(bodyWidth * 0.7, Math.max(140, startWidth + (ev.clientX - startX)));
      previewPanel.style.width = `${w}px`;
      finalWidth = w;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(Math.round(finalWidth)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  const editorBody = el("div", { class: "editor-body" }, previewPanel, previewResizer, canvasWrap);

  async function pickAudio(): Promise<void> {
    const file = await pickFile("audio/*,.ogg,.mp3,.wav");
    if (!file) return;
    await attempt(async () => {
      await api.projectSetAudio(data.id, file.bytes);
      await loadAudio();
      toast("Audio set", "ok");
    });
  }

  async function loadAudio(): Promise<void> {
    const pcm = await api.projectLoadAudio(data.id);
    player.loadPcm(pcm);
    noAudioOverlay.remove();
    syncTicks();
    requestDraw();
    updateStatus();
  }

  // --- status bar -----------------------------------------------------------
  const saveSpan = el("span", { class: "save-state saved", text: "saved" });
  // Combo count is just the note total (see ChartDoc.comboCount), so show the kind
  // breakdown alongside it instead of a separate, always-identical note-count span.
  const comboSpan = el("span", { title: "Combo (= note count for this difficulty), by kind, with each kind's share of the total" });
  const selSpan = el("span");
  const cursorSpan = el("span");
  const npsSpan = el("span", { title: "Average notes/sec, and the densest 1-second window" });
  const lengthSpan = el("span", { title: "Time from the first note to the last" });
  const tempoChangesSpan = el("span", { title: "Mid-song tempo and time-signature changes" });
  const issuesSpan = el("span", {
    class: "issues",
    title: "Chart issues — click for details",
    onclick: showIssues,
  });

  const statusbar = el(
    "div",
    { class: "statusbar" },
    saveSpan,
    comboSpan,
    selSpan,
    issuesSpan,
    npsSpan,
    lengthSpan,
    tempoChangesSpan,
    el("span", { class: "spacer", style: "flex:1" }),
    cursorSpan,
  );

  /** Densest 1-second window, in notes — `times` must already be sorted ascending. */
  function maxNotesPerSecond(times: number[]): number {
    let max = 0;
    let j = 0;
    for (let i = 0; i < times.length; i++) {
      while (times[j] < times[i] - 1) j++;
      max = Math.max(max, i - j + 1);
    }
    return max;
  }

  function updateStatus(): void {
    saveSpan.textContent = saveState;
    saveSpan.className = `save-state ${saveState === "saved" ? "saved" : "dirty"}`;
    selSpan.textContent = doc().selection.size ? `sel ${doc().selection.size}` : "";
    const issues = doc().issues(player.loaded ? player.duration : 0);
    const errors = issues.filter((i) => i.severity === "error").length;
    issuesSpan.textContent = issues.length
      ? `⚠ ${issues.length} issue${issues.length > 1 ? "s" : ""}`
      : "✓ no issues";
    issuesSpan.className = `issues ${errors ? "bad" : ""}`;

    const notes = doc().notes;
    const byKind = { tap: 0, hold: 0, star: 0, slide: 0, flick: 0 };
    for (const n of notes) byKind[n.kind]++;
    const pct = (n: number) => (notes.length > 0 ? Math.round((n / notes.length) * 100) : 0);
    comboSpan.textContent =
      `combo ${doc().comboCount} ` +
      `(T${byKind.tap} ${pct(byKind.tap)}% ` +
      `H${byKind.hold} ${pct(byKind.hold)}% ` +
      `St${byKind.star} ${pct(byKind.star)}% ` +
      `Sl${byKind.slide} ${pct(byKind.slide)}% ` +
      `Fl${byKind.flick} ${pct(byKind.flick)}%)`;

    if (notes.length > 0) {
      const times = notes.map((n) => n.t).sort((a, b) => a - b);
      const lengthSec = times[times.length - 1] - times[0];
      const avgNps = lengthSec > 0 ? notes.length / lengthSec : 0;
      npsSpan.textContent = `NPS avg ${avgNps.toFixed(1)} / max ${maxNotesPerSecond(times)}`;
      lengthSpan.textContent = `len ${fmtTime(lengthSec)}`;
    } else {
      npsSpan.textContent = "NPS —";
      lengthSpan.textContent = "len —";
    }

    const bpmChanges = editorMeta.bpm_changes?.length ?? 0;
    const timeSigChanges = editorMeta.time_sig_changes?.length ?? 0;
    tempoChangesSpan.textContent = `${bpmChanges} BPM chg · ${timeSigChanges} time-sig chg`;
  }

  function showIssues(): void {
    const issues = doc().issues(player.loaded ? player.duration : 0);
    openDialog(
      `${DIFFICULTIES[level].name} — chart issues`,
      issues.length
        ? el(
            "div",
            {},
            ...issues.map((i) =>
              el("p", {
                class: "dialog-body",
                text: `${i.severity === "error" ? "✕" : "⚠"} ${i.message}`,
              }),
            ),
          )
        : el("p", { class: "dialog-body", text: "No issues — ready to upload." }),
    );
  }

  function showHelp(): void {
    const rows: [string, string][] = [
      ["1–6", "Select / Tap / Hold / Star / Slide / Flick tool"],
      ["Click", "Place note (drag for hold length)"],
      ["Slide: click, click, …", "Chain points across lanes · drag the last point for a hold end"],
      ["Esc (Slide tool)", "End the current slide chain"],
      ["Drag note", "Move · drag a hold's tail to resize"],
      ["Click selected hold (tool ≠ Slide)", "Toggle its release between normal and flick"],
      ["Click selected slide's tail (tool ≠ Slide)", "Toggle the chain's ending between normal/hold and flick"],
      ["Right-click", "Delete note"],
      ["Shift+click", "Add to selection"],
      ["Del", "Delete selection"],
      ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
      ["Ctrl+C / X / V", "Copy / cut / paste at playhead"],
      ["Ctrl+Shift+V", "Paste mirrored (lanes flipped) at playhead"],
      ["Ctrl+A", "Select all"],
      ["Space", "Play / pause"],
      ["Home / End", "Jump to start / end"],
      ["Ctrl+G", "Jump to a measure number"],
      ["↑ / ↓", "Step playhead by one snap division"],
      ["Wheel", "Scroll · Ctrl+wheel zoom · middle-drag pan"],
      ["Click waveform", "Seek"],
      ["Snap to grid button", "Pull near-grid notes/lengths exactly onto the grid"],
      ["Click/drag song density strip (preview)", "Seek — shows a time/measure tooltip"],
    ];
    openDialog(
      "Shortcuts",
      el(
        "div",
        { class: "hint-list" },
        ...rows.flatMap(([k, v]) => [el("kbd", { text: k }), el("span", { text: v })]),
      ),
    );
  }

  function openJumpDialog(): void {
    const curMeasure = Math.floor(timeSig().measureAt(tempo().beatAt(player.time))) + 1;
    const measureInput = el("input", {
      type: "number",
      min: "1",
      step: "1",
      value: String(curMeasure),
      title: "Measure number to jump to",
    });

    function doJump(): void {
      const m = Math.max(1, Math.round(Number(measureInput.value)) || 1);
      const beat = timeSig().beatAtMeasure(m - 1);
      player.seek(tempo().timeAt(beat));
      scrollToPlayhead(player.time);
      requestDraw();
      handle.close();
    }
    measureInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJump();
    });

    const handle = openDialog(
      "Jump to measure",
      el(
        "div",
        { class: "row" },
        el("span", { class: "mini-label", text: "Measure" }),
        measureInput,
        el("button", { class: "btn btn-primary", text: "Jump", onclick: doJump }),
      ),
    );
    measureInput.focus();
    measureInput.select();
  }

  function openTempoDialog(): void {
    const rowsHost = el("div", { class: "tempo-rows" });
    const changes = () => editorMeta.bpm_changes!;
    // buildTempoMap decides which rows count (tempo().dropped is the ones that don't);
    // the dialog only reports that — one rule, never a row that silently does nothing.
    const DEAD_HINT =
      "This tempo change has no effect: it must come after the start offset and after the previous change (no two at the same time).";

    function renderRows(): void {
      changes().sort((a, b) => a.time_sec - b.time_sec);
      const dead = new Set(tempo().dropped);
      rowsHost.replaceChildren(
        ...changes().map((c) => {
          const timeInput = el("input", {
            type: "number",
            step: "0.001",
            value: String(c.time_sec),
            title: dead.has(c) ? DEAD_HINT : "Time this tempo change starts, in seconds",
            onchange: () => {
              const v = Number(timeInput.value);
              if (Number.isFinite(v) && v >= 0) c.time_sec = v;
              markDirty();
              requestDraw();
              renderRows();
              if (tempo().dropped.includes(c)) toast(DEAD_HINT, "error");
            },
          });
          if (dead.has(c)) timeInput.style.outline = "2px solid var(--danger)";
          const bpmChangeInput = el("input", {
            type: "number",
            min: "1",
            step: "0.01",
            value: String(c.bpm),
            title: "BPM from this point onward",
            onchange: () => {
              const v = Number(bpmChangeInput.value);
              if (v >= 1) c.bpm = v;
              markDirty();
              requestDraw();
            },
          });
          return el(
            "div",
            { class: "row tempo-row" },
            timeInput,
            bpmChangeInput,
            el("button", {
              class: "btn btn-ghost",
              text: "✕",
              title: "Remove this tempo change",
              onclick: () => {
                editorMeta.bpm_changes = editorMeta.bpm_changes!.filter((x) => x !== c);
                markDirty();
                requestDraw();
                renderRows();
              },
            }),
          );
        }),
      );
    }
    renderRows();

    const startBpmInput = el("input", {
      type: "number",
      min: "1",
      step: "0.01",
      value: String(bpm()),
      title: "BPM from the start (same as the toolbar BPM field)",
      onchange: () => {
        const v = Number(startBpmInput.value);
        if (v >= 1) {
          manifest.bpm = v;
          bpmInput.value = String(v);
          markDirty();
          requestDraw();
        }
      },
    });

    const sigRowsHost = el("div", { class: "tempo-rows" });

    function renderSigRows(): void {
      editorMeta.time_sig_changes!.sort((a, b) => a.time_sec - b.time_sec);
      sigRowsHost.replaceChildren(
        ...editorMeta.time_sig_changes!.map((c) => {
          const timeInput = el("input", {
            type: "number",
            step: "0.001",
            value: String(c.time_sec),
            title: "Time this time-signature change starts, in seconds",
            onchange: () => {
              const v = Number(timeInput.value);
              if (Number.isFinite(v) && v >= 0) c.time_sec = v;
              markDirty();
              requestDraw();
              renderSigRows();
            },
          });
          const beatsInput = el("input", {
            type: "number",
            min: "1",
            step: "1",
            value: String(c.beats),
            title: "Beats per measure from this point onward",
            onchange: () => {
              const v = Math.round(Number(beatsInput.value));
              if (v >= 1) c.beats = v;
              markDirty();
              requestDraw();
            },
          });
          return el(
            "div",
            { class: "row tempo-row" },
            timeInput,
            beatsInput,
            el("button", {
              class: "btn btn-ghost",
              text: "✕",
              title: "Remove this time-signature change",
              onclick: () => {
                editorMeta.time_sig_changes = editorMeta.time_sig_changes!.filter((x) => x !== c);
                markDirty();
                requestDraw();
                renderSigRows();
              },
            }),
          );
        }),
      );
    }
    renderSigRows();

    const startBeatsInput = el("input", {
      type: "number",
      min: "1",
      step: "1",
      value: String(editorMeta.beats_per_measure),
      title: "Beats per measure from the start",
      onchange: () => {
        const v = Math.round(Number(startBeatsInput.value));
        if (v >= 1) {
          editorMeta.beats_per_measure = v;
          markDirty();
          requestDraw();
        }
      },
    });

    openDialog(
      "Tempo & time signature",
      el("p", {
        class: "dialog-body",
        text: "The grid follows each change from its time onward — times are absolute seconds, not beats.",
      }),
      el(
        "div",
        { class: "row tempo-row" },
        el("span", { class: "mini-label", text: `Start (offset ${editorMeta.offset_sec.toFixed(3)}s)` }),
        startBpmInput,
      ),
      rowsHost,
      el("button", {
        class: "btn",
        text: "+ Add tempo change at playhead",
        title: "Insert a tempo change at the current playhead position",
        onclick: () => {
          const t = snapTime(player.time);
          if (t <= editorMeta.offset_sec) {
            toast("The playhead is at or before the start — move it later first", "error");
            return;
          }
          // the bpm in effect here — read before replacing an existing change at this
          // time, so the replacement keeps its bpm rather than silently reverting it
          const change = { time_sec: t, bpm: tempo().bpmAt(t) };
          const existing = changes().filter((c) => Math.abs(c.time_sec - t) < 1e-9);
          if (existing.length) {
            editorMeta.bpm_changes = changes().filter((c) => !existing.includes(c));
            toast(`Replaced the tempo change at ${t.toFixed(3)}s`);
          }
          changes().push(change);
          markDirty();
          requestDraw();
          renderRows();
        },
      }),
      el("hr", { class: "dialog-sep" }),
      el(
        "div",
        { class: "row tempo-row" },
        el("span", { class: "mini-label", text: "Start beats/measure" }),
        startBeatsInput,
      ),
      sigRowsHost,
      el("button", {
        class: "btn",
        text: "+ Add time-signature change at playhead",
        title: "Insert a time-signature change at the current playhead position",
        onclick: () => {
          const t = snapTime(player.time);
          if (t <= editorMeta.offset_sec) {
            toast("The playhead is at or before the start — move it later first", "error");
            return;
          }
          editorMeta.time_sig_changes!.push({ time_sec: t, beats: timeSig().beatsAt(tempo().beatAt(t)) });
          markDirty();
          requestDraw();
          renderSigRows();
        },
      }),
    );
  }

  // --- settings / upload ----------------------------------------------------
  function openSettings(): void {
    openMetadataDialog(data.id, manifest, docs, {
      onChanged: () => {
        setTitle(manifest.name || "(untitled)", () => openSettings(), "Song settings");
        bpmInput.value = String(bpm());
        renderTabs();
        markDirty();
        requestDraw();
      },
      onAudioChanged: () => void attempt(loadAudio),
    });
  }

  function pickBundleChart(candidates: api.ChartCandidate[]): Promise<api.ChartCandidate | null> {
    return new Promise((resolve) => {
      let picked: api.ChartCandidate | null = null;
      const dlg = openDialog(
        "Which chart from this bundle?",
        el(
          "div",
          { class: "row wrap", style: "gap:6px" },
          ...candidates.map((c) =>
            el("button", {
              class: "btn",
              text: c.name,
              onclick: () => {
                picked = c;
                dlg.close();
              },
            }),
          ),
        ),
      );
      dlg.root.addEventListener("close", () => resolve(picked));
    });
  }

  async function importChartFlow(): Promise<void> {
    const file = await pickFile(".json,.asset,.txt,.note,.unity3d,.bundle,application/json");
    if (!file) return;
    let text: string;
    const head = new Uint8Array(file.bytes.slice(0, 7));
    if (String.fromCharCode(...head) === "UnityFS") {
      let candidates: api.ChartCandidate[];
      try {
        candidates = await api.bundleExtractCharts(file.bytes);
      } catch (e) {
        toast(String(e), "error");
        return;
      }
      const importable = candidates.filter((c) =>
        CONVERTERS.some((cv) => {
          try {
            return cv.detect(c.content);
          } catch {
            return false;
          }
        }),
      );
      if (!importable.length) {
        toast("The bundle contains no charts in a supported format", "error");
        return;
      }
      const chosen =
        importable.length === 1 ? importable[0] : await pickBundleChart(importable);
      if (!chosen) return;
      text = chosen.content;
    } else {
      text = new TextDecoder().decode(file.bytes);
    }
    let result: ReturnType<typeof importChart>;
    try {
      result = importChart(text);
    } catch (e) {
      toast(String(e), "error");
      return;
    }
    const d = doc();
    if (
      d.notes.length &&
      !(await confirmDialog(
        `Replace the current ${DIFFICULTIES[level].name} chart (${d.notes.length} notes) with the imported ${result.format} chart (${result.notes.length} notes)?`,
        "Replace",
      ))
    ) {
      return;
    }
    endActiveSlide();
    d.edit(() => {
      d.notes = ChartDoc.fromSif(result.notes).notes;
      d.selection.clear();
    });
    const warnings = [...result.warnings];
    if (result.bpm && result.bpm !== manifest.bpm) {
      manifest.bpm = result.bpm;
      bpmInput.value = String(result.bpm);
      warnings.push(`BPM set to ${result.bpm} (from the imported chart).`);
    }
    if (warnings.length) {
      openDialog(
        `Imported ${result.notes.length} notes (${result.format})`,
        ...warnings.map((w) => el("p", { class: "dialog-body", text: `⚠ ${w}` })),
      );
    } else {
      toast(`Imported ${result.notes.length} notes from ${result.format}`, "ok");
    }
  }

  async function upload(): Promise<void> {
    if (!(await doSave())) {
      toast("Saving failed — not uploading a stale project", "error");
      return;
    }
    if (![...docs.values()].some((d) => d.notes.length)) {
      toast("Chart at least one difficulty before uploading", "error");
      return;
    }
    const audioDur = player.loaded ? player.duration : 0;
    const errors = [...docs.entries()].flatMap(([lvl, d]) =>
      d.notes.length
        ? d.issues(audioDur)
            .filter((i) => i.severity === "error")
            .map((i) => `${DIFFICULTIES[lvl].short}: ${i.message}`)
        : [],
    );
    if (errors.length) {
      openDialog(
        "Fix chart errors before uploading",
        el("p", { class: "dialog-body", text: "These would be rejected by the server or crash the game:" }),
        ...errors.slice(0, 12).map((m) => el("p", { class: "dialog-body", text: `✕ ${m}` })),
      );
      return;
    }
    openUploadDialog(data.id, manifest.name, editorMeta.last_upload, (lu) => {
      editorMeta.last_upload = lu;
    });
  }

  // --- gestures ---------------------------------------------------------------
  function canvasPos(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function viewState(): DrawState {
    const tm = tempo();
    const slideTail = openSlideTail();
    return {
      orientation,
      scroll,
      zoom,
      bpm: bpm(),
      offset: editorMeta.offset_sec,
      tempoSegments: tm.segments,
      timeSigSegments: timeSig().segments.map((s) => ({ ...s, startSec: tm.timeAt(s.startBeat) })),
      snap,
      duration: duration(),
      notes: doc().notes,
      selection: doc().selection,
      cursor: player.displayTime,
      peaks: player.peaks,
      peaksPerSec: player.peaksPerSec,
      ghost: gesture.type === "place-slide" ? null : ghost,
      pendingHold:
        gesture.type === "place-hold"
          ? { t: gesture.note.t, lane: gesture.note.lane, dur: gesture.note.dur }
          : null,
      box: gesture.type === "box" ? gesture : null,
      activeSlideFrom:
        tool === "slide" && gesture.type === "none" && slideTail
          ? { t: slideTail.t, lane: slideTail.lane }
          : null,
      activeSlideEditId:
        gesture.type === "place-slide" ? gesture.note.id : tool === "slide" && slideTail ? slideTail.id : null,
    };
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    if (gesture.type !== "none") return; // a gesture is active (other button/pointer)
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = canvasPos(e);
    const s = viewState();
    const info = renderer.pointInfo(x, y, s);

    if (e.button === 1) {
      gesture = {
        type: "pan",
        startScroll: scroll,
        startPos: orientation === "vertical" ? y : x,
      };
      e.preventDefault();
      return;
    }

    if (!info) return;

    if (info.kind === "gutter") {
      // pause while scrubbing — seeking a live source every pointermove
      // restarts it constantly and sounds like a glitch storm
      const resume = player.playing;
      if (resume) player.pause();
      player.seek(Math.max(0, Math.min(duration(), info.t)));
      gesture = { type: "scrub", resume };
      requestDraw();
      return;
    }

    const d = doc();
    const hit = renderer.noteHit(x, y, s, d.notes);

    if (e.button === 2) {
      if (hit) {
        endActiveSlide();
        d.edit(() => {
          d.remove(d.selection.has(hit.note.id) ? [...d.selection] : [hit.note.id]);
        });
      }
      return;
    }
    if (e.button !== 0) return;

    if (hit) {
      if (e.shiftKey) {
        endActiveSlide();
        if (d.selection.has(hit.note.id)) d.selection.delete(hit.note.id);
        else d.selection.add(hit.note.id);
        requestDraw();
        updateStatus();
        return;
      }

      const eligibleTail =
        tool === "slide" &&
        hit.note.kind === "slide" &&
        hit.note.dur === 0 &&
        d.selection.size === 1 &&
        d.selection.has(hit.note.id) &&
        d.isSlideChainTail(hit.note);

      // A plain click (no drag) on an already-selected tap/star note flips it — and every
      // other selected tap/star note along with it — to the other kind. A quick way to
      // swap types without deleting and re-placing. The same click on a selected hold
      // toggles its release between normal and flick; on a selected slide chain's tail
      // (only while some OTHER tool is active — the Slide tool's own plain click on an
      // eligible tail already means "reopen this chain for editing", handled below via
      // slideTogglePending) it toggles the chain's ending the same way.
      const kindTogglePending =
        d.selection.has(hit.note.id) &&
        (hit.note.kind === "tap" ||
          hit.note.kind === "star" ||
          hit.note.kind === "hold" ||
          (hit.note.kind === "slide" && tool !== "slide" && d.isSlideChainTail(hit.note)));

      // Clicking a slide chain tail that's already open for editing lets you drag it
      // into a hold, or click again (no drag) to close it. Once it becomes a hold it
      // can't reopen — the chain is done, matching the server's "a hold ends the run".
      // An eligible tail that ISN'T open yet falls through to the normal move gesture
      // below instead — a drag just repositions it like any other note; only a plain
      // click with no net movement opens it (handled in finishGesture).
      if (eligibleTail && openSlideTail()?.id === hit.note.id) {
        gesture = { type: "place-slide", pre: d.begin(), note: hit.note, slideId: hit.note.slideId!, wasActive: true };
        requestDraw();
        return;
      }

      endActiveSlide();
      if (!d.selection.has(hit.note.id)) {
        d.selection.clear();
        d.selection.add(hit.note.id);
      }
      const orig = new Map<number, { t: number; lane: number }>();
      let minLane = 9;
      let maxLane = 1;
      for (const n of d.selectedNotes()) {
        orig.set(n.id, { t: n.t, lane: n.lane });
        minLane = Math.min(minLane, n.lane);
        maxLane = Math.max(maxLane, n.lane);
      }
      gesture = {
        type: "move",
        pre: d.begin(),
        startT: info.t,
        startLane: info.lane,
        orig,
        slideTogglePending: eligibleTail,
        kindTogglePending,
        moved: false,
        minLane,
        maxLane,
        part: hit.part === "tail" ? "tail" : "head",
        resizeNote: hit.part === "tail" ? hit.note : null,
      };
      requestDraw();
      updateStatus();
      return;
    }

    if (tool === "select") {
      endActiveSlide();
      gesture = { type: "box", x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey };
      if (!e.shiftKey) {
        d.selection.clear();
        updateStatus();
      }
      requestDraw();
      return;
    }

    // placement
    const t = snapTime(info.t);
    if (tool === "hold") {
      const pre = d.begin();
      const note = d.place(t, info.lane, "hold", 0);
      gesture = { type: "place-hold", pre, note };
    } else if (tool === "slide") {
      // activeSlide only ever points at an open (dur === 0) tail — see finishGesture's
      // "place-slide" case — so there's never a stale hold tail to undo here.
      const pre = d.begin();
      const slideId = openSlideTail() ? activeSlide!.slideId : allocateSlideId();
      const note = d.place(t, info.lane, "slide", 0, slideId);
      d.selection.clear();
      d.selection.add(note.id);
      gesture = { type: "place-slide", pre, note, slideId, wasActive: false };
    } else {
      d.edit(() => {
        const note = d.place(t, info.lane, tool as NoteKind);
        d.selection.clear();
        d.selection.add(note.id);
      });
    }
    requestDraw();
  });

  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = canvasPos(e);
    const s = viewState();
    const info = renderer.pointInfo(x, y, s);
    const d = doc();

    switch (gesture.type) {
      case "pan": {
        const pos = orientation === "vertical" ? y : x;
        scroll = gesture.startScroll - (pos - gesture.startPos) / zoom;
        clampScroll();
        requestDraw();
        return;
      }
      case "scrub": {
        if (info) player.seek(Math.max(0, Math.min(duration(), info.t)));
        requestDraw();
        return;
      }
      case "place-hold": {
        if (info) {
          gesture.note.dur = Math.max(0, snapTime(info.t) - gesture.note.t);
        }
        requestDraw();
        return;
      }
      case "place-slide": {
        if (info) {
          gesture.note.dur = Math.max(0, snapTime(info.t) - gesture.note.t);
          // Dragging into a hold and ending in a flick are mutually exclusive —
          // a real drag here always means "this chain ends in a hold".
          gesture.note.flickEnd = false;
        }
        requestDraw();
        return;
      }
      case "move": {
        if (!info || info.kind !== "lanes") return;
        if (gesture.resizeNote) {
          const n = gesture.resizeNote;
          const beforeDur = n.dur;
          n.dur = Math.max(localStepSec(n.t), snapTime(info.t) - n.t);
          // Same "did it actually move" tracking as the plain-move branch below — a tail
          // drag that changes the duration is a real edit, not a click, and must not also
          // trigger kindTogglePending's flick-toggle in finishGesture.
          if (n.dur !== beforeDur) gesture.moved = true;
        } else {
          // Move by an INTEGER number of grid slots (tempo.ts) — counted on the same
          // segment-local grid that's drawn and snapped to, so a drag across a tempo change
          // continues on the next segment's lines instead of assuming one constant step
          // song-wide. On-grid notes are re-derived from the grid formula (stays bit-exact);
          // off-grid notes (BPM-mismatched imports) shift by the same seconds their nearest
          // grid line does, keeping their distance from it instead of being quantized.
          const tm = tempo();
          const rawDt = info.t - gesture.startT;
          const hasGrid = bpm() > 0;
          const kd = hasGrid ? tm.slotAt(info.t, snap) - tm.slotAt(gesture.startT, snap) : 0;
          // clamp the lane delta so the WHOLE selection stays in 1..9 —
          // per-note clamping compresses lanes and stacks notes
          const dl = Math.max(
            1 - gesture.minLane,
            Math.min(9 - gesture.maxLane, info.lane - gesture.startLane),
          );
          for (const n of d.notes) {
            const o = gesture.orig.get(n.id);
            if (!o) continue;
            if (!hasGrid) {
              n.t = Math.max(0, o.t + rawDt);
            } else if (kd === 0) {
              // No net movement keeps the exact original value: re-deriving it through the
              // grid math can land an ulp off, which then reads as a real edit (a phantom
              // undo entry, broken exact-time sim grouping, a failed "plain click" test in
              // finishGesture's slideTogglePending/kindTogglePending checks).
              n.t = o.t;
            } else {
              const slot = tm.slotAt(o.t, snap);
              const here = tm.slotTime(slot, snap);
              const there = tm.slotTime(slot + kd, snap);
              // Within float noise of the grid counts as on it too (not just bit-exact) —
              // this self-heals any tiny pre-existing drift (e.g. from an older chart, or
              // notes merged from elsewhere) onto the new grid position, instead of just
              // preserving it via the raw-distance shift. `there` is a pure function of an
              // integer slot, so notes sharing one land bit-identical.
              const onGrid = Math.abs(snapWith(tm, o.t) - o.t) < 1e-4;
              n.t = onGrid ? Math.max(0, there) : Math.max(0, o.t + (there - here));
            }
            if (hasGrid && kd !== 0 && (n.kind === "hold" || (n.kind === "slide" && n.dur > 0))) {
              // A hold/slide-tail's length is otherwise carried through a move completely
              // unchanged — only its start shifts. If the END was already on the grid, keep
              // it on the SAME relative slot after the move too (same idea as the position
              // self-heal above), so two notes of "the same" length that get moved to share
              // a start also end up with bit-identical ends, instead of each still dragging
              // along whatever (possibly one-tick-off) duration it happened to have before.
              // Skipped when kd === 0 for the same reason position skips it: re-deriving an
              // unmoved note through the grid math can land an ulp off and read as a real edit.
              const origEnd = o.t + n.dur;
              const onGridEnd = Math.abs(snapWith(tm, origEnd) - origEnd) < 1e-4;
              if (onGridEnd) {
                const endSlot = tm.slotAt(origEnd, snap) + kd;
                n.dur = Math.max(0, tm.slotTime(endSlot, snap) - n.t);
              }
            }
            n.lane = o.lane + dl;
            // Tracks a REAL displacement at any point during the drag, not just a net
            // change by release time — dragging away and back to the exact start should
            // still count as an actual drag (see the "moved" field's doc comment).
            if (n.t !== o.t || n.lane !== o.lane) gesture.moved = true;
          }
        }
        requestDraw();
        return;
      }
      case "box": {
        gesture.x1 = x;
        gesture.y1 = y;
        requestDraw();
        return;
      }
      case "none": {
        if (tool !== "select" && info?.kind === "lanes") {
          ghost = { t: snapTime(info.t), lane: info.lane, kind: tool as NoteKind };
        } else {
          ghost = null;
        }
        requestDraw();
      }
    }
  });

  const finishGesture = (e: PointerEvent) => {
    const d = doc();
    switch (gesture.type) {
      case "place-hold": {
        if (gesture.note.dur <= 0) gesture.note.dur = localStepSec(gesture.note.t);
        d.selection.clear();
        d.selection.add(gesture.note.id);
        d.commit(gesture.pre);
        break;
      }
      case "place-slide": {
        // no forced minimum duration — a slide point defaults to a plain link, not a hold
        d.selection.clear();
        d.selection.add(gesture.note.id);
        d.commit(gesture.pre);
        if (gesture.note.dur > 0) {
          // dragged into a hold — the chain is done here, regardless of prior state
          endActiveSlide();
        } else if (gesture.wasActive) {
          // a plain click on the already-open tail toggles it back to select mode
          endActiveSlide();
        } else {
          activeSlide = { slideId: gesture.slideId, lastId: gesture.note.id };
        }
        break;
      }
      case "move": {
        if (!gesture.resizeNote) d.resolveCollisions(new Set(gesture.orig.keys()));
        if (gesture.kindTogglePending && !gesture.moved) {
          // a plain click, no drag — flip every selected tap/star note, hold release, or
          // slide chain ending instead of no-op'ing
          for (const id of gesture.orig.keys()) {
            const n = d.byId(id);
            if (!n) continue;
            if (n.kind === "tap" || n.kind === "star") n.kind = n.kind === "tap" ? "star" : "tap";
            else if (n.kind === "hold") n.flickEnd = !n.flickEnd;
            else if (n.kind === "slide" && d.isSlideChainTail(n)) {
              n.flickEnd = !n.flickEnd;
              if (n.flickEnd) n.dur = 0; // a flick ending carries no hold duration
            }
          }
        }
        d.commit(gesture.pre);
        if (gesture.slideTogglePending && !gesture.moved) {
          const [[id]] = gesture.orig;
          const n = d.byId(id);
          if (n) {
            // a plain click, no drag — open the chain for editing instead of no-op'ing
            activeSlide = { slideId: n.slideId!, lastId: n.id };
          }
        }
        break;
      }
      case "box": {
        const s = viewState();
        const picked = renderer.notesInBox(gesture, s, d.notes);
        if (!gesture.additive) d.selection.clear();
        for (const n of picked) d.selection.add(n.id);
        break;
      }
      case "scrub": {
        if (gesture.resume && !player.playing) player.play();
        break;
      }
      default:
        break;
    }
    gesture = { type: "none" };
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    requestDraw();
    updateStatus();
  };
  canvas.addEventListener("pointerup", finishGesture);
  canvas.addEventListener("pointercancel", finishGesture);

  canvas.addEventListener("pointerleave", () => {
    ghost = null;
    requestDraw();
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const { x, y } = { x: e.offsetX, y: e.offsetY };
        const s = viewState();
        const info = renderer.pointInfo(x, y, s);
        const anchor = info ? info.t : scroll;
        zoomBy(Math.exp(-e.deltaY * 0.0016), anchor);
      } else {
        const delta = (e.deltaY !== 0 ? e.deltaY : e.deltaX) / zoom;
        scroll += delta;
        clampScroll();
        requestDraw();
      }
    },
    { passive: false },
  );

  function clampScroll(): void {
    const span = renderer.timeSpan(viewState());
    scroll = Math.max(-2, Math.min(duration() + 2 - span * 0.2, scroll));
  }

  function zoomBy(factor: number, anchorT?: number): void {
    const before = anchorT ?? scroll + renderer.timeSpan(viewState()) / 2;
    const frac = (before - scroll) * zoom; // px from origin
    zoom = Math.max(30, Math.min(1200, zoom * factor));
    scroll = before - frac / zoom;
    clampScroll();
    markDirty();
    requestDraw();
  }

  // --- keyboard ---------------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      document.querySelector("dialog[open]")
    ) {
      return;
    }
    const d = doc();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // editing/transport keys during an active pointer gesture would corrupt
    // the gesture's undo bookkeeping — ignore them until it ends
    if (gesture.type !== "none") return;

    if (e.code === "Space") {
      e.preventDefault();
      player.toggle();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "z") {
      e.preventDefault();
      endActiveSlide();
      e.shiftKey ? d.redo() : d.undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "y") {
      e.preventDefault();
      endActiveSlide();
      d.redo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      for (const n of d.notes) d.selection.add(n.id);
      requestDraw();
      updateStatus();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doSave();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "g") {
      e.preventDefault();
      openJumpDialog();
      return;
    }
    if (ctrl && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      const sel = d.selectedNotes();
      if (!sel.length) return;
      const tm = tempo();
      const baseBeat = tm.beatAt(Math.min(...sel.map((n) => n.t)));
      clipboard = sel.map((n) => ({
        dBeat: tm.beatAt(n.t) - baseBeat,
        lane: n.lane,
        kind: n.kind,
        durBeat: n.dur > 0 ? tm.beatAt(n.t + n.dur) - tm.beatAt(n.t) : 0,
        slideId: n.slideId,
        flickEnd: n.flickEnd,
      }));
      if (e.key.toLowerCase() === "x") {
        endActiveSlide();
        d.edit(() => d.remove([...d.selection]));
      }
      toast(`${clipboard.length} note${clipboard.length > 1 ? "s" : ""} ${e.key === "x" ? "cut" : "copied"}`);
      return;
    }
    if (ctrl && e.key.toLowerCase() === "v") {
      if (!clipboard.length) return;
      const tm = tempo();
      const hasGrid = bpm() > 0;
      const baseBeat = tm.beatAt(snapTime(player.time));
      // Distinct source chains get fresh ids so pasted copies don't merge into the originals.
      const slideIdMap = new Map<number, number>();
      d.edit(() => {
        d.selection.clear();
        for (const c of clipboard) {
          // Beat offsets land the copied rhythm at the tempo in effect here — paste across
          // a tempo change keeps the same rhythm rather than the same raw seconds. Keep the
          // computed offset as-is rather than forcing it onto the CURRENT snap setting
          // (that would distort spacing for a selection mixing notes from different snap
          // divisions, e.g. triplets alongside quarter notes) — but if it lands within
          // float noise of the current grid anyway (the overwhelmingly common case, since
          // the source note was itself on-grid), snap it exactly there so a note placed
          // afterward via a fresh click lines up bit for bit (exact f64 equality is what
          // the server's chord grouping relies on).
          const raw = tm.timeAt(baseBeat + c.dBeat);
          let t: number;
          if (hasGrid) {
            const grid = snapTime(raw);
            t = Math.abs(grid - raw) < 1e-4 ? grid : Math.max(0, raw);
          } else {
            t = Math.max(0, raw);
          }
          const dur = c.durBeat > 0 ? Math.max(0, tm.timeAt(tm.beatAt(t) + c.durBeat) - t) : 0;
          let lane = c.lane;
          if(shift) {
            lane = 10 - lane;
          }
          let slideId: number | undefined;
          if (c.kind === "slide" && c.slideId !== undefined) {
            slideId = slideIdMap.get(c.slideId);
            if (slideId === undefined) {
              slideId = allocateSlideId();
              slideIdMap.set(c.slideId, slideId);
            }
          }
          const n = d.place(t, lane, c.kind, dur, slideId);
          if (c.flickEnd) n.flickEnd = true;
          d.selection.add(n.id);
        }
      });
      return;
    }
    switch (e.key) {
      case "1":
        setTool("select");
        break;
      case "2":
        setTool("tap");
        break;
      case "3":
        setTool("hold");
        break;
      case "4":
        setTool("star");
        break;
      case "5":
        setTool("slide");
        break;
      case "6":
        setTool("flick");
        break;
      case "Delete":
      case "Backspace":
        if (d.selection.size) {
          endActiveSlide();
          d.edit(() => d.remove([...d.selection]));
        }
        break;
      case "Escape":
        endActiveSlide();
        d.selection.clear();
        requestDraw();
        updateStatus();
        break;
      case "Home":
        player.seek(0);
        scroll = -0.5;
        requestDraw();
        break;
      case "End":
        player.seek(duration());
        scrollToPlayhead(player.time);
        requestDraw();
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        player.seek(snapTime(player.time - localStepSec(player.time) * 1.001));
        scrollToPlayhead(player.time);
        requestDraw();
        break;
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        player.seek(snapTime(player.time + localStepSec(player.time) * 1.001));
        scrollToPlayhead(player.time);
        requestDraw();
        break;
    }
  }
  window.addEventListener("keydown", onKey);

  // --- render loop ------------------------------------------------------------
  function requestDraw(): void {
    needsDraw = true;
  }

  /** Recenter the view if `cur` has strayed near/past the right edge or before the visible
   *  range — the rule playback already follows every frame, reused for manual seeks (Home
   *  excepted, which always resets to the very start) so the playhead never goes missing. */
  function scrollToPlayhead(cur: number): void {
    const span = renderer.timeSpan(viewState());
    if (cur > scroll + span * 0.75 || cur < scroll) {
      scroll = cur - span * 0.25;
    }
  }

  function frame(): void {
    if (disposed) return;
    if (player.playing) {
      needsDraw = true;
      const cur = player.displayTime;
      if (gesture.type === "none") scrollToPlayhead(cur);
      timeDisplay.textContent = `${fmtTime(cur)} / ${fmtTime(player.duration)}`;
    }
    if (needsDraw) {
      needsDraw = false;
      renderer.draw(viewState());
    }
    // The preview animates continuously against the playhead, independent of the main
    // canvas's needsDraw gating.
    const measureInfo = currentMeasureInfo();
    const songInfo = songMeasureInfo();
    previewRenderer.draw({
      now: player.displayTime,
      approachSec: previewApproachSec,
      notes: doc().notes,
      sizeScale: previewSizeScale,
      measureLabel: measureInfo.measureLabel,
      measureNps: measureInfo.measureNps,
      songMeasureNps: songInfo.songMeasureNps,
      currentMeasureIndex: songInfo.currentMeasureIndex,
      currentMeasureFrac: songInfo.currentMeasureFrac,
      songHoverPos: previewSongHoverPos,
      songHoverLabel: previewSongHoverPos !== null ? formatSongPosition(previewSongHoverPos) : null,
      hoverLane: previewHoverLane,
    });
    requestAnimationFrame(frame);
  }

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
    requestDraw();
  });
  resizeObserver.observe(canvasWrap);
  const previewResizeObserver = new ResizeObserver(() => previewRenderer.resize());
  previewResizeObserver.observe(previewWrap);

  player.onstate = () => {
    playBtn.textContent = player.playing ? "⏸" : "⏵";
    timeDisplay.textContent = `${fmtTime(player.time)} / ${fmtTime(player.duration)}`;
    requestDraw();
  };

  function hookDoc(d: ChartDoc): ChartDoc {
    d.onchange = () => {
      markDirty();
      syncTicks();
      requestDraw();
      updateStatus();
    };
    return d;
  }
  for (const d of docs.values()) hookDoc(d);

  // --- assemble ---------------------------------------------------------------
  const root = el("div", { class: "view editor-view" }, toolbar, editorBody, statusbar);

  renderTabs();
  updateStatus();
  requestAnimationFrame(() => {
    const savedPreviewWidth = loadPreviewWidthPx();
    if (savedPreviewWidth !== null) {
      const bodyWidth = editorBody.getBoundingClientRect().width;
      previewPanel.style.width = `${Math.min(bodyWidth * 0.7, Math.max(140, savedPreviewWidth))}px`;
    }
    renderer.resize();
    previewRenderer.resize();
    requestDraw();
    frame();
  });

  if (data.audio_ext) {
    void attempt(loadAudio);
  } else {
    canvasWrap.append(noAudioOverlay);
  }
  syncTicks();

  return {
    root,
    async dispose() {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      resizeObserver.disconnect();
      previewResizeObserver.disconnect();
      player.dispose();
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (saveState !== "saved") await doSave();
    },
  };
}

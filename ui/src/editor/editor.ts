import * as api from "../api.js";
import { attempt, confirmDialog, el, fmtTime, openDialog, pickFile, toast } from "../dom.js";
import type { ProjectData, SifNote } from "../types.js";
import { DIFFICULTIES } from "../types.js";
import { Player } from "./audio.js";
import { ChartDoc, allocateSlideId, round6 } from "./chart.js";
import type { Note, NoteKind } from "./chart.js";
import { buildTempoMap } from "./tempo.js";
import { Renderer } from "./render.js";
import type { DrawState, Orientation } from "./render.js";
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
    }
  | { type: "box"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { type: "pan"; startScroll: number; startPos: number }
  | { type: "scrub"; resume: boolean };

const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16];
const RATES = [0.5, 0.75, 1];

export async function createEditor(projectId: string, goBack: () => void): Promise<EditorView> {
  const data: ProjectData = await api.projectLoad(projectId);
  const manifest = data.manifest;
  const editorMeta = data.editor;
  // Absent on projects saved before mid-song tempo changes existed.
  editorMeta.bpm_changes ??= [];

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
  let clipboard: { dt: number; lane: number; kind: NoteKind; dur: number; slideId?: number }[] = [];
  // Slide chain currently being extended by sequential clicks of the slide tool.
  let activeSlide: { slideId: number; lastId: number; lastT: number; lastLane: number } | null = null;
  function endActiveSlide(): void {
    activeSlide = null;
  }

  const player = new Player();
  await player.init();

  const bpm = () => manifest.bpm ?? 120;
  // Rebuilt on demand — the change list is tiny, no need to cache/invalidate.
  const tempo = () => buildTempoMap(bpm(), editorMeta.offset_sec, editorMeta.bpm_changes!);

  const fallbackDuration = () => {
    let last = 60;
    for (const d of docs.values()) for (const n of d.notes) last = Math.max(last, n.t + n.dur + 10);
    return last;
  };
  const duration = () => (player.loaded ? player.duration : fallbackDuration());

  function snapTime(t: number): number {
    const clamped = Math.max(0, t);
    if (bpm() <= 0) return round6(clamped);
    const tm = tempo();
    const snappedBeat = Math.round(tm.beatAt(clamped) * snap) / snap;
    return round6(Math.max(0, tm.timeAt(snappedBeat)));
  }

  /** A sensible "one grid division" length in seconds at time `t` — always positive
   *  (self-heals an unset/invalid BPM to a 120 fallback), for defaults like a click-placed
   *  hold/slide's length or the arrow-key playhead step. Not used to gate whether snapping
   *  happens at all — that's still the explicit `bpm() > 0` checks below. */
  function localStepSec(t: number): number {
    const tm = tempo();
    return tm.timeAt(tm.beatAt(t) + 1 / snap) - t;
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

  async function doSave(): Promise<boolean> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
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
      if (gen === saveGen && saveTimer === null) saveState = "saved";
      else if (saveState === "saving") saveState = "dirty";
    } catch (e) {
      saveState = "dirty";
      ok = false;
      toast(`Save failed: ${e}`, "error");
    }
    updateStatus();
    return ok;
  }

  function markDirty(): void {
    saveGen++;
    saveState = "dirty";
    updateStatus();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void doSave(), 1200);
  }

  // --- toolbar --------------------------------------------------------------
  const titleBtn = el("button", {
    class: "btn btn-ghost",
    text: manifest.name || "(untitled)",
    title: "Song settings",
    onclick: () => openSettings(),
  });

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
      const delta = editorMeta.offset_sec - committedOffset;
      committedOffset = editorMeta.offset_sec;
      if (delta === 0) return;
      for (const d of docs.values()) {
        d.edit(() => {
          for (const n of d.notes) n.t = round6(Math.max(0, n.t + delta));
        });
      }
      // Tempo changes are anchored to absolute time too — shift them with everything
      // else so a change's position relative to the beat grid doesn't move.
      for (const c of editorMeta.bpm_changes!) c.time_sec = round6(Math.max(0, c.time_sec + delta));
      markDirty();
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
    class: "btn tool-btn active",
    text: "🔔",
    title: "Note ticks during playback",
    onclick: () => {
      player.setTicksEnabled(!player.ticksEnabled);
      tickBtn.classList.toggle("active", player.ticksEnabled);
    },
  });

  const tickSoundSelect = el(
    "select",
    {
      title: player.supportsTickSe
        ? "Tick sound"
        : "Tick sound (the native audio engine can only play the synthesized beep)",
      disabled: !player.supportsTickSe,
      onchange: () => player.setTickSound(tickSoundSelect.value === "se" ? "se" : "beep"),
    },
    el("option", { value: "beep", text: "Beep" }),
    el("option", { value: "se", text: "Perfect SE" }),
  );
  tickSoundSelect.value = player.tickSound;

  const volumeInput = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: "100",
    title: "Audio volume",
    oninput: () => player.setVolume(Number(volumeInput.value) / 100),
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
      titleBtn,
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
        title: "Add or edit mid-song tempo changes",
        onclick: () => openTempoDialog(),
      }),
    ),
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
    ),
    el(
      "div",
      { class: "group" },
      el("button", { class: "btn tool-btn", text: "−", title: "Zoom out (Ctrl+wheel)", onclick: () => zoomBy(1 / 1.3) }),
      el("button", { class: "btn tool-btn", text: "+", title: "Zoom in (Ctrl+wheel)", onclick: () => zoomBy(1.3) }),
      orientBtn,
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
  const comboSpan = el("span");
  const selSpan = el("span");
  const cursorSpan = el("span");
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
    el("span", { class: "spacer", style: "flex:1" }),
    cursorSpan,
  );

  function updateStatus(): void {
    saveSpan.textContent = saveState;
    saveSpan.className = `save-state ${saveState === "saved" ? "saved" : "dirty"}`;
    comboSpan.textContent = `combo ${doc().comboCount}`;
    selSpan.textContent = doc().selection.size ? `sel ${doc().selection.size}` : "";
    const issues = doc().issues(player.loaded ? player.duration : 0);
    const errors = issues.filter((i) => i.severity === "error").length;
    issuesSpan.textContent = issues.length
      ? `⚠ ${issues.length} issue${issues.length > 1 ? "s" : ""}`
      : "✓ no issues";
    issuesSpan.className = `issues ${errors ? "bad" : ""}`;
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
      ["1–5", "Select / Tap / Hold / Star / Slide tool"],
      ["Click", "Place note (drag for hold length)"],
      ["Slide: click, click, …", "Chain points across lanes · drag the last point for a hold end"],
      ["Esc (Slide tool)", "End the current slide chain"],
      ["Drag note", "Move · drag a hold's tail to resize"],
      ["Right-click", "Delete note"],
      ["Shift+click", "Add to selection"],
      ["Del", "Delete selection"],
      ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
      ["Ctrl+C / X / V", "Copy / cut / paste at playhead"],
      ["Ctrl+Shift+V", "Paste mirrored (lanes flipped) at playhead"],
      ["Ctrl+A", "Select all"],
      ["Space", "Play / pause"],
      ["Home / End", "Jump to start / end"],
      ["↑ / ↓", "Step playhead by one snap division"],
      ["Wheel", "Scroll · Ctrl+wheel zoom · middle-drag pan"],
      ["Click waveform", "Seek"],
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

  function openTempoDialog(): void {
    const rowsHost = el("div", { class: "tempo-rows" });

    function renderRows(): void {
      editorMeta.bpm_changes!.sort((a, b) => a.time_sec - b.time_sec);
      rowsHost.replaceChildren(
        ...editorMeta.bpm_changes!.map((c) => {
          const timeInput = el("input", {
            type: "number",
            step: "0.001",
            value: String(c.time_sec),
            title: "Time this tempo change starts, in seconds",
            onchange: () => {
              const v = Number(timeInput.value);
              if (Number.isFinite(v) && v >= 0) c.time_sec = v;
              markDirty();
              requestDraw();
              renderRows();
            },
          });
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

    openDialog(
      "Tempo changes",
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
        text: "+ Add at playhead",
        title: "Insert a tempo change at the current playhead position",
        onclick: () => {
          const t = snapTime(player.time);
          if (t <= editorMeta.offset_sec) {
            toast("The playhead is at or before the start — move it later first", "error");
            return;
          }
          editorMeta.bpm_changes!.push({ time_sec: t, bpm: tempo().bpmAt(t) });
          markDirty();
          requestDraw();
          renderRows();
        },
      }),
    );
  }

  // --- settings / upload ----------------------------------------------------
  function openSettings(): void {
    openMetadataDialog(data.id, manifest, docs, {
      onChanged: () => {
        titleBtn.textContent = manifest.name || "(untitled)";
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
    return {
      orientation,
      scroll,
      zoom,
      bpm: bpm(),
      offset: editorMeta.offset_sec,
      tempoSegments: tempo().segments,
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
        tool === "slide" && gesture.type === "none" && activeSlide
          ? { t: activeSlide.lastT, lane: activeSlide.lastLane }
          : null,
      activeSlideEditId:
        gesture.type === "place-slide" ? gesture.note.id : tool === "slide" && activeSlide ? activeSlide.lastId : null,
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

      // Clicking a slide chain tail that's already open for editing lets you drag it
      // into a hold, or click again (no drag) to close it. Once it becomes a hold it
      // can't reopen — the chain is done, matching the server's "a hold ends the run".
      // An eligible tail that ISN'T open yet falls through to the normal move gesture
      // below instead — a drag just repositions it like any other note; only a plain
      // click with no net movement opens it (handled in finishGesture).
      if (eligibleTail && activeSlide && activeSlide.lastId === hit.note.id) {
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
      const slideId = activeSlide ? activeSlide.slideId : allocateSlideId();
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
        }
        requestDraw();
        return;
      }
      case "move": {
        if (!info || info.kind !== "lanes") return;
        if (gesture.resizeNote) {
          const n = gesture.resizeNote;
          n.dur = Math.max(localStepSec(n.t), snapTime(info.t) - n.t);
        } else {
          // Move by an INTEGER number of grid divisions, counted in BEATS (via the tempo
          // map) rather than raw seconds — that stays correct across a BPM change instead
          // of assuming one constant step song-wide. On-grid notes are re-derived from the
          // grid formula (stays bit-exact), off-grid notes (BPM-mismatched imports) shift
          // by the same number of divisions instead of being quantized to the wrong grid.
          const tm = tempo();
          const rawDt = info.t - gesture.startT;
          const hasGrid = bpm() > 0;
          const kd = hasGrid ? Math.round((tm.beatAt(info.t) - tm.beatAt(gesture.startT)) * snap) : 0;
          // clamp the lane delta so the WHOLE selection stays in 1..9 —
          // per-note clamping compresses lanes and stacks notes
          const dl = Math.max(
            1 - gesture.minLane,
            Math.min(9 - gesture.maxLane, info.lane - gesture.startLane),
          );
          for (const n of d.notes) {
            const o = gesture.orig.get(n.id);
            if (!o) continue;
            if (hasGrid) {
              const onGrid = snapTime(o.t) === o.t;
              if (onGrid) {
                const beatK = Math.round(tm.beatAt(o.t) * snap) + kd;
                n.t = round6(Math.max(0, tm.timeAt(beatK / snap)));
              } else {
                n.t = round6(Math.max(0, tm.timeAt(tm.beatAt(o.t) + kd / snap)));
              }
            } else {
              n.t = round6(Math.max(0, o.t + rawDt));
            }
            n.lane = o.lane + dl;
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
          activeSlide = {
            slideId: gesture.slideId,
            lastId: gesture.note.id,
            lastT: gesture.note.t,
            lastLane: gesture.note.lane,
          };
        }
        break;
      }
      case "move": {
        if (!gesture.resizeNote) d.resolveCollisions(new Set(gesture.orig.keys()));
        d.commit(gesture.pre);
        if (gesture.slideTogglePending) {
          const [[id, orig]] = gesture.orig;
          const n = d.byId(id);
          if (n && n.t === orig.t && n.lane === orig.lane) {
            // a plain click, no drag — open the chain for editing instead of no-op'ing
            activeSlide = { slideId: n.slideId!, lastId: n.id, lastT: n.t, lastLane: n.lane };
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
    if (ctrl && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      const sel = d.selectedNotes();
      if (!sel.length) return;
      const base = Math.min(...sel.map((n) => n.t));
      clipboard = sel.map((n) => ({ dt: n.t - base, lane: n.lane, kind: n.kind, dur: n.dur, slideId: n.slideId }));
      if (e.key.toLowerCase() === "x") d.edit(() => d.remove([...d.selection]));
      toast(`${clipboard.length} note${clipboard.length > 1 ? "s" : ""} ${e.key === "x" ? "cut" : "copied"}`);
      return;
    }
    if (ctrl && e.key.toLowerCase() === "v") {
      if (!clipboard.length) return;
      const base = snapTime(player.time);
      // Distinct source chains get fresh ids so pasted copies don't merge into the originals.
      const slideIdMap = new Map<number, number>();
      d.edit(() => {
        d.selection.clear();
        for (const c of clipboard) {
          // Keep each note's original offset from the first copied note as-is, rather
          // than re-snapping to the CURRENT snap setting — that would distort spacing
          // for a selection that mixes notes placed under different snap divisions
          // (e.g. triplets alongside quarter notes). round6 alone keeps notes that were
          // simultaneous in the source staying bit-identical after paste.
          const t = round6(Math.max(0, base + c.dt));
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
          const n = d.place(t, lane, c.kind, c.dur, slideId);
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
      case "Delete":
      case "Backspace":
        if (d.selection.size) d.edit(() => d.remove([...d.selection]));
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
        requestDraw();
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        player.seek(snapTime(player.time - localStepSec(player.time) * 1.001));
        requestDraw();
        break;
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        player.seek(snapTime(player.time + localStepSec(player.time) * 1.001));
        requestDraw();
        break;
    }
  }
  window.addEventListener("keydown", onKey);

  // --- render loop ------------------------------------------------------------
  function requestDraw(): void {
    needsDraw = true;
  }

  function frame(): void {
    if (disposed) return;
    if (player.playing) {
      needsDraw = true;
      // keep the playhead in view
      const span = renderer.timeSpan(viewState());
      const cur = player.displayTime;
      if ((cur > scroll + span * 0.75 || cur < scroll) && gesture.type === "none") {
        scroll = cur - span * 0.25;
      }
      timeDisplay.textContent = `${fmtTime(cur)} / ${fmtTime(player.duration)}`;
    }
    if (needsDraw) {
      needsDraw = false;
      renderer.draw(viewState());
    }
    requestAnimationFrame(frame);
  }

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
    requestDraw();
  });
  resizeObserver.observe(canvasWrap);

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
  const root = el("div", { class: "view editor-view" }, toolbar, canvasWrap, statusbar);

  renderTabs();
  updateStatus();
  requestAnimationFrame(() => {
    renderer.resize();
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
      player.dispose();
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (saveState !== "saved") await doSave();
    },
  };
}

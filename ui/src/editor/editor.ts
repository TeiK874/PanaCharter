import * as api from "../api.js";
import { attempt, confirmDialog, el, fmtTime, openDialog, pickFile, toast } from "../dom.js";
import type { ProjectData, SifNote } from "../types.js";
import { DIFFICULTIES } from "../types.js";
import { Player } from "./audio.js";
import { ChartDoc } from "./chart.js";
import type { Note, NoteKind } from "./chart.js";
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
      type: "move";
      pre: string;
      startT: number;
      startLane: number;
      orig: Map<number, { t: number; lane: number }>;
      minLane: number;
      maxLane: number;
      part: "head" | "tail";
      resizeNote: Note | null;
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
  let clipboard: { dt: number; lane: number; kind: NoteKind; dur: number }[] = [];

  const player = new Player();
  await player.init();

  const bpm = () => manifest.bpm ?? 120;
  const gridStep = () => 60 / Math.max(1, bpm()) / snap;

  const fallbackDuration = () => {
    let last = 60;
    for (const d of docs.values()) for (const n of d.notes) last = Math.max(last, n.t + n.dur + 10);
    return last;
  };
  const duration = () => (player.loaded ? player.duration : fallbackDuration());

  function snapTime(t: number): number {
    const clamped = Math.max(0, t);
    if (bpm() <= 0) return clamped;
    const step = gridStep();
    const k = Math.round((clamped - editorMeta.offset_sec) / step);
    return Math.max(0, editorMeta.offset_sec + k * step);
  }

  function syncTicks(): void {
    const times: number[] = [];
    for (const n of doc().notes) {
      times.push(n.t);
      if (n.kind === "hold") times.push(n.t + n.dur);
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

  const offsetInput = el("input", {
    type: "number",
    step: "0.001",
    value: String(editorMeta.offset_sec),
    title: "Grid offset: time of beat 1 in seconds",
    oninput: () => {
      const v = Number(offsetInput.value);
      if (Number.isFinite(v)) {
        editorMeta.offset_sec = v;
        markDirty();
        requestDraw();
      }
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
    ),
    el("div", { class: "group" }, playBtn, rateSelect, tickBtn, timeDisplay),
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
      ["1–4", "Select / Tap / Hold / Star tool"],
      ["Click", "Place note (drag for hold length)"],
      ["Drag note", "Move · drag a hold's tail to resize"],
      ["Right-click", "Delete note"],
      ["Shift+click", "Add to selection"],
      ["Del", "Delete selection"],
      ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
      ["Ctrl+C / X / V", "Copy / cut / paste at playhead"],
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
    d.edit(() => {
      d.notes.length = 0;
      d.selection.clear();
      for (const n of result.notes) {
        const kind = n.effect === 3 && n.effect_value > 0 ? "hold" : n.effect === 4 ? "star" : "tap";
        d.place(n.timing_sec, n.position, kind, kind === "hold" ? n.effect_value : 0);
      }
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
      snap,
      duration: duration(),
      notes: doc().notes,
      selection: doc().selection,
      cursor: player.displayTime,
      peaks: player.peaks,
      peaksPerSec: player.peaksPerSec,
      ghost,
      pendingHold:
        gesture.type === "place-hold"
          ? { t: gesture.note.t, lane: gesture.note.lane, dur: gesture.note.dur }
          : null,
      box: gesture.type === "box" ? gesture : null,
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
        d.edit(() => {
          d.remove(d.selection.has(hit.note.id) ? [...d.selection] : [hit.note.id]);
        });
      }
      return;
    }
    if (e.button !== 0) return;

    if (hit) {
      if (e.shiftKey) {
        if (d.selection.has(hit.note.id)) d.selection.delete(hit.note.id);
        else d.selection.add(hit.note.id);
        requestDraw();
        updateStatus();
        return;
      }
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
      case "move": {
        if (!info || info.kind !== "lanes") return;
        if (gesture.resizeNote) {
          const n = gesture.resizeNote;
          n.dur = Math.max(gridStep(), snapTime(info.t) - n.t);
        } else {
          // Move by an INTEGER number of grid steps so relative rhythm is
          // preserved: on-grid notes are re-derived from the grid formula
          // (stays bit-exact), off-grid notes (BPM-change imports) shift by
          // the same delta instead of being quantized to the wrong grid.
          const rawDt = info.t - gesture.startT;
          const step = bpm() > 0 ? gridStep() : 0;
          const kd = step > 0 ? Math.round(rawDt / step) : 0;
          // clamp the lane delta so the WHOLE selection stays in 1..9 —
          // per-note clamping compresses lanes and stacks notes
          const dl = Math.max(
            1 - gesture.minLane,
            Math.min(9 - gesture.maxLane, info.lane - gesture.startLane),
          );
          for (const n of d.notes) {
            const o = gesture.orig.get(n.id);
            if (!o) continue;
            if (step > 0) {
              const onGrid = snapTime(o.t) === o.t;
              if (onGrid) {
                const k = Math.round((o.t - editorMeta.offset_sec) / step) + kd;
                n.t = Math.max(0, editorMeta.offset_sec + k * step);
              } else {
                n.t = Math.max(0, o.t + kd * step);
              }
            } else {
              n.t = Math.max(0, o.t + rawDt);
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
        if (gesture.note.dur <= 0) gesture.note.dur = gridStep();
        d.selection.clear();
        d.selection.add(gesture.note.id);
        d.commit(gesture.pre);
        break;
      }
      case "move": {
        if (!gesture.resizeNote) d.resolveCollisions(new Set(gesture.orig.keys()));
        d.commit(gesture.pre);
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
      e.shiftKey ? d.redo() : d.undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "y") {
      e.preventDefault();
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
      clipboard = sel.map((n) => ({ dt: n.t - base, lane: n.lane, kind: n.kind, dur: n.dur }));
      if (e.key.toLowerCase() === "x") d.edit(() => d.remove([...d.selection]));
      toast(`${clipboard.length} note${clipboard.length > 1 ? "s" : ""} ${e.key === "x" ? "cut" : "copied"}`);
      return;
    }
    if (ctrl && e.key.toLowerCase() === "v") {
      if (!clipboard.length) return;
      const base = snapTime(player.time);
      d.edit(() => {
        d.selection.clear();
        for (const c of clipboard) {
          // re-derive from the grid formula so pasted notes stay bit-exact
          // with freshly placed ones (exact f64 equality = in-game sync)
          const t = bpm() > 0 ? snapTime(base + c.dt) : base + c.dt;
          const n = d.place(t, c.lane, c.kind, c.dur);
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
      case "Delete":
      case "Backspace":
        if (d.selection.size) d.edit(() => d.remove([...d.selection]));
        break;
      case "Escape":
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
        player.seek(snapTime(player.time - gridStep() * 1.001));
        requestDraw();
        break;
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        player.seek(snapTime(player.time + gridStep() * 1.001));
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

// Batch import of Bandori songs from game asset bundles.
//
// The user multi-selects any mix of musicscoreNN / bgmNNN / musicjacketNN
// bundles; the backend groups them per song; charts are converted with the
// same verified .note converter the single-chart importer uses.

import * as api from "../api.js";
import { el, openDialog, pickDirFiles, pickFiles, toast } from "../dom.js";
import { importChart } from "../convert/index.js";
import type { SifNote } from "../types.js";

/** Files in a Bandori assets tree that are worth scanning. */
const BUNDLE_NAME = /^(musicscore|musicjacket|bgm)\d+$/;

/** bandori difficulty → ew chart level (special/command are not importable). */
const DIFF_LEVEL: [string, number][] = [
  ["easy", 1],
  ["normal", 2],
  ["hard", 3],
  ["expert", 4],
];

interface Row {
  entry: api.BandoriSongEntry;
  checked: boolean;
  title: string | null;
  band: string | null;
  status: string;
}

export function openBandoriBatchDialog(onDone: () => void): void {
  const sessionId = crypto.randomUUID();
  let rows: Row[] = [];
  let busy = false;

  const statusLine = el("p", { class: "dialog-body", text: "No bundles scanned yet." });
  const table = el("div", {});
  const importBtn = el("button", {
    class: "btn btn-primary",
    text: "Import selected",
    disabled: true,
    onclick: () => void doImport(),
  });
  const addBtn = el("button", {
    class: "btn",
    text: "Add bundle files…",
    onclick: () => void addBundles(),
  });
  const addDirBtn = el("button", {
    class: "btn",
    text: "Add folder…",
    title: "Scan a folder (e.g. the assets Android/ tree) — musicscore/bgm/musicjacket bundles are auto-detected by name",
    onclick: () => void addFolder(),
  });

  function renderTable(): void {
    table.replaceChildren();
    if (!rows.length) return;
    for (const row of rows) {
      const importable = row.entry.difficulties.some((d) =>
        DIFF_LEVEL.some(([name]) => name === d),
      );
      const checkbox = el("input", {
        type: "checkbox",
        checked: row.checked && importable,
        disabled: !importable || busy,
        onchange: () => {
          row.checked = checkbox.checked;
        },
      });
      const diffs = row.entry.difficulties
        .filter((d) => DIFF_LEVEL.some(([n]) => n === d))
        .join(" ");
      table.append(
        el(
          "div",
          { class: "row", style: "gap:8px;padding:3px 0;border-bottom:1px solid var(--line)" },
          checkbox,
          el(
            "span",
            { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
            el("strong", { text: row.title ?? row.entry.stem }),
            row.band ? ` — ${row.band}` : "",
          ),
          el("span", { class: "chip", text: diffs || "no charts" }),
          el("span", {
            class: "chip",
            text: row.entry.has_audio ? "♫ audio" : "no audio",
            style: row.entry.has_audio ? "color:var(--green)" : "",
          }),
          el("span", {
            class: "chip",
            text: row.entry.has_jacket ? "🖼 jacket" : "no jacket",
            style: row.entry.has_jacket ? "color:var(--green)" : "",
          }),
          el("span", { class: "mini-label", text: row.status }),
        ),
      );
    }
  }

  function applyCatalog(catalog: api.BandoriCatalog): void {
    const old = new Map(rows.map((r) => [r.entry.stem, r]));
    rows = catalog.songs.map((entry) => {
      const prev = old.get(entry.stem);
      return {
        entry,
        checked: prev?.checked ?? true,
        title: prev?.title ?? null,
        band: prev?.band ?? null,
        status: prev?.status ?? "",
      };
    });
    importBtn.disabled = !rows.length || busy;
  }

  async function scanAll(
    files: { name: string; read: () => Promise<ArrayBuffer> }[],
    quietErrors: boolean,
  ): Promise<void> {
    busy = true;
    addBtn.disabled = true;
    addDirBtn.disabled = true;
    let done = 0;
    let skipped = 0;
    for (const file of files) {
      statusLine.textContent = `Scanning ${file.name} (${++done}/${files.length})…`;
      try {
        applyCatalog(await api.bandoriScan(sessionId, await file.read()));
      } catch (e) {
        // un-pulled LFS pointer stubs and stray files land here
        if (quietErrors) skipped++;
        else toast(`${file.name}: ${e}`, "error");
      }
      renderTable();
    }
    busy = false;
    addBtn.disabled = false;
    addDirBtn.disabled = false;
    importBtn.disabled = !rows.length;
    const skipNote = skipped ? ` (${skipped} files skipped — not usable bundles)` : "";
    statusLine.textContent = `${rows.length} songs found${skipNote}. Fetching titles from bestdori…`;
    try {
      const meta = await api.bandoriMeta(sessionId);
      for (const row of rows) {
        const m = meta[row.entry.stem];
        if (m) {
          row.title = m.title;
          row.band = m.band;
        }
      }
      statusLine.textContent = `${rows.length} songs found${skipNote}.`;
    } catch (e) {
      statusLine.textContent = `${rows.length} songs found${skipNote} (bestdori titles unavailable: ${e})`;
    }
    renderTable();
  }

  async function addBundles(): Promise<void> {
    const files = await pickFiles(".bundle,.unity3d,*");
    if (!files.length) return;
    await scanAll(
      files.map((f) => ({ name: f.name, read: () => Promise.resolve(f.bytes) })),
      false,
    );
  }

  async function addFolder(): Promise<void> {
    const all = await pickDirFiles();
    if (!all.length) return;
    const matches = all.filter((f) => BUNDLE_NAME.test(f.name));
    if (!matches.length) {
      toast("No musicscore/bgm/musicjacket bundles found in that folder", "error");
      return;
    }
    statusLine.textContent = `Found ${matches.length} bundles in the folder (of ${all.length} files).`;
    await scanAll(matches, true);
  }

  async function doImport(): Promise<void> {
    const picked = rows.filter((r) => r.checked);
    if (!picked.length) return;
    busy = true;
    importBtn.disabled = true;
    addBtn.disabled = true;
    let ok = 0;
    for (const row of picked) {
      row.status = "importing…";
      renderTable();
      try {
        const charts: Record<number, SifNote[]> = {};
        const levels: Record<number, number> = {};
        let bpm: number | null = null;
        let warnings = 0;
        for (const [diff, level] of DIFF_LEVEL) {
          if (!row.entry.difficulties.includes(diff)) continue;
          const text = await api.bandoriChart(sessionId, row.entry.stem, diff);
          const converted = importChart(text);
          charts[level] = converted.notes;
          warnings += converted.warnings.length;
          if (converted.bpm && !bpm) bpm = converted.bpm;
          const playLevel = text.match(/^#PLAYLEVEL\s+(\d+)/m);
          levels[level] = Math.max(1, Math.min(20, Number(playLevel?.[1]) || 3 * level));
        }
        if (!Object.keys(charts).length) throw "no importable difficulties";
        const result = await api.bandoriImportSong(
          sessionId,
          row.entry.stem,
          row.title ?? row.entry.stem,
          row.band ?? "BanG Dream!",
          bpm,
          levels,
          charts,
        );
        row.status = `✓ audio: ${result.audio}${warnings ? ` · ${warnings} chart warnings` : ""}`;
        row.checked = false;
        ok++;
      } catch (e) {
        row.status = `✕ ${e}`;
      }
      renderTable();
    }
    busy = false;
    addBtn.disabled = false;
    importBtn.disabled = false;
    statusLine.textContent = `Imported ${ok}/${picked.length} songs into Projects.`;
    toast(`Imported ${ok} Bandori song${ok === 1 ? "" : "s"}`, "ok");
    onDone();
  }

  const dlg = openDialog(
    "Batch import Bandori songs",
    el("p", {
      class: "dialog-body",
      text: "Point this at the Bandori assets — pick a folder (bundles are auto-detected by name: musicscoreNN charts, bgmNNN audio, musicjacketNN art) or individual files. Songs are matched across bundles automatically; add more at any point before importing.",
    }),
    el("div", { class: "row", style: "margin:10px 0" }, addDirBtn, addBtn, importBtn),
    statusLine,
    el("div", { style: "max-height:45vh;overflow:auto" }, table),
  );
  dlg.root.addEventListener("close", () => void api.bandoriClose(sessionId).catch(() => {}));
}

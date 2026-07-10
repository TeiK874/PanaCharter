import * as api from "../api.js";
import { attempt, confirmDialog, el, openDialog, pickFile, toast } from "../dom.js";
import type { CatalogSong, ProjectSummary } from "../types.js";
import { ATTRIBUTES, DIFFICULTIES } from "../types.js";
import { openBandoriBatchDialog } from "./bandori.js";

/** Wrap an async button action so re-clicks are ignored while it runs. */
function oneShot(fn: (btn: HTMLButtonElement) => Promise<void>): (e: Event) => void {
  return (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true;
    void fn(btn).finally(() => {
      btn.disabled = false;
    });
  };
}

export interface LibraryCtx {
  openEditor: (projectId: string) => void;
}

type TabName = "local" | "mine" | "browse";

export async function createLibraryView(ctx: LibraryCtx): Promise<{ root: HTMLElement; dispose: () => void }> {
  const blobUrls: string[] = [];
  function blobUrl(bytes: ArrayBuffer): string {
    const url = URL.createObjectURL(new Blob([bytes]));
    blobUrls.push(url);
    return url;
  }

  const content = el("div", {});
  let activeTab: TabName = "local";
  let renderGen = 0;

  const tabs: Record<TabName, HTMLButtonElement> = {
    local: el("button", { class: "tab", text: "Projects", onclick: () => switchTab("local") }),
    mine: el("button", { class: "tab", text: "My uploads", onclick: () => switchTab("mine") }),
    browse: el("button", { class: "tab", text: "Browse server", onclick: () => switchTab("browse") }),
  };

  function switchTab(tab: TabName): void {
    activeTab = tab;
    for (const [name, btn] of Object.entries(tabs)) {
      btn.classList.toggle("active", name === tab);
    }
    void renderTab();
  }

  async function renderTab(): Promise<void> {
    const gen = ++renderGen; // a newer render (tab switch) wins
    content.replaceChildren(el("p", { class: "empty-note", text: "Loading…" }));
    let rendered: HTMLElement;
    try {
      if (activeTab === "local") rendered = await renderLocal();
      else if (activeTab === "mine") rendered = await renderMine();
      else rendered = await renderBrowse();
    } catch (e) {
      let message = String(e);
      if (message.includes("Not connected to a server")) {
        message = "Connect to a server first — click the server button in the top right.";
      }
      rendered = el("p", { class: "empty-note", text: message });
    }
    if (gen === renderGen) content.replaceChildren(rendered);
  }

  function jacketEl(load: () => Promise<ArrayBuffer>): HTMLElement {
    const holder = el("div", { class: "jacket", text: "♪" });
    void load()
      .then((bytes) => {
        const img = el("img", { class: "jacket", alt: "" }) as HTMLImageElement;
        img.src = blobUrl(bytes);
        holder.replaceWith(img);
      })
      .catch(() => {});
    return holder;
  }

  function attrChip(attribute: number): HTMLElement {
    return el("span", {
      class: `chip attr-${attribute}`,
      text: ATTRIBUTES[attribute] ?? `attr ${attribute}`,
    });
  }

  // --- Projects (local) -----------------------------------------------------

  async function renderLocal(): Promise<HTMLElement> {
    const projects = await api.projectList();
    const grid = el("div", { class: "card-grid" });

    for (const p of projects) {
      grid.append(projectCard(p));
    }

    const newBtn = el("button", {
      class: "btn btn-primary",
      text: "New project",
      onclick: () => newProjectDialog(),
    });
    const importBtn = el("button", {
      class: "btn",
      text: "Import package (.zip)",
      onclick: () =>
        void attempt(async () => {
          const file = await pickFile(".zip,application/zip");
          if (!file) return;
          const summary = await api.projectImportZip(file.bytes);
          toast(`Imported "${summary.name}"`, "ok");
          await renderTab();
        }),
    });
    const bandoriBtn = el("button", {
      class: "btn",
      text: "Batch import Bandori…",
      title: "Import whole songs (charts + audio + jackets) from Bandori asset bundles",
      onclick: () => openBandoriBatchDialog(() => void renderTab()),
    });

    return el(
      "div",
      {},
      el("div", { class: "row", style: "margin-bottom:14px" }, newBtn, importBtn, bandoriBtn),
      projects.length
        ? grid
        : el("p", {
            class: "empty-note",
            text: "No projects yet. Create one, import a package, or download a song from the server tabs.",
          }),
    );
  }

  function projectCard(p: ProjectSummary): HTMLElement {
    return el(
      "div",
      { class: "song-card" },
      jacketEl(() => api.projectGetJacket(p.id)),
      el(
        "div",
        { class: "info" },
        el("div", { class: "title", text: p.name || "(untitled)" }),
        el("div", { class: "artist", text: p.artist }),
        el(
          "div",
          { class: "meta-row" },
          attrChip(p.attribute),
          ...p.levels.map((lvl) =>
            el("span", { class: `diff-chip diff-${lvl}`, text: DIFFICULTIES[lvl].short }),
          ),
          !p.has_audio && el("span", { class: "chip", text: "no audio" }),
        ),
        el(
          "div",
          { class: "actions" },
          el("button", { class: "btn btn-primary", text: "Open", onclick: () => ctx.openEditor(p.id) }),
          el("button", {
            class: "btn",
            text: "Export",
            title: "Write a server-compatible package zip",
            onclick: () =>
              void attempt(async () => {
                const path = await api.projectExport(p.id);
                toast(`Exported to ${path}`, "ok");
              }),
          }),
          el("button", {
            class: "btn btn-danger",
            text: "Delete",
            onclick: async () => {
              if (!(await confirmDialog(`Delete the local project "${p.name}"? Uploaded copies on servers are not affected.`))) return;
              await attempt(() => api.projectDelete(p.id));
              await renderTab();
            },
          }),
        ),
      ),
    );
  }

  function newProjectDialog(): void {
    const nameInput = el("input", { type: "text", placeholder: "Song title" });
    const artistInput = el("input", { type: "text", placeholder: "Artist" });
    const dlg = openDialog(
      "New project",
      el(
        "div",
        { class: "form-grid" },
        el("label", { class: "field span2" }, "Title", nameInput),
        el("label", { class: "field span2" }, "Artist", artistInput),
      ),
      el(
        "div",
        { class: "dialog-actions" },
        el("button", {
          class: "btn btn-primary",
          text: "Create & open",
          onclick: oneShot(async () => {
            await attempt(async () => {
              if (!nameInput.value.trim() || !artistInput.value.trim()) {
                toast("Title and artist are required (the server insists too)", "error");
                return;
              }
              const summary = await api.projectCreate(nameInput.value.trim(), artistInput.value.trim());
              dlg.close();
              ctx.openEditor(summary.id);
            });
          }),
        }),
      ),
    );
    nameInput.focus();
  }

  // --- My uploads -------------------------------------------------------------

  async function renderMine(): Promise<HTMLElement> {
    const session = await api.sessionInfo();
    if (!session.logged_in) {
      return el("p", {
        class: "empty-note",
        text: "Log in (server button, top right) to manage your uploaded songs.",
      });
    }
    const songs = await api.listMine();
    if (!songs.length) {
      return el("p", { class: "empty-note", text: "You haven't uploaded any songs to this server yet." });
    }
    const grid = el("div", { class: "card-grid" });
    for (const song of songs) grid.append(mineCard(song));
    return grid;
  }

  function mineCard(song: CatalogSong): HTMLElement {
    const visSelect = el(
      "select",
      {},
      el("option", { value: "public", text: "public" }),
      el("option", { value: "private", text: "private" }),
      el("option", { value: "shared", text: "shared" }),
    );
    visSelect.value = song.visibility ?? "public";
    const sharedInput = el("input", {
      type: "text",
      placeholder: "shared user IDs",
      value: (song.shared_with ?? []).join(", "),
      style: "width:150px",
    });
    const dlDisabled = el("input", {
      type: "checkbox",
      checked: song.downloads_disabled ?? false,
      title: "Disable package downloads for others",
    });

    return el(
      "div",
      { class: "song-card" },
      jacketEl(() => api.fetchJacket(song.music_id)),
      el(
        "div",
        { class: "info" },
        el("div", { class: "title", text: song.name }),
        el("div", { class: "artist", text: song.artist }),
        el(
          "div",
          { class: "meta-row" },
          el("span", { class: "chip id", text: `#${song.music_id}` }),
          attrChip(song.attribute),
          ...song.levels.map((l) =>
            el("span", {
              class: `diff-chip diff-${l.level}`,
              text: `${DIFFICULTIES[l.level].short} ${l.level_number}★`,
            }),
          ),
        ),
        el(
          "div",
          { class: "meta-row" },
          visSelect,
          sharedInput,
          el("label", { class: "row", style: "gap:4px;font-size:12px;color:var(--muted)" }, dlDisabled, "no downloads"),
          el("button", {
            class: "btn",
            text: "Apply",
            onclick: () =>
              void attempt(async () => {
                const parts = sharedInput.value.split(/[\s,]+/).filter(Boolean);
                if (parts.some((p) => !/^\d{1,15}$/.test(p))) {
                  throw "Shared list must be numeric user IDs (up to 15 digits)";
                }
                const ids = parts.map(Number);
                await api.setVisibility(
                  song.music_id,
                  visSelect.value,
                  visSelect.value === "shared" ? ids : [],
                  dlDisabled.checked,
                );
                toast("Visibility updated", "ok");
              }),
          }),
        ),
        el(
          "div",
          { class: "actions" },
          el("button", {
            class: "btn",
            text: "Download to projects",
            title: "Fetch the original chart/audio/jacket into a local project",
            onclick: oneShot(async () => {
              await attempt(async () => {
                const summary = await api.downloadSongToProject(song.music_id);
                toast(`Downloaded into local project "${summary.name}"`, "ok");
              });
            }),
          }),
          el("button", {
            class: "btn btn-danger",
            text: "Delete from server",
            onclick: async () => {
              if (
                !(await confirmDialog(
                  `Delete "${song.name}" (#${song.music_id}) from the server? Players lose access and its id is never reused.`,
                ))
              )
                return;
              await attempt(() => api.deleteSong(song.music_id));
              await renderTab();
            },
          }),
        ),
      ),
    );
  }

  // --- Browse -------------------------------------------------------------------

  async function renderBrowse(): Promise<HTMLElement> {
    const songs = await api.browseSongs();
    if (!songs.length) {
      return el("p", { class: "empty-note", text: "No songs visible on this server yet." });
    }
    const grid = el("div", { class: "card-grid" });
    for (const song of songs) {
      grid.append(
        el(
          "div",
          { class: "song-card" },
          jacketEl(() => api.fetchJacket(song.music_id)),
          el(
            "div",
            { class: "info" },
            el("div", { class: "title", text: song.name }),
            el("div", { class: "artist", text: `${song.artist} — uploaded by ${song.uploader ?? "?"}` }),
            el(
              "div",
              { class: "meta-row" },
              el("span", { class: "chip id", text: `#${song.music_id}` }),
              attrChip(song.attribute),
              ...song.levels.map((l) =>
                el("span", {
                  class: `diff-chip diff-${l.level}`,
                  text: `${DIFFICULTIES[l.level].short} ${l.level_number}★`,
                }),
              ),
              song.mine && el("span", { class: "chip", text: "mine" }),
            ),
            el(
              "div",
              { class: "actions" },
              el("button", {
                class: "btn",
                text:
                  song.downloads_disabled && !song.mine
                    ? "Downloads disabled"
                    : "Download to projects",
                disabled: song.downloads_disabled && !song.mine,
                onclick: oneShot(async () => {
                  await attempt(async () => {
                    const summary = await api.downloadSongToProject(song.music_id);
                    toast(`Downloaded into local project "${summary.name}" — see Projects`, "ok");
                  });
                }),
              }),
            ),
          ),
        ),
      );
    }
    return grid;
  }

  const root = el(
    "div",
    { class: "view" },
    el("div", { class: "view-tabs" }, tabs.local, tabs.mine, tabs.browse),
    content,
  );
  switchTab("local");

  return {
    root,
    dispose() {
      for (const url of blobUrls) URL.revokeObjectURL(url);
    },
  };
}

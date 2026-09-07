import * as api from "../api.js";
import { el, openDialog, toast } from "../dom.js";
import type { LastUpload } from "../types.js";

/** Parse "123, 456 789" → [123, 456, 789]; returns null on garbage. */
function parseUserIds(raw: string): number[] | null {
  const ids: number[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    if (!part) continue;
    if (!/^\d{1,15}$/.test(part)) return null;
    ids.push(Number(part));
  }
  return ids;
}

export function openUploadDialog(
  projectId: string,
  songName: string,
  lastUpload: LastUpload | null,
  onUploaded?: (lu: LastUpload) => void,
): void {
  let mode: "new" | "update" = "new";

  // --- mode choice (shown when this project already lives on the current server)
  const modeRow = el("div", { class: "row wrap", style: "display:none;gap:14px" });
  const newSongFields = el("div", {});

  function setMode(m: "new" | "update"): void {
    mode = m;
    newSongFields.style.display = m === "update" ? "none" : "";
    uploadBtn.textContent = m === "update" ? `Update #${lastUpload!.music_id}` : "Upload";
    for (const input of modeRow.querySelectorAll("input")) {
      input.checked = input.value === m;
    }
  }

  void api.sessionInfo().then((session) => {
    if (lastUpload && session.server && lastUpload.server === session.server) {
      const radio = (value: "new" | "update", label: string) =>
        el(
          "label",
          { class: "row", style: "gap:6px;font-size:13px;cursor:pointer" },
          el("input", { type: "radio", name: "upload-mode", value, onchange: () => setMode(value) }),
          label,
        );
      modeRow.append(
        radio("update", `Update #${lastUpload.music_id} — keeps the id, players keep their scores`),
        radio("new", "Upload as a new song"),
      );
      modeRow.style.display = "";
      setMode("update");
    }
  });

  // --- new-upload-only fields
  const visSelect = el(
    "select",
    { onchange: () => syncShared() },
    el("option", { value: "public", text: "Public — everyone on the server" }),
    el("option", { value: "private", text: "Private — only you" }),
    el("option", { value: "shared", text: "Shared — you + listed users" }),
  );
  const sharedInput = el("textarea", {
    placeholder: "User IDs, comma or space separated",
    disabled: true,
  });
  function syncShared(): void {
    sharedInput.disabled = visSelect.value !== "shared";
  }
  const dlDisabled = el("input", { type: "checkbox" });

  newSongFields.append(
    el(
      "div",
      { class: "form-grid" },
      el("label", { class: "field span2" }, "Visibility", visSelect),
      el("label", { class: "field span2" }, "Share with", sharedInput),
      el(
        "label",
        { class: "field span2", style: "flex-direction:row;align-items:center;gap:8px" },
        dlDisabled,
        "Disable package downloads (others can play the song but not export it)",
      ),
    ),
  );

  const status = el("p", { class: "dialog-body" });
  const uploadBtn = el("button", {
    class: "btn btn-primary",
    text: "Upload",
    onclick: () => void doUpload(),
  });

  async function doUpload(): Promise<void> {
    const session = await api.sessionInfo();
    if (!session.logged_in) {
      status.textContent = "Not logged in — open the server panel (top right) and log in first.";
      return;
    }
    // validate before locking the dialog, so a rejected form can't leave it stuck busy
    const shared = mode === "new" ? parseUserIds(sharedInput.value) : [];
    if (shared === null) {
      status.textContent = "The shared-with list contains something that isn't a user ID.";
      return;
    }
    if (mode === "new" && visSelect.value === "shared" && shared.length === 0) {
      status.textContent = "Shared visibility needs at least one numeric user ID.";
      return;
    }
    dlg.setBusy(true);
    uploadBtn.disabled = true;
    status.textContent = "Uploading… (the server transcodes audio, this can take a moment)";
    try {
      if (mode === "update") {
        const result = await api.updateSong(projectId, lastUpload!.music_id);
        if (result.last_upload) onUploaded?.(result.last_upload);
        toast(`"${songName}" updated (#${result.music_id})`, "ok");
      } else {
        const result = await api.uploadProject(
          projectId,
          visSelect.value,
          visSelect.value === "shared" ? shared : [],
          dlDisabled.checked,
        );
        if (result.last_upload) onUploaded?.(result.last_upload);
        toast(`"${songName}" uploaded as #${result.music_id}`, "ok");
      }
      dlg.close();
    } catch (e) {
      // the dialog can be gone by now — never write the error into a detached node
      if (dlg.root.isConnected) status.textContent = String(e);
      else toast(String(e), "error");
    } finally {
      dlg.setBusy(false);
      uploadBtn.disabled = false;
    }
  }

  const dlg = openDialog(
    `Upload "${songName}"`,
    modeRow,
    lastUpload
      ? el("p", {
          class: "dialog-body",
          text: `Previously uploaded to ${lastUpload.server} as #${lastUpload.music_id}.`,
        })
      : null,
    newSongFields,
    el("p", {
      class: "dialog-body",
      text: "Score targets and mission combos are computed by the server from your hardest difficulty.",
    }),
    status,
    el("div", { class: "dialog-actions" }, uploadBtn),
  );
}

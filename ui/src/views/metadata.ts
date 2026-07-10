import * as api from "../api.js";
import { attempt, el, openDialog, pickFile, toast } from "../dom.js";
import type { Manifest } from "../types.js";
import { ATTRIBUTES, BAND_CATEGORIES } from "../types.js";
import type { ChartDoc } from "../editor/chart.js";

export interface MetadataCallbacks {
  onChanged: () => void;
  onAudioChanged: () => void;
}

export function openMetadataDialog(
  projectId: string,
  manifest: Manifest,
  _docs: Map<number, ChartDoc>,
  cb: MetadataCallbacks,
): void {
  const text = (
    label: string,
    get: () => string,
    set: (v: string) => void,
    span2 = false,
    placeholder = "",
  ) => {
    const input = el("input", {
      type: "text",
      value: get(),
      placeholder,
      oninput: () => {
        set(input.value);
        cb.onChanged();
      },
    });
    return el("label", { class: `field ${span2 ? "span2" : ""}` }, label, input);
  };

  const num = (
    label: string,
    get: () => number | null,
    set: (v: number | null) => void,
    title = "",
  ) => {
    const input = el("input", {
      type: "number",
      step: "0.01",
      value: get() == null ? "" : String(get()),
      title,
      oninput: () => {
        const v = input.value.trim();
        set(v === "" ? null : Number(v));
        cb.onChanged();
      },
    });
    return el("label", { class: "field" }, label, input);
  };

  const attrSelect = el(
    "select",
    {
      onchange: () => {
        manifest.attribute = Number(attrSelect.value);
        cb.onChanged();
      },
    },
    ...Object.entries(ATTRIBUTES).map(([v, name]) =>
      el("option", { value: v, text: name }),
    ),
  );
  attrSelect.value = String(manifest.attribute);

  const bandSelect = el(
    "select",
    {
      onchange: () => {
        manifest.band_category = bandSelect.value;
        cb.onChanged();
      },
    },
    ...BAND_CATEGORIES.map((b) => el("option", { value: b, text: b })),
  );
  bandSelect.value = BAND_CATEGORIES.includes(manifest.band_category)
    ? manifest.band_category
    : "OTHER";

  // jacket preview (object URLs revoked on replace + dialog close)
  let jacketUrl: string | null = null;
  const setJacketUrl = (blob: Blob): string => {
    if (jacketUrl) URL.revokeObjectURL(jacketUrl);
    jacketUrl = URL.createObjectURL(blob);
    return jacketUrl;
  };
  const jacketImg = el("img", { class: "jacket", alt: "Jacket preview" }) as HTMLImageElement;
  const jacketFallback = el("div", { class: "jacket", text: "♪" });
  const jacketBox = el("div", {});
  jacketBox.append(jacketFallback);
  void attempt(async () => {
    const bytes = await api.projectGetJacket(projectId).catch(() => null);
    if (bytes) {
      jacketImg.src = setJacketUrl(new Blob([bytes]));
      jacketBox.replaceChildren(jacketImg);
    }
  });

  const dlg = openDialog(
    "Song settings",
    el(
      "div",
      { class: "form-grid" },
      text("Title *", () => manifest.name, (v) => (manifest.name = v)),
      text("Artist *", () => manifest.artist, (v) => (manifest.artist = v)),
      text("Title (English)", () => manifest.name_en, (v) => (manifest.name_en = v)),
      text("Artist (English)", () => manifest.artist_en, (v) => (manifest.artist_en = v)),
      text("Short title", () => manifest.short_name, (v) => (manifest.short_name = v)),
      text("Kana (sort key)", () => manifest.kana, (v) => (manifest.kana = v)),
      el("label", { class: "field" }, "Attribute", attrSelect),
      el("label", { class: "field" }, "Group", bandSelect),
      num(
        "Preview start (s)",
        () => manifest.preview_start_sec,
        (v) => (manifest.preview_start_sec = v),
        "Menu preview cut start. Empty = 30% into the track.",
      ),
      num(
        "Preview length (s)",
        () => manifest.preview_length_sec,
        (v) => (manifest.preview_length_sec = v),
        "Menu preview length. Empty = 30 s.",
      ),
      el(
        "div",
        { class: "span2 row" },
        jacketBox,
        el(
          "div",
          { class: "row wrap", style: "flex-direction:column;align-items:flex-start" },
          el("button", {
            class: "btn",
            text: "Set jacket (png / jpg)",
            onclick: () =>
              void attempt(async () => {
                const file = await pickFile("image/png,image/jpeg,.png,.jpg,.jpeg");
                if (!file) return;
                await api.projectSetJacket(projectId, file.bytes);
                jacketImg.src = setJacketUrl(new Blob([file.bytes]));
                jacketBox.replaceChildren(jacketImg);
                cb.onChanged();
                toast("Jacket set — the server crops it square at 512×512", "ok");
              }),
          }),
          el("button", {
            class: "btn",
            text: "Set audio (ogg / mp3 / wav)",
            onclick: () =>
              void attempt(async () => {
                const file = await pickFile("audio/*,.ogg,.mp3,.wav");
                if (!file) return;
                await api.projectSetAudio(projectId, file.bytes);
                cb.onAudioChanged();
                toast("Audio set", "ok");
              }),
          }),
        ),
      ),
    ),
    el("div", { class: "dialog-actions" }, el("button", { class: "btn btn-primary", text: "Done", onclick: () => dlg.close() })),
  );
  dlg.root.addEventListener("close", () => {
    if (jacketUrl) URL.revokeObjectURL(jacketUrl);
  });
}

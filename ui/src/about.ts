// The About dialog: version, where PanaCharter is distributed from, and credits.

import { el, openDialog, toast } from "./dom.js";
import { invoke } from "./tauri.js";

// The addresses the backend's open_url (src-tauri/src/open_url.rs) is willing to open —
// keep the two lists in step.
const REPO_URL = "https://github.com/TeiK874/PanaCharter";
const RELEASES_URL = "https://github.com/TeiK874/PanaCharter/releases";
const AUTHOR_URL = "https://git.ethanthesleepy.one/ethanaobrien";
const CHARTER_URL = "https://git.ethanthesleepy.one/ethanaobrien/charter";
const EW_URL = "https://git.ethanthesleepy.one/ethanaobrien/ew";

/** A link that opens in the user's default browser (never inside the app window). */
function link(url: string, text = url): HTMLElement {
  return el("a", {
    class: "about-link",
    href: url,
    text,
    title: url,
    onclick: (e: Event) => {
      e.preventDefault();
      invoke<void>("open_url", { url }).catch((err: unknown) => toast(String(err), "error"));
    },
  });
}

export async function openAbout(): Promise<void> {
  // The version baked into the executable (tauri.conf.json), so it can't drift from the build.
  const version = await invoke<string>("plugin:app|version").catch(() => null);
  openDialog(
    "About PanaCharter",
    el("p", { class: "about-name", text: version ? `PanaCharter ${version}` : "PanaCharter" }),
    el("p", {
      class: "dialog-body",
      text: "A desktop beatmap editor for SIF2 custom songs.",
    }),
    el("h3", { class: "about-head", text: "Download" }),
    el("p", { class: "dialog-body" }, link(RELEASES_URL)),
    el("h3", { class: "about-head", text: "Source code" }),
    el("p", { class: "dialog-body" }, link(REPO_URL)),
    el("hr", { class: "dialog-sep" }),
    el("h3", { class: "about-head", text: "Credits" }),
    el(
      "p",
      { class: "dialog-body" },
      "PanaCharter is based on ",
      link(CHARTER_URL, "Charter"),
      ", created by ",
      link(AUTHOR_URL, "ethanaobrien"),
      ", who also wrote the ",
      link(EW_URL, "ew"),
      " server it works with.",
    ),
  );
}

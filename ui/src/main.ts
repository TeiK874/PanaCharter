import * as api from "./api.js";
import { el, toast } from "./dom.js";
import { createConnectView } from "./views/connect.js";
import { createLibraryView } from "./views/library.js";
import { createEditor } from "./editor/editor.js";
import { getCurrentWindow } from "./tauri.js";

const app = document.getElementById("app")!;

type View = { root: HTMLElement; dispose?: () => void | Promise<void> };

let currentDispose: (() => void | Promise<void>) | null = null;
/** The outgoing view's in-flight dispose, shared so a navigation that arrives
 *  mid-dispose waits for it too instead of building its view on top of it. */
let disposing: Promise<void> | null = null;
let viewHost = el("div", { style: "display:contents" });
let mountEpoch = 0;

/** Dispose the current view, then build and show the next one. The old view
 *  goes first because its dispose has side effects the new one reads: the
 *  editor flushes its pending autosave there, and the library lists it. */
async function mount(create: () => Promise<View>): Promise<void> {
  // serialize rapid navigations: the newest mount wins, losers get disposed
  const epoch = ++mountEpoch;
  const old = currentDispose;
  currentDispose = null;
  if (old) {
    disposing = Promise.resolve()
      .then(old)
      .finally(() => {
        disposing = null;
      });
  }
  if (disposing) await disposing;
  if (epoch !== mountEpoch) return; // a newer mount raced past us
  // Clear any title the outgoing view set — a view that wants one (currently only the
  // editor) sets its own right back during create() below; one that doesn't (the
  // library, the connect screen) should leave the topbar without a stale song title.
  setTopbarTitle(null);
  let view: View;
  try {
    view = await create();
  } catch (e) {
    if (epoch !== mountEpoch) return; // superseded — the newer mount shows its own view
    viewHost.replaceChildren(); // the old view is already disposed; don't leave its dead DOM up
    throw e;
  }
  if (epoch !== mountEpoch) {
    // a newer mount raced past us — this view will never be shown
    await view.dispose?.();
    return;
  }
  currentDispose = view.dispose ?? null;
  viewHost.replaceChildren(view.root);
}

// --- top bar -----------------------------------------------------------------

const serverChip = el(
  "button",
  { class: "server-chip", title: "Server & login", onclick: () => void goConnect() },
  el("span", { class: "dot" }),
  el("span", { text: "no server" }),
);

async function refreshTopbar(): Promise<void> {
  const session = await api.sessionInfo();
  const dot = serverChip.querySelector(".dot")!;
  const label = serverChip.querySelector("span:last-child")!;
  dot.classList.toggle("on", session.logged_in);
  if (!session.server) {
    label.textContent = "connect to a server";
  } else {
    const host = session.server.replace(/^https?:\/\//, "");
    label.textContent = session.logged_in ? `${host} · ${session.uid}` : `${host} · not logged in`;
  }
}

// Set by the current view (currently only the editor) to show its own title right next
// to the wordmark, ahead of the spacer — so its position never moves regardless of the
// title's length, unlike when it lived inside the editor's own per-view toolbar.
const topbarTitleBtn = el("button", { class: "btn btn-ghost topbar-title" });
topbarTitleBtn.hidden = true;

function setTopbarTitle(text: string | null, onClick?: () => void, tooltip?: string): void {
  topbarTitleBtn.hidden = text === null;
  topbarTitleBtn.textContent = text ?? "";
  topbarTitleBtn.onclick = onClick ?? null;
  topbarTitleBtn.title = tooltip ?? "";
}

const topbar = el(
  "div",
  { class: "topbar" },
  el("span", { class: "wordmark" }, "PANACHARTER", el("span", { class: "note-glyph", text: " ♪" })),
  topbarTitleBtn,
  el("span", { class: "spacer" }),
  serverChip,
);

// --- routing -------------------------------------------------------------------

async function goLibrary(): Promise<void> {
  await mount(() =>
    createLibraryView({
      openEditor: (id) => void goEditor(id),
    }),
  );
}

async function goConnect(): Promise<void> {
  await mount(() =>
    createConnectView({
      onSession: refreshTopbar,
      goLibrary: () => void goLibrary(),
    }),
  );
}

async function goEditor(projectId: string): Promise<void> {
  try {
    await mount(() => createEditor(projectId, () => void goLibrary(), setTopbarTitle));
  } catch (e) {
    toast(String(e), "error");
    // the library was already disposed to make room for the editor — bring it back
    void goLibrary();
  }
}

// --- session expiry ---------------------------------------------------------------

let lastExpiryToast = 0;
window.addEventListener("charter-auth-expired", () => {
  void refreshTopbar();
  const now = Date.now();
  if (now - lastExpiryToast > 8000) {
    lastExpiryToast = now;
    toast("Your server session expired — log in again from the server panel (top right)", "error");
  }
});

// --- flush pending edits before the OS window closes -----------------------------
// The editor debounces autosave by ~1.2s (markDirty) and only flushes it early on
// in-app navigation, via the outgoing view's dispose() (see mount() above). Closing
// the WINDOW itself — the OS close button, Alt+F4, Cmd+Q — bypasses that entirely,
// so an edit made just before closing (a bulk fix like "Snap to grid" being the most
// noticeable case) could silently never reach disk. Intercept the close request,
// flush the current view the same way navigating away would, then force the window
// closed for real — a second request while already closing just goes through, since
// close() would otherwise re-raise this same event and recurse.
let closingForReal = false;
void getCurrentWindow().onCloseRequested(async (event) => {
  if (closingForReal) return;
  event.preventDefault();
  closingForReal = true;
  try {
    await currentDispose?.();
  } finally {
    await getCurrentWindow().destroy();
  }
});

// --- boot ------------------------------------------------------------------------

app.append(topbar, viewHost);

void (async () => {
  await refreshTopbar();
  const session = await api.sessionInfo();
  if (session.server) await goLibrary();
  else await goConnect();
  // A stored token may have died since last launch (24h expiry, single-session
  // kick). Probe once so the top bar tells the truth from the start.
  if (session.logged_in) {
    void api.listMine().catch(() => {});
  }
})();

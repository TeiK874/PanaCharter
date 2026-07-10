import * as api from "./api.js";
import { el, toast } from "./dom.js";
import { createConnectView } from "./views/connect.js";
import { createLibraryView } from "./views/library.js";
import { createEditor } from "./editor/editor.js";

const app = document.getElementById("app")!;

let currentDispose: (() => void | Promise<void>) | null = null;
let viewHost = el("div", { style: "display:contents" });
let mountEpoch = 0;

async function mount(view: { root: HTMLElement; dispose?: () => void | Promise<void> }): Promise<void> {
  // serialize rapid navigations: the newest mount wins, losers get disposed
  const epoch = ++mountEpoch;
  const old = currentDispose;
  currentDispose = null;
  if (old) await old();
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

const topbar = el(
  "div",
  { class: "topbar" },
  el("span", { class: "wordmark" }, "CHARTER", el("span", { class: "note-glyph", text: " ♪" })),
  el("span", { class: "spacer" }),
  serverChip,
);

// --- routing -------------------------------------------------------------------

async function goLibrary(): Promise<void> {
  await mount(
    await createLibraryView({
      openEditor: (id) => void goEditor(id),
    }),
  );
}

async function goConnect(): Promise<void> {
  await mount(
    await createConnectView({
      onSession: refreshTopbar,
      goLibrary: () => void goLibrary(),
    }),
  );
}

async function goEditor(projectId: string): Promise<void> {
  try {
    const editor = await createEditor(projectId, () => void goLibrary());
    await mount(editor);
  } catch (e) {
    toast(String(e), "error");
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

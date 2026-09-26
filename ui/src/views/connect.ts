import * as api from "../api.js";
import { el, toast } from "../dom.js";
import type { SessionInfo } from "../types.js";

export interface ConnectCtx {
  onSession: () => Promise<void>;
  goLibrary: () => void;
}

export async function createConnectView(ctx: ConnectCtx): Promise<{ root: HTMLElement }> {
  const session: SessionInfo = await api.sessionInfo();

  const serverInput = el("input", {
    type: "text",
    placeholder: "http://127.0.0.1:8080",
    value: session.server ?? "",
  });
  const serverStatus = el("div", { class: "status-line" });

  const uidInput = el("input", {
    type: "number",
    placeholder: "User ID (shown on the webui account page)",
    value: session.uid == null ? "" : String(session.uid),
  });
  const passInput = el("input", {
    type: "password",
    placeholder: "Transfer password (set in the game's settings)",
  });
  const loginStatus = el("div", { class: "status-line" });

  function setStatus(host: HTMLElement, ok: boolean | null, text: string): void {
    host.replaceChildren(
      el("span", {
        class: "dot",
        style: `width:8px;height:8px;border-radius:50%;background:${
          ok === null ? "var(--muted)" : ok ? "var(--green)" : "var(--danger)"
        }`,
      }),
      el("span", { text }),
    );
  }

  const logoutBtn = el("button", {
    class: "btn",
    text: "Log out",
    style: session.logged_in ? "" : "display:none",
    onclick: () =>
      void api.logout().then(async () => {
        loginStatus.replaceChildren();
        logoutBtn.style.display = "none";
        await ctx.onSession();
        toast("Logged out", "ok");
      }),
  });
  if (session.logged_in) {
    setStatus(loginStatus, true, `Logged in as ${session.uid}`);
  }

  // One in-flight flag for both actions: the buttons and Enter on the password
  // field all land here, and ew sessions are single-use — a second concurrent
  // login would kick the first one's token right after it was stored.
  let busy = false;
  function setBusy(b: boolean): void {
    busy = b;
    connectBtn.disabled = b;
    loginBtn.disabled = b;
  }

  const connectBtn = el("button", {
    class: "btn",
    text: "Connect",
    onclick: () => void doConnect(),
  });

  async function doConnect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await connect();
    } finally {
      setBusy(false);
    }
  }

  /** Connect to the server in the input. The caller holds the busy flag. */
  async function connect(): Promise<boolean> {
    setStatus(serverStatus, null, "Connecting…");
    try {
      const info = (await api.connect(serverInput.value)) as {
        data?: { custom_songs?: boolean };
        custom_songs?: boolean;
      };
      const enabled = info?.data?.custom_songs ?? info?.custom_songs ?? null;
      if (enabled === false) {
        setStatus(
          serverStatus,
          false,
          "Connected, but custom songs are DISABLED on this server (needs --enable-custom-songs).",
        );
      } else {
        setStatus(
          serverStatus,
          true,
          enabled === true
            ? "Connected — custom songs are enabled."
            : "Connected (couldn't read the custom-songs flag; uploads will tell).",
        );
      }
      await ctx.onSession();
      // switching servers drops the token — don't keep a stale "Logged in as"
      const si = await api.sessionInfo();
      if (!si.logged_in) loginStatus.replaceChildren();
      return true;
    } catch (e) {
      setStatus(serverStatus, false, String(e));
      return false;
    }
  }

  const loginBtn = el("button", {
    class: "btn btn-primary",
    text: "Log in",
    onclick: () => void doLogin(),
  });

  async function doLogin(): Promise<void> {
    if (busy) return;
    const raw = uidInput.value.trim();
    if (!/^\d{1,15}$/.test(raw) || !passInput.value) {
      setStatus(loginStatus, false, "Enter your numeric user ID (up to 15 digits) and transfer password.");
      return;
    }
    const uid = Number(raw);
    setBusy(true);
    setStatus(loginStatus, null, "Logging in…");
    try {
      if (!(await api.sessionInfo()).server || serverInput.value.trim()) {
        if (!(await connect())) return;
      }
      await api.login(uid, passInput.value);
      setStatus(loginStatus, true, `Logged in as ${uid}`);
      toast("Logged in", "ok");
      await ctx.onSession();
      ctx.goLibrary();
    } catch (e) {
      setStatus(loginStatus, false, String(e));
    } finally {
      setBusy(false);
    }
  }

  passInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doLogin();
  });

  const root = el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "connect-panel" },
      el("h1", {}, "CHARTER ", el("span", { text: "♪" })),
      el("p", {
        class: "sub",
        text: "Chart SIF2 beatmaps and manage them on an ew custom-songs server. You can work on local projects offline — connect and log in when you're ready to upload.",
      }),
      el("label", { class: "field" }, "Server", serverInput),
      el("div", { class: "row" }, connectBtn, serverStatus),
      el("hr", { style: "border:none;border-top:1px solid var(--line)" }),
      el("label", { class: "field" }, "User ID", uidInput),
      el("label", { class: "field" }, "Transfer password", passInput),
      el("div", { class: "row" }, loginBtn, logoutBtn, loginStatus),
      el("p", {
        class: "sub",
        text: "Heads-up: the server allows one webui session at a time — logging in here signs out a browser session for the same account, and the session lasts 24 hours.",
      }),
      el("div", { class: "row" }, el("button", { class: "btn btn-ghost", text: "Skip — work locally →", onclick: () => ctx.goLibrary() })),
    ),
  );

  return { root };
}

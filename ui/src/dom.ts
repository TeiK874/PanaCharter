// Tiny DOM helpers — the whole "framework".

type Attrs = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") {
      node.className = String(value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "value" && "value" in node) {
      (node as HTMLInputElement).value = String(value);
    } else if (key === "checked" && "checked" in node) {
      (node as HTMLInputElement).checked = Boolean(value);
    } else if (key === "disabled" && "disabled" in node) {
      (node as HTMLInputElement).disabled = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "error" | "ok" = "info"): void {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  const item = el("div", { class: `toast toast-${kind}`, text: message });
  toastHost.append(item);
  setTimeout(() => item.classList.add("gone"), 3800);
  setTimeout(() => item.remove(), 4300);
}

/** Run an async action, toasting its error (backend errors are plain strings). */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (e) {
    toast(String(e), "error");
    return undefined;
  }
}

export interface DialogHandle {
  root: HTMLDialogElement;
  close: () => void;
  /** Lock the dialog while an action is in flight: the ✕ button is disabled
   *  and Esc is ignored. `close()` itself is unaffected, for the owner. */
  setBusy: (busy: boolean) => void;
}

export function openDialog(title: string, ...content: Child[]): DialogHandle {
  const root = el("dialog", { class: "dialog" });
  let busy = false;
  const closeBtn = el("button", {
    class: "btn btn-ghost dialog-close",
    text: "✕",
    title: "Close",
    onclick: () => {
      if (!busy) root.close();
    },
  });
  root.append(
    el("div", { class: "dialog-head" }, el("h2", { text: title }), closeBtn),
    ...content.filter((c): c is Node | string => c != null && c !== false),
  );
  // Esc arrives as `cancel`; the ✕ button calls close() directly, so both
  // paths have to check the lock
  root.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  root.addEventListener("close", () => root.remove());
  document.body.append(root);
  root.showModal();
  return {
    root,
    close: () => root.close(),
    setBusy: (b) => {
      busy = b;
      closeBtn.disabled = b;
    },
  };
}

export function confirmDialog(message: string, action = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = openDialog(
      "Are you sure?",
      el("p", { class: "dialog-body", text: message }),
      el(
        "div",
        { class: "dialog-actions" },
        el("button", {
          class: "btn",
          text: "Cancel",
          onclick: () => dlg.close(),
        }),
        el("button", {
          class: "btn btn-danger",
          text: action,
          onclick: () => {
            ok = true;
            dlg.close();
          },
        }),
      ),
    );
    dlg.root.addEventListener("close", () => resolve(ok));
  });
}

/** Prompt for a file; resolves with its bytes, or null if cancelled. */
export function pickFile(accept: string): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, bytes: await file.arrayBuffer() });
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Prompt for a directory; resolves with lazy handles (bytes read on demand)
 *  so callers can filter by name before touching file contents. */
export function pickDirFiles(): Promise<{ name: string; path: string; read: () => Promise<ArrayBuffer> }[]> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", webkitdirectory: true });
    input.addEventListener("change", () => {
      resolve(
        [...(input.files ?? [])].map((file) => ({
          name: file.name,
          path: (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name,
          read: () => file.arrayBuffer(),
        })),
      );
    });
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** Prompt for multiple files; resolves with an empty array if cancelled. */
export function pickFiles(accept: string): Promise<{ name: string; bytes: ArrayBuffer }[]> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept, multiple: true });
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      const out = [];
      for (const file of files) {
        out.push({ name: file.name, bytes: await file.arrayBuffer() });
      }
      resolve(out);
    });
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

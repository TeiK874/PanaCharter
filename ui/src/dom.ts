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
}

export function openDialog(title: string, ...content: Child[]): DialogHandle {
  const root = el("dialog", { class: "dialog" });
  const closeBtn = el("button", {
    class: "btn btn-ghost dialog-close",
    text: "✕",
    title: "Close",
    onclick: () => root.close(),
  });
  root.append(
    el("div", { class: "dialog-head" }, el("h2", { text: title }), closeBtn),
    ...content.filter((c): c is Node | string => c != null && c !== false),
  );
  root.addEventListener("close", () => root.remove());
  document.body.append(root);
  root.showModal();
  return { root, close: () => root.close() };
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

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

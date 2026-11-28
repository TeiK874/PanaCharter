// In-page dropdown menus for every <select>.
//
// A native <select> opens its list in a separate popup window of the browser engine. On
// Windows that popup does not appear at all under the WebView2 launch options the app needs
// (see main.rs: direct composition is switched off to stop the mouse pointer freezing in
// full screen), so none of the app's dropdowns could be opened. Rather than depend on the
// engine's popup, a mouse press on a <select> is taken over here and its options are shown as
// an ordinary element inside the page. The <select> itself stays the source of truth: its
// value is set and `input` / `change` events fired on it exactly as the native list would, so
// no caller needs to know.

interface OpenMenu {
  select: HTMLSelectElement;
  menu: HTMLElement;
  items: HTMLElement[];
  /** Index into `items` of the keyboard-highlighted entry. */
  active: number;
}

let open: OpenMenu | null = null;

/** Selects the menu should leave alone: multi-line list boxes, which are not a dropdown. */
function takesOver(select: HTMLSelectElement): boolean {
  return !select.disabled && !select.multiple && select.size <= 1;
}

function closeMenu(): void {
  if (!open) return;
  open.menu.remove();
  open = null;
}

function choose(index: number): void {
  if (!open) return;
  const { select, items } = open;
  const item = items[index];
  const option = item && select.options[Number(item.dataset.index)];
  closeMenu();
  select.focus();
  if (!option || option.disabled || select.selectedIndex === option.index) return;
  select.selectedIndex = option.index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function highlight(index: number): void {
  if (!open || !open.items.length) return;
  open.active = (index + open.items.length) % open.items.length;
  open.items.forEach((item, i) => item.classList.toggle("active", i === open!.active));
  open.items[open.active].scrollIntoView({ block: "nearest" });
}

function openMenu(select: HTMLSelectElement): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");

  const items: HTMLElement[] = [];
  Array.from(select.options).forEach((option, i) => {
    if (option.hidden) return;
    const item = document.createElement("div");
    item.className = "select-menu-item";
    item.setAttribute("role", "option");
    item.dataset.index = String(i);
    item.textContent = option.text;
    if (option.disabled) item.classList.add("disabled");
    if (option.selected) item.classList.add("selected");
    item.addEventListener("mouseenter", () => {
      if (open) highlight(items.indexOf(item));
    });
    item.addEventListener("click", () => {
      if (!option.disabled) choose(items.indexOf(item));
    });
    items.push(item);
    menu.append(item);
  });
  if (!items.length) return;

  // Inside the select's own <dialog> when it has one: a modal dialog makes everything outside
  // it inert, and only things inside it can sit above it.
  (select.closest("dialog") ?? document.body).append(menu);

  const r = select.getBoundingClientRect();
  menu.style.minWidth = `${r.width}px`;
  // Room below, else above, whichever is bigger; never taller than the window.
  const gap = 4;
  const below = window.innerHeight - r.bottom - gap - 8;
  const above = r.top - gap - 8;
  const placeBelow = below >= Math.min(menu.scrollHeight, 220) || below >= above;
  const maxHeight = Math.max(80, placeBelow ? below : above);
  menu.style.maxHeight = `${maxHeight}px`;
  const height = Math.min(menu.scrollHeight, maxHeight);
  menu.style.top = `${placeBelow ? r.bottom + gap : r.top - gap - height}px`;
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;

  open = { select, menu, items, active: 0 };
  const selected = items.findIndex((item) => item.classList.contains("selected"));
  highlight(selected >= 0 ? selected : 0);
}

function onMouseDown(e: MouseEvent): void {
  const target = e.target;
  if (open && target instanceof Node && open.menu.contains(target)) return; // a click on an item
  const select = target instanceof Element ? target.closest("select") : null;
  if (select && takesOver(select) && e.button === 0) {
    e.preventDefault(); // keeps the engine from opening its own (invisible) popup
    const same = open?.select === select;
    closeMenu();
    select.focus();
    if (!same) openMenu(select);
    return;
  }
  closeMenu();
}

function onKeyDown(e: KeyboardEvent): void {
  if (open) {
    // The menu owns the keyboard while it is up — the editor's own shortcuts (arrow keys
    // step the playhead, Esc closes the dialog) must not also fire.
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "ArrowDown":
        handled();
        highlight(open.active + 1);
        return;
      case "ArrowUp":
        handled();
        highlight(open.active - 1);
        return;
      case "Home":
        handled();
        highlight(0);
        return;
      case "End":
        handled();
        highlight(open.items.length - 1);
        return;
      case "Enter":
      case " ":
        handled();
        choose(open.active);
        return;
      case "Escape":
      case "Tab":
        if (e.key === "Escape") handled();
        closeMenu();
        return;
      default:
        handled(); // typing while the list is up shouldn't place notes behind it
        return;
    }
  }
  // Space (or Alt+Down) on a focused dropdown opens it, as the native control does.
  const t = e.target;
  if (t instanceof HTMLSelectElement && takesOver(t) && (e.key === " " || (e.altKey && e.key === "ArrowDown"))) {
    e.preventDefault();
    e.stopPropagation();
    openMenu(t);
  }
}

/** Call once at startup. */
export function installSelectMenus(): void {
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  // The list is positioned against the page as it was when it opened; any scroll or resize
  // would leave it floating in the wrong place.
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
  document.addEventListener(
    "scroll",
    (e) => {
      if (open && !(e.target instanceof Node && open.menu.contains(e.target))) closeMenu();
    },
    true,
  );
}

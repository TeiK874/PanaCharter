# PanaCharter ♪

A desktop beatmap editor for SIF2 (Love Live! School Idol Festival 2) custom songs,
built with Tauri + Rust and a dependency-free vanilla-TypeScript frontend.

Talks to an [ew](https://git.ethanthesleepy.one/ethanaobrien/ew) custom-songs server:
log in with your user ID + transfer password, chart locally, then upload / manage
visibility / browse / download other people's songs as editable projects.
Re-uploading a project you already published offers **update in place**
(`POST /custom_song/update`) — the song keeps its music id and players keep their
scores; unchanged audio/jackets are not re-sent.

## Credits

PanaCharter is based on Charter, created by [ethanaobrien](https://git.ethanthesleepy.one/ethanaobrien),
who also wrote the [ew](https://git.ethanthesleepy.one/ethanaobrien/ew) server it works with.
The original project lives at
[ethanaobrien/charter](https://git.ethanthesleepy.one/ethanaobrien/charter); this
repository carries additional changes on top of it.

## Layout

- `src-tauri/` — Rust backend: ew server HTTP client (`server.rs`), local project
  store (`projects.rs`, mirrors the server's export-package format), symphonia audio
  decoding (`audio.rs`).
- `ui/` — frontend. No framework, no bundler: `tsc` emits native ES modules into
  `ui/dist/js`, `index.html`/`styles.css` are copied alongside. Tauri IPC via the
  `withGlobalTauri` bridge. `ui/assets/` holds static binary assets (e.g. the tick SE
  sound) copied verbatim into `ui/dist/assets/` by the same build step.
- Charts are stored and exchanged in the SIF1/NPPS4 JSON schema (the server's upload
  format); the server transcodes to SIF2 NoteData on upload.
- `ui/src/convert/` — chart importers (⤓ Import in the editor, auto-detected):
  SIF1/NPPS4 JSON, official SIF2 NoteData (served JSON + Unity `.asset` YAML),
  Bandori `.note` (BMS, rules matched to `bandori-sif2-tools`), Bestdori JSON.
  Adding a format = one module implementing `ChartConverter` + one registry line.
- `src-tauri/src/bundle.rs` — minimal UnityFS AssetBundle reader: feed Import a raw
  `.unity3d`/musicscore bundle and it extracts TextAsset charts (Bandori) and
  `Aoharu.NoteData` MonoBehaviours (SIF2) directly, with a picker when a bundle
  holds several difficulties.
- `src-tauri/src/bandori_batch.rs` — **batch import** ("Batch import Bandori…" in
  Projects): feed it any mix of Bandori `musicscoreNN` (charts), `sound/bgmNNN`
  (audio as split CRI ACB → HCA → decoded via system `ffmpeg`, optional) and
  `musicjacketNN` bundles (ASTC textures → PNG); songs are grouped automatically,
  titles/bands come from the bestdori API (cached), and each selected song becomes
  a ready-to-edit project. Rules match `bandori-sif2-tools`.

## Dependencies

Rust (stable, via [rustup](https://rustup.rs)) and Node.js 18+ everywhere, plus the
Tauri 2 system libraries:

### Ubuntu / Debian

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
                 librsvg2-dev build-essential pkg-config curl
```

### Fedora

```sh
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel \
                 gcc gcc-c++ make pkgconf-pkg-config
```

### Windows

Visual Studio Build Tools (the "Desktop development with C++" workload). The
WebView2 runtime is preinstalled on Windows 10/11.

## Develop

```sh
npm install
npx tauri dev        # runs `npm run build` first, then launches the app
npm run watch        # optional: tsc -w in a second terminal; Ctrl+R reloads the webview
```

## Build a release binary

```sh
npx tauri build --no-bundle   # binary at src-tauri/target/release/panacharter
```

CI does this automatically: `.forgejo/workflows/release.yml` builds Linux + Windows
binaries on every push and attaches them to a Forgejo release on every tag.

## Editor quick reference

| Input | Action |
|---|---|
| `1`–`6` | Select / Tap / Hold / Star / Slide / Flick tool — the Flick tool, and everything else that makes a flick, is off until you tick the checkbox right of its toolbar button (an app-wide setting, off by default) |
| Click | Place note (drag to set a hold's length) |
| Slide: click, click, … | Chain points across lanes · drag the last point to end it in a hold |
| `Esc` (Slide tool) | End the current slide chain |
| Drag note | Move it · drag a hold's **tail** to resize |
| Click an already-selected tap/star note | Flip it — and every other selected tap/star note — to the other kind (no drag); with flicks on it cycles tap → star → flick → tap |
| Click an already-selected hold, or a selected slide's tail (tool ≠ Slide), with flicks on | Toggle its release between normal and flick — and every other selected one along with it (no drag) |
| Right-click | Delete note |
| Shift+click | Add to / remove from selection |
| Drag on empty space (select tool) | Box select |
| `Del` | Delete selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste at the playhead — pasted notes that would start after the end of the song are skipped, and holds running past it are cut off at the last grid line inside the song (a message says how many) |
| `Ctrl+Shift+V` | Paste mirrored (lanes flipped left-right) at the playhead |
| `Ctrl+A` | Select all |
| `Space` | Play / pause |
| `Home` / `End` | Jump to start / end |
| `Ctrl+G` / Jump… toolbar button | Jump to a measure number |
| `↑` / `↓` (or `←` / `→`) | Step the playhead by one snap division |
| Wheel | Scroll · `Ctrl`+wheel zoom · middle-drag pan |
| Click the waveform | Seek |
| `A` `S` `D` `F` `G` `H` `J` `K` `L` | Place a tap at the playhead, in lanes 9→1 left to right — works during playback too. Hold the key down while playing to place a hold instead of a tap. In ⚙ Settings: click a lane's key box then press any key to rebind it (auto-advances to the next box); how much earlier than the keypress the note lands (input-lag compensation) and how long a hold-down counts as a hold are also adjustable there — all app-wide settings saved across projects |
| Layout dropdown (next to the zoom buttons) | Vertical ↓ (time runs top to bottom), Vertical ↑ (bottom to top), or Horizontal → (a left-to-right timeline) — saved per project |
| Snap to grid toolbar button | Pull every note (and hold/slide length) that's within about 2ms of a grid line exactly onto it — checks every standard division (plain and triplet), not just the currently-selected one |
| Checkbox right of Snap to grid | When ticked, dragging notes lands the earliest selected note exactly on the grid even if it started off it, the rest of the selection keeping its positions relative to it (off by default; an app-wide setting) |
| 🔔 toolbar button | Toggle note ticks during playback |
| 🔔 tick-sound dropdown | Switch the playback tick between a synthesized beep and a sample SE (web audio backend only) |
| 🔊 toolbar slider | Adjust audio playback volume |
| Tick on/off, tick sound, and volume | App-wide settings, saved across projects |
| Tempo… toolbar button | Add/edit mid-song BPM and time-signature changes — the grid, measure lines/numbering, and snapping follow each change from its time onward |
| Note preview (left panel) | In-game-style preview: notes fly from a top-center spawn point out to a fan of 9 judgment circles, growing as they approach (drawn as outlines by default; filling them, and coloring them by the song's attribute — Smile / Pure / Cool — instead of by note type, are settings; flicks are triangles pointing back at the spawn point), with a live combo counter above it. Below: a 4-measure density close-up, then a whole-song per-measure density strip — click or drag it to seek, with a "m:ss · Measure N" tooltip, and it auto-scrolls the main view to match. The ⛶ button at its top right (or `F11`) opens a full-screen preview laid out like the in-game screen (1920x1080 reference, scaled to fit), with the jacket dimmed behind it and a header holding the playback controls, the song density/seek strip, and an exit button (`F11` or `Esc` also exits; ⏮ jumps back to the start, and playing from the start first fades in the jacket, song title and artist for a couple of seconds and then starts the music — the names' language and whether it shows at all are settings) — lane keys and playback shortcuts keep working there. Drag the panel's right edge to resize; display size (50–125%), speed (game speed 1–10, or seconds directly), the size notes spawn at (normal notes/hold heads and hold tails separately) and the landing-ripple size, and panel width are all app-wide settings, saved across projects |

Everything autosaves; press **？** in the toolbar for this list in-app.

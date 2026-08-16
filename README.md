# Charter ♪

A desktop beatmap editor for SIF2 (Love Live! School Idol Festival 2) custom songs,
built with Tauri + Rust and a dependency-free vanilla-TypeScript frontend.

Talks to an [ew](https://git.ethanthesleepy.one/ethanaobrien/ew) custom-songs server:
log in with your user ID + transfer password, chart locally, then upload / manage
visibility / browse / download other people's songs as editable projects.
Re-uploading a project you already published offers **update in place**
(`POST /custom_song/update`) — the song keeps its music id and players keep their
scores; unchanged audio/jackets are not re-sent.

## Layout

- `src-tauri/` — Rust backend: ew server HTTP client (`server.rs`), local project
  store (`projects.rs`, mirrors the server's export-package format), symphonia audio
  decoding (`audio.rs`).
- `ui/` — frontend. No framework, no bundler: `tsc` emits native ES modules into
  `ui/dist/js`, `index.html`/`styles.css` are copied alongside. Tauri IPC via the
  `withGlobalTauri` bridge.
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
npx tauri build --no-bundle   # binary at src-tauri/target/release/charter
```

CI does this automatically: `.forgejo/workflows/release.yml` builds Linux + Windows
binaries on every push and attaches them to a Forgejo release on every tag.

## Editor quick reference

| Input | Action |
|---|---|
| `1` / `2` / `3` / `4` | Select / Tap / Hold / Star tool |
| Click | Place note (drag to set a hold's length) |
| Drag note | Move it · drag a hold's **tail** to resize |
| Right-click | Delete note |
| Shift+click | Add to / remove from selection |
| Drag on empty space (select tool) | Box select |
| `Del` | Delete selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste at the playhead |
| `Ctrl+Shift+V` | Paste mirrored (lanes flipped left-right) at the playhead |
| `Ctrl+A` | Select all |
| `Space` | Play / pause |
| `Home` / `End` | Jump to start / end |
| `↑` / `↓` (or `←` / `→`) | Step the playhead by one snap division |
| Wheel | Scroll · `Ctrl`+wheel zoom · middle-drag pan |
| Click the waveform | Seek |
| ⇆ toolbar button | Toggle vertical-scroll ⇄ horizontal-timeline layout |

Everything autosaves; press **？** in the toolbar for this list in-app.

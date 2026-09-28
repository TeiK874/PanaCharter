//! Local project storage.
//!
//! A project directory mirrors the server's export-package layout (§9.3 of the API
//! spec) plus an `editor.json` for editor-only state, so package import/export is a
//! straight copy:
//!
//! ```text
//! {app_data}/projects/{id}/
//!   manifest.json   — package manifest (clean, export-ready)
//!   editor.json     — grid offset, snap, zoom, last-upload record
//!   chart_{1..4}.json — SIF1 upload-schema note arrays
//!   audio.{ogg|mp3|wav}
//!   jacket.{png|jpg}
//! ```

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/// One note in the SIF1/NPPS4 upload schema (§4a). Lane `position` is 1–9
/// right-to-left; `effect` 1=tap, 3=hold (+`effect_value` duration), 4=star,
/// 8=flick, 10=hold ending in a flick (+`effect_value` duration), 11/12=slide,
/// 13=slide ending in a hold (+`effect_value` duration), 14=slide ending in a flick.
#[derive(Serialize, Deserialize, Clone)]
pub struct SifNote {
    pub timing_sec: f64,
    #[serde(deserialize_with = "de_num_u32")]
    pub position: u32,
    #[serde(deserialize_with = "de_num_u32")]
    pub effect: u32,
    #[serde(default)]
    pub effect_value: f64,
    /// Slide chain id (effect 11/12/13/14 only): notes sharing a value > 1 chain together
    /// in time order. 0 (the wire default) reads the same as SIF1's own "not chained" 1.
    #[serde(
        default,
        deserialize_with = "de_notes_level",
        skip_serializing_if = "is_zero_u32"
    )]
    pub notes_level: u32,
}

/// Accept `5` and `5.0` alike — SIF1 charts in the wild are sloppy about this.
fn de_num_u32<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = f64::deserialize(d)?;
    Ok(v as u32)
}

/// `de_num_u32` for an optional field: imported charts are stored verbatim, and
/// real ones carry `1`, `1.0`, `null`, negatives or nothing here — all of which
/// must keep loading. Anything that isn't a non-negative finite number reads as 0.
fn de_notes_level<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Option::<f64>::deserialize(d)?;
    Ok(match v {
        Some(v) if v.is_finite() && v >= 0.0 => v as u32,
        _ => 0,
    })
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LevelMeta {
    pub level: u32,
    pub level_number: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Manifest {
    #[serde(default = "default_format")]
    pub format: u32,
    pub name: String,
    #[serde(default)]
    pub name_en: String,
    #[serde(default)]
    pub short_name: String,
    #[serde(default)]
    pub kana: String,
    pub artist: String,
    #[serde(default)]
    pub artist_en: String,
    #[serde(default = "default_attribute")]
    pub attribute: u32,
    #[serde(default = "default_band")]
    pub band_category: String,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub preview_start_sec: Option<f64>,
    #[serde(default)]
    pub preview_length_sec: Option<f64>,
    #[serde(default)]
    pub levels: Vec<LevelMeta>,
}

fn default_format() -> u32 {
    1
}
fn default_attribute() -> u32 {
    1
}
fn default_band() -> String {
    "OTHER".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LastUpload {
    pub server: String,
    pub music_id: u64,
    /// Asset mtimes at upload time — lets a later update skip re-sending
    /// unchanged audio/jacket (audio re-encode churns everyone's cache).
    #[serde(default)]
    pub audio_mtime_ms: Option<u64>,
    #[serde(default)]
    pub jacket_mtime_ms: Option<u64>,
}

/// A tempo change: from `time_sec` onward the grid follows `bpm` instead.
#[derive(Serialize, Deserialize, Clone)]
pub struct BpmChange {
    pub time_sec: f64,
    pub bpm: f64,
}

/// A time-signature change: from `time_sec` onward, this many beats form a measure.
#[derive(Serialize, Deserialize, Clone)]
pub struct TimeSigChange {
    pub time_sec: f64,
    pub beats: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct EditorMeta {
    #[serde(default)]
    pub offset_sec: f64,
    #[serde(default = "default_snap")]
    pub snap: u32,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    #[serde(default = "default_orientation")]
    pub orientation: String,
    #[serde(default)]
    pub last_upload: Option<LastUpload>,
    /// Mid-song tempo changes after the initial `Manifest.bpm` at `offset_sec`.
    #[serde(default)]
    pub bpm_changes: Vec<BpmChange>,
    /// Beats per measure from `offset_sec` onward. Defaults to 4 (common time).
    #[serde(default = "default_beats_per_measure")]
    pub beats_per_measure: u32,
    /// Mid-song time-signature changes after `beats_per_measure` at `offset_sec`.
    #[serde(default)]
    pub time_sig_changes: Vec<TimeSigChange>,
}

fn default_snap() -> u32 {
    4
}
fn default_zoom() -> f64 {
    200.0
}
fn default_orientation() -> String {
    "vertical".into()
}
fn default_beats_per_measure() -> u32 {
    4
}

impl Default for EditorMeta {
    fn default() -> Self {
        Self {
            offset_sec: 0.0,
            snap: default_snap(),
            zoom: default_zoom(),
            orientation: default_orientation(),
            last_upload: None,
            bpm_changes: Vec::new(),
            beats_per_measure: default_beats_per_measure(),
            time_sig_changes: Vec::new(),
        }
    }
}

#[derive(Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub artist: String,
    pub attribute: u32,
    pub levels: Vec<u32>,
    pub has_audio: bool,
    pub has_jacket: bool,
    pub modified_ms: u64,
}

#[derive(Serialize)]
pub struct ProjectData {
    pub id: String,
    pub manifest: Manifest,
    pub editor: EditorMeta,
    pub charts: BTreeMap<u32, Vec<SifNote>>,
    pub audio_ext: Option<String>,
    pub jacket_ext: Option<String>,
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

pub fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(es)?.join("projects");
    fs::create_dir_all(&dir).map_err(es)?;
    Ok(dir)
}

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("Invalid project id".into())
    }
}

fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    let dir = projects_dir(app)?.join(id);
    if !dir.is_dir() {
        return Err("Project not found".into());
    }
    Ok(dir)
}

fn new_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    format!("p{:x}-{:x}", now.as_millis(), now.subsec_nanos())
}

/// Locate `{stem}.{any ext}` in a project dir, returning (ext, path).
fn find_asset(dir: &Path, stem: &str) -> Option<(String, PathBuf)> {
    let prefix = format!("{stem}.");
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(ext) = name.strip_prefix(&prefix) {
            if ext.ends_with(".tmp") {
                continue; // leftover from an interrupted replacement
            }
            return Some((ext.to_string(), entry.path()));
        }
    }
    None
}

fn remove_asset(dir: &Path, stem: &str) {
    if let Some((_, path)) = find_asset(dir, stem) {
        let _ = fs::remove_file(path);
    }
}

/// Write via `<path>.tmp` + rename so a crash mid-write (autosave, import) can
/// never leave a truncated file behind — an empty manifest.json makes
/// `summarize` return None and the project vanish from the library.
/// Per-process counter making every write_atomic temp path unique. Two overlapping
/// saves of the same file (e.g. a debounced autosave and an explicit flush racing
/// each other) used to share one fixed `.tmp` name: the second write would clobber the
/// first's temp file's *contents*, and whichever finished its rename first would then
/// hit a missing source file, since the other had already consumed it. A unique name
/// per call keeps every write+rename independently atomic regardless of overlap — the
/// rename that lands last simply wins, same as any other last-write-wins file save.
static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let n = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{n}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(es)?;
    fs::rename(&tmp, path).map_err(es)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|md| md.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let bytes = fs::read(dir.join("manifest.json")).map_err(|_| "Project has no manifest")?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Corrupt project manifest: {e}"))
}

fn read_editor(dir: &Path) -> EditorMeta {
    fs::read(dir.join("editor.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn chart_path(dir: &Path, level: u32) -> PathBuf {
    dir.join(format!("chart_{level}.json"))
}

/// Levels that actually have chart files, with star numbers from the manifest
/// (falling back to the server's own defaults of 3/6/9/12).
fn effective_levels(dir: &Path, m: &Manifest) -> Vec<LevelMeta> {
    (1..=4)
        .filter(|l| chart_path(dir, *l).exists())
        .map(|l| LevelMeta {
            level: l,
            level_number: m
                .levels
                .iter()
                .find(|x| x.level == l)
                .map(|x| x.level_number)
                .unwrap_or(3 * l),
        })
        .collect()
}

fn summarize(id: &str, dir: &Path) -> Option<ProjectSummary> {
    let m: Manifest = serde_json::from_slice(&fs::read(dir.join("manifest.json")).ok()?).ok()?;
    let levels = (1..=4).filter(|l| chart_path(dir, *l).exists()).collect();
    let modified_ms = fs::metadata(dir.join("manifest.json"))
        .and_then(|md| md.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(ProjectSummary {
        id: id.to_string(),
        name: m.name,
        artist: m.artist,
        attribute: m.attribute,
        levels,
        has_audio: find_asset(dir, "audio").is_some(),
        has_jacket: find_asset(dir, "jacket").is_some(),
        modified_ms,
    })
}

fn sniff_audio_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"OggS") {
        "ogg"
    } else if bytes.starts_with(b"RIFF") {
        "wav"
    } else {
        "mp3"
    }
}

fn sniff_image_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else {
        "jpg"
    }
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'a>) -> Result<(String, &'a [u8]), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    let id = request
        .headers()
        .get("x-project-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing x-project-id header")?
        .to_string();
    Ok((id, bytes))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn project_list(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let root = projects_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(root).map_err(es)?.flatten() {
        if entry.path().is_dir() {
            let id = entry.file_name().to_string_lossy().to_string();
            if valid_id(&id).is_err() {
                continue; // hand-made dir the API can't address — don't show a ghost
            }
            if let Some(s) = summarize(&id, &entry.path()) {
                out.push(s);
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
    Ok(out)
}

#[tauri::command]
pub fn project_create(app: AppHandle, name: String, artist: String) -> Result<ProjectSummary, String> {
    let id = new_id();
    let dir = projects_dir(&app)?.join(&id);
    fs::create_dir_all(&dir).map_err(es)?;
    let manifest = Manifest {
        format: 1,
        name,
        name_en: String::new(),
        short_name: String::new(),
        kana: String::new(),
        artist,
        artist_en: String::new(),
        attribute: 1,
        band_category: "OTHER".into(),
        bpm: Some(120.0),
        preview_start_sec: None,
        preview_length_sec: None,
        levels: Vec::new(),
    };
    write_atomic(
        &dir.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(es)?,
    )?;
    write_atomic(
        &dir.join("editor.json"),
        &serde_json::to_vec_pretty(&EditorMeta::default()).map_err(es)?,
    )?;
    summarize(&id, &dir).ok_or_else(|| "Failed to create project".into())
}

#[tauri::command]
pub fn project_load(app: AppHandle, id: String) -> Result<ProjectData, String> {
    let dir = project_dir(&app, &id)?;
    let manifest = read_manifest(&dir)?;
    let editor = read_editor(&dir);
    let mut charts = BTreeMap::new();
    for level in 1..=4 {
        if let Ok(bytes) = fs::read(chart_path(&dir, level)) {
            let notes: Vec<SifNote> = serde_json::from_slice(&bytes)
                .map_err(|e| format!("chart_{level}.json is corrupt: {e}"))?;
            charts.insert(level, notes);
        }
    }
    Ok(ProjectData {
        id,
        manifest,
        editor,
        charts,
        audio_ext: find_asset(&dir, "audio").map(|(e, _)| e),
        jacket_ext: find_asset(&dir, "jacket").map(|(e, _)| e),
    })
}

#[tauri::command]
pub fn project_save(
    app: AppHandle,
    id: String,
    manifest: Manifest,
    editor: EditorMeta,
    charts: BTreeMap<u32, Vec<SifNote>>,
) -> Result<(), String> {
    let dir = project_dir(&app, &id)?;
    write_atomic(
        &dir.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(es)?,
    )?;
    write_atomic(
        &dir.join("editor.json"),
        &serde_json::to_vec_pretty(&editor).map_err(es)?,
    )?;
    for level in 1..=4 {
        match charts.get(&level) {
            Some(notes) if !notes.is_empty() => {
                write_atomic(
                    &chart_path(&dir, level),
                    &serde_json::to_vec(notes).map_err(es)?,
                )?;
            }
            _ => {
                let _ = fs::remove_file(chart_path(&dir, level));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn project_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = project_dir(&app, &id)?;
    fs::remove_dir_all(dir).map_err(es)
}

/// Binary-body command: payload = raw file bytes, project id in `x-project-id`.
/// Format is sniffed from magic bytes, not trusted from the filename.
#[tauri::command]
pub async fn project_set_audio(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (id, bytes) = raw_body(&request)?;
    let dir = project_dir(&app, &id)?;
    let ext = sniff_audio_ext(bytes);
    let bytes = bytes.to_vec();
    // decoding a whole track takes seconds — keep it off the webview thread
    tauri::async_runtime::spawn_blocking(move || {
        // validate by decoding BEFORE touching the old asset — a flac renamed
        // .mp3 (or a webp sniffed as wav) should fail here with a clear message,
        // not later during editor load or upload
        crate::audio::decode_to_pcm(bytes.clone(), Some(ext))?;
        let tmp = dir.join(format!("audio.{ext}.tmp"));
        fs::write(&tmp, &bytes).map_err(es)?;
        remove_asset(&dir, "audio");
        fs::rename(&tmp, dir.join(format!("audio.{ext}"))).map_err(es)?;
        Ok(ext.to_string())
    })
    .await
    .map_err(es)?
}

#[tauri::command]
pub fn project_set_jacket(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let (id, bytes) = raw_body(&request)?;
    let dir = project_dir(&app, &id)?;
    let ext = sniff_image_ext(bytes);
    let tmp = dir.join(format!("jacket.{ext}.tmp"));
    fs::write(&tmp, bytes).map_err(es)?;
    remove_asset(&dir, "jacket");
    fs::rename(&tmp, dir.join(format!("jacket.{ext}"))).map_err(es)?;
    Ok(ext.to_string())
}

/// Decode the project's audio to PCM for the editor.
/// Response layout (little-endian): `u32 sample_rate | u32 channels | u32 frames |
/// i16 interleaved samples…`.
#[tauri::command]
pub async fn project_load_audio(
    app: AppHandle,
    native: tauri::State<'_, crate::audio_native::NativeAudio>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = project_dir(&app, &id)?;
    let (ext, path) = find_asset(&dir, "audio").ok_or("Project has no audio yet")?;
    // decoding a whole track takes seconds — keep it off the webview thread
    let (rate, channels, pcm) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(path).map_err(es)?;
        crate::audio::decode_to_pcm(bytes, Some(&ext))
    })
    .await
    .map_err(es)??;
    // hand the native player its copy — it becomes the playback engine when
    // PulseAudio is reachable; the returned PCM still drives the waveform
    native.set_pcm(rate, channels, pcm.clone());
    let frames = (pcm.len() as u32) / channels;
    let mut buf = Vec::with_capacity(12 + pcm.len() * 2);
    buf.extend_from_slice(&rate.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&frames.to_le_bytes());
    // i16 → LE bytes; all supported targets are little-endian so a cast is exact
    let (_, body, _) = unsafe { pcm.align_to::<u8>() };
    buf.extend_from_slice(body);
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
pub fn project_get_jacket(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let dir = project_dir(&app, &id)?;
    let (_, path) = find_asset(&dir, "jacket").ok_or("Project has no jacket yet")?;
    let bytes = fs::read(path).map_err(es)?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Packages (zip import/export) and upload bundles
// ---------------------------------------------------------------------------

fn build_package_zip(dir: &Path, manifest: &Manifest) -> Result<Vec<u8>, String> {
    let mut export = manifest.clone();
    export.levels = effective_levels(dir, manifest);

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts).map_err(es)?;
    zip.write_all(&serde_json::to_vec_pretty(&export).map_err(es)?)
        .map_err(es)?;

    // Editor-only state (grid offset, tempo changes, snap, zoom) travels with the package
    // too, so re-importing it elsewhere doesn't lose the grid setup — but last_upload is
    // cleared: a re-imported copy is a fresh project, not already linked to whatever
    // server/music_id the original was uploaded to. This never reaches the ew server
    // itself — collect_upload (the actual upload path) reads project files directly and
    // never calls build_package_zip.
    let mut editor = read_editor(dir);
    editor.last_upload = None;
    zip.start_file("editor.json", opts).map_err(es)?;
    zip.write_all(&serde_json::to_vec_pretty(&editor).map_err(es)?)
        .map_err(es)?;

    let (_, jacket_path) = find_asset(dir, "jacket").ok_or("Project has no jacket yet")?;
    zip.start_file("jacket", opts).map_err(es)?;
    zip.write_all(&fs::read(jacket_path).map_err(es)?).map_err(es)?;

    let (_, audio_path) = find_asset(dir, "audio").ok_or("Project has no audio yet")?;
    zip.start_file("audio", opts).map_err(es)?;
    zip.write_all(&fs::read(audio_path).map_err(es)?).map_err(es)?;

    for lm in &export.levels {
        zip.start_file(format!("chart_{}.json", lm.level), opts).map_err(es)?;
        zip.write_all(&fs::read(chart_path(dir, lm.level)).map_err(es)?)
            .map_err(es)?;
    }

    if export.levels.is_empty() {
        return Err("Project has no charts yet".into());
    }
    Ok(zip.finish().map_err(es)?.into_inner())
}

fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "song".into() } else { s }
}

/// Export the project as a server-compatible package zip; returns the written path.
#[tauri::command(async)]
pub fn project_export(app: AppHandle, id: String) -> Result<String, String> {
    let dir = project_dir(&app, &id)?;
    let manifest = read_manifest(&dir)?;
    let bytes = build_package_zip(&dir, &manifest)?;
    let out_dir = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Downloads"))
        .filter(|d| d.is_dir())
        .map_or_else(
            || {
                let d = app
                    .path()
                    .app_data_dir()
                    .map_err(es)
                    .map(|d| d.join("exports"))?;
                fs::create_dir_all(&d).map_err(es)?;
                Ok::<PathBuf, String>(d)
            },
            Ok,
        )?;
    let path = out_dir.join(format!("custom_song_{}.zip", slug(&manifest.name)));
    write_atomic(&path, &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn import_zip_bytes(app: &AppHandle, bytes: Vec<u8>) -> Result<ProjectSummary, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "Package is not a valid zip file".to_string())?;

    let mut manifest: Option<Manifest> = None;
    let mut editor: Option<EditorMeta> = None;
    let mut jacket: Option<Vec<u8>> = None;
    let mut audio: Option<Vec<u8>> = None;
    let mut charts: Vec<(u32, Vec<u8>)> = Vec::new();

    const MAX_ENTRY: u64 = 64 * 1024 * 1024;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(es)?;
        if file.size() > MAX_ENTRY {
            return Err(format!("Package entry '{}' is implausibly large", file.name()));
        }
        total = total.saturating_add(file.size());
        if total > 2 * MAX_ENTRY {
            return Err("Package decompresses to an implausible size".into());
        }
        let name = file.name().to_string();
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(es)?;
        match name.as_str() {
            "manifest.json" => {
                manifest = Some(
                    serde_json::from_slice(&data)
                        .map_err(|e| format!("Package manifest is not valid JSON: {e}"))?,
                );
            }
            // Grid offset/tempo changes/snap/zoom, if the package carries them (packages
            // from the ew server or older charter versions won't) — best-effort, a
            // missing or corrupt editor.json just falls back to EditorMeta::default().
            "editor.json" => editor = serde_json::from_slice(&data).ok(),
            "jacket" => jacket = Some(data),
            "audio" => audio = Some(data),
            _ => {
                if let Some(level) = name
                    .strip_prefix("chart_")
                    .and_then(|r| r.strip_suffix(".json"))
                    .and_then(|n| n.parse::<u32>().ok())
                    .filter(|l| (1..=4).contains(l))
                {
                    let _: Vec<SifNote> = serde_json::from_slice(&data)
                        .map_err(|e| format!("chart_{level}.json in package is not a valid chart: {e}"))?;
                    charts.push((level, data));
                }
            }
        }
    }

    let manifest = manifest.ok_or("Package has no manifest.json")?;
    if manifest.format != 1 {
        return Err("Unsupported package format".into());
    }
    let jacket = jacket.ok_or("Package has no jacket")?;
    let audio = audio.ok_or("Package has no audio")?;
    if charts.is_empty() {
        return Err("Package has no charts".into());
    }

    let id = new_id();
    let dir = projects_dir(app)?.join(&id);
    fs::create_dir_all(&dir).map_err(es)?;
    write_atomic(
        &dir.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(es)?,
    )?;
    write_atomic(
        &dir.join("editor.json"),
        &serde_json::to_vec_pretty(&editor.unwrap_or_default()).map_err(es)?,
    )?;
    write_atomic(
        &dir.join(format!("jacket.{}", sniff_image_ext(&jacket))),
        &jacket,
    )?;
    write_atomic(
        &dir.join(format!("audio.{}", sniff_audio_ext(&audio))),
        &audio,
    )?;
    for (level, data) in charts {
        write_atomic(&chart_path(&dir, level), &data)?;
    }
    summarize(&id, &dir).ok_or_else(|| "Failed to read imported project".into())
}

/// Binary-body command: payload = package zip bytes.
#[tauri::command(async)]
pub fn project_import_zip(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<ProjectSummary, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    import_zip_bytes(&app, bytes.clone())
}

/// Create a project directory from parts already in memory (used by the
/// Bandori batch importer). Chart notes are written as SIF1 JSON like save.
pub(crate) fn create_project_files(
    app: &AppHandle,
    manifest: &Manifest,
    charts: &BTreeMap<u32, Vec<SifNote>>,
    jacket_png: Option<&[u8]>,
    audio: Option<(&str, &[u8])>,
) -> Result<ProjectSummary, String> {
    let id = new_id();
    let dir = projects_dir(app)?.join(&id);
    fs::create_dir_all(&dir).map_err(es)?;
    write_atomic(
        &dir.join("manifest.json"),
        &serde_json::to_vec_pretty(manifest).map_err(es)?,
    )?;
    write_atomic(
        &dir.join("editor.json"),
        &serde_json::to_vec_pretty(&EditorMeta::default()).map_err(es)?,
    )?;
    for (level, notes) in charts {
        if (1..=4).contains(level) && !notes.is_empty() {
            write_atomic(&chart_path(&dir, *level), &serde_json::to_vec(notes).map_err(es)?)?;
        }
    }
    if let Some(png) = jacket_png {
        write_atomic(&dir.join("jacket.png"), png)?;
    }
    if let Some((ext, bytes)) = audio {
        write_atomic(&dir.join(format!("audio.{ext}")), bytes)?;
    }
    summarize(&id, &dir).ok_or_else(|| "Failed to create project".into())
}

pub struct UploadBundle {
    pub manifest: Manifest,
    /// (level, level_number, chart json bytes)
    pub charts: Vec<(u32, u32, Vec<u8>)>,
    pub audio: (String, Vec<u8>),
    pub jacket: (String, Vec<u8>),
    /// mtimes captured when the bytes were read — recording these (rather than
    /// re-sampling after the upload) keeps change detection honest if the user
    /// swaps an asset while the upload is in flight
    pub audio_mtime_ms: Option<u64>,
    pub jacket_mtime_ms: Option<u64>,
}

pub fn collect_upload(app: &AppHandle, id: &str) -> Result<UploadBundle, String> {
    let dir = project_dir(app, id)?;
    let manifest = read_manifest(&dir)?;
    let (audio_ext, audio_path) =
        find_asset(&dir, "audio").ok_or("Add an audio track before uploading")?;
    let (jacket_ext, jacket_path) =
        find_asset(&dir, "jacket").ok_or("Add a jacket image before uploading")?;
    let audio_mtime_ms = mtime_ms(&audio_path);
    let jacket_mtime_ms = mtime_ms(&jacket_path);
    let charts = effective_levels(&dir, &manifest)
        .into_iter()
        .map(|lm| {
            Ok((
                lm.level,
                lm.level_number,
                fs::read(chart_path(&dir, lm.level)).map_err(es)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(UploadBundle {
        manifest,
        charts,
        audio: (audio_ext, fs::read(audio_path).map_err(es)?),
        jacket: (jacket_ext, fs::read(jacket_path).map_err(es)?),
        audio_mtime_ms,
        jacket_mtime_ms,
    })
}

pub fn record_upload(
    app: &AppHandle,
    id: &str,
    server: &str,
    music_id: u64,
    audio_mtime_ms: Option<u64>,
    jacket_mtime_ms: Option<u64>,
) -> Option<LastUpload> {
    let dir = project_dir(app, id).ok()?;
    let mut editor = read_editor(&dir);
    let lu = LastUpload {
        server: server.to_string(),
        music_id,
        audio_mtime_ms,
        jacket_mtime_ms,
    };
    editor.last_upload = Some(lu.clone());
    let bytes = serde_json::to_vec_pretty(&editor).ok()?;
    write_atomic(&dir.join("editor.json"), &bytes).ok()?;
    Some(lu)
}

pub struct UpdateBundle {
    pub manifest: Manifest,
    /// (level, level_number, chart json bytes) — the full desired chart state.
    pub charts: Vec<(u32, u32, Vec<u8>)>,
    /// Levels 1–4 with no local chart — sent as remove_chart_{N}.
    pub removed_levels: Vec<u32>,
    /// Only present when changed since the recorded upload.
    pub audio: Option<(String, Vec<u8>)>,
    pub jacket: Option<(String, Vec<u8>)>,
    /// mtimes to record after a successful update (see UploadBundle).
    pub audio_mtime_ms: Option<u64>,
    pub jacket_mtime_ms: Option<u64>,
}

pub fn collect_update(app: &AppHandle, id: &str) -> Result<UpdateBundle, String> {
    let dir = project_dir(app, id)?;
    let manifest = read_manifest(&dir)?;
    let editor = read_editor(&dir);
    let last = editor.last_upload.as_ref();

    let charts = effective_levels(&dir, &manifest)
        .into_iter()
        .map(|lm| {
            Ok((
                lm.level,
                lm.level_number,
                fs::read(chart_path(&dir, lm.level)).map_err(es)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let removed_levels = (1..=4).filter(|l| !chart_path(&dir, *l).exists()).collect();

    /// (asset to send if it changed, its current mtime to record)
    type ChangedAsset = (Option<(String, Vec<u8>)>, Option<u64>);
    let changed_asset = |stem: &str, recorded: Option<u64>| -> Result<ChangedAsset, String> {
        match find_asset(&dir, stem) {
            Some((ext, path)) => {
                let now = mtime_ms(&path);
                if now.is_some() && now == recorded {
                    Ok((None, recorded)) // unchanged since last upload/update
                } else {
                    Ok((Some((ext, fs::read(&path).map_err(es)?)), now))
                }
            }
            None => Ok((None, None)), // absent locally = keep the server's copy
        }
    };
    let (audio, audio_mtime_ms) = changed_asset("audio", last.and_then(|l| l.audio_mtime_ms))?;
    let (jacket, jacket_mtime_ms) = changed_asset("jacket", last.and_then(|l| l.jacket_mtime_ms))?;

    Ok(UpdateBundle {
        manifest,
        charts,
        removed_levels,
        audio,
        jacket,
        audio_mtime_ms,
        jacket_mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Charts on disk are stored verbatim from imports, so every shape of
    /// `notes_level` that SIF1 tooling emits has to keep loading.
    #[test]
    fn notes_level_tolerates_wild_charts() {
        let load = |extra: &str| -> u32 {
            let json = format!(r#"{{"timing_sec":1.5,"position":5,"effect":11{extra}}}"#);
            serde_json::from_str::<SifNote>(&json).unwrap().notes_level
        };
        assert_eq!(load(""), 0);
        assert_eq!(load(r#","notes_level":null"#), 0);
        assert_eq!(load(r#","notes_level":2"#), 2);
        assert_eq!(load(r#","notes_level":1.0"#), 1);
        assert_eq!(load(r#","notes_level":-1"#), 0);
        // and zero stays off the wire
        let note = SifNote {
            timing_sec: 1.0,
            position: 1,
            effect: 1,
            effect_value: 0.0,
            notes_level: 0,
        };
        assert!(!serde_json::to_string(&note).unwrap().contains("notes_level"));
    }

    // Traced from a real field report: a chart's note kept getting flagged as
    // off-grid every time the project was reopened, even though the editor sent the
    // exact right value on every save. Root cause: serde_json 1.0.150 parses the
    // decimal string "1.9242268041237114" back as the ADJACENT f64 (one ULP off,
    // 1.9242268041237112) instead of the value that string actually names — a
    // parser bug, not anything wrong on the editor's side. Full 17-significant-digit
    // doubles are the only representations that can exercise this; round6ing at
    // toSif() (see chart.ts) keeps the app from ever emitting one. This test just
    // guards against a serde_json upgrade silently fixing (or moving) the bug from
    // under us without anyone noticing this comment.
    #[test]
    fn serde_json_1_0_150_mis_parses_this_specific_decimal_string() {
        let v: f64 = serde_json::from_str("1.9242268041237114").unwrap();
        assert_eq!(v, 1.9242268041237112, "if this fails, serde_json's parser bug is fixed — the round6 workaround in chart.ts's toSif() may no longer be load-bearing");
    }
}

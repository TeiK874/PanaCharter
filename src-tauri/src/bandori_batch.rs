//! Batch import of Bandori (BanG Dream!) songs from game asset bundles.
//!
//! Half-integration of ethanaobrien/bandori-sif2-tools' bulk pipeline: the user
//! feeds the app any mix of `musicscoreNN` bundles (`.note` charts + chorus
//! clips), `sound/bgmNNN` bundles (the full song as a split CRI ACB), and
//! `musicjacketNN` bundles (ASTC-compressed jacket textures). A scan session
//! groups everything per song; import creates one local project per song:
//!
//! - charts: extracted here, converted by the frontend's existing (verified)
//!   Bandori `.note` converter;
//! - audio: split ACB chunks reassembled → the HCA stream inside the AFS2
//!   container is handed to `ffmpeg` (system binary, optional) → ogg vorbis;
//! - jacket: Texture2D located via the bundle's container table, ASTC/ETC2
//!   decoded, re-encoded as PNG;
//! - title/band metadata: bestdori.com API dumps (cached), matched by the
//!   chart's `#BGM bgmNNN` id — the bestdori song id IS the bgm number.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::bundle::{Cur, read_serialized_file, read_unityfs};

const DIFFICULTIES: [&str; 6] = ["easy", "normal", "hard", "expert", "special", "command"];

#[derive(Default)]
struct SongParts {
    /// difficulty name → .note text
    charts: BTreeMap<String, String>,
    bgm_id: Option<String>,
}

#[derive(Default)]
struct Session {
    songs: HashMap<String, SongParts>,
    /// bgm id ("bgm009") → acb chunk (name, bytes); order restored at import
    bgm: HashMap<String, Vec<(String, Vec<u8>)>>,
    /// song stem → decoded jacket PNG
    jackets: HashMap<String, Vec<u8>>,
}

#[derive(Default)]
pub struct BandoriBatch {
    sessions: Mutex<HashMap<String, Session>>,
}

// ---------------------------------------------------------------------------
// bundle scanning
// ---------------------------------------------------------------------------

/// "{stem}_{difficulty}" → (stem, difficulty)
fn split_chart_name(name: &str) -> Option<(String, String)> {
    for diff in DIFFICULTIES {
        if let Some(stem) = name.strip_suffix(&format!("_{diff}")) {
            if !stem.is_empty() {
                return Some((stem.to_string(), diff.to_string()));
            }
        }
    }
    None
}

/// "bgm009-014.acb" / "bgm009.acb" → "bgm009"
fn split_bgm_name(name: &str) -> Option<String> {
    let rest = name.strip_suffix(".acb")?;
    let base = rest.split('-').next()?;
    if base.starts_with("bgm") && base[3..].chars().all(|c| c.is_ascii_digit()) && base.len() > 3 {
        Some(base.to_string())
    } else {
        None
    }
}

/// The bgm id actually referenced by the chart. The `#BGM` header is
/// unreliable (stale copy-paste values in real data) — the ground truth is the
/// `#WAVxx bgmNNN.wav` keysound entry played on the BGM channel.
fn note_bgm_id(text: &str) -> Option<String> {
    let mut header_bgm = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("#WAV") {
            // char-boundary-safe: bundle text is untrusted lossy UTF-8
            let value = line.split_whitespace().nth(1).unwrap_or("");
            if let Some(base) = value.strip_suffix(".wav") {
                if base.len() > 3
                    && base.starts_with("bgm")
                    && base[3..].chars().all(|c| c.is_ascii_digit())
                {
                    return Some(base.to_string());
                }
            }
        } else if let Some(rest) = line.strip_prefix("#BGM ") {
            let id = rest.trim().trim_end_matches(".wav").to_string();
            if !id.is_empty() {
                header_bgm = Some(id);
            }
        }
    }
    header_bgm
}

struct Texture {
    width: usize,
    height: usize,
    format: i32,
    data: TextureData,
}

enum TextureData {
    Inline(Vec<u8>),
    Streamed { path: String, offset: u64, size: u32 },
}

/// Parse a Texture2D object (Unity 2020–2022 layouts, tolerant).
fn parse_texture2d(data: &[u8], be: bool) -> Result<Texture, String> {
    let mut c = Cur::new(data);
    let _name = c.ustring(be)?;
    let _forced_fallback = c.i32(be)?;
    c.skip(2)?; // m_DownscaleFallback + m_IsAlphaChannelOptional
    c.align(4);
    let width = c.i32(be)?;
    let height = c.i32(be)?;
    let _complete_size = c.u32(be)?;
    let _mips_stripped = c.i32(be)?;
    let format = c.i32(be)?;
    let _mip_count = c.i32(be)?;
    c.skip(4)?; // bools: readable / preprocessed / mip-limit / streaming
    if !(1..=16384).contains(&width) || !(1..=16384).contains(&height) || !(1..=100).contains(&format) {
        return Err("not a texture we understand".into());
    }

    // 2022.2+ has m_MipmapLimitGroupName here; 2020/2021 doesn't. Try both.
    for with_group_name in [true, false] {
        let mut c = Cur::new(data);
        // Re-position: cheapest is to re-parse the prefix.
        let _ = c.ustring(be)?;
        let _ = c.i32(be)?;
        c.skip(2)?;
        c.align(4);
        for _ in 0..6 {
            let _ = c.i32(be)?;
        }
        c.skip(4)?;
        if with_group_name {
            // 2022.2+: m_MipmapLimitGroupName, then m_StreamingMipmaps gets
            // its own bool word (in ≤2021 it packs into the earlier bool block)
            if c.ustring(be).is_err() || c.skip(4).is_err() {
                continue;
            }
        }
        let _priority = c.i32(be);
        let image_count = match c.i32(be) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let dimension = match c.i32(be) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if dimension != 2 || !(1..=8).contains(&image_count) {
            continue;
        }
        // GLTextureSettings (6 ints) + lightmap + colorspace
        if c.skip(8 * 4).is_err() {
            continue;
        }
        let blob_len = match c.u32(be) {
            Ok(v) => v as usize,
            Err(_) => continue,
        };
        if c.skip(blob_len).is_err() {
            continue;
        }
        c.align(4);
        let image_size = match c.u32(be) {
            Ok(v) => v as usize,
            Err(_) => continue,
        };
        if image_size > 0 {
            let Ok(bytes) = c.take(image_size) else { continue };
            return Ok(Texture {
                width: width as usize,
                height: height as usize,
                format,
                data: TextureData::Inline(bytes.to_vec()),
            });
        }
        let (Ok(offset), Ok(size), Ok(path)) = (c.u64(be), c.u32(be), c.ustring(be)) else {
            continue;
        };
        if size == 0 || path.is_empty() {
            continue;
        }
        return Ok(Texture {
            width: width as usize,
            height: height as usize,
            format,
            data: TextureData::Streamed { path, offset, size },
        });
    }
    Err("unrecognized Texture2D layout".into())
}

fn decode_texture_to_png(tex: &Texture, raw: &[u8]) -> Result<Vec<u8>, String> {
    let (w, h) = (tex.width, tex.height);
    let mut pixels: Vec<u32> = vec![0; w * h];
    let r = match tex.format {
        3 => {
            // RGB24
            for (i, px) in raw.chunks_exact(3).take(w * h).enumerate() {
                pixels[i] = u32::from_le_bytes([px[2], px[1], px[0], 255]);
            }
            Ok(())
        }
        4 => {
            // RGBA32
            for (i, px) in raw.chunks_exact(4).take(w * h).enumerate() {
                pixels[i] = u32::from_le_bytes([px[2], px[1], px[0], px[3]]);
            }
            Ok(())
        }
        34 => texture2ddecoder::decode_etc1(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        45 => texture2ddecoder::decode_etc2_rgb(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        46 => texture2ddecoder::decode_etc2_rgba1(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        47 => texture2ddecoder::decode_etc2_rgba8(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        48 => texture2ddecoder::decode_astc_4_4(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        49 => texture2ddecoder::decode_astc_5_5(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        50 => texture2ddecoder::decode_astc_6_6(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        51 | 57 => texture2ddecoder::decode_astc_8_8(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        52 | 58 => texture2ddecoder::decode_astc_10_10(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        53 | 59 => texture2ddecoder::decode_astc_12_12(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        54 => texture2ddecoder::decode_astc_4_4(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        55 => texture2ddecoder::decode_astc_5_5(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        56 => texture2ddecoder::decode_astc_6_6(raw, w, h, &mut pixels).map_err(|e| e.to_string()),
        other => Err(format!("unsupported texture format {other}")),
    };
    r.map_err(|e| format!("texture decode failed: {e}"))?;

    // decoder output is BGRA (one u32 per pixel, little-endian ARGB); Unity
    // textures are bottom-up, so flip rows while converting to RGBA
    let mut rgba = vec![0u8; w * h * 4];
    for y in 0..h {
        let src_row = h - 1 - y;
        for x in 0..w {
            let p = pixels[src_row * w + x].to_le_bytes(); // B G R A
            let o = (y * w + x) * 4;
            rgba[o] = p[2];
            rgba[o + 1] = p[1];
            rgba[o + 2] = p[0];
            rgba[o + 3] = p[3];
        }
    }

    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// AssetBundle (class 142): m_Container path → PPtr path_id.
fn parse_container(data: &[u8], be: bool) -> Result<Vec<(String, i64)>, String> {
    let mut c = Cur::new(data);
    let _name = c.ustring(be)?;
    let preload = c.u32(be)? as usize;
    if preload > 1_000_000 {
        return Err("implausible preload table".into());
    }
    c.skip(preload * 12)?; // PPtr: fileID i32 + pathID i64
    let count = c.u32(be)? as usize;
    if count > 1_000_000 {
        return Err("implausible container".into());
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let path = c.ustring(be)?;
        let _preload_index = c.i32(be)?;
        let _preload_size = c.i32(be)?;
        let _file_id = c.i32(be)?;
        let path_id = c.i64(be)?;
        out.push((path, path_id));
    }
    Ok(out)
}

fn scan_bundle(session: &mut Session, bytes: &[u8]) -> Result<(), String> {
    let files = read_unityfs(bytes)?;
    let ress: HashMap<&str, &Vec<u8>> = files
        .iter()
        .filter(|(p, _)| p.ends_with(".resS"))
        .map(|(p, c)| (p.rsplit('/').next().unwrap_or(p), c))
        .collect();

    for (path, content) in &files {
        if path.ends_with(".resS") {
            continue;
        }
        let Ok((objects, data_offset, be)) = read_serialized_file(content) else {
            continue;
        };
        let payload = |start: u64, size: u32| -> Option<&[u8]> {
            let s = data_offset.checked_add(start)? as usize;
            let e = s.checked_add(size as usize)?;
            content.get(s..e)
        };

        let mut textures: HashMap<i64, Texture> = HashMap::new();
        let mut container: Vec<(String, i64)> = Vec::new();

        for obj in &objects {
            let Some(data) = payload(obj.byte_start, obj.byte_size) else {
                continue;
            };
            match obj.class_id {
                49 => {
                    let mut c = Cur::new(data);
                    let Ok(name) = c.ustring(be) else { continue };
                    let Ok(len) = c.u32(be) else { continue };
                    let Ok(body) = c.take(len as usize) else { continue };
                    if let Some(bgm) = split_bgm_name(&name) {
                        let chunks = session.bgm.entry(bgm).or_default();
                        // re-scanning the same bundle must replace, not duplicate —
                        // duplicated chunks interleave into a corrupt ACB
                        if let Some(existing) = chunks.iter_mut().find(|(n, _)| *n == name) {
                            existing.1 = body.to_vec();
                        } else {
                            chunks.push((name, body.to_vec()));
                        }
                    } else if let Some((stem, diff)) = split_chart_name(&name) {
                        let text = String::from_utf8_lossy(body).into_owned();
                        let entry = session.songs.entry(stem).or_default();
                        if entry.bgm_id.is_none() {
                            entry.bgm_id = note_bgm_id(&text);
                        }
                        entry.charts.insert(diff, text);
                    }
                    // chorusNNN.acb and other assets: ignored
                }
                28 => match parse_texture2d(data, be) {
                    Ok(tex) => {
                        textures.insert(obj.path_id, tex);
                    }
                    Err(e) => {
                        if std::env::var_os("CHARTER_BATCH_DEBUG").is_some() {
                            eprintln!("texture2d parse failed: {e}");
                        }
                    }
                },
                142 => match parse_container(data, be) {
                    Ok(c) => container = c,
                    Err(e) => {
                        if std::env::var_os("CHARTER_BATCH_DEBUG").is_some() {
                            eprintln!("container parse failed: {e}");
                        }
                    }
                },
                _ => {}
            }
        }

        // resolve jackets via container paths: .../musicjacketNN/<stem>/jacket.png
        for (cpath, path_id) in &container {
            let lower = cpath.to_lowercase();
            if !lower.ends_with("/jacket.png") {
                continue;
            }
            let Some(stem) = lower.rsplit('/').nth(1).map(|s| s.to_string()) else {
                continue;
            };
            let Some(tex) = textures.get(path_id) else {
                continue;
            };
            let raw: Vec<u8> = match &tex.data {
                TextureData::Inline(b) => b.clone(),
                TextureData::Streamed { path, offset, size } => {
                    let base = path.rsplit('/').next().unwrap_or(path);
                    let Some(res) = ress.get(base) else { continue };
                    let start = *offset as usize;
                    let Some(end) = start.checked_add(*size as usize) else {
                        continue;
                    };
                    let Some(slice) = res.get(start..end) else { continue };
                    slice.to_vec()
                }
            };
            match decode_texture_to_png(tex, &raw) {
                Ok(pngb) => {
                    session.jackets.insert(stem, pngb);
                }
                Err(e) => {
                    if std::env::var_os("CHARTER_BATCH_DEBUG").is_some() {
                        eprintln!("jacket decode failed for {stem}: {e}");
                    }
                }
            }
        }
        if std::env::var_os("CHARTER_BATCH_DEBUG").is_some() {
            eprintln!(
                "file {path}: {} objects, {} textures parsed, {} container entries",
                objects.len(),
                textures.len(),
                container.len()
            );
        }
    }
    Ok(())
}

fn catalog(session: &Session) -> Value {
    let mut songs: Vec<Value> = session
        .songs
        .iter()
        .map(|(stem, parts)| {
            let has_audio = parts
                .bgm_id
                .as_ref()
                .map(|b| session.bgm.contains_key(b))
                .unwrap_or(false);
            json!({
                "stem": stem,
                "difficulties": parts.charts.keys().collect::<Vec<_>>(),
                "bgm_id": parts.bgm_id,
                "has_audio": has_audio,
                "has_jacket": session.jackets.contains_key(stem),
            })
        })
        .collect();
    songs.sort_by(|a, b| a["stem"].as_str().cmp(&b["stem"].as_str()));
    json!({
        "songs": songs,
        "loose_bgm": session.bgm.len(),
        "loose_jackets": session.jackets.len(),
    })
}

// ---------------------------------------------------------------------------
// audio: split ACB chunks → HCA → ffmpeg → ogg
// ---------------------------------------------------------------------------

fn ffmpeg_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// Find the HCA stream inside a reassembled ACB (inside its AFS2/AWB section).
fn find_hca(acb: &[u8]) -> Option<&[u8]> {
    let afs2 = acb.windows(4).position(|w| w == b"AFS2")?;
    let tail = &acb[afs2..];
    let plain = tail.windows(4).position(|w| w == b"HCA\0");
    let masked = tail
        .windows(4)
        .position(|w| w == [0xC8, 0xC3, 0xC1, 0x00]);
    let start = match (plain, masked) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };
    Some(&tail[start..])
}

/// Decode to ogg (preferred) or wav; returns (extension, bytes).
fn decode_audio(
    cache_dir: &std::path::Path,
    bgm_id: &str,
    chunks: &[(String, Vec<u8>)],
) -> Result<(String, Vec<u8>), String> {
    if !ffmpeg_available() {
        return Err("ffmpeg not found on PATH — install it to import audio".into());
    }
    let mut sorted: Vec<&(String, Vec<u8>)> = chunks.iter().collect();
    sorted.sort_by_key(|(name, _)| {
        name.trim_end_matches(".acb")
            .rsplit('-')
            .next()
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0)
    });
    let acb: Vec<u8> = sorted.iter().flat_map(|(_, b)| b.iter().copied()).collect();
    let hca = find_hca(&acb).ok_or("no HCA stream found in the ACB")?;

    let dir = cache_dir.join("bandori-audio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let in_path = dir.join(format!("{bgm_id}.hca"));
    std::fs::write(&in_path, hca).map_err(|e| e.to_string())?;

    let attempts: [(&str, &[&str]); 2] = [
        ("ogg", &["-c:a", "libvorbis", "-q:a", "6"]),
        ("wav", &["-c:a", "pcm_s16le"]),
    ];
    let mut last_err = String::new();
    for (ext, args) in attempts {
        let out_path = dir.join(format!("{bgm_id}.{ext}"));
        let status = std::process::Command::new("ffmpeg")
            .arg("-y")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-i")
            .arg(&in_path)
            .args(args)
            .arg(&out_path)
            .output();
        match status {
            Ok(out) if out.status.success() => {
                let bytes = std::fs::read(&out_path).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&out_path);
                if bytes.len() > 1000 {
                    // keep the input until we're done — the wav fallback needs it
                    let _ = std::fs::remove_file(&in_path);
                    return Ok((ext.to_string(), bytes));
                }
                last_err = "ffmpeg produced an empty file".into();
            }
            Ok(out) => {
                last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let _ = std::fs::remove_file(&out_path);
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let _ = std::fs::remove_file(&in_path);
    Err(format!("ffmpeg decode failed: {last_err}"))
}

// ---------------------------------------------------------------------------
// bestdori metadata
// ---------------------------------------------------------------------------

fn first_filled(v: Option<&Value>) -> Option<String> {
    v?.as_array()?
        .iter()
        .find_map(|x| x.as_str().filter(|s| !s.is_empty()).map(String::from))
}

async fn fetch_cached(
    client: &reqwest::Client,
    app: &AppHandle,
    url: &str,
    file: &str,
) -> Result<Value, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file);
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < std::time::Duration::from_secs(7 * 24 * 3600))
        .unwrap_or(false);
    if fresh {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(v) = serde_json::from_slice(&bytes) {
                return Ok(v);
            }
        }
    }
    let fetched: Result<Value, String> = async {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("bestdori fetch failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("bestdori answered HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let v: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("bad bestdori data: {e}"))?;
        let _ = std::fs::write(&path, &bytes);
        Ok(v)
    }
    .await;
    match fetched {
        Ok(v) => Ok(v),
        // network down but a stale cache exists: better than nothing
        Err(e) => std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or(e),
    }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

fn session_header(request: &tauri::ipc::Request<'_>) -> Result<String, String> {
    request
        .headers()
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() < 100)
        .map(String::from)
        .ok_or("Missing session id".into())
}

/// Binary-body command: payload = one asset bundle.
#[tauri::command]
pub fn bandori_scan(
    state: State<'_, BandoriBatch>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let session_id = session_header(&request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    let mut sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
    let session = sessions.entry(session_id).or_default();
    scan_bundle(session, bytes)?;
    Ok(catalog(session))
}

#[tauri::command]
pub fn bandori_chart(
    state: State<'_, BandoriBatch>,
    session_id: String,
    stem: String,
    difficulty: String,
) -> Result<String, String> {
    let sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
    sessions
        .get(&session_id)
        .and_then(|s| s.songs.get(&stem))
        .and_then(|s| s.charts.get(&difficulty))
        .cloned()
        .ok_or_else(|| "Chart not found in this scan session".into())
}

/// Fetch bestdori titles/bands for every scanned song (cached on disk).
#[tauri::command]
pub async fn bandori_meta(
    app: AppHandle,
    state: State<'_, BandoriBatch>,
    server: State<'_, crate::server::ServerState>,
    session_id: String,
) -> Result<Value, String> {
    let bgm_ids: Vec<(String, String)> = {
        let sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let session = sessions.get(&session_id).ok_or("Unknown session")?;
        session
            .songs
            .iter()
            .filter_map(|(stem, p)| p.bgm_id.clone().map(|b| (stem.clone(), b)))
            .collect()
    };
    let songs = fetch_cached(
        &server.client,
        &app,
        "https://bestdori.com/api/songs/all.8.json",
        "bestdori_songs.json",
    )
    .await?;
    let bands = fetch_cached(
        &server.client,
        &app,
        "https://bestdori.com/api/bands/main.1.json",
        "bestdori_bands.json",
    )
    .await?;

    let mut out = serde_json::Map::new();
    for (stem, bgm) in bgm_ids {
        let digits: String = bgm.chars().filter(|c| c.is_ascii_digit()).collect();
        let key = digits.trim_start_matches('0');
        let key = if key.is_empty() { "0" } else { key };
        let Some(song) = songs.get(key) else { continue };
        let title = first_filled(song.get("musicTitle"));
        let band = song
            .get("bandId")
            .and_then(|b| b.as_i64())
            .and_then(|id| bands.get(id.to_string()))
            .and_then(|b| first_filled(b.get("bandName")));
        out.insert(stem, json!({ "title": title, "band": band }));
    }
    Ok(Value::Object(out))
}

#[derive(Serialize)]
pub struct BatchImportResult {
    pub summary: crate::projects::ProjectSummary,
    pub audio: String,
}

#[tauri::command]
pub fn bandori_import_song(
    app: AppHandle,
    state: State<'_, BandoriBatch>,
    session_id: String,
    stem: String,
    name: String,
    artist: String,
    bpm: Option<f64>,
    levels: BTreeMap<u32, u32>,
    charts: BTreeMap<u32, Vec<crate::projects::SifNote>>,
) -> Result<BatchImportResult, String> {
    if charts.is_empty() {
        return Err("No difficulties to import".into());
    }
    let (jacket, bgm_chunks) = {
        let sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let session = sessions.get(&session_id).ok_or("Unknown session")?;
        let parts = session.songs.get(&stem).ok_or("Song not in this session")?;
        let jacket = session.jackets.get(&stem).cloned();
        let chunks = parts
            .bgm_id
            .as_ref()
            .and_then(|b| session.bgm.get(b).map(|c| (b.clone(), c.clone())));
        (jacket, chunks)
    };

    let mut audio_status = "no audio bundle scanned for this song".to_string();
    let mut audio: Option<(String, Vec<u8>)> = None;
    if let Some((bgm_id, chunks)) = bgm_chunks {
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        match decode_audio(&cache, &bgm_id, &chunks) {
            Ok(a) => {
                audio_status = format!("ok ({})", a.0);
                audio = Some(a);
            }
            Err(e) => audio_status = e,
        }
    }

    let manifest = crate::projects::Manifest {
        format: 1,
        name,
        name_en: String::new(),
        short_name: String::new(),
        kana: String::new(),
        artist,
        artist_en: String::new(),
        attribute: 1,
        band_category: "OTHER".into(),
        bpm,
        preview_start_sec: None,
        preview_length_sec: None,
        levels: levels
            .iter()
            .map(|(l, n)| crate::projects::LevelMeta {
                level: *l,
                level_number: *n,
            })
            .collect(),
    };
    let summary = crate::projects::create_project_files(
        &app,
        &manifest,
        &charts,
        jacket.as_deref(),
        audio.as_ref().map(|(e, b)| (e.as_str(), b.as_slice())),
    )?;
    Ok(BatchImportResult {
        summary,
        audio: audio_status,
    })
}

#[tauri::command]
pub fn bandori_close(state: State<'_, BandoriBatch>, session_id: String) {
    state.sessions.lock().unwrap_or_else(|p| p.into_inner()).remove(&session_id);
}

#[cfg(test)]
mod tests {
    /// CHARTER_BANDORI_BUNDLES=/path/a,/path/b cargo test bandori_scan_real -- --nocapture
    #[test]
    fn bandori_scan_real() {
        let Ok(paths) = std::env::var("CHARTER_BANDORI_BUNDLES") else {
            return;
        };
        let mut session = super::Session::default();
        for p in paths.split(',') {
            let bytes = std::fs::read(p).unwrap();
            super::scan_bundle(&mut session, &bytes).unwrap();
        }
        println!("{}", serde_json::to_string_pretty(&super::catalog(&session)).unwrap());
        if let Ok(dir) = std::env::var("CHARTER_DUMP_DIR") {
            for (stem, png) in &session.jackets {
                std::fs::write(format!("{dir}/{stem}.png"), png).unwrap();
            }
            for (bgm, chunks) in &session.bgm {
                match super::decode_audio(std::path::Path::new(&dir), bgm, chunks) {
                    Ok((ext, bytes)) => {
                        println!("audio {bgm}: {} -> {} bytes", ext, bytes.len());
                        std::fs::write(format!("{dir}/{bgm}.{ext}"), bytes).unwrap();
                    }
                    Err(e) => println!("audio {bgm} FAILED: {e}"),
                }
            }
        }
    }
}

//! HTTP client for the ew custom-songs server.
//!
//! All management endpoints return HTTP 200 with `{"result":"ERR","message":…}` on
//! failure — only a disabled feature (or bad asset URL) yields a real 404.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct ServerState {
    pub client: reqwest::Client,
    pub session: Mutex<Session>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .expect("failed to build http client"),
            session: Mutex::new(Session::default()),
        }
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Session {
    pub server: Option<String>,
    pub uid: Option<u64>,
    pub token: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

pub fn load_saved_session(app: &AppHandle, state: &ServerState) {
    if let Ok(path) = settings_path(app) {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(saved) = serde_json::from_str::<Session>(&text) {
                *state.session.lock().unwrap() = saved;
            }
        }
    }
}

fn persist(app: &AppHandle, session: &Session) {
    if let Ok(path) = settings_path(app) {
        let _ = std::fs::write(path, serde_json::to_vec_pretty(session).unwrap());
    }
}

fn base_url(state: &ServerState) -> Result<String, String> {
    state
        .session
        .lock()
        .unwrap()
        .server
        .clone()
        .ok_or_else(|| "Not connected to a server".to_string())
}

fn cookie_header(state: &ServerState) -> Result<String, String> {
    let token = state
        .session
        .lock()
        .unwrap()
        .token
        .clone()
        .ok_or_else(|| "Not logged in".to_string())?;
    Ok(format!("ew_token={token}"))
}

fn net_err(e: reqwest::Error) -> String {
    format!("Network error: {e}")
}

fn check_envelope(v: Value) -> Result<Value, String> {
    if v.get("result").and_then(|r| r.as_str()) == Some("OK") {
        Ok(v)
    } else {
        Err(v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Server returned an error")
            .to_string())
    }
}

async fn parse_mgmt(resp: reqwest::Response) -> Result<Value, String> {
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Custom songs are disabled on this server".into());
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad server response: {e}"))?;
    check_envelope(v)
}

/// The server said our token is dead (24h expiry, or a webui login elsewhere
/// kicked it — sessions are single-use). Drop the stored token so the UI
/// reflects reality instead of a green dot on a corpse.
fn drop_dead_token(app: &AppHandle, state: &ServerState, err: String) -> String {
    if err == "Not logged in" {
        let mut sess = state.session.lock().unwrap();
        if sess.token.take().is_some() {
            persist(app, &sess);
        }
    }
    err
}

/// Connect to a server: normalize the URL, probe `/api/webui/serverInfo`, persist.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, ServerState>,
    server: String,
) -> Result<Value, String> {
    let mut url = server.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err("Server URL is required".into());
    }
    if !url.contains("://") {
        url = format!("http://{url}");
    }
    let resp = state
        .client
        .get(format!("{url}/api/webui/serverInfo"))
        .send()
        .await
        .map_err(|e| format!("Could not reach server: {e}"))?;
    let info: Value = resp
        .json()
        .await
        .map_err(|_| "That doesn't look like an ew server (bad serverInfo response)".to_string())?;
    {
        let mut sess = state.session.lock().unwrap();
        if sess.server.as_deref() != Some(url.as_str()) {
            sess.token = None; // a token never outlives its server
        }
        sess.server = Some(url);
        persist(&app, &sess);
    }
    Ok(info)
}

#[tauri::command]
pub async fn login(
    app: AppHandle,
    state: State<'_, ServerState>,
    uid: u64,
    password: String,
) -> Result<(), String> {
    let base = base_url(&state)?;
    let body = serde_json::to_string(&json!({ "uid": uid, "password": password })).unwrap();
    let resp = state
        .client
        .post(format!("{base}/api/webui/login"))
        .body(body)
        .send()
        .await
        .map_err(net_err)?;
    let mut token = None;
    for c in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(s) = c.to_str() {
            if let Some(rest) = s.strip_prefix("ew_token=") {
                token = Some(rest.split(';').next().unwrap_or("").to_string());
            }
        }
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad server response: {e}"))?;
    check_envelope(v)?;
    let token = token.ok_or("Server accepted the login but sent no session cookie")?;
    let mut sess = state.session.lock().unwrap();
    sess.uid = Some(uid);
    sess.token = Some(token);
    persist(&app, &sess);
    Ok(())
}

#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, ServerState>) -> Result<(), String> {
    if let (Ok(base), Ok(cookie)) = (base_url(&state), cookie_header(&state)) {
        let _ = state
            .client
            .get(format!("{base}/webui/logout"))
            .header("cookie", cookie)
            .send()
            .await;
    }
    let mut sess = state.session.lock().unwrap();
    sess.token = None;
    persist(&app, &sess);
    Ok(())
}

#[tauri::command]
pub fn session_info(state: State<'_, ServerState>) -> Value {
    let s = state.session.lock().unwrap();
    json!({ "server": s.server, "uid": s.uid, "logged_in": s.token.is_some() })
}

/// `GET /custom_song/mine` — songs owned by the logged-in user.
#[tauri::command]
pub async fn list_mine(app: AppHandle, state: State<'_, ServerState>) -> Result<Value, String> {
    let base = base_url(&state)?;
    let cookie = cookie_header(&state)?;
    let resp = state
        .client
        .get(format!("{base}/custom_song/mine"))
        .header("cookie", cookie)
        .send()
        .await
        .map_err(net_err)?;
    let v = parse_mgmt(resp).await.map_err(|e| drop_dead_token(&app, &state, e))?;
    Ok(v.get("songs").cloned().unwrap_or_else(|| json!([])))
}

/// `GET /custom_song/browse` — public catalog (plus own/shared songs when logged in).
#[tauri::command]
pub async fn browse_songs(app: AppHandle, state: State<'_, ServerState>) -> Result<Value, String> {
    let base = base_url(&state)?;
    let mut req = state.client.get(format!("{base}/custom_song/browse"));
    if let Ok(cookie) = cookie_header(&state) {
        req = req.header("cookie", cookie);
    }
    let resp = req.send().await.map_err(net_err)?;
    let v = parse_mgmt(resp).await.map_err(|e| drop_dead_token(&app, &state, e))?;
    Ok(v.get("songs").cloned().unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub async fn set_visibility(
    app: AppHandle,
    state: State<'_, ServerState>,
    music_id: u64,
    visibility: String,
    shared_with: Vec<u64>,
    downloads_disabled: Option<bool>,
) -> Result<(), String> {
    let base = base_url(&state)?;
    let cookie = cookie_header(&state)?;
    let mut body = json!({
        "music_id": music_id,
        "visibility": visibility,
        "shared_with": shared_with,
    });
    if let Some(d) = downloads_disabled {
        body["downloads_disabled"] = json!(d);
    }
    let resp = state
        .client
        .post(format!("{base}/custom_song/visibility"))
        .body(serde_json::to_string(&body).unwrap())
        .header("cookie", cookie)
        .send()
        .await
        .map_err(net_err)?;
    parse_mgmt(resp)
        .await
        .map_err(|e| drop_dead_token(&app, &state, e))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_song(
    app: AppHandle,
    state: State<'_, ServerState>,
    music_id: u64,
) -> Result<(), String> {
    let base = base_url(&state)?;
    let cookie = cookie_header(&state)?;
    let resp = state
        .client
        .post(format!("{base}/custom_song/delete"))
        .body(serde_json::to_string(&json!({ "music_id": music_id })).unwrap())
        .header("cookie", cookie)
        .send()
        .await
        .map_err(net_err)?;
    parse_mgmt(resp)
        .await
        .map_err(|e| drop_dead_token(&app, &state, e))?;
    Ok(())
}

/// Fetch a song's jacket for thumbnails (sessionless asset GET, proxied so the
/// webview never needs to load plain-http content itself).
#[tauri::command]
pub async fn fetch_jacket(
    state: State<'_, ServerState>,
    music_id: u64,
) -> Result<tauri::ipc::Response, String> {
    let base = base_url(&state)?;
    let resp = state
        .client
        .get(format!("{base}/custom_song/assets/{music_id}/jacket.png"))
        .send()
        .await
        .map_err(net_err)?;
    if !resp.status().is_success() {
        return Err(format!("Jacket not available (HTTP {})", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(net_err)?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// `POST /custom_song/upload` — multipart upload built from a local project.
#[tauri::command]
pub async fn upload_project(
    app: AppHandle,
    state: State<'_, ServerState>,
    project_id: String,
    visibility: String,
    shared_with: Vec<u64>,
    downloads_disabled: bool,
) -> Result<u64, String> {
    let base = base_url(&state)?;
    let cookie = cookie_header(&state)?;
    let bundle = crate::projects::collect_upload(&app, &project_id)?;
    let m = &bundle.manifest;
    if m.name.trim().is_empty() || m.artist.trim().is_empty() {
        return Err("Song name and artist are required".into());
    }
    if bundle.charts.is_empty() {
        return Err("At least one difficulty chart is required".into());
    }

    use reqwest::multipart::{Form, Part};
    let mut form = Form::new()
        .text("name", m.name.clone())
        .text("artist", m.artist.clone())
        .text("name_en", m.name_en.clone())
        .text("artist_en", m.artist_en.clone())
        .text("short_name", m.short_name.clone())
        .text("kana", m.kana.clone())
        .text("attribute", m.attribute.to_string())
        .text("band_category", m.band_category.clone())
        .text("visibility", visibility);
    if let Some(bpm) = m.bpm {
        form = form.text("bpm", bpm.to_string());
    }
    if let Some(v) = m.preview_start_sec {
        form = form.text("preview_start_sec", v.to_string());
    }
    if let Some(v) = m.preview_length_sec {
        form = form.text("preview_length_sec", v.to_string());
    }
    if !shared_with.is_empty() {
        // upload wants a comma-separated string (unlike /visibility's JSON array)
        let joined = shared_with
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        form = form.text("shared_with", joined);
    }
    if downloads_disabled {
        form = form.text("downloads_disabled", "1");
    }

    let (jacket_ext, jacket_bytes) = bundle.jacket;
    form = form.part(
        "jacket",
        Part::bytes(jacket_bytes).file_name(format!("jacket.{jacket_ext}")),
    );
    let (audio_ext, audio_bytes) = bundle.audio;
    form = form.part(
        "audio",
        Part::bytes(audio_bytes).file_name(format!("audio.{audio_ext}")),
    );
    for (level, level_number, chart_bytes) in bundle.charts {
        form = form.part(
            format!("chart_{level}"),
            Part::bytes(chart_bytes).file_name(format!("chart_{level}.json")),
        );
        form = form.text(format!("level_number_{level}"), level_number.to_string());
    }

    let resp = state
        .client
        .post(format!("{base}/custom_song/upload"))
        .header("cookie", cookie)
        .multipart(form)
        .send()
        .await
        .map_err(net_err)?;
    let v = parse_mgmt(resp).await.map_err(|e| drop_dead_token(&app, &state, e))?;
    let music_id = v
        .get("music_id")
        .and_then(|m| m.as_u64())
        .ok_or("Server did not return a music_id")?;
    crate::projects::record_upload(&app, &project_id, &base, music_id);
    Ok(music_id)
}

/// `POST /custom_song/update` — edit a song in place, keeping its music_id and
/// player score records. Sends the project's full desired state; audio/jacket are
/// only included when they changed since the last upload/update (mtime-tracked).
#[tauri::command]
pub async fn update_project(
    app: AppHandle,
    state: State<'_, ServerState>,
    project_id: String,
    music_id: u64,
) -> Result<u64, String> {
    let base = base_url(&state)?;
    let cookie = cookie_header(&state)?;
    let bundle = crate::projects::collect_update(&app, &project_id)?;
    let m = &bundle.manifest;
    if m.name.trim().is_empty() || m.artist.trim().is_empty() {
        return Err("Song name and artist are required".into());
    }
    if bundle.charts.is_empty() {
        return Err("At least one difficulty chart is required".into());
    }

    use reqwest::multipart::{Form, Part};
    let mut form = Form::new()
        .text("music_id", music_id.to_string())
        .text("name", m.name.clone())
        .text("artist", m.artist.clone())
        .text("name_en", m.name_en.clone())
        .text("artist_en", m.artist_en.clone())
        .text("short_name", m.short_name.clone())
        .text("kana", m.kana.clone())
        .text("attribute", m.attribute.to_string())
        .text("band_category", m.band_category.clone());
    if let Some(bpm) = m.bpm {
        form = form.text("bpm", bpm.to_string());
    }
    if let Some(v) = m.preview_start_sec {
        form = form.text("preview_start_sec", v.to_string());
    }
    if let Some(v) = m.preview_length_sec {
        form = form.text("preview_length_sec", v.to_string());
    }
    if let Some((ext, bytes)) = bundle.jacket {
        form = form.part("jacket", Part::bytes(bytes).file_name(format!("jacket.{ext}")));
    }
    if let Some((ext, bytes)) = bundle.audio {
        form = form.part("audio", Part::bytes(bytes).file_name(format!("audio.{ext}")));
    }
    for (level, level_number, chart_bytes) in bundle.charts {
        form = form.part(
            format!("chart_{level}"),
            Part::bytes(chart_bytes).file_name(format!("chart_{level}.json")),
        );
        form = form.text(format!("level_number_{level}"), level_number.to_string());
    }
    for level in bundle.removed_levels {
        form = form.text(format!("remove_chart_{level}"), "1");
    }

    let resp = state
        .client
        .post(format!("{base}/custom_song/update"))
        .header("cookie", cookie)
        .multipart(form)
        .send()
        .await
        .map_err(net_err)?;
    let v = parse_mgmt(resp).await.map_err(|e| drop_dead_token(&app, &state, e))?;
    let music_id = v
        .get("music_id")
        .and_then(|m| m.as_u64())
        .unwrap_or(music_id);
    crate::projects::record_upload(&app, &project_id, &base, music_id);
    Ok(music_id)
}

/// `GET /custom_song/download/{id}` — fetch an export package and import it
/// straight into a new local project.
#[tauri::command]
pub async fn download_song_to_project(
    app: AppHandle,
    state: State<'_, ServerState>,
    music_id: u64,
) -> Result<Value, String> {
    let base = base_url(&state)?;
    let mut req = state
        .client
        .get(format!("{base}/custom_song/download/{music_id}"));
    if let Ok(cookie) = cookie_header(&state) {
        req = req.header("cookie", cookie);
    }
    let resp = req.send().await.map_err(net_err)?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Custom songs are disabled on this server".into());
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.map_err(net_err)?;
    if content_type.contains("json") {
        let v: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("Bad server response: {e}"))?;
        check_envelope(v)?;
        return Err("Unexpected server response".into());
    }
    let summary = crate::projects::import_zip_bytes(&app, bytes.to_vec())?;
    Ok(serde_json::to_value(summary).unwrap())
}

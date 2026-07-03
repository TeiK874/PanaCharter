#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod bundle;
mod projects;
mod server;

use tauri::Manager;

fn main() {
    // WebKitGTK plays audio through GStreamer's pulsesink. On bridged audio
    // stacks (WSLg, some PipeWire setups) the default fragment size is tiny
    // and underruns audibly whenever the CPU spikes — heard as crackling or
    // stuttering playback. A bigger stream buffer fixes it; respect the
    // user's own value if they set one.
    if std::env::var_os("PULSE_LATENCY_MSEC").is_none() {
        // SAFETY: called before any other thread exists (pre-Tauri init).
        unsafe { std::env::set_var("PULSE_LATENCY_MSEC", "100") };
    }

    tauri::Builder::default()
        .manage(server::ServerState::new())
        .setup(|app| {
            let state = app.state::<server::ServerState>();
            server::load_saved_session(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            server::connect,
            server::login,
            server::logout,
            server::session_info,
            server::list_mine,
            server::browse_songs,
            server::set_visibility,
            server::delete_song,
            server::fetch_jacket,
            server::upload_project,
            server::update_project,
            server::download_song_to_project,
            projects::project_list,
            projects::project_create,
            projects::project_load,
            projects::project_save,
            projects::project_delete,
            projects::project_set_audio,
            projects::project_set_jacket,
            projects::project_load_audio,
            projects::project_get_jacket,
            projects::project_export,
            projects::project_import_zip,
            bundle::bundle_extract_charts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod audio_native;
mod bundle;
mod projects;
mod server;

use tauri::Manager;

fn main() {
    // Dev builds serve the frontend from disk, and WebKitGTK's HTTP cache
    // keeps serving stale JS across rebuilds (tauri:// responses carry no
    // validators). Drop the cache before the webview spins up so a dev
    // relaunch always runs current code. Release builds embed their assets.
    #[cfg(all(debug_assertions, target_os = "linux"))]
    {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".local/share"))
            });
        if let Some(base) = data_home {
            let _ = std::fs::remove_dir_all(base.join("dev.ethanobrien.charter/WebKitCache"));
        }
    }

    tauri::Builder::default()
        .manage(server::ServerState::new())
        .manage(audio_native::NativeAudio::new())
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
            audio_native::native_available,
            audio_native::native_play,
            audio_native::native_pause,
            audio_native::native_position,
            audio_native::native_set_ticks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

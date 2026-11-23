#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod audio_native;
mod bandori_batch;
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

    // Same class of risk on Windows: WebView2's asset requests ride its virtual-host
    // HTTP mechanism, and those responses carry no cache validators either — the same
    // gap the Linux workaround above targets, just never ported here. This was
    // investigated as a possible cause of a stale-data bug that turned out to be a
    // separate serde_json parsing issue (see the regression test in projects.rs), but
    // the underlying gap is real regardless, so the mitigation stays: cap the cache
    // sizes near zero (there's no official "disable" switch) since this is a local IPC
    // channel and a handful of small asset files, nothing that benefits from caching.
    // Also `--disable-direct-composition`: on some Windows 11 machines (AMD GPUs seen) the
    // mouse pointer's drawn image freezes for seconds in OS full screen while the real
    // pointer keeps working, which looks like Chromium's DirectComposition/multiplane-overlay
    // presentation (it never happens while a screen recorder is capturing the window).
    // Chromium apps report the flag stops it, and it did here too (WebView2, Windows 11).
    // Must be set before the WebView2 environment is created, i.e. before .run() below.
    #[cfg(target_os = "windows")]
    {
        // Safe: called before any other thread exists (start of main, before .run()).
        unsafe {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disk-cache-size=1 --media-cache-size=1 --disable-direct-composition",
            );
        }
    }

    tauri::Builder::default()
        .manage(server::ServerState::new())
        .manage(audio_native::NativeAudio::new())
        .manage(bandori_batch::BandoriBatch::default())
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
            audio_native::native_set_volume,
            bandori_batch::bandori_scan,
            bandori_batch::bandori_chart,
            bandori_batch::bandori_meta,
            bandori_batch::bandori_import_song,
            bandori_batch::bandori_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

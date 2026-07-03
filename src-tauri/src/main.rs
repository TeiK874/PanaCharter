#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod projects;
mod server;

use tauri::Manager;

fn main() {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

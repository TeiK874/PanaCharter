//! Opens one of the project's own web pages in the user's default browser (the About
//! dialog's links). A plain `<a href>` in the webview would navigate the whole app window
//! away, so the UI asks the backend instead.
//!
//! Only an exact allow-list of addresses is ever opened: the command is reachable from
//! page script, and an arbitrary address handed to the OS opener is more than a link.

const ALLOWED: &[&str] = &[
    "https://github.com/TeiK874/PanaCharter",
    "https://github.com/TeiK874/PanaCharter/releases",
    "https://git.ethanthesleepy.one/ethanaobrien",
    "https://git.ethanthesleepy.one/ethanaobrien/charter",
    "https://git.ethanthesleepy.one/ethanaobrien/ew",
];

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !ALLOWED.contains(&url.as_str()) {
        return Err("That address can't be opened from here".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&url);
    // Off the calling thread: a sync command runs on the main thread, and waiting for the
    // opener (which can take a moment to start the browser) would freeze the window. The exit
    // code is ignored — Windows' explorer reports 1 even when it opened the page.
    std::thread::spawn(move || {
        let _ = cmd.status();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_anything_off_the_list() {
        assert!(open_url("https://example.com".into()).is_err());
        assert!(open_url("https://github.com/TeiK874/PanaCharter/evil".into()).is_err());
        assert!(open_url("https://github.com/TeiK874/PanaCharter.evil.com".into()).is_err());
        assert!(open_url("file:///C:/Windows/System32/calc.exe".into()).is_err());
    }
}

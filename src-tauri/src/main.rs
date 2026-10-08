// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// The app runs on Chromium (CEF), and the same executable is also each of
/// Chromium's renderer, GPU and utility processes. This attribute runs that
/// helper side and returns before the app is ever built, for any process
/// Chromium launched with a `--type=` switch.
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    tk_review_lib::run()
}

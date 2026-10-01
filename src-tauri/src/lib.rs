mod commands;
pub mod error;
pub mod git;
pub mod github;
pub mod models;
pub mod review;
pub mod runs;

use tauri::Manager;

use crate::runs::AgentRuns;

/// The page zoom the UI starts at, set before the first paint so it never
/// flashes at 100%. `src/lib/zoom.ts` owns the level from there; keep the two
/// in step.
const DEFAULT_ZOOM: f64 = 0.8;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentRuns::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_zoom(DEFAULT_ZOOM)?;
                // A two-finger swipe walks the page's history, as in Safari.
                // The page keeps history in step with its screens (see
                // `src/lib/screenHistory.ts`), so this is back to the list.
                #[cfg(target_os = "macos")]
                window.with_webview(|webview| {
                    // SAFETY: on macOS the handle is the window's live WKWebView,
                    // and `with_webview` runs this on the main thread.
                    unsafe {
                        let view = &*webview.inner().cast::<objc2_web_kit::WKWebView>();
                        view.setAllowsBackForwardNavigationGestures(true);
                    }
                })?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::select_repo,
            commands::list_branches,
            commands::fetch_remotes,
            commands::list_prs,
            commands::open_pr,
            commands::refresh_pr,
            commands::post_pr_comment,
            commands::submit_pr_review,
            commands::get_github_image,
            commands::diff_branches,
            commands::get_patch,
            commands::list_commits,
            commands::get_file_versions,
            commands::review_diff,
            commands::re_review_diff,
            commands::explain_diff,
            commands::review_reply,
            commands::list_agent_models,
            commands::cancel_agent_run,
            commands::abandon_agent_runs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<AgentRuns>().kill_all();
            }
        });
}

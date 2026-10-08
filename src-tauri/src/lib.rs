mod commands;
pub mod error;
pub mod git;
pub mod github;
pub mod models;
pub mod review;
pub mod rules;
pub mod runs;

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::runs::AgentRuns;

/// The page zoom the UI starts at, set before the first paint so it never
/// flashes at 100%. `src/lib/zoom.ts` owns the level from there; keep the two
/// in step.
const DEFAULT_ZOOM: f64 = 0.8;

/// View's zoom items: menu id, title, hotkey, and the step sent to the page.
const ZOOM_ITEMS: [(&str, &str, &str, &str); 3] = [
    ("zoom-reset", "Actual Size", "CmdOrCtrl+0", "reset"),
    ("zoom-in", "Zoom In", "CmdOrCtrl+=", "in"),
    ("zoom-out", "Zoom Out", "CmdOrCtrl+-", "out"),
];

/// Tauri's default menu, with the zoom items at the top of View as in Safari.
/// The page owns the level and takes the same hotkeys itself (the webview
/// offers them to the page before the menu), so the items mostly show the keys; a
/// click reaches the page as a `zoom` event. Only macOS's default menu has a
/// View menu; elsewhere the hotkeys alone will do.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let view = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().is_ok_and(|text| text == "View") => {
            Some(submenu)
        }
        _ => None,
    });
    if let Some(view) = view {
        let items = ZOOM_ITEMS
            .iter()
            .map(|(id, title, hotkey, _)| MenuItem::with_id(app, *id, *title, true, Some(*hotkey)))
            .collect::<tauri::Result<Vec<_>>>()?;
        let separator = PredefinedMenuItem::separator(app)?;
        view.prepend_items(&[&items[0], &items[1], &items[2], &separator])?;
    }
    Ok(menu)
}

/// Chromium's profile, which holds the page's localStorage: saved reviews,
/// explanations, history. CEF keeps it under the user's cache folder unless told
/// otherwise, where cleanup tools and backups both treat it as disposable.
fn chromium_profile(identifier: &str) -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
        .join("cef")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let profile = chromium_profile(&context.config().identifier);
    tauri::Builder::default()
        .runtime(tauri_runtime_cef::Cef::default().root_cache_path(profile))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentRuns::default())
        .menu(app_menu)
        .on_menu_event(|app, event| {
            let step = ZOOM_ITEMS.iter().find(|(id, ..)| event.id() == *id);
            if let Some((.., step)) = step {
                let _ = app.emit("zoom", step);
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_zoom(DEFAULT_ZOOM)?;
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
            commands::pr_discussion,
            commands::submit_pr_review,
            commands::set_pr_thread_resolved,
            commands::get_github_image,
            commands::diff_branches,
            commands::get_patch,
            commands::list_commits,
            commands::get_file_versions,
            commands::review_diff,
            commands::get_repo_rules,
            commands::set_repo_rules,
            commands::re_review_diff,
            commands::explain_diff,
            commands::review_reply,
            commands::list_agent_models,
            commands::cancel_agent_run,
            commands::abandon_agent_runs,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<AgentRuns>().kill_all();
            }
        });
}

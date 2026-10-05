mod commands;
pub mod error;
pub mod git;
pub mod github;
pub mod models;
pub mod review;
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
/// The page owns the level and takes the same hotkeys itself (WebKit offers
/// them to the page before the menu), so the items mostly show the keys; a
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

/// WebKit holds a page to about 60 frames a second whatever the display can
/// do (Safari's "Prefer Page Rendering Updates near 60fps"), so every
/// transition ran at half a 120Hz screen's rate or less. The switch is a
/// feature flag with no public setter: it's found by key in WebKit's own list
/// of features, and left alone if this WebKit doesn't list it.
///
/// # Safety
///
/// `view` must be the live WKWebView, on the main thread.
#[cfg(target_os = "macos")]
unsafe fn render_at_display_rate(view: &objc2_web_kit::WKWebView) {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;

    const FLAG: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";
    let preferences = view.configuration().preferences();
    let Some(class) = AnyClass::get(c"WKPreferences") else {
        return;
    };
    let can_set: bool = msg_send![&*preferences, respondsToSelector: sel!(_setEnabled:forFeature:)];
    if !class.responds_to(sel!(_features)) || !can_set {
        return;
    }
    let features: Option<Retained<AnyObject>> = msg_send![class, _features];
    let Some(features) = features else {
        return;
    };
    let count: usize = msg_send![&*features, count];
    for index in 0..count {
        let feature: Retained<AnyObject> = msg_send![&*features, objectAtIndex: index];
        let key: Option<Retained<NSString>> = msg_send![&*feature, key];
        if key.is_some_and(|key| key.to_string() == FLAG) {
            let _: () = msg_send![&*preferences, _setEnabled: false, forFeature: &*feature];
            return;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
                        render_at_display_rate(view);
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

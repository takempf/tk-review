mod commands;
pub mod error;
pub mod git;
pub mod github;
pub mod models;
pub mod review;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::select_repo,
            commands::list_branches,
            commands::fetch_remotes,
            commands::list_prs,
            commands::open_pr,
            commands::refresh_pr,
            commands::post_pr_comment,
            commands::get_github_image,
            commands::diff_branches,
            commands::get_patch,
            commands::get_file_versions,
            commands::review_diff,
            commands::re_review_diff,
            commands::explain_diff,
            commands::review_reply,
            commands::list_agent_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

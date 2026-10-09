pub(crate) use std::collections::HashMap;
pub(crate) use std::io::{BufRead, BufReader, Read, Write};
pub(crate) use std::process::{Child, ChildStdin, Command, Stdio};
pub(crate) use std::sync::{Arc, Mutex};

pub(crate) use serde::Serialize;
pub(crate) use tauri::{AppHandle, Emitter, State};

mod claude;
mod logs;
mod pty;
mod sessions;
mod shell;

pub(crate) fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

pub(crate) fn expand_with(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_string();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => path.to_string(),
    }
}

pub(crate) fn expand(path: &str) -> String {
    expand_with(path, &home_dir())
}

pub(crate) const BRIEF_RULES: &str = "Keep answers short. Don't commit; I commit myself.\n\n";
pub(crate) const MAX_TOOL_OUTPUT: usize = 50_000;

pub(crate) fn strip_brief(text: &str) -> String {
    let text = match text.strip_prefix("You're working on Jira ticket ") {
        Some(rest) => rest.split_once("\n\n").map_or(text, |(_, r)| r),
        None => text,
    };
    text.strip_prefix(BRIEF_RULES).unwrap_or(text).to_string()
}

pub(crate) fn tilde_with(s: &str, home: &str) -> String {
    if home.is_empty() {
        s.to_string()
    } else {
        s.replace(home, "~")
    }
}

pub(crate) fn tilde(s: &str) -> String {
    tilde_with(s, &home_dir())
}

pub(crate) fn safe(v: &str) -> bool {
    !v.is_empty()
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']'))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(claude::Runs::default())
        .manage(pty::Ptys::default())
        .menu(|app| {
            use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
            Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "Cockpit",
                        true,
                        &[
                            &P::about(app, None, None)?,
                            &P::separator(app)?,
                            &P::hide(app, None)?,
                            &P::hide_others(app, None)?,
                            &P::separator(app)?,
                            &P::quit(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &P::undo(app, None)?,
                            &P::redo(app, None)?,
                            &P::separator(app)?,
                            &P::cut(app, None)?,
                            &P::copy(app, None)?,
                            &P::paste(app, None)?,
                            &P::select_all(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Window",
                        true,
                        &[&P::minimize(app, None)?, &P::fullscreen(app, None)?],
                    )?,
                ],
            )
        })
        .invoke_handler(tauri::generate_handler![
            claude::claude_send,
            claude::claude_write,
            claude::claude_close,
            claude::claude_stop,
            claude::claude_probe,
            claude::claude_oneshot,
            sessions::claude_sessions,
            sessions::claude_transcript,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            shell::shell_commands,
            shell::git_info,
            logs::logs_load_all,
            logs::log_save,
            shell::shell_history,
            shell::complete_path,
            shell::run_command,
            shell::list_files,
            shell::append_file,
            shell::read_settings,
            sessions::session_rewind
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests;

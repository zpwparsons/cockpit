use crate::*;

#[tauri::command]
pub(crate) async fn shell_commands() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = Command::new("/bin/zsh")
            .args(["-lic", "print -rl -- ${(k)commands} ${(k)aliases} ${(k)builtins} ${(k)functions} ${(k)reswords}"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn parse_history(text: &str) -> Vec<String> {
    {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let mut entry = String::new();
        let mut entries = Vec::new();
        for line in text.lines() {
            if let Some(rest) = entry.strip_suffix('\\') {
                entry = format!("{rest}\n{line}");
            } else {
                if !entry.is_empty() {
                    entries.push(std::mem::take(&mut entry));
                }
                entry = line.to_string();
            }
        }
        entries.push(entry);
        for e in entries.into_iter().rev() {
            let cmd = if e.starts_with(": ") {
                e.split_once(';').map_or(e.as_str(), |(_, c)| c).to_string()
            } else {
                e
            };
            let cmd = cmd.trim().to_string();
            if !cmd.is_empty() && seen.insert(cmd.clone()) {
                out.push(cmd);
                if out.len() >= 5000 {
                    break;
                }
            }
        }
        out
    }
}

#[tauri::command]
pub(crate) async fn shell_history() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = std::env::var("HISTFILE").unwrap_or_else(|_| expand("~/.zsh_history"));
        let bytes = std::fs::read(path).unwrap_or_default();
        parse_history(&String::from_utf8_lossy(&bytes))
    })
    .await
    .unwrap_or_default()
}

pub(crate) fn complete_path_in(cwd: &str, partial: &str, home: &str) -> Vec<String> {
    {
        let (dir_part, prefix) = partial
            .rsplit_once('/')
            .map_or(("", partial), |(d, p)| (d, p));
        let base = if partial.starts_with('/') {
            std::path::PathBuf::from(if dir_part.is_empty() { "/" } else { dir_part })
        } else if partial.starts_with('~') {
            std::path::PathBuf::from(expand_with(&format!("{dir_part}/"), home))
        } else {
            std::path::PathBuf::from(expand_with(cwd, home)).join(dir_part)
        };
        let lead = if partial.contains('/') {
            format!("{dir_part}/")
        } else {
            String::new()
        };
        let mut out: Vec<String> = std::fs::read_dir(base)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        if !name.starts_with(prefix)
                            || (name.starts_with('.') && !prefix.starts_with('.'))
                        {
                            return None;
                        }
                        let dir =
                            e.file_type().map(|t| t.is_dir()).unwrap_or(false) || e.path().is_dir();
                        Some(format!("{lead}{name}{}", if dir { "/" } else { "" }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort();
        out.truncate(200);
        out
    }
}

#[tauri::command]
pub(crate) async fn complete_path(cwd: String, partial: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || complete_path_in(&cwd, &partial, &home_dir()))
        .await
        .unwrap_or_default()
}

#[derive(Serialize)]
pub(crate) struct CommandOutput {
    pub(crate) output: String,
    pub(crate) code: i32,
}

#[tauri::command]
pub(crate) async fn run_command(
    cwd: String,
    cmd: String,
    input: Option<String>,
) -> Result<CommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("/bin/zsh")
            .args(["-lc", &format!("{{ {cmd}\n}} 2>&1")])
            .current_dir(expand(&cwd))
            .env("TERM", "xterm-256color")
            .env("CLICOLOR_FORCE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.unwrap_or_default().as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
        output.truncate(output.floor_char_boundary(MAX_TOOL_OUTPUT));
        Ok(CommandOutput {
            output,
            code: out.status.code().unwrap_or(1),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) type FileCache = Mutex<HashMap<String, (std::time::Instant, Arc<Vec<String>>)>>;
pub(crate) static FILE_CACHE: std::sync::OnceLock<FileCache> = std::sync::OnceLock::new();

pub(crate) fn project_files(dir: &str) -> Arc<Vec<String>> {
    let cache = FILE_CACHE.get_or_init(Default::default);
    if let Some((at, files)) = cache.lock().unwrap().get(dir) {
        if at.elapsed() < std::time::Duration::from_secs(15) {
            return files.clone();
        }
    }
    let files: Vec<String> = Command::new("git")
        .args([
            "-C",
            dir,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| {
            std::fs::read_dir(dir)
                .map(|rd| {
                    rd.filter_map(Result::ok)
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        });
    let files = Arc::new(files);
    cache
        .lock()
        .unwrap()
        .insert(dir.to_string(), (std::time::Instant::now(), files.clone()));
    files
}

#[tauri::command]
pub(crate) async fn list_files(cwd: String, query: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = project_files(&expand(&cwd));
        let q = query.to_lowercase();
        let mut hits: Vec<(usize, &String)> = files
            .iter()
            .filter_map(|f| {
                let lower = f.to_lowercase();
                let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
                let rank = if q.is_empty() {
                    2
                } else if name.starts_with(&q) {
                    0
                } else if lower.contains(&q) {
                    1
                } else {
                    return None;
                };
                Some((rank, f))
            })
            .collect();
        hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.len().cmp(&b.1.len())));
        hits.into_iter().take(50).map(|(_, f)| f.clone()).collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub(crate) async fn append_file(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::PathBuf::from(expand(&path));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let sep = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        std::fs::write(&path, format!("{existing}{sep}{text}\n")).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn read_settings(cwd: String) -> Vec<(String, serde_json::Value)> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&cwd);
        [
            expand("~/.claude/settings.json"),
            format!("{dir}/.claude/settings.json"),
            format!("{dir}/.claude/settings.local.json"),
        ]
        .into_iter()
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            Some((tilde(&p), serde_json::from_str(&text).ok()?))
        })
        .collect()
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize)]
pub(crate) struct GitInfo {
    pub(crate) branch: String,
    pub(crate) dirty: bool,
}

pub(crate) fn parse_git_status(text: &str) -> Option<GitInfo> {
    let mut lines = text.lines();
    let head = lines.next()?.strip_prefix("## ")?;
    let branch = head
        .strip_prefix("No commits yet on ")
        .unwrap_or(head)
        .split("...")
        .next()?
        .to_string();
    Some(GitInfo {
        branch,
        dirty: lines.next().is_some(),
    })
}

#[tauri::command]
pub(crate) async fn git_info(cwd: String) -> Option<GitInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&cwd);
        let out = Command::new("git")
            .args(["-C", &dir, "status", "--porcelain=v1", "--branch"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_git_status(&String::from_utf8_lossy(&out.stdout))
    })
    .await
    .ok()
    .flatten()
}

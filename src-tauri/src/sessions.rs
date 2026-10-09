use crate::*;

pub(crate) fn session_dir(cwd: &str) -> std::path::PathBuf {
    let encoded: String = expand(cwd)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    std::path::PathBuf::from(expand("~/.claude/projects")).join(encoded)
}

#[derive(Serialize)]
pub(crate) struct SessionInfo {
    pub(crate) id: String,
    pub(crate) modified: u64,
    pub(crate) title: String,
    pub(crate) branch: String,
    pub(crate) size: u64,
}

pub(crate) fn session_title(path: &std::path::Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let mut branch = String::new();
    let mut title = None;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(400) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if branch.is_empty() {
            if let Some(b) = v["gitBranch"].as_str() {
                branch = b.to_string();
            }
        }
        if v["type"] == "summary" {
            if let Some(s) = v["summary"].as_str() {
                return Some((s.to_string(), branch));
            }
        }
        if title.is_some() {
            if !branch.is_empty() {
                break;
            }
            continue;
        }
        if v["type"] != "user" || v["isMeta"] == true {
            continue;
        }
        let text = match &v["message"]["content"] {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter_map(|b| (b["type"] == "text").then(|| b["text"].as_str()).flatten())
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        let text = strip_brief(&text);
        let text = text.trim();
        if !text.is_empty() && !text.starts_with('<') {
            title = Some(text.chars().take(120).collect::<String>());
        }
    }
    title.map(|t| (t, branch))
}

pub(crate) fn sessions_in(dir: &std::path::Path) -> Result<Vec<SessionInfo>, String> {
    {
        let mut files: Vec<(u64, u64, std::path::PathBuf)> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                let modified = meta
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_millis() as u64;
                Some((modified, meta.len(), e.path()))
            })
            .collect();
        files.sort_by_key(|f| std::cmp::Reverse(f.0));
        Ok(files
            .into_iter()
            .filter_map(|(modified, size, path)| {
                let (title, branch) = session_title(&path)?;
                Some(SessionInfo {
                    id: path.file_stem()?.to_string_lossy().into_owned(),
                    modified,
                    title,
                    branch,
                    size,
                })
            })
            .take(40)
            .collect())
    }
}

#[tauri::command]
pub(crate) async fn claude_sessions(cwd: String) -> Result<Vec<SessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions_in(&session_dir(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn tool_detail(input: &serde_json::Value) -> String {
    [
        "command",
        "file_path",
        "pattern",
        "path",
        "url",
        "skill",
        "description",
    ]
    .iter()
    .find_map(|k| input[*k].as_str())
    .map(tilde)
    .unwrap_or_default()
}

#[derive(Serialize)]
pub(crate) struct Diff {
    pub(crate) old: String,
    pub(crate) new: String,
}

pub(crate) fn tool_diff(name: &str, input: &serde_json::Value) -> Option<Vec<Diff>> {
    let s = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    match name {
        "Edit" => Some(vec![Diff {
            old: s(input, "old_string"),
            new: s(input, "new_string"),
        }]),
        "MultiEdit" => Some(
            input["edits"]
                .as_array()?
                .iter()
                .map(|e| Diff {
                    old: s(e, "old_string"),
                    new: s(e, "new_string"),
                })
                .collect(),
        ),
        "Write" => Some(vec![Diff {
            old: String::new(),
            new: s(input, "content"),
        }]),
        _ => None,
    }
}

pub(crate) fn result_text(content: &serde_json::Value) -> String {
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    text.chars().take(MAX_TOOL_OUTPUT).collect()
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TranscriptItem {
    User {
        text: String,
    },
    Text {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        detail: String,
        diff: Option<Vec<Diff>>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
    },
}

pub(crate) fn prompt_text(t: &str) -> Option<String> {
    if t.starts_with("<local-command-stdout>") {
        return None;
    }
    if let Some(rest) = t.strip_prefix("<command-name>") {
        let name = rest.split("</command-name>").next().unwrap_or_default();
        let args = t
            .split("<command-args>")
            .nth(1)
            .and_then(|a| a.split("</command-args>").next())
            .unwrap_or_default();
        return Some(format!("{name} {args}").trim().to_string());
    }
    if t.starts_with("<bash-input>") {
        return Some(strip_brief(
            t.rsplit_once("</bash-stdout>")
                .map_or(t, |(_, r)| r)
                .trim_start(),
        ));
    }
    (!t.starts_with('<')).then(|| strip_brief(t))
}

pub(crate) fn transcript_items(line: &str) -> Vec<TranscriptItem> {
    let Ok(m) = serde_json::from_str::<serde_json::Value>(line) else {
        return vec![];
    };
    if m["isMeta"] == true || m["isSidechain"] == true {
        return vec![];
    }
    let content = &m["message"]["content"];
    let user_text = |t: &str| prompt_text(t).map(|text| TranscriptItem::User { text });
    match m["type"].as_str() {
        Some("user") => match content {
            serde_json::Value::String(t) => user_text(t).into_iter().collect(),
            serde_json::Value::Array(blocks) => {
                let mut items: Vec<TranscriptItem> = blocks
                    .iter()
                    .filter_map(|b| match b["type"].as_str() {
                        Some("tool_result") => Some(TranscriptItem::ToolResult {
                            id: b["tool_use_id"].as_str().unwrap_or_default().to_string(),
                            output: result_text(&b["content"]),
                            is_error: b["is_error"] == true,
                        }),
                        Some("text") => user_text(b["text"].as_str().unwrap_or_default()),
                        _ => None,
                    })
                    .collect();
                if items.is_empty() && blocks.iter().any(|b| b["type"] == "image") {
                    items.push(TranscriptItem::User {
                        text: "[image]".into(),
                    });
                }
                items
            }
            _ => vec![],
        },
        Some("assistant") => content
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| match b["type"].as_str() {
                        Some("text") => {
                            let t = b["text"].as_str().unwrap_or_default().trim();
                            (!t.is_empty()).then(|| TranscriptItem::Text {
                                text: t.to_string(),
                            })
                        }
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or_default();
                            Some(TranscriptItem::Tool {
                                id: b["id"].as_str().unwrap_or_default().to_string(),
                                name: name.to_string(),
                                detail: tool_detail(&b["input"]),
                                diff: tool_diff(name, &b["input"]),
                            })
                        }
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

#[tauri::command]
pub(crate) async fn claude_transcript(
    cwd: String,
    id: String,
) -> Result<Vec<TranscriptItem>, String> {
    if !safe(&id) {
        return Err("bad session id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(session_dir(&cwd).join(format!("{id}.jsonl")))
            .map_err(|e| e.to_string())?;
        Ok(BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .flat_map(|l| transcript_items(&l))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn session_rewind(
    cwd: String,
    id: String,
    keep_users: usize,
) -> Result<String, String> {
    if !safe(&id) {
        return Err("bad session id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = session_dir(&cwd);
        let text =
            std::fs::read_to_string(dir.join(format!("{id}.jsonl"))).map_err(|e| e.to_string())?;
        let new_id = new_session_id();
        std::fs::write(
            dir.join(format!("{new_id}.jsonl")),
            rewind_text(&text, &id, &new_id, keep_users),
        )
        .map_err(|e| e.to_string())?;
        Ok(new_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn is_prompt_line(v: &serde_json::Value) -> bool {
    let content = &v["message"]["content"];
    let has_prompt = match content {
        serde_json::Value::String(t) => prompt_text(t).is_some(),
        serde_json::Value::Array(blocks) => {
            !blocks.iter().any(|b| b["type"] == "tool_result")
                && blocks.iter().any(|b| {
                    b["type"] == "image"
                        || (b["type"] == "text"
                            && prompt_text(b["text"].as_str().unwrap_or_default()).is_some())
                })
        }
        _ => false,
    };
    v["type"] == "user" && v["isMeta"] != true && v["isSidechain"] != true && has_prompt
}

pub(crate) fn rewind_text(text: &str, id: &str, new_id: &str, keep_users: usize) -> String {
    let mut users = 0;
    let mut out = String::new();
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if is_prompt_line(&v) {
                if users == keep_users {
                    break;
                }
                users += 1;
            }
        }
        out.push_str(&line.replace(id, new_id));
        out.push('\n');
    }
    out
}

pub(crate) fn new_session_id() -> String {
    {
        let new_id = format!(
            "{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}",
            rand_u64() as u32,
            rand_u64() as u16,
            rand_u64() & 0xfff,
            rand_u64() & 0xfff,
            rand_u64() & 0xffff_ffff_ffff
        );
        new_id
    }
}

pub(crate) fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    h.finish()
}

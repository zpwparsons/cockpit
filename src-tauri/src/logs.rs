use crate::*;

pub(crate) fn logs_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn log_file_name(key: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key)
}

pub(crate) fn log_key_from_name(name: &str) -> Option<String> {
    use base64::Engine;
    String::from_utf8(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(name.as_bytes())
            .ok()?,
    )
    .ok()
}

pub(crate) fn load_logs_in(
    dir: &std::path::Path,
) -> Result<HashMap<String, serde_json::Value>, String> {
    {
        let mut out = HashMap::new();
        for entry in std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let Some(key) = path
                .file_stem()
                .and_then(|s| log_key_from_name(&s.to_string_lossy()))
            else {
                continue;
            };
            if let Ok(value) = std::fs::read_to_string(&path)
                .map_err(|_| ())
                .and_then(|t| serde_json::from_str(&t).map_err(|_| ()))
            {
                out.insert(key, value);
            }
        }
        Ok(out)
    }
}

pub(crate) fn save_log_in(dir: &std::path::Path, key: &str, json: &str) -> Result<(), String> {
    let name = log_file_name(key);
    let tmp = dir.join(format!("{name}.json.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("{name}.json"))).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn logs_load_all(
    app: AppHandle,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let dir = logs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_logs_in(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn log_save(app: AppHandle, key: String, json: String) -> Result<(), String> {
    let dir = logs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_log_in(&dir, &key, &json))
        .await
        .map_err(|e| e.to_string())?
}

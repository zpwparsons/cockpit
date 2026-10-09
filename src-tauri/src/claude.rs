use crate::*;

const CLAUDE_EXEC: &str = "path=(~/.local/bin ~/.claude/local $path); exec claude \"$@\"";

pub(crate) type SharedStdin = Arc<Mutex<Option<ChildStdin>>>;

pub(crate) struct Proc {
    child: Child,
    stdin: SharedStdin,
}

#[derive(Default)]
pub(crate) struct Runs(Arc<Mutex<HashMap<String, Proc>>>);

#[derive(Clone, Serialize)]
pub(crate) struct Line {
    run: String,
    line: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct Done {
    run: String,
    code: Option<i32>,
    stderr: String,
}

#[tauri::command]
pub(crate) async fn claude_probe(cwd: String, rate: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("/bin/zsh")
            .args([
                "-lc",
                CLAUDE_EXEC,
                "claude",
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
            ])
            .args(if rate {
                &["--model", "haiku", "--tools", ""][..]
            } else {
                &[][..]
            })
            .current_dir(expand(&cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b".");
        }
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let init = BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
            .find(|l| {
                if rate {
                    l.contains("\"type\":\"rate_limit_event\"")
                } else {
                    l.contains("\"subtype\":\"init\"")
                }
            });
        let _ = child.kill();
        let _ = child.wait();
        init.ok_or_else(|| "no event".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn claude_oneshot(cwd: String, prompt: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("/bin/zsh")
            .args(["-lc", CLAUDE_EXEC, "claude"])
            .args([
                "-p",
                "--model",
                "haiku",
                "--no-session-persistence",
                "--tools",
                "",
                "--output-format",
                "text",
            ])
            .current_dir(expand(&cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn claude_send(
    app: AppHandle,
    runs: State<Runs>,
    run: String,
    cwd: String,
    args: Vec<String>,
    message: String,
) -> Result<(), String> {
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", CLAUDE_EXEC, "claude"])
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
        ])
        .args(&args)
        .current_dir(expand(&cwd))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    let stdin: SharedStdin = Arc::new(Mutex::new(Some(child.stdin.take().ok_or("no stdin")?)));
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    runs.0.lock().unwrap().insert(
        run.clone(),
        Proc {
            child,
            stdin: stdin.clone(),
        },
    );

    std::thread::spawn(move || {
        if let Some(pipe) = stdin.lock().unwrap().as_mut() {
            let _ = writeln!(pipe, "{message}");
        }
    });

    let map = runs.0.clone();
    std::thread::spawn(move || {
        let err = std::thread::spawn(move || {
            let mut out = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                out.push_str(&line);
                out.push('\n');
            }
            out
        });

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app.emit(
                "claude://line",
                Line {
                    run: run.clone(),
                    line,
                },
            );
        }

        let proc = map.lock().unwrap().remove(&run);
        let code = proc.and_then(|mut p| {
            p.stdin.lock().unwrap().take();
            p.child.wait().ok()
        });
        let stderr = err.join().unwrap_or_default();
        let _ = app.emit(
            "claude://done",
            Done {
                run,
                code: code.and_then(|s| s.code()),
                stderr,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub(crate) async fn claude_write(
    runs: State<'_, Runs>,
    run: String,
    line: String,
) -> Result<(), String> {
    let stdin = runs
        .0
        .lock()
        .unwrap()
        .get(&run)
        .map(|p| p.stdin.clone())
        .ok_or("run is not active")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = stdin.lock().unwrap();
        let pipe = guard.as_mut().ok_or("run is not accepting input")?;
        writeln!(pipe, "{line}").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn claude_close(runs: State<Runs>, run: String) {
    if let Some(stdin) = runs.0.lock().unwrap().get(&run).map(|p| p.stdin.clone()) {
        std::thread::spawn(move || stdin.lock().unwrap().take());
    }
}

#[tauri::command]
pub(crate) fn claude_stop(runs: State<Runs>, run: String) {
    let Some(pid) = runs.0.lock().unwrap().get(&run).map(|p| p.child.id()) else {
        return;
    };
    let _ = Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status();
    let map = runs.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(p) = map.lock().unwrap().get_mut(&run) {
            let _ = p.child.kill();
        }
    });
}

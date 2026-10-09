use crate::{logs::*, pty::*, sessions::*, shell::*, *};
use serde_json::json;

fn markers(bytes: &[u8]) -> Vec<String> {
    let mut parser = vte::Parser::new();
    let mut m = Markers::default();
    parser.advance(&mut m, bytes);
    m.0.iter()
        .map(|e| serde_json::to_string(e).unwrap())
        .collect()
}

#[test]
fn detects_markers_and_alt_screen() {
    assert_eq!(
        markers(b"echo\x1b]6973;C\x07out\x1b[?1049hfull\x1b[?1049l\x1b]6973;D;130;/tmp/a;b\x07"),
        [
            r#"{"kind":"cmd"}"#,
            r#"{"kind":"alt","on":true}"#,
            r#"{"kind":"alt","on":false}"#,
            r#"{"kind":"done","code":130,"cwd":"/tmp/a;b"}"#
        ]
    );
}

#[test]
fn detects_completion_markers() {
    let out = markers("\x1b]6973;E\x07\x1b]6973;S;4\x07\x1b]6973;M;checkout␟switch; branch\x07\x1b]6973;M;plain\x07\x1b]6973;F\x07".as_bytes());
    assert_eq!(
        out,
        [
            r#"{"kind":"compStart"}"#,
            r#"{"kind":"compSpan","len":4}"#,
            r#"{"kind":"compMatch","value":"checkout","desc":"switch; branch"}"#,
            r#"{"kind":"compMatch","value":"plain","desc":""}"#,
            r#"{"kind":"compEnd"}"#
        ]
    );
}

#[test]
fn ignores_foreign_osc_and_other_private_modes() {
    assert!(markers(b"\x1b]0;title\x07\x1b[?25l\x1b[?2004h").is_empty());
    assert_eq!(
        markers(b"\x1b]6973;D;x;/tmp\x07"),
        [r#"{"kind":"done","code":1,"cwd":"/tmp"}"#]
    );
    assert_eq!(markers(b"\x1b[?47h"), [r#"{"kind":"alt","on":true}"#]);
}

#[test]
fn keeps_incomplete_utf8_tail() {
    let bytes = "é".as_bytes();
    assert_eq!(utf8_split(&[b'a', bytes[0]]), 1);
    assert_eq!(utf8_split(&[b'a', bytes[0], bytes[1]]), 3);
    assert_eq!(utf8_split(b"plain"), 5);
    assert_eq!(utf8_split(&[0xff, b'a']), 2);
}

#[test]
fn expands_and_collapses_home() {
    assert_eq!(expand_with("~", "/h/me"), "/h/me");
    assert_eq!(expand_with("~/Code", "/h/me"), "/h/me/Code");
    assert_eq!(expand_with("/abs", "/h/me"), "/abs");
    assert_eq!(expand_with("~x", "/h/me"), "~x");
    assert_eq!(tilde_with("/h/me/Code/x", "/h/me"), "~/Code/x");
    assert_eq!(tilde_with("/other", "/h/me"), "/other");
    assert_eq!(tilde_with("/h/me", ""), "/h/me");
}

#[test]
fn session_dir_encodes_path() {
    let home = home_dir();
    let dir = session_dir("~/Code/eff-client");
    assert_eq!(
        dir,
        std::path::PathBuf::from(format!("{home}/.claude/projects"))
            .join(format!("{}-Code-eff-client", home.replace('/', "-")))
    );
}

#[test]
fn safe_rejects_shell_metacharacters() {
    assert!(safe("abc-123_x.y[1]"));
    assert!(!safe(""));
    assert!(!safe("a b"));
    assert!(!safe("x;rm"));
    assert!(!safe("../etc"));
}

#[test]
fn strips_brief_rules_and_ticket_header() {
    assert_eq!(strip_brief(&format!("{BRIEF_RULES}hello")), "hello");
    assert_eq!(
        strip_brief(&format!(
            "You're working on Jira ticket FSP-1.\n\n{BRIEF_RULES}fix it"
        )),
        "fix it"
    );
    assert_eq!(strip_brief("plain"), "plain");
}

#[test]
fn prompt_text_handles_special_messages() {
    assert_eq!(
        prompt_text("<local-command-stdout>x</local-command-stdout>"),
        None
    );
    assert_eq!(prompt_text("<command-name>/model</command-name><command-message>m</command-message><command-args>opus</command-args>"), Some("/model opus".into()));
    assert_eq!(
        prompt_text("<command-name>/clear</command-name>"),
        Some("/clear".into())
    );
    assert_eq!(
        prompt_text("<bash-input>ls</bash-input>\n<bash-stdout>a\n</bash-stdout>\nnow fix it"),
        Some("now fix it".into())
    );
    assert_eq!(prompt_text("<system-reminder>x</system-reminder>"), None);
    assert_eq!(prompt_text(&format!("{BRIEF_RULES}hi")), Some("hi".into()));
}

#[test]
fn tool_detail_prefers_command_then_path() {
    assert_eq!(tool_detail(&json!({"command":"ls","file_path":"/x"})), "ls");
    assert_eq!(
        tool_detail(&json!({"file_path": format!("{}/a.rs", home_dir())})),
        "~/a.rs"
    );
    assert_eq!(tool_detail(&json!({"skill":"zero-quote"})), "zero-quote");
    assert_eq!(tool_detail(&json!({})), "");
}

#[test]
fn tool_diff_covers_edit_write_multiedit() {
    let d = tool_diff("Edit", &json!({"old_string":"a","new_string":"b"})).unwrap();
    assert_eq!((d[0].old.as_str(), d[0].new.as_str()), ("a", "b"));
    let w = tool_diff("Write", &json!({"content":"c"})).unwrap();
    assert_eq!((w[0].old.as_str(), w[0].new.as_str()), ("", "c"));
    let m = tool_diff(
        "MultiEdit",
        &json!({"edits":[{"old_string":"1","new_string":"2"},{"old_string":"3","new_string":"4"}]}),
    )
    .unwrap();
    assert_eq!(m.len(), 2);
    assert!(tool_diff("MultiEdit", &json!({})).is_none());
    assert!(tool_diff("Bash", &json!({})).is_none());
}

#[test]
fn result_text_joins_blocks_and_caps_length() {
    assert_eq!(result_text(&json!("plain")), "plain");
    assert_eq!(
        result_text(
            &json!([{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}])
        ),
        "a\nb"
    );
    assert_eq!(result_text(&json!(42)), "");
    let long = "x".repeat(MAX_TOOL_OUTPUT + 10);
    assert_eq!(result_text(&json!(long)).len(), MAX_TOOL_OUTPUT);
}

#[test]
fn transcript_items_parses_user_and_assistant_lines() {
    let user =
        json!({"type":"user","message":{"role":"user","content":format!("{BRIEF_RULES}hello")}})
            .to_string();
    assert_eq!(
        serde_json::to_value(transcript_items(&user)).unwrap(),
        json!([{"kind":"user","text":"hello"}])
    );

    let meta = json!({"type":"user","isMeta":true,"message":{"content":"x"}}).to_string();
    assert!(transcript_items(&meta).is_empty());

    let side = json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"x"}]}}).to_string();
    assert!(transcript_items(&side).is_empty());

    let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"out","is_error":true}]}}).to_string();
    assert_eq!(
        serde_json::to_value(transcript_items(&result)).unwrap(),
        json!([{"kind":"toolResult","id":"t1","output":"out","isError":true}])
    );

    let image_only =
        json!({"type":"user","message":{"content":[{"type":"image","source":{}}]}}).to_string();
    assert_eq!(
        serde_json::to_value(transcript_items(&image_only)).unwrap(),
        json!([{"kind":"user","text":"[image]"}])
    );

    let assistant = json!({"type":"assistant","message":{"content":[
        {"type":"text","text":"  hi  "},
        {"type":"text","text":"   "},
        {"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/x","old_string":"a","new_string":"b"}}
    ]}}).to_string();
    let items = serde_json::to_value(transcript_items(&assistant)).unwrap();
    assert_eq!(items[0], json!({"kind":"text","text":"hi"}));
    assert_eq!(items[1]["kind"], "tool");
    assert_eq!(items[1]["detail"], "/x");
    assert_eq!(items[1]["diff"][0]["new"], "b");
    assert_eq!(items.as_array().unwrap().len(), 2);

    assert!(transcript_items("not json").is_empty());
    assert!(transcript_items(&json!({"type":"summary"}).to_string()).is_empty());
}

#[test]
fn session_title_uses_summary_then_first_prompt_and_branch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, [
        json!({"type":"user","isMeta":true,"message":{"content":"<system>skip</system>"}}).to_string(),
        json!({"type":"user","gitBranch":"main","message":{"content":format!("{BRIEF_RULES}first real prompt")}}).to_string(),
    ].join("\n")).unwrap();
    assert_eq!(
        session_title(&path),
        Some(("first real prompt".into(), "main".into()))
    );

    let summarised = dir.path().join("t.jsonl");
    std::fs::write(
        &summarised,
        [
            json!({"type":"summary","summary":"Nice title"}).to_string(),
            json!({"type":"user","message":{"content":"ignored"}}).to_string(),
        ]
        .join("\n"),
    )
    .unwrap();
    assert_eq!(
        session_title(&summarised),
        Some(("Nice title".into(), String::new()))
    );

    let empty = dir.path().join("u.jsonl");
    std::fs::write(
        &empty,
        json!({"type":"user","message":{"content":"<local-command-stdout>x"}}).to_string(),
    )
    .unwrap();
    assert_eq!(session_title(&empty), None);
}

#[test]
fn sessions_in_sorts_newest_first_and_skips_untitled() {
    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, title: &str| {
        std::fs::write(
            dir.path().join(name),
            json!({"type":"user","message":{"content":title}}).to_string(),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    write("old.jsonl", "old one");
    write("new.jsonl", "new one");
    std::fs::write(dir.path().join("blank.jsonl"), "").unwrap();
    std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
    let list = sessions_in(dir.path()).unwrap();
    assert_eq!(
        list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["new", "old"]
    );
    assert_eq!(list[0].title, "new one");
    assert!(list[0].size > 0);
    assert!(sessions_in(&dir.path().join("missing")).is_err());
}

#[test]
fn parse_history_handles_extended_format_dedup_and_continuations() {
    let text =
        ": 1700000000:0;git status\nplain cmd\n: 1700000001:0;multi \\\nline\ngit status\n\n";
    assert_eq!(
        parse_history(text),
        ["git status", "multi \nline", "plain cmd"]
    );
    assert!(parse_history("").is_empty());
}

#[test]
fn complete_path_in_lists_matching_entries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("src/components")).unwrap();
    std::fs::write(root.join("src/main.ts"), "").unwrap();
    std::fs::write(root.join("README.md"), "").unwrap();
    std::fs::write(root.join(".hidden"), "").unwrap();
    let cwd = root.to_string_lossy().into_owned();

    assert_eq!(complete_path_in(&cwd, "s", ""), ["src/"]);
    assert_eq!(
        complete_path_in(&cwd, "src/", ""),
        ["src/components/", "src/main.ts"]
    );
    assert_eq!(complete_path_in(&cwd, "src/m", ""), ["src/main.ts"]);
    assert_eq!(complete_path_in(&cwd, "", ""), ["README.md", "src/"]);
    assert_eq!(complete_path_in(&cwd, ".", ""), [".hidden"]);
    assert_eq!(complete_path_in(&cwd, "~/s", &cwd), ["~/src/"]);
    assert_eq!(
        complete_path_in(&cwd, &format!("{cwd}/sr"), ""),
        [format!("{cwd}/src/")]
    );
    assert!(complete_path_in(&cwd, "nope/", "").is_empty());
}

#[test]
fn rewind_text_keeps_n_prompts_and_renames_session() {
    let prompt =
        |t: &str| json!({"type":"user","sessionId":"old","message":{"content":t}}).to_string();
    let reply = json!({"type":"assistant","sessionId":"old","message":{"content":[{"type":"text","text":"ok"}]}}).to_string();
    let tool_result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"o"}]}}).to_string();
    let text = [
        prompt("one"),
        reply.clone(),
        tool_result,
        prompt("<local-command-stdout>skip"),
        prompt("two"),
        reply.clone(),
        prompt("three"),
    ]
    .join("\n");

    let kept = rewind_text(&text, "old", "new", 2);
    let lines: Vec<&str> = kept.lines().collect();
    assert_eq!(lines.len(), 6);
    assert!(lines.iter().all(|l| !l.contains("\"old\"")));
    assert!(lines[4].contains("\"two\""));
    assert!(lines[5].contains("\"ok\""));

    assert_eq!(rewind_text(&text, "old", "new", 0), "");
    assert_eq!(rewind_text(&text, "old", "new", 99).lines().count(), 7);
}

#[test]
fn is_prompt_line_matches_ui_counting() {
    assert!(is_prompt_line(
        &json!({"type":"user","message":{"content":"hi"}})
    ));
    assert!(is_prompt_line(
        &json!({"type":"user","message":{"content":[{"type":"image"}]}})
    ));
    assert!(is_prompt_line(
        &json!({"type":"user","message":{"content":"<bash-input>ls</bash-input>\n<bash-stdout>x</bash-stdout>\nq"}})
    ));
    assert!(!is_prompt_line(
        &json!({"type":"user","message":{"content":[{"type":"tool_result"}]}})
    ));
    assert!(!is_prompt_line(
        &json!({"type":"user","isMeta":true,"message":{"content":"hi"}})
    ));
    assert!(!is_prompt_line(
        &json!({"type":"assistant","message":{"content":"hi"}})
    ));
}

#[test]
fn new_session_ids_look_like_uuids_and_differ() {
    let a = new_session_id();
    let b = new_session_id();
    assert_eq!(a.len(), 36);
    assert!(safe(&a));
    assert_ne!(a, b);
}

#[test]
fn parses_git_status_header() {
    let g = parse_git_status("## main...origin/main [ahead 1]\n M file\n").unwrap();
    assert_eq!((g.branch.as_str(), g.dirty), ("main", true));
    let g = parse_git_status("## feature/x\n").unwrap();
    assert_eq!((g.branch.as_str(), g.dirty), ("feature/x", false));
    let g = parse_git_status("## No commits yet on main\n").unwrap();
    assert_eq!(g.branch, "main");
    assert!(parse_git_status("fatal: not a git repo").is_none());
    assert!(parse_git_status("").is_none());
}

#[test]
fn zdotdir_files_chain_to_the_users_rc_files() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("it's here");
    write_zdotdir(&target).unwrap();
    let zshenv = std::fs::read_to_string(target.join(".zshenv")).unwrap();
    assert!(zshenv.contains("source $HOME/.zshenv"));
    assert!(zshenv.ends_with("ZDOTDIR='".to_string().as_str()) || zshenv.contains("ZDOTDIR='"));
    assert!(zshenv.contains("it'\\''s here"));
    let zshrc = std::fs::read_to_string(target.join(".zshrc")).unwrap();
    assert!(zshrc.contains("source $HOME/.zshrc"));
    assert!(zshrc.contains("__ck_complete"));
    assert!(zshrc.contains("add-zsh-hook preexec __cockpit_preexec"));
    assert!(!std::fs::read_to_string(target.join(".zlogin"))
        .unwrap()
        .contains("ZDOTDIR='"));
}

#[test]
fn log_files_round_trip_keys_with_special_characters() {
    let dir = tempfile::tempdir().unwrap();
    for key in ["#eff-client", "FSP-3216", "weird/key with spaces"] {
        save_log_in(dir.path(), key, &json!([{"id":1,"text":key}]).to_string()).unwrap();
    }
    std::fs::write(dir.path().join("junk.json"), "{not json").unwrap();
    std::fs::write(dir.path().join("README.txt"), "x").unwrap();
    let loaded = load_logs_in(dir.path()).unwrap();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded["#eff-client"][0]["text"], "#eff-client");
    assert!(!dir
        .path()
        .join(format!("{}.json.tmp", log_file_name("FSP-3216")))
        .exists());
    assert_eq!(log_key_from_name(&log_file_name("a/b")), Some("a/b".into()));
    assert_eq!(log_key_from_name("***"), None);
}

#[test]
fn pty_shell_emits_block_and_completion_markers() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    if !std::path::Path::new("/bin/zsh").exists() {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join(".zshrc"),
        "autoload -Uz compinit; compinit -C\n",
    )
    .unwrap();
    let zdot = home.path().join("zdot");
    write_zdotdir(&zdot).unwrap();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.arg("-il");
    cmd.cwd(home.path());
    cmd.env("HOME", home.path());
    cmd.env("ZDOTDIR", &zdot);
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut parser = vte::Parser::new();
    let mut m = Markers::default();
    let mut events: Vec<String> = Vec::new();
    let mut wait_for = |events: &mut Vec<String>, needle: &str| -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if events.iter().any(|e| e.contains(needle)) {
                return true;
            }
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                parser.advance(&mut m, &chunk);
                events.extend(m.0.drain(..).map(|e| serde_json::to_string(&e).unwrap()));
            }
        }
        false
    };

    assert!(
        wait_for(&mut events, "\"done\""),
        "shell never became ready: {events:?}"
    );
    events.clear();

    writer.write_all(b"\x1b[200~false\x1b[201~\r").unwrap();
    assert!(wait_for(&mut events, "\"done\""));
    let cwd = home.path().canonicalize().unwrap().display().to_string();
    assert_eq!(
        events,
        [
            r#"{"kind":"cmd"}"#.to_string(),
            format!(r#"{{"kind":"done","code":1,"cwd":"{cwd}"}}"#)
        ]
    );
    events.clear();

    let hex: String = "git chec".bytes().map(|b| format!("{b:02x}")).collect();
    writer
        .write_all(format!("\x1b[200~__ck_complete {hex}\x1b[201~\r").as_bytes())
        .unwrap();
    assert!(
        wait_for(&mut events, "compEnd"),
        "no completion end: {events:?}"
    );
    assert_eq!(events[0], r#"{"kind":"compStart"}"#);
    assert_eq!(events[1], r#"{"kind":"compSpan","len":4}"#);
    let described = events
        .iter()
        .any(|e| e.contains(r#""value":"checkout""#) && !e.ends_with(r#""desc":""}"#));
    assert!(described, "checkout should carry a description: {events:?}");
    let leaked = events
        .iter()
        .any(|e| e.contains(r#""kind":"cmd""#) || e.contains(r#""kind":"done""#));
    assert!(!leaked, "completion leaked block markers: {events:?}");

    let _ = child.kill();
}

#[test]
fn shell_bootstrap_markers_are_valid_zsh() {
    let dir = tempfile::tempdir().unwrap();
    write_zdotdir(dir.path()).unwrap();
    let out = Command::new("/bin/zsh")
        .args(["-n", &dir.path().join(".zshrc").to_string_lossy()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

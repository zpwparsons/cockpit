use crate::*;

pub(crate) const COMP_SEP: char = '\u{241f}';

pub(crate) const ZSHRC: &str = r#"ZDOTDIR=$HOME
[[ -f $HOME/.zshrc ]] && source $HOME/.zshrc
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -C }
typeset -g __ck_skip=0 __ck_active=0 __ck_line=''
__cockpit_preexec() { [[ $1 == __ck_complete\ * ]] && { __ck_skip=1; return }; printf '\e]6973;C\a' }
__cockpit_precmd() { local rc=$?; if (( __ck_skip )); then __ck_skip=0; return; fi; printf '\e]6973;D;%s;%s\a' "$rc" "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook preexec __cockpit_preexec
precmd_functions=(__cockpit_precmd ${precmd_functions:#__cockpit_precmd})
__ck_history() { [[ $1 != __ck_complete\ * ]] }
zshaddhistory_functions+=(__ck_history)
__ck_capture() {
  local i dname=''
  for (( i = 1; i <= $#; i++ )); do
    [[ ${argv[i]} == -- ]] && break
    [[ ${argv[i]} == -[^-]* ]] || continue
    [[ ${argv[i]} == *[OAD]* ]] && { builtin compadd "$@"; return }
    [[ ${argv[i]} == *d ]] && dname=${argv[i+1]}
  done
  local -a __hits __dscr
  [[ -n $dname ]] && __dscr=("${(@P)dname}")
  builtin compadd -A __hits -D __dscr "$@"
  local i h
  for (( i = 1; i <= $#__hits; i++ )); do
    h=${__hits[i]}
    [[ -z ${__dscr[i]} && -d ${~h} ]] && h+=/
    printf '\e]6973;M;%s␟%s\a' "$h" "${__dscr[i]}"
  done
}
__ck_completer() {
  printf '\e]6973;S;%s\a' $(( ${#IPREFIX} + ${#PREFIX} ))
  compadd() { __ck_capture "$@" }
  { _main_complete } always { unfunction compadd }
  compstate[insert]=''
  compstate[list]=''
}
zle -C __ck_complete_widget complete-word __ck_completer
(( ${+widgets[zle-line-init]} )) && zle -A zle-line-init __ck_prev_lineinit
__ck_lineinit() {
  if (( __ck_active )); then
    BUFFER=$__ck_line; CURSOR=${#BUFFER}
    zle __ck_complete_widget
    BUFFER=' '
    zle accept-line
  elif (( ${+widgets[__ck_prev_lineinit]} )); then
    zle __ck_prev_lineinit
  fi
}
zle -N zle-line-init __ck_lineinit
__ck_complete() {
  setopt localoptions extendedglob
  local esc=${1//(#b)(??)/\\x$match[1]}
  printf -v __ck_line '%b' $esc
  printf '\e]6973;E\a'
  __ck_active=1
  { select _ in 1; do break; done } 2>/dev/null
  __ck_active=0
  printf '\e]6973;F\a'
}
PROMPT='' RPROMPT='' PS2='' PROMPT_EOL_MARK=''
unsetopt prompt_sp prompt_cr 2>/dev/null
"#;

pub(crate) fn zdotdir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zdotdir");
    write_zdotdir(&dir)?;
    Ok(dir)
}

pub(crate) fn write_zdotdir(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let back = format!(
        "ZDOTDIR='{}'\n",
        dir.display().to_string().replace('\'', "'\\''")
    );
    let wrap = |file: &str, restore: bool| {
        format!(
            "ZDOTDIR=$HOME\n[[ -f $HOME/{file} ]] && source $HOME/{file}\n{}",
            if restore { back.as_str() } else { "" }
        )
    };
    for (name, body) in [
        (".zshenv", wrap(".zshenv", true)),
        (".zprofile", wrap(".zprofile", true)),
        (".zshrc", ZSHRC.to_string()),
        (".zlogin", wrap(".zlogin", false)),
    ] {
        std::fs::write(dir.join(name), body).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) struct Pty {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub(crate) struct Ptys(Arc<Mutex<HashMap<String, Pty>>>);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PtyEvent {
    Data { data: String },
    Cmd,
    Done { code: i32, cwd: String },
    Alt { on: bool },
    Exit,
    CompStart,
    CompSpan { len: usize },
    CompMatch { value: String, desc: String },
    CompEnd,
}

#[derive(Clone, Serialize)]
pub(crate) struct PtyMessage {
    tab: String,
    event: PtyEvent,
}

#[derive(Default)]
pub(crate) struct Markers(pub(crate) Vec<PtyEvent>);

impl vte::Perform for Markers {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell: bool) {
        if params.first() != Some(&&b"6973"[..]) {
            return;
        }
        let text = |i: usize| {
            params
                .get(i)
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .unwrap_or_default()
        };
        match params.get(1).map(|p| &p[..]) {
            Some(b"C") => self.0.push(PtyEvent::Cmd),
            Some(b"E") => self.0.push(PtyEvent::CompStart),
            Some(b"F") => self.0.push(PtyEvent::CompEnd),
            Some(b"S") => self.0.push(PtyEvent::CompSpan {
                len: text(2).parse().unwrap_or(0),
            }),
            Some(b"M") => {
                let raw = params[2.min(params.len())..]
                    .iter()
                    .map(|p| String::from_utf8_lossy(p))
                    .collect::<Vec<_>>()
                    .join(";");
                let (value, desc) = raw.split_once(COMP_SEP).unwrap_or((raw.as_str(), ""));
                self.0.push(PtyEvent::CompMatch {
                    value: value.to_string(),
                    desc: desc.to_string(),
                })
            }
            Some(b"D") => {
                let cwd = params[3.min(params.len())..]
                    .iter()
                    .map(|p| String::from_utf8_lossy(p))
                    .collect::<Vec<_>>()
                    .join(";");
                self.0.push(PtyEvent::Done {
                    code: text(2).parse().unwrap_or(1),
                    cwd,
                })
            }
            _ => {}
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        if intermediates != b"?" || !matches!(action, 'h' | 'l') {
            return;
        }
        if params
            .iter()
            .any(|p| matches!(p.first(), Some(1049 | 1047 | 47)))
        {
            self.0.push(PtyEvent::Alt { on: action == 'h' });
        }
    }
}

pub(crate) fn utf8_split(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

#[tauri::command]
pub(crate) async fn pty_open(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    tab: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    if ptys.0.lock().unwrap().contains_key(&tab) {
        return Ok(());
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.arg("-il");
    cmd.cwd(expand(&cwd));
    cmd.env("ZDOTDIR", zdotdir(&app)?);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Cockpit");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    ptys.0.lock().unwrap().insert(
        tab.clone(),
        Pty {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
        },
    );

    let map = ptys.0.clone();
    std::thread::spawn(move || {
        let emit = |event: PtyEvent| {
            let _ = app.emit(
                "pty://event",
                PtyMessage {
                    tab: tab.clone(),
                    event,
                },
            );
        };
        let mut parser = vte::Parser::new();
        let mut markers = Markers::default();
        let mut buf = vec![0u8; 65536];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &byte in &buf[..n] {
                pending.push(byte);
                parser.advance(&mut markers, &[byte]);
                if markers.0.is_empty() {
                    continue;
                }
                if !pending.is_empty() {
                    emit(PtyEvent::Data {
                        data: String::from_utf8_lossy(&pending).into_owned(),
                    });
                    pending.clear();
                }
                for event in markers.0.drain(..) {
                    emit(event);
                }
            }
            let cut = utf8_split(&pending);
            if cut > 0 {
                emit(PtyEvent::Data {
                    data: String::from_utf8_lossy(&pending[..cut]).into_owned(),
                });
                pending.drain(..cut);
            }
        }
        if let Some(mut p) = map.lock().unwrap().remove(&tab) {
            let _ = p.child.wait();
        }
        emit(PtyEvent::Exit);
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn pty_write(
    ptys: State<'_, Ptys>,
    tab: String,
    data: String,
) -> Result<(), String> {
    let writer = ptys
        .0
        .lock()
        .unwrap()
        .get(&tab)
        .map(|p| p.writer.clone())
        .ok_or("terminal is not running")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut w = writer.lock().unwrap();
        w.write_all(data.as_bytes())
            .and_then(|_| w.flush())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn pty_resize(ptys: State<Ptys>, tab: String, cols: u16, rows: u16) {
    if let Some(p) = ptys.0.lock().unwrap().get(&tab) {
        let _ = p.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

#[tauri::command]
pub(crate) async fn pty_close(ptys: State<'_, Ptys>, tab: String) -> Result<(), String> {
    let pty = ptys.0.lock().unwrap().remove(&tab);
    if let Some(mut p) = pty {
        let _ = p.child.kill();
        std::thread::spawn(move || p.child.wait());
    }
    Ok(())
}

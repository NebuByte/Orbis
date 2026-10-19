//! Voice, listening only for now: you talk, Orbis turns it into words on this PC (Whisper small with
//! OpenVINO, in orbis_voice.py next to the search engine) and the page treats them like typing.
//! - The microphone is opened by the page (so the core can move with your voice) and only for as
//!   long as it listens: one sentence with push-to-talk, or while Orbis is open in "Orbis" mode.
//! - Push-to-talk: Ctrl+Alt+Space anywhere in Windows (Orbis comes to the front), or the mic button.
//! - Nothing is recorded to disk and nothing leaves the PC.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SCRIPT: &str = include_str!("../../semantic/orbis_voice.py");
pub const HOTKEY: &str = "ctrl+alt+space";

fn script() -> PathBuf {
    let p = crate::sem::engine_dir().join("orbis_voice.py");
    if std::fs::read_to_string(&p).map(|t| t != SCRIPT).unwrap_or(true) && crate::sem::engine_dir().exists() {
        let _ = std::fs::write(&p, SCRIPT);
    }
    p
}
/// the engine's Python, the speech package and the model are all there
pub fn installed() -> bool {
    let e = crate::sem::engine_dir();
    crate::sem::python().exists() && e.join(r"whisper\small\openvino_encoder_model.xml").exists() && e.join(r".venv\Lib\site-packages\openvino_genai").exists()
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
}
#[derive(Default)]
pub struct Voice {
    p: Mutex<Option<Proc>>,
    installing: AtomicBool,
}

#[derive(Serialize, Deserialize)]
pub struct Heard {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub ms: f64,
    #[serde(default, skip_serializing)]
    error: Option<String>,
}

impl Voice {
    fn spawn() -> Result<Proc, String> {
        let mut child = Command::new(crate::sem::python())
            .arg("-u")
            .arg(script())
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("speech recognition could not start: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut line = String::new();
        if out.read_line(&mut line).unwrap_or(0) == 0 || !line.contains("\"ready\"") {
            let _ = child.kill();
            return Err("speech recognition did not start".into());
        }
        Ok(Proc { child, stdin, out })
    }
    fn ask(p: &mut Proc, req: &str) -> Result<Heard, String> {
        p.stdin.write_all(req.as_bytes()).and_then(|_| p.stdin.write_all(b"\n")).and_then(|_| p.stdin.flush()).map_err(|e| e.to_string())?;
        let mut line = String::new();
        if p.out.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("closed".into());
        }
        serde_json::from_str(&line).map_err(|e| e.to_string())
    }
    /// words for this audio; a helper that exited while idle is started again once
    fn hear(&self, req: &str) -> Result<Heard, String> {
        let mut g = self.p.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..2 {
            if g.is_none() {
                *g = Some(Self::spawn()?);
            }
            match Self::ask(g.as_mut().unwrap(), req) {
                Ok(h) => return h.error.clone().map_or(Ok(h), Err),
                Err(_) => {
                    if let Some(mut p) = g.take() {
                        let _ = p.child.kill();
                    }
                }
            }
        }
        Err("speech recognition is not responding".into())
    }
    pub fn stop(&self) {
        if let Some(mut p) = self.p.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = p.child.kill();
        }
    }
}

#[derive(Serialize)]
pub struct VoiceStatus {
    pub installed: bool,
    pub installing: bool,
    pub hotkey: &'static str,
}
#[tauri::command]
pub fn voice_status(app: AppHandle) -> VoiceStatus {
    VoiceStatus { installed: installed(), installing: app.state::<Voice>().installing.load(Ordering::SeqCst), hotkey: HOTKEY }
}

/// pcm: 16 kHz mono 16-bit audio, base64
#[tauri::command]
pub async fn voice_hear(pcm: String, prompt: bool, app: AppHandle) -> Result<Heard, String> {
    if pcm.len() > 2_000_000 {
        return Err("That was too long to listen to.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let req = serde_json::json!({ "pcm": pcm, "prompt": prompt }).to_string();
        app.state::<Voice>().hear(&req)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// load the model ahead of the first sentence
#[tauri::command]
pub async fn voice_warm(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let v = app.state::<Voice>();
        let mut g = v.p.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() && installed() {
            *g = Voice::spawn().ok();
        }
    })
    .await;
}

#[derive(Serialize, Clone)]
struct Progress {
    pct: u32,
    msg: String,
}
#[derive(Serialize, Clone)]
struct Done {
    ok: bool,
    error: String,
}
fn setup(app: &AppHandle) -> Result<(), String> {
    let mut child = Command::new(crate::sem::python())
        .arg("-u")
        .arg(script())
        .arg("setup")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut error = String::new();
    for line in BufReader::new(child.stdout.take().ok_or("no output")?).lines().map_while(Result::ok) {
        if let Some(rest) = line.strip_prefix("STEP ") {
            let (p, m) = rest.split_once(' ').unwrap_or((rest, ""));
            let _ = app.emit("voice-progress", Progress { pct: p.parse().unwrap_or(0), msg: m.into() });
        } else if let Some(e) = line.strip_prefix("ERROR ") {
            error = e.into();
        }
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if ok && installed() {
        Ok(())
    } else {
        Err(if error.is_empty() { "the voice setup did not finish".into() } else { error })
    }
}
/// Install speech recognition (and Orbis's offline engine first, when this PC has none yet).
#[tauri::command]
pub fn voice_install(app: AppHandle) {
    if app.state::<Voice>().installing.swap(true, Ordering::SeqCst) {
        return;
    }
    let finish = move |app: AppHandle, r: Result<(), String>| {
        app.state::<Voice>().installing.store(false, Ordering::SeqCst);
        let _ = app.emit("voice-done", Done { ok: r.is_ok(), error: r.err().unwrap_or_default() });
    };
    if crate::sem::python().exists() {
        std::thread::spawn(move || {
            let r = setup(&app);
            finish(app, r);
        });
    } else {
        let a2 = app.clone();
        crate::sem::Sem::install(app, move |ok| {
            let r = if ok { setup(&a2) } else { Err("Orbis's offline engine could not be installed".into()) };
            finish(a2, r);
        });
    }
}

/// Ctrl+Alt+Space only while voice is on (so it never takes the keys from other apps for nothing)
pub fn apply_hotkey(app: &AppHandle, on: bool) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let has = gs.is_registered(HOTKEY);
    if on && !has {
        if let Err(e) = gs.register(HOTKEY) {
            eprintln!("voice hotkey: {e}");
        }
    } else if !on && has {
        let _ = gs.unregister(HOTKEY);
    }
}
/// the hotkey was pressed: bring Orbis up and let the page listen
pub fn on_hotkey(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("voice-ptt", ());
}

/// The page may use the microphone without WebView2's own "allow?" prompt (only the microphone).
pub fn allow_mic(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(a) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                a.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    a.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = std::mem::zeroed();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

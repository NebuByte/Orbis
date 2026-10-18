//! Descriptive search: a small Python helper (orbis_sem.py) running multilingual-e5-small with
//! OpenVINO on the best device this PC has - an Intel NPU, else the Intel GPU, else the CPU.
//! It lives in %LOCALAPPDATA%\Orbis\engine with its own private Python, installed on request
//! (install), so nothing has to be set up by hand. The helper starts on the first keystroke,
//! talks JSON lines over stdin/stdout, and exits by itself after 2 idle minutes.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STALE_RUN_SECS: i64 = 15 * 60;
/// the helper and the installer travel inside orbis.exe and are written out when needed
const SCRIPT: &str = include_str!("../../semantic/orbis_sem.py");
const SETUP: &str = include_str!("engine-setup.ps1");

fn appdata() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into())).join("Orbis")
}
/// where the engine lives (ORBIS_ENGINE overrides it, e.g. for development)
pub fn engine_dir() -> PathBuf {
    std::env::var("ORBIS_ENGINE").map(PathBuf::from).unwrap_or_else(|_| appdata().join("engine"))
}
fn python() -> PathBuf {
    engine_dir().join(r".venv\Scripts\python.exe")
}
fn data() -> PathBuf {
    appdata().join("semantic")
}
/// the helper script on disk, refreshed when this build carries a different one
fn script() -> PathBuf {
    let p = engine_dir().join("orbis_sem.py");
    if std::fs::read_to_string(&p).map(|t| t != SCRIPT).unwrap_or(true) && engine_dir().exists() {
        let _ = std::fs::write(&p, SCRIPT);
    }
    p
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
}

#[derive(Default)]
pub struct Sem {
    p: Mutex<Option<Proc>>,
    installing: AtomicBool,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SemHit {
    pub path: String,
    pub score: f32,
    pub snip: String,
}

#[derive(Deserialize)]
struct Reply {
    hits: Option<Vec<SemHit>>,
    answers: Option<Vec<Answer>>,
    error: Option<String>,
    ms: Option<f64>,
}

/// The passage of a document that best answers a question.
#[derive(Serialize, Deserialize, Clone)]
pub struct Answer {
    pub path: String,
    pub passage: String,
    pub score: f32,
}

/// What the indexer last wrote to status.json, plus whether the engine is installed and running.
#[derive(Serialize, Deserialize, Default)]
pub struct SemStatus {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub installing: bool,
    #[serde(default)]
    pub files: u64,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub done: u64,
    #[serde(default)]
    pub of: u64,
    #[serde(default)]
    pub built: i64,
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub device: String,
    /// the search helper is loaded right now (it exits by itself after 2 idle minutes)
    #[serde(default)]
    pub helper: bool,
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
    devices: serde_json::Value,
}

impl Sem {
    /// installed: a private Python and the model are in the engine folder
    pub fn available() -> bool {
        python().exists() && (engine_dir().join(r"model\onnx\model.onnx").exists() || engine_dir().join(r"model\ir").exists())
    }

    fn lock(&self) -> MutexGuard<'_, Option<Proc>> {
        self.p.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn spawn(device: &str) -> Result<Proc, String> {
        let mut child = Command::new(python())
            .arg("-u")
            .arg(script())
            .arg("serve")
            .env("ORBIS_DEVICE", device)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("descriptive search could not start: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut line = String::new();
        if out.read_line(&mut line).unwrap_or(0) == 0 || !line.contains("\"ready\"") {
            let _ = child.kill();
            return Err("descriptive search did not start".into());
        }
        Ok(Proc { child, stdin, out })
    }

    fn ask(p: &mut Proc, req: &str) -> Result<Reply, String> {
        p.stdin.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        p.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        p.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        if p.out.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("sidecar closed".into());
        }
        serde_json::from_str(&line).map_err(|e| e.to_string())
    }

    /// Ranked documents for a description. A helper that exited while idle is restarted once.
    pub fn query(&self, q: &str, k: usize, device: &str) -> Result<(Vec<SemHit>, f64), String> {
        let req = serde_json::json!({ "q": q, "k": k }).to_string();
        let mut g = self.lock();
        for _ in 0..2 {
            if g.is_none() {
                *g = Some(Self::spawn(device)?);
            }
            match Self::ask(g.as_mut().unwrap(), &req) {
                Ok(r) => {
                    if let Some(e) = r.error {
                        return Err(e);
                    }
                    return Ok((r.hits.unwrap_or_default(), r.ms.unwrap_or(0.0)));
                }
                Err(_) => {
                    if let Some(mut p) = g.take() {
                        let _ = p.child.kill();
                    }
                }
            }
        }
        Err("descriptive search is not responding".into())
    }

    /// The passages of these documents that best answer the question (the helper reads them in full).
    pub fn answer(&self, q: &str, paths: &[String], device: &str) -> Result<Vec<Answer>, String> {
        let req = serde_json::json!({ "op": "passage", "q": q, "paths": paths }).to_string();
        let mut g = self.lock();
        if g.is_none() {
            *g = Some(Self::spawn(device)?);
        }
        let r = Self::ask(g.as_mut().unwrap(), &req)?;
        match r.error {
            Some(e) => Err(e),
            None => Ok(r.answers.unwrap_or_default()),
        }
    }

    /// Start the helper ahead of the first query (model load takes a moment).
    pub fn warm(&self, device: &str) {
        let mut g = self.lock();
        if g.is_none() {
            *g = Self::spawn(device).ok();
        }
    }

    pub fn stop(&self) {
        if let Some(mut p) = self.lock().take() {
            let _ = p.child.kill();
        }
    }

    pub fn status(&self, now: i64) -> SemStatus {
        let mut s: SemStatus = std::fs::read_to_string(data().join("status.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        s.available = Self::available();
        s.installing = self.installing.load(Ordering::SeqCst);
        s.live = s.running && now - s.ts < STALE_RUN_SECS;
        let mut g = self.lock();
        let gone = g.as_mut().map(|p| !matches!(p.child.try_wait(), Ok(None))).unwrap_or(false);
        if gone {
            *g = None;   // it shut itself down after idling
        }
        s.helper = g.is_some();
        s
    }

    /// Read documents in the background (idle priority, new and changed files only). The indexer
    /// holds a lock file, so a second start while one runs just exits.
    pub fn start_index(roots: &[String], device: &str) -> Result<(), String> {
        if !Self::available() {
            return Err("descriptive search is not installed".into());
        }
        let _ = std::fs::create_dir_all(data());
        let log = std::fs::File::create(data().join("index.log")).map_err(|e| e.to_string())?;
        Command::new(python())
            .arg("-u")
            .arg(script())
            .arg("index")
            .args(roots)
            .env("ORBIS_DEVICE", device)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Install the engine (one hidden PowerShell run). Progress goes to the UI as "engine-progress",
    /// the end as "engine-done"; then `then` runs (Orbis starts reading documents).
    pub fn install(app: AppHandle, then: impl FnOnce(bool) + Send + 'static) {
        use tauri::Manager;
        if app.state::<Sem>().installing.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            let dir = engine_dir();
            let ok = (|| -> Result<serde_json::Value, String> {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                std::fs::write(dir.join("orbis_sem.py"), SCRIPT).map_err(|e| e.to_string())?;
                std::fs::write(dir.join("setup.ps1"), SETUP).map_err(|e| e.to_string())?;
                let mut child = Command::new("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(dir.join("setup.ps1"))
                    .arg("-Dir")
                    .arg(&dir)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                let (mut devices, mut error) = (serde_json::Value::Null, String::new());
                for line in BufReader::new(child.stdout.take().ok_or("no output")?).lines().map_while(Result::ok) {
                    if let Some(rest) = line.strip_prefix("STEP ") {
                        let (p, m) = rest.split_once(' ').unwrap_or((rest, ""));
                        let _ = app.emit("engine-progress", Progress { pct: p.parse().unwrap_or(0), msg: m.into() });
                    } else if let Some(j) = line.strip_prefix("DEVICES ") {
                        devices = serde_json::from_str(j).unwrap_or(serde_json::Value::Null);
                    } else if let Some(e) = line.strip_prefix("ERROR ") {
                        error = e.into();
                    }
                }
                let st = child.wait().map_err(|e| e.to_string())?;
                if !st.success() || !Self::available() {
                    return Err(if error.is_empty() { "the setup did not finish".into() } else { error });
                }
                Ok(devices)
            })();
            app.state::<Sem>().installing.store(false, Ordering::SeqCst);
            let done = match &ok {
                Ok(d) => Done { ok: true, error: String::new(), devices: d.clone() },
                Err(e) => Done { ok: false, error: e.clone(), devices: serde_json::Value::Null },
            };
            let _ = app.emit("engine-done", done);
            then(ok.is_ok());
        });
    }
}

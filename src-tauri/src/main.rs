// Orbis - neural file explorer + launcher. A normal app: opens full screen (kiosk) or in a
// window (F11 switches), and EXIT closes it completely - no tray, no hotkey, nothing left behind.
// This file: the commands the UI calls, background indexing, and the bridge to the NPU
// descriptive search (sem.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod env;
mod index;
mod sem;
mod sys;
mod watch;

use index::{GNode, Index, Skip, K_FILE, K_LINK, NONE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, RunEvent, State, WebviewWindow};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REFRESH_AFTER_SECS: i64 = 12 * 3600;
const SEM_REFRESH_AFTER_SECS: i64 = 24 * 3600;

struct Shared {
    idx: RwLock<Option<Arc<Index>>>,
    building: AtomicBool,
    progress: Arc<AtomicU64>,
    /// lowercase current path -> (where it came from, what moved it)
    moves: RwLock<HashMap<String, (String, String)>>,
}

/// Everything the first-run setup (and the settings panel) can choose. Missing fields take their
/// defaults, so older settings files keep working.
#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    #[serde(default = "yes")]
    kiosk: bool,
    #[serde(default = "default_theme")]
    theme: String,
    /// the first-run setup was completed (or skipped)
    #[serde(default)]
    setup_done: bool,
    /// frame rate: "auto" (60 plugged in, 30 on battery), "60" or "30"
    #[serde(default = "auto")]
    fps: String,
    /// "full" or "lite" (no glows, sparks or landmarks - for modest graphics)
    #[serde(default = "full")]
    visuals: String,
    /// live activity: watch the drives for changes
    #[serde(default = "yes")]
    live: bool,
    /// descriptive search on/off, and where it runs: "auto" | "NPU" | "GPU" | "CPU"
    #[serde(default)]
    semantic: bool,
    #[serde(default = "auto")]
    sem_device: String,
    /// folders whose documents are read for descriptive search (empty: Desktop, Documents, Downloads)
    #[serde(default)]
    doc_roots: Vec<String>,
    /// drives on the map (empty: every fixed drive)
    #[serde(default)]
    drives: Vec<String>,
    /// places left out of the map and the search: the suggested ones that are ticked (see places())
    #[serde(default = "default_skip_places")]
    skip_places: Vec<String>,
    /// and your own folders to leave out
    #[serde(default)]
    skip_custom: Vec<String>,
    /// file types that show in results (folders always do); all_types: every type shows
    #[serde(default)]
    all_types: bool,
    #[serde(default = "default_types")]
    types: Vec<String>,
    /// Orbis is the Windows screen saver, after this many idle minutes
    #[serde(default)]
    saver: bool,
    #[serde(default = "ten")]
    saver_minutes: u32,
    /// set by the UI when this PC could not keep the motion smooth: 1 = no 60 fps, 2 = also lite effects
    #[serde(default)]
    perf_cap: u8,
    /// start with Windows (the Run key is the switch; this remembers it, so it can be put back)
    #[serde(default)]
    autostart: Option<bool>,
    /// when Windows starts Orbis, stay in the tray instead of opening full screen
    #[serde(default)]
    tray_start: bool,
}
fn ten() -> u32 {
    10
}
impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").expect("defaults")
    }
}
fn yes() -> bool {
    true
}
fn default_theme() -> String {
    "ice".into()
}
fn auto() -> String {
    "auto".into()
}
fn full() -> String {
    "full".into()
}

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into())).join("Orbis")
}
/// Orbis used to be called Twin. On a PC that ran Twin, carry everything over once: the data folder
/// (index, settings, search engine, pins) and the Windows settings that pointed at the old name -
/// restore_windows_settings() then points Start with Windows and the screen saver at Orbis.
fn migrate_from_twin() {
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS}, RegKey};
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into()));
    let old = local.join("Twin");
    if !old.is_dir() || data_dir().exists() || std::fs::rename(&old, data_dir()).is_err() {
        return; // nothing to move, already moved, or Twin is still open (next start tries again)
    }
    let _ = std::fs::remove_file(data_dir().join("Twin.scr"));
    let _ = std::fs::remove_dir_all(local.join("com.nebubyte.twin")); // the old window's browser cache
    let hk = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(k) = hk.open_subkey_with_flags(RUN_KEY, KEY_ALL_ACCESS) {
        let _ = k.delete_value("Twin");
    }
    if let Ok(k) = hk.open_subkey_with_flags(DESKTOP_KEY, KEY_ALL_ACCESS) {
        let cur: String = k.get_value("SCRNSAVE.EXE").unwrap_or_default();
        if cur.to_lowercase().ends_with(r"\twin\twin.scr") {
            let _ = k.delete_value("SCRNSAVE.EXE");
        }
    }
}
fn cache_path() -> PathBuf {
    data_dir().join("index.bin")
}
fn load_settings() -> Settings {
    std::fs::read_to_string(data_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}
fn save_settings(s: &Settings) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(data_dir().join("settings.json"), serde_json::to_string(s).unwrap_or_default());
}

/// The drives on the map: the ones chosen in settings, or every fixed drive of this PC.
fn map_drives(s: &Settings) -> Vec<String> {
    let fixed = env::fixed_drives();
    let chosen: Vec<String> = s.drives.iter().filter(|d| fixed.iter().any(|f| f.eq_ignore_ascii_case(d))).cloned().collect();
    if chosen.is_empty() {
        fixed
    } else {
        chosen
    }
}
fn roots(s: &Settings) -> Vec<(String, PathBuf)> {
    map_drives(s).into_iter().map(|d| (d.clone(), PathBuf::from(format!("{d}\\")))).filter(|(_, p)| p.exists()).collect()
}

// ---------------------------------------------------------------- what Orbis searches
// Two choices in the settings. File types: only the chosen ones show in results (checked while
// searching, so a change is instant; folders always show). Places: folders the scan leaves out
// altogether - Windows, programs and app caches by default - so they never fill the map or the
// results (a change re-scans the drives).

/// The file types offered: (key, label, extensions, on by default)
const TYPE_GROUPS: &[(&str, &str, &[&str], bool)] = &[
    ("docs", "Documents", &["pdf", "doc", "docx", "xls", "xlsx", "xlsm", "csv", "ppt", "pptx", "txt", "md", "rtf", "odt", "ods", "odp", "epub"], true),
    ("images", "Images", &["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "tif", "tiff", "psd", "ai", "raw"], true),
    ("video", "Video", &["mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v"], true),
    ("audio", "Audio", &["mp3", "wav", "flac", "m4a", "ogg", "aac", "wma"], true),
    ("archives", "Archives", &["zip", "rar", "7z", "tar", "gz", "iso"], true),
    ("apps", "Apps and shortcuts", &["exe", "msi", "lnk", "url", "apk", "appx", "msix"], true),
    ("design", "Design and 3D", &["dwg", "dxf", "skp", "blend", "fbx", "obj", "stl", "fig", "xd"], true),
    ("code", "Code and data", &["js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "cs", "php", "html", "css", "json", "xml", "yml", "yaml", "sql", "ps1", "bat", "sh", "ipynb"], false),
];
fn default_types() -> Vec<String> {
    TYPE_GROUPS.iter().filter(|g| g.3).flat_map(|g| g.2.iter().map(|e| e.to_string())).collect()
}

/// A place Orbis suggests leaving out, with its folders on this PC.
#[derive(Serialize)]
struct Place {
    key: &'static str,
    label: &'static str,
    paths: Vec<String>,
}
fn places() -> Vec<Place> {
    let sys = env::system_drive();
    let var = |v: &str, d: String| std::env::var(v).unwrap_or(d);
    let mut programs = vec![var("ProgramFiles", format!(r"{sys}\Program Files")), var("ProgramFiles(x86)", format!(r"{sys}\Program Files (x86)"))];
    for d in env::fixed_drives().iter().filter(|d| !d.eq_ignore_ascii_case(&sys)) {
        programs.push(format!(r"{d}\Program Files"));
        programs.push(format!(r"{d}\Program Files (x86)"));
    }
    let leftovers = ["Windows.old", "$WinREAgent", "Config.Msi", "Recovery", "PerfLogs", "$Windows.~BT", "$Windows.~WS", "$SysReset", "MSOCache"];
    vec![
        Place { key: "windows", label: "Windows", paths: vec![var("SystemRoot", format!(r"{sys}\Windows"))] },
        Place { key: "program_files", label: "Program Files", paths: programs },
        Place { key: "program_data", label: "ProgramData", paths: vec![var("ProgramData", format!(r"{sys}\ProgramData"))] },
        Place { key: "appdata", label: "AppData · app settings and caches", paths: dirs::home_dir().map(|h| vec![h.join("AppData").display().to_string()]).unwrap_or_default() },
        Place { key: "setup", label: "Windows setup and recovery leftovers", paths: leftovers.iter().map(|n| format!(r"{sys}\{n}")).collect() },
    ]
}
fn default_skip_places() -> Vec<String> {
    ["windows", "program_files", "program_data", "appdata", "setup"].iter().map(|s| s.to_string()).collect()
}

/// Every folder the scan leaves out: the ticked places, your own, and on every drive the Recycle Bin
/// and System Volume Information. Sorted, so it also tells whether the index matches the settings.
fn skip_list(s: &Settings) -> Vec<String> {
    let mut v: Vec<String> = places().into_iter().filter(|p| s.skip_places.iter().any(|k| k == p.key)).flat_map(|p| p.paths).collect();
    v.extend(s.skip_custom.iter().cloned());
    for d in env::fixed_drives() {
        v.push(format!(r"{d}\$Recycle.Bin"));
        v.push(format!(r"{d}\System Volume Information"));
    }
    let mut v: Vec<String> = v.into_iter().map(|p| p.trim_end_matches('\\').to_string()).collect();
    v.sort_by_key(|p| p.to_lowercase());
    v.dedup_by_key(|p| p.to_lowercase());
    v
}
/// what the current index was built from (drives + what it left out), saved next to it
fn scope_print(s: &Settings) -> String {
    let mut v = map_drives(s);
    v.push("--".into());
    v.extend(skip_list(s));
    v.join("\n").to_lowercase()
}
fn scope_file() -> PathBuf {
    data_dir().join("index.scope")
}

#[derive(Serialize)]
struct TypeGroup {
    key: &'static str,
    label: &'static str,
    exts: Vec<&'static str>,
}
#[derive(Serialize)]
struct ScopeOptions {
    places: Vec<Place>,
    groups: Vec<TypeGroup>,
}
/// The choices for "What Orbis searches": the places as they are on this PC, and the file types.
#[tauri::command]
fn scope_options() -> ScopeOptions {
    let mut places = places();
    for p in &mut places {
        p.paths.retain(|x| Path::new(x).is_dir());
    }
    ScopeOptions { places, groups: TYPE_GROUPS.iter().map(|g| TypeGroup { key: g.0, label: g.1, exts: g.2.to_vec() }).collect() }
}
/// A folder you want left out: it must exist, and not be a whole drive.
#[tauri::command]
fn check_folder(path: String) -> Result<String, String> {
    let p = path.trim().trim_matches('"').trim_end_matches(['\\', '/']).replace('/', "\\");
    if p.len() <= 2 {
        return Err("Pick a folder, not a whole drive (drives are chosen in the setup).".into());
    }
    if !Path::new(&p).is_dir() {
        return Err(format!("There is no folder {p}"));
    }
    Ok(p)
}

/// Folders whose documents feed the descriptive search.
fn doc_roots(s: &Settings) -> Vec<String> {
    if !s.doc_roots.is_empty() {
        return s.doc_roots.clone();
    }
    [dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir()].into_iter().flatten().map(|p| p.display().to_string()).collect()
}

/// What live activity watches: the mapped drives other than the Windows drive (whole), plus the
/// user's own folders when they sit on the Windows drive - never all of C:, which changes constantly.
fn live_roots(s: &Settings) -> Vec<PathBuf> {
    let sys = env::system_drive();
    let mut v: Vec<PathBuf> = map_drives(s).into_iter().filter(|d| !d.eq_ignore_ascii_case(&sys)).map(|d| PathBuf::from(format!("{d}\\"))).collect();
    for f in env::user_folders() {
        if f.display().to_string().to_lowercase().starts_with(&sys.to_lowercase()) {
            v.push(f);
        }
    }
    v
}
fn settings_of(app: &AppHandle) -> Settings {
    app.state::<RwLock<Settings>>().read().unwrap().clone()
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn get(s: &Shared) -> Result<Arc<Index>, String> {
    s.idx.read().unwrap().clone().ok_or_else(|| "index not ready yet".into())
}

// ---------------------------------------------------------------- window: kiosk or windowed

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn apply_kiosk(w: &WebviewWindow, on: bool) {
    if on {
        let _ = w.set_fullscreen(true);
    } else {
        let _ = w.set_fullscreen(false);
        let _ = w.set_size(LogicalSize::new(1280.0, 800.0));
        let _ = w.center();
    }
}

// ---------------------------------------------------------------- tray and window
// Orbis lives in the tray: the window's close button hides it there (live activity, the screen saver
// and indexing keep going, drawing stops), a click on the tray icon brings it back, and EXIT (or
// "Exit Orbis" in the tray menu) closes it completely.

struct TrayItems {
    autostart: tauri::menu::CheckMenuItem<tauri::Wry>,
    tray_start: tauri::menu::CheckMenuItem<tauri::Wry>,
    saver: tauri::menu::CheckMenuItem<tauri::Wry>,
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// the tray menu's ticks follow the settings, wherever they were changed
fn sync_tray(app: &AppHandle) {
    if let Some(t) = app.try_state::<TrayItems>() {
        let s = settings_of(app);
        let _ = t.autostart.set_checked(autostart_on());
        let _ = t.tray_start.set_checked(s.tray_start);
        let _ = t.saver.set_checked(s.saver);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let s = settings_of(app);
    let open = MenuItem::with_id(app, "open", "Open Orbis", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on(), None::<&str>)?;
    let tray_start = CheckMenuItem::with_id(app, "tray_start", "Start quietly in the tray", true, s.tray_start, None::<&str>)?;
    let saver = CheckMenuItem::with_id(app, "saver", "Screen saver", true, s.saver, None::<&str>)?;
    let preview = MenuItem::with_id(app, "preview", "Preview the screen saver", true, None::<&str>)?;
    let rescan = MenuItem::with_id(app, "rescan", "Re-scan drives", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Exit Orbis", true, None::<&str>)?;
    let (s1, s2, s3) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
    let menu = Menu::with_items(app, &[&open, &s1, &autostart, &tray_start, &saver, &preview, &s2, &rescan, &s3, &quit])?;
    app.manage(TrayItems { autostart, tray_start, saver });
    let mut tray = TrayIconBuilder::with_id("orbis").tooltip("Orbis").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, ev| {
        let toggle = |patch: serde_json::Value| {
            if let Err(e) = update_settings(patch, app.clone()) {
                let _ = app.emit("toast", e);
            }
        };
        match ev.id().as_ref() {
            "open" => show_main(app),
            "autostart" => {
                let on = !autostart_on();
                let _ = set_autostart(on, app.clone());
            }
            "tray_start" => toggle(serde_json::json!({ "tray_start": !settings_of(app).tray_start })),
            "saver" => toggle(serde_json::json!({ "saver": !settings_of(app).saver })),
            "preview" => enter_saver(app),
            "rescan" => start_index(app.clone(), true),
            "quit" => quit_app(app.clone()),
            _ => {}
        }
        sync_tray(app);
        let _ = app.emit("prefs-changed", ());
    })
    .on_tray_icon_event(|tray, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

/// Orbis's own title bar (the window has no classic frame): minimise, maximise, hide to the tray
#[tauri::command]
fn win_minimize(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.minimize();
    }
}
#[tauri::command]
fn win_toggle_maximize(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = if w.is_maximized().unwrap_or(false) { w.unmaximize() } else { w.maximize() };
    }
}
#[tauri::command]
fn win_hide(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
    }
}

// ---------------------------------------------------------------- screen saver
// Windows runs a screen saver as "<file>.scr /s" ("/p <hwnd>" for the little preview, "/c" for its
// settings). Orbis's .scr is a copy of orbis.exe. When Orbis is already open, the copy hands over to it
// (the open window becomes the screen saver) and waits until the screen saver ends, because Windows
// counts the screen saver as running for as long as that process lives.

struct Saver {
    active: AtomicBool,
    /// this process was started by Windows only to be the screen saver: quit when it ends
    only: AtomicBool,
    /// Orbis was minimised before the screen saver: minimise it again afterwards
    was_min: AtomicBool,
    /// Orbis was hidden in the tray before the screen saver: hide it again afterwards
    was_hidden: AtomicBool,
}

mod handoff {
    use std::sync::atomic::{AtomicIsize, Ordering};
    const RUNNING: &str = "Local\\NebuByte.Orbis.Running";
    const GO: &str = "Local\\NebuByte.Orbis.SaverGo";
    const DONE: &str = "Local\\NebuByte.Orbis.SaverDone";
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const EVENT_MODIFY_STATE: u32 = 0x0002;
    static DONE_H: AtomicIsize = AtomicIsize::new(0);

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(sa: *const std::ffi::c_void, owner: i32, name: *const u16) -> isize;
        fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> isize;
        fn CreateEventW(sa: *const std::ffi::c_void, manual: i32, initial: i32, name: *const u16) -> isize;
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> isize;
        fn SetEvent(h: isize) -> i32;
        fn ResetEvent(h: isize) -> i32;
        fn WaitForSingleObject(h: isize, ms: u32) -> u32;
        fn CloseHandle(h: isize) -> i32;
    }
    fn w(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn running() -> bool {
        let r = unsafe { OpenMutexW(SYNCHRONIZE, 0, w(RUNNING).as_ptr()) };
        if r != 0 {
            unsafe { CloseHandle(r) };
        }
        r != 0
    }

    /// The open Orbis: say it is running, and become the screen saver whenever a copy asks.
    pub fn serve(on_request: impl Fn() + Send + 'static) {
        unsafe {
            CreateMutexW(std::ptr::null(), 0, w(RUNNING).as_ptr()); // held until Orbis exits
            DONE_H.store(CreateEventW(std::ptr::null(), 1, 1, w(DONE).as_ptr()), Ordering::SeqCst);
            let go = CreateEventW(std::ptr::null(), 0, 0, w(GO).as_ptr());
            if go == 0 {
                return;
            }
            std::thread::spawn(move || {
                while WaitForSingleObject(go, u32::MAX) == 0 {
                    on_request();
                }
            });
        }
    }
    /// The screen saver started or ended; a waiting copy quits when it ends.
    pub fn saver_running(on: bool) {
        let h = DONE_H.load(Ordering::SeqCst);
        if h != 0 {
            unsafe {
                if on {
                    ResetEvent(h);
                } else {
                    SetEvent(h);
                }
            }
        }
    }
    /// The copy Windows started: when Orbis is already open, hand over to it and wait for the end.
    pub fn forward() -> bool {
        if !running() {
            return false;
        }
        unsafe {
            let go = OpenEventW(EVENT_MODIFY_STATE, 0, w(GO).as_ptr());
            let done = OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, 0, w(DONE).as_ptr());
            if go == 0 || done == 0 {
                for h in [go, done] {
                    if h != 0 {
                        CloseHandle(h);
                    }
                }
                return false;
            }
            ResetEvent(done);
            SetEvent(go);
            // until the screen saver ends, or Orbis closes
            while WaitForSingleObject(done, 1000) != 0 && running() {}
            CloseHandle(go);
            CloseHandle(done);
        }
        true
    }
}

#[derive(PartialEq)]
enum Launch {
    Normal,
    Saver,
    Preview,
}
fn launch_kind(args: &[String]) -> Launch {
    match args.get(1).map(|a| a.to_lowercase()) {
        Some(a) if a.starts_with("/s") || a.starts_with("-s") => Launch::Saver,
        Some(a) if a.starts_with("/p") || a.starts_with("-p") => Launch::Preview,
        _ => Launch::Normal,
    }
}

/// Become the screen saver: full screen on top, catch up on indexing while nobody is using the PC.
fn enter_saver(app: &AppHandle) {
    let sv = app.state::<Saver>();
    if sv.active.swap(true, Ordering::SeqCst) {
        return;
    }
    handoff::saver_running(true);
    if let Some(w) = main_window(app) {
        sv.was_min.store(w.is_minimized().unwrap_or(false), Ordering::SeqCst);
        sv.was_hidden.store(!w.is_visible().unwrap_or(true), Ordering::SeqCst);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_fullscreen(true);
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
    let _ = app.emit("saver", true);
    // catch up on indexing while nobody is using the PC
    let app = app.clone();
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        for _ in 0..120 {
            if shared.idx.read().unwrap().is_some() {
                break; // a fresh start loads the cached index first
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        // the drives: a fresh scan when the index is over half an hour old
        let stale = shared.idx.read().unwrap().as_ref().map(|ix| now() - ix.built_at > 1800).unwrap_or(false);
        if stale && app.state::<Saver>().active.load(Ordering::SeqCst) {
            start_index(app.clone(), true);
        }
        // the documents: only new and changed ones are read
        let set = settings_of(&app);
        if set.semantic && !app.state::<sem::Sem>().status(now()).live {
            let _ = sem::Sem::start_index(&doc_roots(&set), &set.sem_device);
        }
    });
}

/// The screen saver, now (the Preview button).
#[tauri::command]
fn start_saver(app: AppHandle) {
    enter_saver(&app);
}

/// Any input ends the screen saver: back to how Orbis was, or quit if it only ran as the saver.
#[tauri::command]
fn exit_saver(app: AppHandle) {
    let sv = app.state::<Saver>();
    if !sv.active.swap(false, Ordering::SeqCst) {
        return;
    }
    handoff::saver_running(false);
    if sv.only.load(Ordering::SeqCst) {
        app.state::<sem::Sem>().stop();
        app.exit(0);
        return;
    }
    if let Some(w) = main_window(&app) {
        let _ = w.set_always_on_top(false);
        apply_kiosk(&w, settings_of(&app).kiosk);
        if sv.was_hidden.load(Ordering::SeqCst) {
            let _ = w.hide();
        } else if sv.was_min.load(Ordering::SeqCst) {
            let _ = w.minimize();
        }
    }
    let _ = app.emit("saver", false);
}

const DESKTOP_KEY: &str = r"Control Panel\Desktop";
fn saver_file() -> PathBuf {
    data_dir().join("Orbis.scr")
}
/// Keep the .scr copy in step with this build (it is a copy of orbis.exe).
fn refresh_saver_file() {
    let (Ok(exe), dst) = (std::env::current_exe(), saver_file()) else { return };
    let stale = match (std::fs::metadata(&exe), std::fs::metadata(&dst)) {
        (Ok(a), Ok(b)) => a.len() != b.len() || a.modified().ok() > b.modified().ok(),
        _ => true,
    };
    if stale {
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::copy(&exe, &dst);
    }
}
#[link(name = "user32")]
extern "system" {
    fn SystemParametersInfoW(action: u32, param: u32, pv: *mut std::ffi::c_void, winini: u32) -> i32;
}
/// Make Orbis the Windows screen saver (or stop being it). Per user, no admin rights needed. The
/// screen saver that was set before is remembered and comes back when Orbis stops being it.
fn apply_screensaver(on: bool, minutes: u32) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(DESKTOP_KEY).map_err(|e| e.to_string())?;
    let ours = saver_file().display().to_string();
    let prev_file = data_dir().join("saver-before.json");
    let current: String = k.get_value("SCRNSAVE.EXE").unwrap_or_default();
    let is_ours = current.eq_ignore_ascii_case(&ours);
    let mut active = on;
    if on {
        if !is_ours {
            let before = serde_json::json!({ "exe": current, "active": k.get_value::<String, _>("ScreenSaveActive").unwrap_or_default() });
            let _ = std::fs::write(&prev_file, before.to_string());
        }
        refresh_saver_file();
        k.set_value("SCRNSAVE.EXE", &ours).map_err(|e| e.to_string())?;
        k.set_value("ScreenSaveActive", &"1").map_err(|e| e.to_string())?;
        k.set_value("ScreenSaveTimeOut", &(minutes.max(1) * 60).to_string()).map_err(|e| e.to_string())?;
    } else if is_ours {
        let before: serde_json::Value = std::fs::read_to_string(&prev_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let exe = before["exe"].as_str().unwrap_or("");
        if exe.is_empty() || !Path::new(exe).exists() {
            let _ = k.delete_value("SCRNSAVE.EXE");
        } else {
            k.set_value("SCRNSAVE.EXE", &exe).map_err(|e| e.to_string())?;
            active = before["active"].as_str() == Some("1");
        }
        k.set_value("ScreenSaveActive", &if active { "1" } else { "0" }).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&prev_file);
    } else {
        return Ok(()); // someone picked another screen saver since: leave it alone
    }
    // tell Windows now (SPI_SETSCREENSAVEACTIVE, SPI_SETSCREENSAVETIMEOUT; send the change)
    unsafe {
        SystemParametersInfoW(0x0011, active as u32, std::ptr::null_mut(), 2);
        if on {
            SystemParametersInfoW(0x000F, minutes.max(1) * 60, std::ptr::null_mut(), 2);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- indexing

/// Load the cached index right away (instant start). Build a fresh one when there is no
/// cache, when asked, or when the cache is older than 12 hours - the old one stays usable
/// until the new one is swapped in.
fn start_index(app: AppHandle, force: bool) {
    let s = app.state::<Shared>();
    if s.building.swap(true, Ordering::SeqCst) {
        return;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let s = app2.state::<Shared>();
        let mut need_build = force;
        if !force {
            match Index::load(&cache_path()) {
                Some(ix) => {
                    // stale, or built with other drives / places left out than the settings say now
                    let scope_ok = std::fs::read_to_string(scope_file()).is_ok_and(|t| t == scope_print(&settings_of(&app2)));
                    need_build = now() - ix.built_at > REFRESH_AFTER_SECS || !scope_ok;
                    *s.idx.write().unwrap() = Some(Arc::new(ix));
                    let _ = app2.emit("index-ready", ());
                }
                None => need_build = true,
            }
        }
        if need_build {
            s.progress.store(0, Ordering::Relaxed);
            let done = Arc::new(AtomicBool::new(false));
            {
                let (app3, done, prog) = (app2.clone(), done.clone(), s.progress.clone());
                std::thread::spawn(move || {
                    while !done.load(Ordering::Relaxed) {
                        let _ = app3.emit("index-progress", prog.load(Ordering::Relaxed));
                        std::thread::sleep(Duration::from_millis(250));
                    }
                });
            }
            let t = Instant::now();
            let set = settings_of(&app2);
            let ix = Index::build(&roots(&set), &Skip::new(&skip_list(&set)), &s.progress);
            done.store(true, Ordering::Relaxed);
            let _ = ix.save(&cache_path());
            let _ = std::fs::write(scope_file(), scope_print(&set));
            let secs = t.elapsed().as_secs_f32();
            *s.idx.write().unwrap() = Some(Arc::new(ix));
            let _ = app2.emit("index-built", secs);
            let _ = app2.emit("index-ready", ());
        }
        s.building.store(false, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------- "came from" history

/// Minimal CSV line reader: quoted fields, "" as an escaped quote.
fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q = false;
    let mut it = line.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '"' if q && it.peek() == Some(&'"') => {
                cur.push('"');
                it.next();
            }
            '"' => q = !q,
            ',' if !q => out.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// Optional move history: %LOCALAPPDATA%\\Orbis\\moves.csv with columns From,To[,Why] - written by
/// file-organising tools, so Orbis can say where a moved file used to be. Absent on most PCs.
fn load_moves() -> HashMap<String, (String, String)> {
    let mut m = HashMap::new();
    if let Ok(t) = std::fs::read_to_string(data_dir().join("moves.csv")) {
        for l in t.lines().skip(1) {
            let f = csv_fields(l);
            if f.len() >= 2 && !f[1].is_empty() {
                let why = f.get(2).filter(|w| !w.is_empty()).cloned().unwrap_or_else(|| "moved".into());
                m.insert(f[1].to_lowercase(), (f[0].clone(), why));
            }
        }
    }
    m
}

/// Exact path first, then the nearest moved parent folder (a moved folder carries its files).
fn came_from(moves: &HashMap<String, (String, String)>, path: &str) -> Option<(String, String)> {
    let lower = path.to_lowercase();
    if let Some(v) = moves.get(&lower) {
        return Some(v.clone());
    }
    let mut cut = lower.len();
    while let Some(i) = lower[..cut].rfind('\\') {
        cut = i;
        if let Some((from, why)) = moves.get(&lower[..cut]) {
            let from_base = from.trim_end_matches(" (on the HP)");
            return Some((format!("{from_base}{}", &path[cut..]), why.clone()));
        }
    }
    None
}

#[derive(Serialize)]
struct Zone {
    host: Option<String>,
    referrer: Option<String>,
    zone: Option<String>,
}

/// The "downloaded from" stamp Windows writes next to downloaded files.
fn zone_of(path: &str) -> Option<Zone> {
    let t = std::fs::read_to_string(format!("{path}:Zone.Identifier")).ok()?;
    let val = |k: &str| t.lines().find_map(|l| l.strip_prefix(k)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    Some(Zone { host: val("HostUrl="), referrer: val("ReferrerUrl="), zone: val("ZoneId=") })
}


// ---------------------------------------------------------------- commands: files

#[derive(Serialize)]
struct Status {
    ready: bool,
    building: bool,
    items: usize,
    built_at: i64,
    scanned: u64,
    apps: usize,
    kiosk: bool,
    theme: String,
    autostart: bool,
    saver_active: bool,
    settings: Settings,
    sem: sem::SemStatus,
}

#[tauri::command]
fn status(s: State<Shared>, a: State<apps::Apps>, st: State<RwLock<Settings>>, e: State<sem::Sem>, sv: State<Saver>) -> Status {
    let ix = s.idx.read().unwrap().clone();
    let set = st.read().unwrap().clone();
    Status {
        ready: ix.is_some(),
        building: s.building.load(Ordering::Relaxed),
        items: ix.as_ref().map(|i| i.len()).unwrap_or(0),
        built_at: ix.as_ref().map(|i| i.built_at).unwrap_or(0),
        scanned: s.progress.load(Ordering::Relaxed),
        apps: a.count(),
        kiosk: set.kiosk,
        theme: set.theme.clone(),
        autostart: autostart_on(),
        saver_active: sv.active.load(Ordering::SeqCst),
        sem: e.status(now()),
        settings: set,
    }
}

#[tauri::command]
async fn base_graph(s: State<'_, Shared>) -> Result<Vec<GNode>, String> {
    Ok(get(&s)?.base_graph())
}

#[derive(Serialize)]
struct Hit {
    id: u32,
    kind: u8,
    size: u64,
    mtime: u32,
    tooling: bool,
    /// inside agent worktrees, build output or test data
    noisy: bool,
    chain: Vec<GNode>,
}

#[derive(Serialize)]
struct SearchOut {
    total: usize,
    ms: f64,
    hits: Vec<Hit>,
}

#[tauri::command]
async fn search(q: String, limit: usize, filters: Option<index::Filters>, s: State<'_, Shared>, st: State<'_, RwLock<Settings>>) -> Result<SearchOut, String> {
    let ix = get(&s)?;
    let t = Instant::now();
    let mut f = filters.unwrap_or_default();
    {
        let set = st.read().unwrap();
        if !set.all_types && f.exts.is_empty() {
            f.allowed = Some(set.types.iter().map(|e| e.to_lowercase()).collect());
        }
    }
    let (total, top) = ix.search(&q, &f, limit.clamp(1, 1000));
    let hits = top
        .iter()
        .map(|&(i, _)| {
            let u = i as usize;
            Hit { id: i, kind: ix.kind[u], size: ix.size[u], mtime: ix.mtime[u], tooling: ix.is_tooling(u), noisy: ix.is_noise(u), chain: ix.chain(i) }
        })
        .collect();
    Ok(SearchOut { total, ms: t.elapsed().as_secs_f64() * 1000.0, hits })
}

#[derive(Serialize)]
struct SemHitOut {
    path: String,
    score: f32,
    snip: String,
    /// the same item in the file index (None when it lives somewhere Orbis does not map)
    id: Option<u32>,
    size: u64,
    mtime: u32,
    noisy: bool,
    chain: Vec<GNode>,
}

#[derive(Serialize)]
struct DescribeOut {
    ms: f64,
    hits: Vec<SemHitOut>,
}

/// Descriptive search on the NPU: documents ranked by meaning, joined to the map.
#[tauri::command]
async fn describe(q: String, k: usize, app: AppHandle) -> Result<DescribeOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let set = settings_of(&app);
        if !set.semantic {
            return Err("descriptive search is off".into());
        }
        let (hits, ms) = app.state::<sem::Sem>().query(&q, k.clamp(1, 60), &set.sem_device)?;
        let ix = app.state::<Shared>().idx.read().unwrap().clone();
        let paths: Vec<String> = hits.iter().map(|h| h.path.clone()).collect();
        let ids = ix.as_ref().map(|ix| ix.find_paths(&paths)).unwrap_or_else(|| vec![None; paths.len()]);
        let out = hits
            .into_iter()
            .zip(ids)
            .map(|(h, id)| {
                let (size, mtime, chain) = match (id, ix.as_ref()) {
                    (Some(i), Some(ix)) => (ix.size[i as usize], ix.mtime[i as usize], ix.chain(i)),
                    _ => {
                        let md = std::fs::metadata(&h.path).ok();
                        let mt = md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as u32).unwrap_or(0);
                        (md.map(|m| m.len()).unwrap_or(0), mt, Vec::new())
                    }
                };
                SemHitOut { noisy: matches!((id, ix.as_ref()), (Some(i), Some(ix)) if ix.is_noise(i as usize)), path: h.path, score: h.score, snip: h.snip, id, size, mtime, chain }
            })
            .collect();
        Ok(DescribeOut { ms, hits: out })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Start the descriptive search ahead of the first query (called on the first keystroke).
#[tauri::command]
async fn describe_warm(app: AppHandle) {
    let set = settings_of(&app);
    if set.semantic && sem::Sem::available() {
        let _ = tauri::async_runtime::spawn_blocking(move || app.state::<sem::Sem>().warm(&set.sem_device)).await;
    }
}

#[tauri::command]
fn reindex_docs(app: AppHandle) -> Result<(), String> {
    let set = settings_of(&app);
    sem::Sem::start_index(&doc_roots(&set), &set.sem_device)
}

/// This PC, for the first-run setup: hardware, drives, user folders.
#[tauri::command]
fn system_profile(s: State<sys::Sys>) -> env::Profile {
    let st = s.sample();
    env::profile(st.battery.is_some(), st.mem_total)
}

/// Install the descriptive-search engine; when it is ready, turn the feature on and read documents.
#[tauri::command]
fn install_engine(app: AppHandle) {
    let h = app.clone();
    sem::Sem::install(app, move |ok| {
        if ok {
            let state = h.state::<RwLock<Settings>>();
            let mut s = state.write().unwrap();
            s.semantic = true;
            save_settings(&s);
            let _ = sem::Sem::start_index(&doc_roots(&s), &s.sem_device);
        }
    });
}

/// Change settings (any subset of fields) and apply what they affect right away.
#[tauri::command]
fn update_settings(patch: serde_json::Value, app: AppHandle) -> Result<Settings, String> {
    let st = app.state::<RwLock<Settings>>();
    let before = st.read().unwrap().clone();
    let mut v = serde_json::to_value(&before).map_err(|e| e.to_string())?;
    if let (Some(o), Some(p)) = (v.as_object_mut(), patch.as_object()) {
        for (k, val) in p {
            o.insert(k.clone(), val.clone());
        }
    }
    let after: Settings = serde_json::from_value(v).map_err(|e| e.to_string())?;
    {
        let mut w = st.write().unwrap();
        *w = after.clone();
        save_settings(&w);
    }
    if after.live != before.live || after.drives != before.drives {
        watch::stop(&app);
        if after.live {
            watch::start(app.clone(), live_roots(&after));
        }
    }
    if after.drives != before.drives || skip_list(&after) != skip_list(&before) {
        start_index(app.clone(), true); // a re-scan with the new drives / places left out
    }
    if after.saver != before.saver || (after.saver && after.saver_minutes != before.saver_minutes) {
        apply_screensaver(after.saver, after.saver_minutes)?;
    }
    sync_tray(&app);
    if !after.semantic || after.sem_device != before.sem_device {
        app.state::<sem::Sem>().stop();
    }
    if after.semantic && (!before.semantic || after.doc_roots != before.doc_roots || after.sem_device != before.sem_device) {
        let _ = sem::Sem::start_index(&doc_roots(&after), &after.sem_device);
    }
    Ok(after)
}

#[derive(Serialize)]
struct Details {
    id: u32,
    name: String,
    path: String,
    kind: u8,
    size: u64,
    count: u32,
    dirs: u32,
    files: u32,
    mtime: u32,
    created: i64,
    is_repo: bool,
    tooling: bool,
    zone: Option<Zone>,
    came_from: Option<(String, String)>,
}

#[tauri::command]
async fn details(id: u32, s: State<'_, Shared>) -> Result<Details, String> {
    let ix = get(&s)?;
    let i = id as usize;
    if i >= ix.len() {
        return Err("no such item".into());
    }
    let path = ix.path(id);
    let (dirs, files) = ix.direct_children(id);
    let created = std::fs::metadata(&path).ok().and_then(|m| m.created().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
    let is_file = ix.kind[i] == K_FILE || ix.kind[i] == K_LINK;
    Ok(Details {
        id,
        name: ix.name(i).to_string(),
        kind: ix.kind[i],
        size: ix.size[i],
        count: ix.count[i],
        dirs,
        files,
        mtime: ix.mtime[i],
        created,
        is_repo: !is_file && Path::new(&path).join(".git").exists(),
        tooling: ix.is_tooling(i),
        zone: if is_file { zone_of(&path) } else { None },
        came_from: came_from(&s.moves.read().unwrap(), &path),
        path,
    })
}

/// Items are addressed by index id; documents found by meaning that the map does not hold
/// (rare) are addressed by their path instead.
fn target(s: &Shared, id: Option<u32>, path: Option<String>) -> Result<String, String> {
    if let Some(id) = id {
        let ix = get(s)?;
        if id as usize >= ix.len() || ix.parent[id as usize] == NONE {
            return Err("no such item".into());
        }
        return Ok(ix.path(id));
    }
    match path {
        Some(p) if Path::new(&p).exists() => Ok(p),
        _ => Err("no such item".into()),
    }
}

#[tauri::command]
fn open_item(id: Option<u32>, path: Option<String>, s: State<Shared>) -> Result<(), String> {
    let p = target(&s, id, path)?;
    Command::new("explorer.exe").arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn reveal_item(id: Option<u32>, path: Option<String>, s: State<Shared>) -> Result<(), String> {
    let p = target(&s, id, path)?;
    Command::new("explorer.exe").raw_arg(format!("/select,\"{p}\"")).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn vscode_item(id: Option<u32>, path: Option<String>, s: State<Shared>) -> Result<(), String> {
    let p = target(&s, id, path)?;
    let candidates = [
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join(r"Programs\Microsoft VS Code\Code.exe"),
        PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default()).join(r"Microsoft VS Code\Code.exe"),
    ];
    match candidates.iter().find(|c| c.exists()) {
        Some(code) => Command::new(code).arg(&p).spawn().map(|_| ()).map_err(|e| e.to_string()),
        // installed some other way: the `code` command, if it is on PATH
        None => Command::new("cmd.exe").args(["/c", "code"]).arg(&p).creation_flags(CREATE_NO_WINDOW).spawn().map(|_| ()).map_err(|_| "VS Code was not found".to_string()),
    }
}

#[tauri::command]
fn rebuild(app: AppHandle) {
    start_index(app, true);
}

// ---------------------------------------------------------------- commands: apps, system, window

#[tauri::command]
fn apps_search(q: String, a: State<apps::Apps>) -> Vec<apps::App> {
    a.search(&q, 6)
}

#[tauri::command]
fn apps_top(n: usize, a: State<apps::Apps>) -> Vec<apps::App> {
    a.top(n.clamp(1, 16))
}

/// Pin an app to the left list, or unpin it.
#[tauri::command]
fn pin_app(id: String, on: bool, a: State<apps::Apps>) {
    a.pin(&id, on);
}

/// The search box's "> command" list: a fixed set of actions - nothing else can be run from it.
#[tauri::command]
fn run_command(name: String, app: AppHandle) -> Result<(), String> {
    let open = |t: &str| Command::new("explorer.exe").arg(t).spawn().map(|_| ()).map_err(|e| e.to_string());
    let run = |exe: &str, args: &[&str]| Command::new(exe).args(args).creation_flags(CREATE_NO_WINDOW).spawn().map(|_| ()).map_err(|e| e.to_string());
    match name.as_str() {
        "settings" => open("ms-settings:"),
        "wifi" => open("ms-settings:network-wifi"),
        "bluetooth" => open("ms-settings:bluetooth"),
        "display" => open("ms-settings:display"),
        "sound" => open("ms-settings:sound"),
        "updates" => open("ms-settings:windowsupdate"),
        "apps" => open("ms-settings:appsfeatures"),
        "storage" => open("ms-settings:storagesense"),
        "power" => open("ms-settings:powersleep"),
        "recycle" => open("shell:RecycleBinFolder"),
        "downloads" => open("shell:Downloads"),
        "documents" => open("shell:Personal"),
        "taskmgr" => run("taskmgr.exe", &[]),
        "control" => run("control.exe", &[]),
        "terminal" => Command::new("wt.exe").spawn().map(|_| ()).or_else(|_| run("cmd.exe", &["/c", "start", "powershell"])),
        "lock" => run("rundll32.exe", &["user32.dll,LockWorkStation"]),
        // real sleep (SetSuspendState through rundll32 hibernates when hibernation is on)
        "sleep" => run("powershell.exe", &["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]),
        "restart" => run("shutdown.exe", &["/r", "/t", "0"]),
        "shutdown" => run("shutdown.exe", &["/s", "/hybrid", "/t", "0"]),   // keeps Fast Startup
        "signout" => run("shutdown.exe", &["/l"]),
        "reindex" => {
            start_index(app, true);
            Ok(())
        }
        _ => Err(format!("unknown command: {name}")),
    }
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
fn autostart_value() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY).and_then(|k| k.get_value::<String, _>("Orbis")).ok()
}
fn autostart_on() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY).and_then(|k| k.get_value::<String, _>("Orbis")).is_ok()
}
/// Start with Windows: a value in your own Run key (no admin rights, undone by switching it off).
fn write_autostart(on: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        k.set_value("Orbis", &format!("\"{}\" --autostart", exe.display())).map_err(|e| e.to_string())?;
    } else {
        let _ = k.delete_value("Orbis");
    }
    Ok(())
}
#[tauri::command]
fn set_autostart(on: bool, app: AppHandle) -> Result<bool, String> {
    write_autostart(on)?;
    let st = app.state::<RwLock<Settings>>();
    let mut w = st.write().unwrap();
    w.autostart = Some(on);
    save_settings(&w);
    drop(w);
    sync_tray(&app);
    Ok(autostart_on())
}

/// Starting with Windows and the screen saver live in Windows' own settings, which an upgrade (it runs
/// the old uninstaller) or a cleanup tool can remove. Put back what Orbis's settings say - unless you
/// picked a different screen saver in Windows since, which then wins.
fn restore_windows_settings(app: &AppHandle) {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let st = app.state::<RwLock<Settings>>();
    let mut s = st.write().unwrap();
    match s.autostart {
        None => s.autostart = Some(autostart_on()), // first run of this version: learn it
        Some(true) if !autostart_value().is_some_and(|v| v.contains("--autostart")) => {
            let _ = write_autostart(true); // missing, or written by an older version
        }
        _ => {}
    }
    if s.saver {
        let current: String = RegKey::predef(HKEY_CURRENT_USER).open_subkey(DESKTOP_KEY).and_then(|k| k.get_value("SCRNSAVE.EXE")).unwrap_or_default();
        if current.is_empty() {
            let _ = apply_screensaver(true, s.saver_minutes);
        } else if !current.eq_ignore_ascii_case(&saver_file().display().to_string()) {
            s.saver = false;
        } else {
            refresh_saver_file(); // a new build: keep the screen-saver copy current
        }
    }
    save_settings(&s);
}

/// App icons (data URLs) for the dock and the app results; the UI recolours them to the theme.
#[tauri::command]
fn app_icons(ids: Vec<String>, a: State<apps::Apps>) -> HashMap<String, String> {
    a.icons(&ids)
}

#[tauri::command]
fn launch_app(id: String, a: State<apps::Apps>) -> Result<(), String> {
    a.launch(&id)
}

#[tauri::command]
fn sys_stats(s: State<sys::Sys>) -> sys::Stats {
    s.sample()
}

/// Full screen (kiosk) or a normal window. Remembered for next time.
#[tauri::command]
fn set_kiosk(on: bool, app: AppHandle, st: State<RwLock<Settings>>) -> bool {
    if let Some(w) = main_window(&app) {
        apply_kiosk(&w, on);
    }
    let mut s = st.write().unwrap();
    s.kiosk = on;
    save_settings(&s);
    on
}

#[tauri::command]
fn set_theme(theme: String, st: State<RwLock<Settings>>) {
    let mut s = st.write().unwrap();
    s.theme = theme;
    save_settings(&s);
}

/// EXIT: close Orbis completely (the descriptive search sidecar goes with it).
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.state::<sem::Sem>().stop();
    app.exit(0);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let kind = launch_kind(&args);
    if kind == Launch::Preview {
        return; // the tiny preview in Windows' screen-saver dialog: nothing to draw there
    }
    if kind == Launch::Saver && handoff::forward() {
        return; // the open Orbis was the screen saver, and it has ended
    }
    migrate_from_twin();
    let settings = load_settings();
    let quiet = args.iter().any(|a| a == "--autostart") && settings.tray_start && kind == Launch::Normal;
    let app = tauri::Builder::default()
        // a second start (the screen saver, a shortcut) hands over to the Orbis already running
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if launch_kind(&argv) == Launch::Saver {
                enter_saver(app);
            } else if launch_kind(&argv) == Launch::Normal {
                app.state::<Saver>().only.store(false, Ordering::SeqCst); // opened on purpose: stay open afterwards
                if let Some(w) = main_window(app) {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .manage(Saver { active: AtomicBool::new(false), only: AtomicBool::new(kind == Launch::Saver), was_min: AtomicBool::new(false), was_hidden: AtomicBool::new(false) })
        .manage(Shared {
            idx: RwLock::new(None),
            building: AtomicBool::new(false),
            progress: Arc::new(AtomicU64::new(0)),
            moves: RwLock::new(HashMap::new()),
        })
        .manage(RwLock::new(settings.clone()))
        .manage(apps::Apps::default())
        .manage(sys::Sys::default())
        .manage(sem::Sem::default())
        .manage(watch::Live::default())
        .setup(move |app| {
            let h = app.handle().clone();
            *app.state::<Shared>().moves.write().unwrap() = load_moves();
            app.state::<apps::Apps>().load_cached();
            {
                let h2 = h.clone();
                std::thread::spawn(move || {
                    let a = h2.state::<apps::Apps>();
                    a.refresh();
                    a.fetch_icons();
                    let _ = h2.emit("icons-ready", ());
                });
            }
            if let Some(w) = main_window(&h) {
                apply_kiosk(&w, settings.kiosk);
                if !quiet {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            if let Err(e) = build_tray(&h) {
                eprintln!("no tray icon: {e}");
            }
            {
                let h2 = h.clone();
                handoff::serve(move || enter_saver(&h2));
            }
            if kind == Launch::Saver {
                enter_saver(&h);
            } else {
                restore_windows_settings(&h);
            }
            if settings.live {
                watch::start(h.clone(), live_roots(&settings));
            }
            // documents: refresh the meaning index once a day, quietly, at idle priority
            let ss = h.state::<sem::Sem>().status(now());
            if settings.semantic && ss.available && !ss.live && now() - ss.built > SEM_REFRESH_AFTER_SECS {
                let _ = sem::Sem::start_index(&doc_roots(&settings), &settings.sem_device);
            }
            start_index(h, false);
            Ok(())
        })
        // the window's close button (and Alt+F4) hides Orbis in the tray; EXIT closes it for good
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            scope_options, check_folder, status, base_graph, search, describe, describe_warm, reindex_docs, details, open_item, reveal_item,
            vscode_item, rebuild, apps_search, apps_top, app_icons, pin_app, run_command, set_autostart, launch_app, sys_stats, set_kiosk, set_theme, quit_app, system_profile, install_engine, update_settings, exit_saver, start_saver,
            win_minimize, win_toggle_maximize, win_hide
        ])
        .build(tauri::generate_context!())
        .expect("error while building Orbis");
    app.run(|app, ev| {
        if let RunEvent::Exit = ev {
            app.state::<sem::Sem>().stop();
        }
    });
}

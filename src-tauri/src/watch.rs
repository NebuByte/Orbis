//! Live activity: Windows tells Orbis about every file created, changed or removed in the watched
//! folders (the data drives, and the user's own folders when they are on the Windows drive). Orbis gathers them for 400 ms, turns them into
//! the folders they happened in, and sends those to the map, which lights them up. Nothing is
//! scanned: the notifications come from Windows (ReadDirectoryChangesW), so it costs next to nothing.

use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// churn nobody needs to see: caches, version control, build output, the recycle bin
const SKIP: &[&str] = &[
    "\\appdata\\", "\\$recycle.bin", "\\system volume information", "\\.git\\", "\\node_modules\\", "\\__pycache__\\",
    "\\.vs\\", "\\obj\\", "\\bin\\", "\\target\\", "\\.next\\", "\\.cache\\", "\\.gradle\\", "\\.venv\\", "\\.claude\\",
];
const MAX_PER_BATCH: usize = 24;

/// keeps the watcher alive for as long as Orbis runs
#[derive(Default)]
pub struct Live(Mutex<Option<notify::RecommendedWatcher>>);

pub fn stop(app: &AppHandle) {
    *app.state::<Live>().0.lock().unwrap_or_else(|e| e.into_inner()) = None;   // dropping the watcher ends it
}

pub fn start(app: AppHandle, roots: Vec<PathBuf>) {
    let (tx, rx) = channel::<PathBuf>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)) {
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        }
    });
    let Ok(mut w) = watcher else { return };
    for r in &roots {
        if r.exists() {
            let _ = w.watch(r, RecursiveMode::Recursive);
        }
    }
    *app.state::<Live>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(w);
    std::thread::spawn(move || loop {
        let Ok(first) = rx.recv() else { return };
        let mut dirs: HashSet<String> = HashSet::new();
        let mut take = |p: PathBuf| {
            let low = p.to_string_lossy().to_lowercase();
            if SKIP.iter().any(|s| low.contains(s)) {
                return;
            }
            if let Some(parent) = p.parent() {
                dirs.insert(parent.to_string_lossy().into_owned());
            }
        };
        take(first);
        let until = Instant::now() + Duration::from_millis(400);
        loop {
            match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(p) => take(p),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if !dirs.is_empty() {
            let batch: Vec<String> = dirs.into_iter().take(MAX_PER_BATCH).collect();
            let _ = app.emit("fs-activity", batch);
        }
    });
}
